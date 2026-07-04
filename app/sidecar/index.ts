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

import { FrameDecoder } from '../shared/framing.js'
import { MAX_FRAME_BYTES } from '../shared/limits.js'
import { getSessionId } from '../../src/bootstrap/state.js'
import { initializeSidecarRuntime } from './initializeRuntime.js'
import { createSidecarSessionController } from './sessionController.js'
import { SidecarServer, type SidecarSocketLike } from './sidecarServer.js'

type SidecarArgs = {
  socketPath: string
  sessionId: string
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
  return {
    socketPath,
    sessionId,
    probeOnAttach: process.env.CATCODE_SIDECAR_PROBE === '1',
  }
}

async function main(): Promise<void> {
  const args = parseArgs()

  if (!args.probeOnAttach) {
    await initializeSidecarRuntime()
  }
  const engineSessionId = args.probeOnAttach
    ? `probe:${args.sessionId}`
    : getSessionId()

  const { controller, permissions } = await createSidecarSessionController({
    probe: args.probeOnAttach,
  })

  const server = new SidecarServer({
    sessionId: args.sessionId,
    engineSessionId,
    controller,
    ...(permissions ? { permissions } : {}),
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
  process.stderr.write(
    `[sidecar] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  )
  process.exit(1)
})
