/**
 * Headless Bun engine sidecar — entrypoint (net-new, small).
 *
 * Run as its own OS process by the supervisor (Electron-free). It:
 *   1. builds a real QueryEngine-backed `AppSessionController` for normal
 *      startup, or the P1-0 fixture controller only when explicitly requested;
 *   2. listens on a Unix-domain socket (D6 pin 1) at the path handed to it;
 *   3. raw-forwards controller events and validates inbound frames via
 *      `SidecarServer`.
 *
 * `CATCODE_SIDECAR_PROBE=1` retains the P1-0 transport fixture: it submits one
 * probe prompt on first attach so tests can verify raw `tool_use` forwarding.
 * Normal Electron startup does not set that flag and never emits the fixture.
 *
 * ZERO `electron` imports. This is a plain Bun program.
 */

import { statSync } from 'node:fs'

import { FrameDecoder } from '../shared/framing.js'
import { MAX_FRAME_BYTES } from '../shared/limits.js'
import { getSessionId } from '../../src/bootstrap/state.js'
import type { Message } from '../../src/types/message.js'
import { toSDKMessages } from '../../src/utils/messages/mappers.js'
import { initializeSidecarRuntime } from './initializeRuntime.js'
import { createSidecarSessionController } from './sessionController.js'
import { resumeEngineSession, SidecarResumeError } from './sessionResume.js'
import { SidecarServer, type SidecarSocketLike } from './sidecarServer.js'

/** Dedicated non-zero exit for an unresumable engine session id. */
const RESUME_FAILED_EXIT_CODE = 4

type SidecarArgs = {
  socketPath: string
  sessionId: string
  /**
   * Caller-chosen session root (REGISTRY.md §7). Host-owned input (T8/HC1); the
   * supervisor also sets it as the child's spawn cwd, so the engine's project
   * identity is already rooted here. Validated below as defense in depth.
   */
  cwd: string
  /**
   * Optional engine session to resume (REGISTRY.md R3). Present ⇒ resume that
   * transcript through the engine's real machinery, never a fresh mint.
   */
  resumeEngineSessionId: string | undefined
  /** P1-0 only: inject the probe tool_use frame on first attach. */
  probeOnAttach: boolean
}

function parseArgs(): SidecarArgs {
  const socketPath = process.env.CATCODE_SIDECAR_SOCKET
  const sessionId = process.env.CATCODE_SIDECAR_SESSION_ID
  if (!socketPath || !sessionId) {
    throw new Error(
      'sidecar requires CATCODE_SIDECAR_SOCKET and CATCODE_SIDECAR_SESSION_ID',
    )
  }
  const probeOnAttach = process.env.CATCODE_SIDECAR_PROBE === '1'
  // The cwd is required for a real session (the engine roots project identity on
  // it). Probe mode has no engine, so tolerate its absence there. Fail loudly on
  // a missing/non-directory cwd rather than silently booting somewhere wrong
  // (defense in depth behind the host's HC1 validation — this session never
  // trusts a renderer-authored path, but it does verify a host-supplied one).
  const cwd = process.env.CATCODE_SIDECAR_CWD
  if (!probeOnAttach) {
    if (!cwd) {
      throw new Error('sidecar requires CATCODE_SIDECAR_CWD')
    }
    let isDir = false
    try {
      isDir = statSync(cwd).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) {
      throw new Error(`CATCODE_SIDECAR_CWD is not a directory: ${cwd}`)
    }
  }
  return {
    socketPath,
    sessionId,
    cwd: cwd ?? process.cwd(),
    resumeEngineSessionId: process.env.CATCODE_SIDECAR_RESUME_SESSION_ID || undefined,
    probeOnAttach,
  }
}

