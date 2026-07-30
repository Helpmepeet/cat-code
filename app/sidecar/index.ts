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
import {
  MAX_FRAME_BYTES,
  PARKED_EXIT_CODE,
  RESUME_FAILED_EXIT_CODE,
} from '../shared/limits.js'
import { getSessionId } from '../../src/bootstrap/state.js'
import type { Message } from '../../src/types/message.js'
import { toSDKMessages } from '../../src/utils/messages/mappers.js'
import { initializeSidecarRuntime } from './initializeRuntime.js'
import { createSidecarSessionController } from './sessionController.js'
import { resumeEngineSession, SidecarResumeError } from './sessionResume.js'
import { SidecarServer } from './sidecarServer.js'
import { createBackpressuredSocket } from './backpressuredSocket.js'

/**
 * CC-3 — idle self-exit TTL (docs O1 / SESSION-LIFETIME §2). A sidecar whose
 * supervisor died (host crash) is orphaned: the socket outlives the parent and
 * nothing reaps it until the next app launch — and never, if its registry row is
 * evicted first. This bounds that lifetime: with no active supervisor connection
 * for this long, the sidecar exits cleanly (unlinks its socket, exit 0). Generous
 * by default so a live, merely-quiet session is never reaped; a live connection
 * cancels the timer regardless of idle time. Overridable via
 * `CATCODE_SIDECAR_IDLE_TTL_MS` (tests shrink it). This is additive time-based
 * self-exit, NOT parent-binding — die-with-window (SESSION-LIFETIME L2) remains
 * supervisor behavior; crash-restore is unaffected (it re-spawns through
 * `host.restoreSession` → `sessionResume.ts`, never attaching to an orphan).
 */
const DEFAULT_SIDECAR_IDLE_TTL_MS = 15 * 60 * 1000

/**
 * Parse `CATCODE_SIDECAR_IDLE_TTL_MS`. A non-negative finite integer overrides
 * the default; `0` disables the timer; a missing/malformed value falls back to
 * the default (fail-safe: a typo never silently disables the janitor).
 */
function parseIdleTtlMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_SIDECAR_IDLE_TTL_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SIDECAR_IDLE_TTL_MS
  return Math.floor(parsed)
}

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

  const {
    controller,
    permissions,
    settings,
    agentConfig,
    goals,
    memory,
    tasks,
    accounts,
    workspaceTrust,
    diagnostics,
    extensions,
    remoteSettings,
    agentMode,
    leases,
    taskControl,
    runControls,
    sessionActions,
    slashCatalog,
  } = await createSidecarSessionController({
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

  const idleTtlMs = parseIdleTtlMs(process.env.CATCODE_SIDECAR_IDLE_TTL_MS)

  const server = new SidecarServer({
    sessionId: args.sessionId,
    engineSessionId,
    controller,
    ...(permissions ? { permissions } : {}),
    ...(settings ? { settings } : {}),
    ...(agentConfig ? { agentConfig } : {}),
    ...(goals ? { goals } : {}),
    ...(memory ? { memory } : {}),
    ...(tasks ? { tasks } : {}),
    ...(accounts ? { accounts } : {}),
    ...(workspaceTrust ? { workspaceTrust } : {}),
    ...(diagnostics ? { diagnostics } : {}),
    ...(extensions ? { extensions } : {}),
    ...(remoteSettings ? { remoteSettings } : {}),
    ...(agentMode ? { agentMode } : {}),
    ...(leases ? { leases } : {}),
    ...(taskControl ? { taskControl } : {}),
    ...(runControls ? { runControls } : {}),
    ...(sessionActions ? { sessionActions } : {}),
    ...(slashCatalog.length > 0 ? { slashCatalog } : {}),
    ...(historyEvents !== undefined ? { history: historyEvents } : {}),
    // P4-6 title-rider: a resumed session already has its title + history, so its
    // first turn this run is a continuation — never retitle it from that prompt.
    resumed: resumedMessages !== undefined,
    idleTtlMs,
    // CC-3 — the idle janitor: clean up the socket like the signal handlers do,
    // then exit 0 (a clean, expected shutdown — not a crash). `cleanup` is the
    // same closure the SIGTERM/SIGINT handlers use; it is defined just below and
    // only invoked here asynchronously by the timer, so it is initialized by the
    // time this fires.
    onIdle: () => {
      cleanup()
      process.exit(0)
    },
    // IDLE-PARK (decisions/IDLE-PARK.md §2/§3) — the gated park exit. The sidecar
    // owns the gate + latch; when it decides to park it flushes the socket and
    // self-exits with the dedicated PARKED_EXIT_CODE so the host can classify the
    // exit as a park (not a crash) purely from the code — no ack frame. Same
    // `cleanup` closure the SIGTERM/onIdle paths use (defined just below and only
    // invoked here asynchronously, so it is initialized by the time this fires).
    onPark: () => {
      cleanup()
      process.exit(PARKED_EXIT_CODE)
    },
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
        // Bun's socket.write() can accept fewer bytes than given once the send
        // buffer fills; the raw wrapper used to discard that short count, which
        // silently truncated any frame over ~8 KiB and desynced the length-
        // prefixed stream. This wrapper queues the remainder and flushes it on
        // `drain` (see backpressuredSocket.ts).
        const { wrapper, drain } = createBackpressuredSocket(socket, {
          onOverflow: queuedBytes => {
            process.stderr.write(
              `[sidecar] outbound queue overflow (${queuedBytes} bytes), dropping connection\n`,
            )
          },
        })
        const connection = server.addConnection(wrapper)
        // Stash per-socket state so data/close/drain can find its connection.
        socketState.set(socket, { connection, decoder: connection.decoder, drain })

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
      drain(socket) {
        const state = socketState.get(socket)
        if (!state) return
        try {
          state.drain()
        } catch (error) {
          process.stderr.write(
            `[sidecar] drain failed, dropping connection: ${
              error instanceof Error ? error.message : String(error)
            }\n`,
          )
          server.removeConnection(state.connection)
          socketState.delete(socket)
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
  {
    connection: ReturnType<SidecarServer['addConnection']>
    decoder: FrameDecoder
    drain: () => void
  }
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
