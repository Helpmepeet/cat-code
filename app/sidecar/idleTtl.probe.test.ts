/**
 * CC-3 idle-TTL acceptance probe (Bun test) — the live-path proof (the 07-09
 * lesson: a synthetic assertion is not enough; spawn a REAL sidecar process).
 *
 * Spawns a real Bun sidecar (probe mode, so no engine boot is needed — the
 * idle-TTL lives in `SidecarServer`, constructed in both modes) with a short
 * `CATCODE_SIDECAR_IDLE_TTL_MS`, and proves:
 *   1. A sidecar whose supervisor never connects (the host-crash / killed-harness
 *      orphan) self-exits cleanly (exit 0) and unlinks its own socket file.
 *   2. A sidecar with an OPEN connection does NOT idle-exit past the TTL, and
 *      resumes the countdown once the connection drops (the crash-then-orphan
 *      path) — proving the timer is connection-gated, not a blind wall clock.
 *
 * Run: `bun test app/sidecar/idleTtl.probe.test.ts`
 */

import { afterEach, expect, test } from 'bun:test'
import { connect, type Socket } from 'node:net'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const sidecarEntry = join(here, 'index.ts')

// A real Bun process cold-starts the sidecar module graph before the TTL clock
// starts (the timer is armed at server construction, right before READY), so the
// import time does not count against the TTL. Still, give the harness headroom.
const TEST_TIMEOUT_MS = 60_000

type Spawned = { proc: ReturnType<typeof Bun.spawn>; socketPath: string }

const spawned: Spawned[] = []
const openSockets: Socket[] = []
const tempDirs: string[] = []

afterEach(() => {
  for (const s of openSockets.splice(0)) {
    try {
      s.destroy()
    } catch {
      // ignore
    }
  }
  for (const { proc } of spawned.splice(0)) {
    try {
      proc.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
})

function shortSocketDir(): string {
  // Keep well under the macOS sun_path 104-byte limit — /tmp base, short name.
  const dir = mkdtempSync(join('/tmp', 'cc3-'))
  tempDirs.push(dir)
  return dir
}

function spawnSidecar(idleTtlMs: number): Spawned {
  const socketPath = join(shortSocketDir(), 's.sock')
  const proc = Bun.spawn(['bun', 'run', sidecarEntry], {
    env: {
      ...process.env,
      CATCODE_SIDECAR_SOCKET: socketPath,
      CATCODE_SIDECAR_SESSION_ID: `cc3-${randomUUID()}`,
      CATCODE_SIDECAR_PROBE: '1',
      CATCODE_SIDECAR_IDLE_TTL_MS: String(idleTtlMs),
    },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  const entry: Spawned = { proc, socketPath }
  spawned.push(entry)
  return entry
}

/** Poll until the sidecar binds its socket (proxy for "server constructed + listening"). */
async function waitForSocket(socketPath: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now()
  while (!existsSync(socketPath)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`sidecar never created its socket at ${socketPath}`)
    }
    await Bun.sleep(25)
  }
}

/** Resolve when the process exits (with its code), or reject on timeout. */
async function waitForExit(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<number | null> {
  const timeout = new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error('process did not exit in time')), timeoutMs)
    // Do not keep the loop alive on the timeout alone.
    ;(t as { unref?: () => void }).unref?.()
  })
  return Promise.race([proc.exited, timeout])
}

test(
  'a never-connected sidecar self-exits cleanly and unlinks its socket after the idle TTL',
  async () => {
    const { proc, socketPath } = spawnSidecar(500)
    await waitForSocket(socketPath)

    // Never connect — this is the host-crash / killed-harness orphan. It must
    // self-exit on the idle TTL rather than linger forever.
    const code = await waitForExit(proc, 15_000)
    expect(code).toBe(0)
    // cleanup() unlinked the socket file so a re-bind of the path is possible.
    expect(existsSync(socketPath)).toBe(false)
  },
  TEST_TIMEOUT_MS,
)

test(
  'a sidecar with an open connection does NOT idle-exit, then resumes the countdown on disconnect',
  async () => {
    const idleTtlMs = 1_500
    const { proc, socketPath } = spawnSidecar(idleTtlMs)
    await waitForSocket(socketPath)

    // Attach a real client connection (the supervisor's role). This clears the
    // idle timer — a live connection must never idle-exit.
    const socket = connect({ path: socketPath })
    openSockets.push(socket)
    socket.on('error', () => {
      /* ignore — the process may exit under us in teardown */
    })
    socket.on('data', () => {
      /* drain ready/probe frames; content is asserted by roundtrip.probe.test.ts */
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })

    // Hold the connection well past the TTL; the process must stay alive.
    await Bun.sleep(idleTtlMs * 2)
    expect(proc.exitCode).toBeNull()

    // Drop the connection — the countdown re-arms (the crash-then-orphan path)
    // and the sidecar self-exits cleanly.
    socket.destroy()
    const code = await waitForExit(proc, idleTtlMs * 4)
    expect(code).toBe(0)
    expect(existsSync(socketPath)).toBe(false)
  },
  TEST_TIMEOUT_MS,
)
