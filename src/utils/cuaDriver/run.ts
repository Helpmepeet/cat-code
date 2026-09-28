import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { logForDebugging } from '../debug.js'
import { execFileNoThrow } from '../execFileNoThrow.js'

/**
 * Per-`query()` record of whether this run drove cua-driver. The `serve`
 * daemon outlives whoever started it (it relaunches through LaunchServices,
 * and every desktop session's `cua-driver mcp` server starts one), and it can
 * keep state from GUI actions after the agent is done: on 2026-09-28 it kept
 * forcing one app to the front for four minutes after the run's last call,
 * until it was killed. So a run that used it stops it when the run ends, and
 * again when it goes idle mid-run. See
 * docs/plans/2026-09-28-cua-driver-safety-net.md.
 */
export type CuaDriverRun = {
  /**
   * Called by the tool guard before a cua-driver call executes. Returns false
   * once the run has ended, and the call must not execute: streamed tools are
   * independent promises, so one still waiting on permission can reach the
   * guard after the query's `finally` has already stopped the daemon.
   */
  markUsed(): boolean
  /** Called from `query()`'s `finally`; stops the daemon if this run used it. */
  end(): Promise<void>
}

export const CUA_DRIVER_IDLE_STOP_MS = 3 * 60 * 1000

// `cua-driver stop` only asks the daemon to exit over its socket (a CLI round
// trip measured about 20 ms); this bounds a hung socket so it cannot hold a
// run's end open.
const STOP_TIMEOUT_MS = 3000

// The desktop sidecar inherits a LaunchServices PATH without ~/.local/bin, so
// resolve the binary by location rather than through PATH. HOME first, as the
// CLI itself does for its socket path.
function findCuaDriverBinary(): string | undefined {
  return [
    join(process.env.HOME || homedir(), '.local', 'bin', 'cua-driver'),
    '/Applications/CuaDriver.app/Contents/MacOS/cua-driver',
  ].find(path => existsSync(path))
}

async function stopCuaDriverDaemon(
  timeoutMs: number = STOP_TIMEOUT_MS,
): Promise<void> {
  const binary = findCuaDriverBinary()
  if (!binary) return
  const result = await execFileNoThrow(binary, ['stop'], {
    timeout: timeoutMs,
    preserveOutputOnError: true,
    useCwd: false,
  })
  logForDebugging(
    `[cua-driver] stop exited ${result.code}${result.error ? `: ${result.error}` : ''}`,
  )
}

let stopDaemon: () => Promise<void> = stopCuaDriverDaemon

export function createCuaDriverRun(
  idleStopMs: number = CUA_DRIVER_IDLE_STOP_MS,
): CuaDriverRun {
  let used = false
  let ended = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined

  const clearIdleTimer = (): void => {
    if (idleTimer === undefined) return
    clearTimeout(idleTimer)
    idleTimer = undefined
  }

  const stop = (): Promise<void> =>
    stopDaemon().catch(error => {
      logForDebugging(`[cua-driver] stop failed: ${String(error)}`, {
        level: 'warn',
      })
    })

  return {
    markUsed() {
      if (ended) return false
      used = true
      clearIdleTimer()
      idleTimer = setTimeout(() => {
        idleTimer = undefined
        void stop()
      }, idleStopMs)
      idleTimer.unref?.()
      return true
    },
    async end() {
      ended = true
      clearIdleTimer()
      if (!used) return
      used = false
      await stop()
    },
  }
}

export const _forTest = {
  /** Replace the daemon stop. Passing null restores the real one. */
  setStopDaemon(next: (() => Promise<void>) | null): void {
    stopDaemon = next ?? stopCuaDriverDaemon
  },
  stopCuaDriverDaemon,
}
