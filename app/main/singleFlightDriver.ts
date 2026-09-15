/**
 * Single-flight, fixed-cadence driver, shared by the sessions-catalog and
 * accounts-pool refreshes.
 *
 * It was written twice, because the accounts runner deliberately declined to
 * import the catalog runner's copy: coupling one surface's poll to the other's
 * module would let one surface's refactor break the other. That objection is
 * answered by owning the driver HERE rather than in either runner, and it needed
 * answering: the two copies had already drifted, and the catalog copy carried a
 * comment admitting its `schedule()` could arm a second self-rescheduling chain
 * and was safe only because of a call-site guard in `main.ts`. The version kept
 * is the accounts one, which clears the pending handle before arming.
 *
 * `run()` performs ONE refresh. At most one run is ever in flight, so
 * the next is only SCHEDULED once the current settles and a slow run can never
 * cause overlapping spawns, while that next run is anchored to the current
 * run's START, so the period stays `intervalMs` rather than
 * `intervalMs + runDuration`. Anchoring on completion instead let the period
 * grow without bound with run duration, silently degrading the freshness
 * contract. A run that overruns the interval schedules the next immediately
 * (delay 0), still serialized behind the in-flight guard. A rejected `run()` is
 * logged and swallowed: the timer keeps ticking and the renderer keeps its last
 * good snapshot.
 */

export type SingleFlightDriver = {
  /** Run once now (respecting single-flight), then keep refreshing on the timer. */
  start(): void
  /**
   * Run out of band because a KNOWN mutation just landed, and re-anchor the
   * cadence to it. Only for events that change the read's subject; the timer
   * covers everything else, and calling this on renderer activity would turn a
   * fixed cadence into a per-interaction engine boot.
   */
  refreshNow(): void
  /** Stop the timer and prevent any further scheduled runs. */
  stop(): void
}

export function createSingleFlightDriver(deps: {
  run: () => Promise<unknown>
  intervalMs: number
  /** Prefix for the swallowed-failure log line, e.g. `catalog-runner`. */
  logLabel: string
  log?: (line: string) => void
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
  /** Injected only so tests can drive the cadence math on a virtual clock. */
  now?: () => number
}): SingleFlightDriver {
  const intervalMs = deps.intervalMs
  const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
  const clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle))
  const now = deps.now ?? (() => Date.now())

  let inFlight = false
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  /**
   * An out-of-band refresh that arrived mid-run. The in-flight run started
   * BEFORE the mutation it is meant to observe, so finishing it proves nothing
   * and dropping the request the way an ordinary tick is dropped would put the
   * caller back on the full interval. One re-run is enough however many arrive.
   */
  let rerunRequested = false

  const clearPendingTimer = () => {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
  }

  /**
   * `startedAt` is when the run that just settled BEGAN. Subtracting its
   * duration keeps successive run starts one `intervalMs` apart; a run slower
   * than the interval clamps to 0 so the cadence degrades to back-to-back
   * rather than compounding.
   */
  const schedule = (startedAt: number) => {
    if (stopped) return
    // The invariant belongs to the function that arms the timer, not to its
    // callers: assigning over a live handle leaves the old one armed and forks a
    // second self-rescheduling chain, permanently doubling the worker spawn rate.
    clearPendingTimer()
    const delay = Math.max(0, intervalMs - (now() - startedAt))
    timer = setTimer(() => {
      timer = null
      void tick()
    }, delay)
    timer.unref?.()
  }

  const tick = async () => {
    // Single-flight: never a second worker while one is in flight. A tick that
    // arrives mid-run is dropped; the running tick reschedules on completion.
    if (inFlight || stopped) return
    inFlight = true
    const startedAt = now()
    try {
      await deps.run()
    } catch (error) {
      deps.log?.(
        `[${deps.logLabel}] refresh failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    } finally {
      inFlight = false
      if (rerunRequested && !stopped) {
        rerunRequested = false
        void tick()
      } else {
        schedule(startedAt)
      }
    }
  }

  return {
    start() {
      if (stopped) return
      // Trigger one run immediately (cold launch: the surface must not sit
      // empty), then self-reschedule from its completion.
      void tick()
    },
    refreshNow() {
      if (stopped) return
      if (inFlight) {
        rerunRequested = true
        return
      }
      // `schedule()` clears the handle itself, so this is not what keeps the
      // chain single. It saves the pending callback from firing a tick that the
      // in-flight guard would drop anyway, one interval from now.
      clearPendingTimer()
      void tick()
    },
    stop() {
      rerunRequested = false
      stopped = true
      clearPendingTimer()
    },
  }
}
