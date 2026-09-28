import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { logForDebugging } from '../debug.js'
import { execFileNoThrow } from '../execFileNoThrow.js'

/**
 * Per-`query()` record of this run's cua-driver use. The `serve` daemon
 * outlives whoever started it (it relaunches through LaunchServices, and every
 * desktop session's `cua-driver mcp` server starts one), and it can keep state
 * from GUI actions after the agent is done: on 2026-09-28 it kept forcing one
 * app to the front for four minutes after the run's last call, until it was
 * killed. So a run that used it stops it when the run ends, and when it goes
 * idle mid-run. See docs/plans/2026-09-28-cua-driver-safety-net.md.
 *
 * Calls go through `beginCall`/`endCall` rather than a bare flag because a
 * run's tools can outlive the run: streaming tools are independent promises,
 * so a call still waiting on permission can reach the guard after the query's
 * `finally` has run, and a call already executing can still be running there.
 */
export type CuaDriverRun = {
  /**
   * Before a cua-driver call executes. Waits out an idle stop that is already
   * in flight, so it cannot shut the daemon down under the new call. Resolves
   * false once the run has ended; the call must not execute.
   */
  beginCall(): Promise<boolean>
  /** After a call that `beginCall` allowed has settled. */
  endCall(): void
  /** From `query()`'s `finally`: refuse new calls, settle, then stop. */
  end(): Promise<void>
}

export const CUA_DRIVER_IDLE_STOP_MS = 3 * 60 * 1000

// `cua-driver stop` only asks the daemon to exit over its socket (a CLI round
// trip measured about 20 ms); this bounds a hung socket so it cannot hold a
// run's end open.
const STOP_TIMEOUT_MS = 3000

// How long `end()` waits for calls still executing before stopping anyway, so
// a call that never returns (a foreground `cua-driver serve`) cannot hold the
// run's end open.
const IN_FLIGHT_WAIT_MS = 10_000

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
  inFlightWaitMs: number = IN_FLIGHT_WAIT_MS,
): CuaDriverRun {
  let ended = false
  // Calls that began since the last stop started; a stop covers everything
  // before it, so end() only needs another stop when this is set.
  let usedSinceStop = false
  let inFlight = 0
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let stopping: Promise<void> | undefined
  let settled: (() => void) | undefined

  const clearIdleTimer = (): void => {
    if (idleTimer === undefined) return
    clearTimeout(idleTimer)
    idleTimer = undefined
  }

  const stopNow = (): Promise<void> => {
    usedSinceStop = false
    const stop = (stopping ?? Promise.resolve()).then(() =>
      stopDaemon().catch(error => {
        logForDebugging(`[cua-driver] stop failed: ${String(error)}`, {
          level: 'warn',
        })
      }),
    )
    stopping = stop
    void stop.finally(() => {
      if (stopping === stop) stopping = undefined
    })
    return stop
  }

  const armIdleTimer = (): void => {
    clearIdleTimer()
    idleTimer = setTimeout(() => {
      idleTimer = undefined
      if (inFlight === 0 && usedSinceStop && !ended) void stopNow()
    }, idleStopMs)
    idleTimer.unref?.()
  }

  const waitForInFlight = (): Promise<void> => {
    if (inFlight === 0) return Promise.resolve()
    return new Promise(resolve => {
      const timer = setTimeout(resolve, inFlightWaitMs)
      timer.unref?.()
      settled = () => {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  return {
    async beginCall() {
      if (ended) return false
      clearIdleTimer()
      if (stopping) await stopping
      if (ended) return false
      usedSinceStop = true
      inFlight++
      return true
    },
    endCall() {
      inFlight = Math.max(0, inFlight - 1)
      if (inFlight > 0) return
      if (settled) {
        const notify = settled
        settled = undefined
        notify()
      }
      if (!ended) armIdleTimer()
    },
    async end() {
      if (ended) return
      ended = true
      clearIdleTimer()
      await waitForInFlight()
      if (stopping) await stopping
      if (usedSinceStop) await stopNow()
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