async function main(): Promise<void> {
  const args = parseArgs()

  if (!args.probeOnAttach) {
    await initializeSidecarRuntime()
  }

  // Resume BEFORE reading the engine session id: processResumedConversation
  // adopts the resumed id via switchSession, so getSessionId() then returns it
  // and the ready frame's engineSessionId echoes the requested resume id. A bad
  // id throws here → the fatal handler below exits non-zero + loudly (never a
  // silent fresh session). Probe mode has no engine and cannot resume.
  // The loaded Message[] are the restored turn context (F1, host-plane review
  // 2026-07-05): they MUST reach the session controller below — id adoption
  // alone restores the transcript key, not the conversation.
  let resumedMessages: Message[] | undefined
  if (!args.probeOnAttach && args.resumeEngineSessionId) {
    const resumed = await resumeEngineSession(args.resumeEngineSessionId, args.cwd)
    resumedMessages = resumed.messages
    process.stderr.write(
      `[sidecar] resume-seeded messages=${resumed.messages.length} engineSessionId=${resumed.engineSessionId}\n`,
    )
  }

  const engineSessionId = args.probeOnAttach
    ? `probe:${args.sessionId}`
    : getSessionId()

  const { controller, permissions, settings, agentConfig, goals, memory, accounts } = await createSidecarSessionController({
    probe: args.probeOnAttach,
    cwd: args.cwd,
    ...(resumedMessages !== undefined ? { initialMessages: resumedMessages } : {}),
  })

  // F2 (decisions/RESTORE-HISTORY.md): the renderer's restored history is the
  // SAME resumedMessages array that seeded the engine above — one source, no
  // drift — converted by the engine's own toSDKMessages (the mapper the remote
  // bridge uses for exactly this replay-to-a-late-display job). Converted AFTER
  // resume so getSessionId() stamps the adopted engine session id.
  const historyEvents = resumedMessages !== undefined
    ? toSDKMessages(resumedMessages)
    : undefined

  const server = new SidecarServer({
    sessionId: args.sessionId,
    engineSessionId,
    controller,
    ...(permissions ? { permissions } : {}),
    ...(settings ? { settings } : {}),
    ...(agentConfig ? { agentConfig } : {}),
    ...(goals ? { goals } : {}),
    ...(memory ? { memory } : {}),
    ...(accounts ? { accounts } : {}),
    ...(historyEvents !== undefined ? { history: historyEvents } : {}),
  })

  // `Bun.listen({ unix })` is the Unix-domain socket transport (D6 pin 1: a
  // socket FILE, not a listening TCP port — no network surface added).
  const bunListen = (globalThis as { Bun?: typeof import('bun') }).Bun?.listen
  if (!bunListen) {
    throw new Error('sidecar must run under Bun (Bun.listen unavailable)')
  }

  // A stale socket file (e.g. from a crashed prior run) blocks bind; remove it.
  try {
    require('fs').unlinkSync(args.socketPath)
  } catch {
    // not present — fine
  }

  bunListen({
    unix: args.socketPath,
    socket: {
      open(socket) {
        const wrapper: SidecarSocketLike = {
          write: data => {
            socket.write(data)
          },
          end: () => {
            socket.end()
          },
        }
        const connection = server.addConnection(wrapper)
        // Stash per-socket state so data/close can find its connection.
        socketState.set(socket, { connection, decoder: connection.decoder })

        if (args.probeOnAttach) {
          // P1-0 gate: drive the real controller so its emit()/subscribe() path
          // ships the tool_use frame. Fire-and-forget; errors surface as an
          // error frame via the server's submit path.
          void controller
            .submit('__p1_0_probe__')
            .catch(error => {
              process.stderr.write(
                `[sidecar] probe submit failed: ${
                  error instanceof Error ? error.message : String(error)
                }\n`,
              )
            })
        }
      },
      data(socket, chunk) {
        const state = socketState.get(socket)
        if (state) {
          server.handleData(state.connection, toBuffer(chunk))
        }
      },
      close(socket) {
        const state = socketState.get(socket)
        if (state) {
          server.removeConnection(state.connection)
          socketState.delete(socket)
        }
      },
      error(socket, error) {
        process.stderr.write(
          `[sidecar] socket error: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        )
        const state = socketState.get(socket)
        if (state) {
          server.removeConnection(state.connection)
          socketState.delete(socket)
        }
      },
    },
  })

  process.stderr.write(
    `[sidecar] READY sessionId=${args.sessionId} socket=${args.socketPath}\n`,
  )

  // Clean the socket file on exit so a restart can re-bind the path.
  const cleanup = () => {
    server.close()
    try {
      require('fs').unlinkSync(args.socketPath)
    } catch {
      // best-effort
    }
  }
  process.on('SIGTERM', () => {
    cleanup()
    process.exit(0)
  })
  process.on('SIGINT', () => {
    cleanup()
    process.exit(0)
  })
}

// Per-socket association: Bun's socket handlers receive the raw socket, so we
// map it to its `SidecarServer` connection + decoder. `FrameDecoder` is unused
// directly here (the connection owns it) but kept in the type for clarity.
const socketState = new WeakMap<
  object,
  { connection: ReturnType<SidecarServer['addConnection']>; decoder: FrameDecoder }
>()

function toBuffer(chunk: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
}

void main().catch(error => {
  // An unresumable engine session id is a distinguishable failure, not a generic
  // crash: mark it explicitly on stderr and use a dedicated non-zero exit code so
  // the supervisor/UI can surface "restore failed" rather than a silent fresh
  // session (D6 anti-Potemkin).
  if (error instanceof SidecarResumeError) {
    process.stderr.write(`[sidecar] resume-failed: ${error.message}\n`)
    process.exit(RESUME_FAILED_EXIT_CODE)
  }
  process.stderr.write(
    `[sidecar] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  )
  process.exit(1)
})
