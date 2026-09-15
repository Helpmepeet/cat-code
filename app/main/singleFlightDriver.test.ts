import { describe, expect, test } from 'bun:test'

import { createSingleFlightDriver } from './singleFlightDriver.js'

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

const noopTimer = () => ({ unref() {} }) as unknown as ReturnType<typeof setTimeout>

describe('createSingleFlightDriver — single-flight + keeps-last-good', () => {
  test('single-flight: a tick while a run is in flight never starts a second worker', async () => {
    let runCount = 0
    let running = 0
    let maxConcurrent = 0
    let release: (() => void) | null = null
    const driver = createSingleFlightDriver({
      run: () => {
        runCount++
        running++
        maxConcurrent = Math.max(maxConcurrent, running)
        return new Promise<void>(resolve => {
          release = () => {
            running--
            resolve()
          }
        })
      },
      intervalMs: 0,
      logLabel: 'test-runner',
      setTimer: noopTimer,
      clearTimer: () => {},
    })

    driver.start() // run #1 in flight
    await flush()
    expect(runCount).toBe(1)

    // Simulate the timer firing (and any spurious extra starts) mid-flight: the
    // in-flight guard must drop them — no second worker while #1 runs.
    driver.start()
    driver.start()
    await flush()
    expect(runCount).toBe(1)
    expect(maxConcurrent).toBe(1)

    release!() // #1 settles
    await flush()
    driver.stop()
    expect(maxConcurrent).toBe(1)
  })

  test('keeps last good: a rejected run is swallowed and the driver reschedules', async () => {
    let runCount = 0
    const logged: string[] = []
    let scheduled = 0
    const driver = createSingleFlightDriver({
      run: () => {
        runCount++
        return Promise.reject(new Error('worker blew up'))
      },
      intervalMs: 0,
      logLabel: 'catalog-runner',
      log: line => logged.push(line),
      setTimer: () => {
        scheduled++
        return noopTimer()
      },
      clearTimer: () => {},
    })

    driver.start()
    await flush()
    // The run rejected, but start() did not throw and the driver rescheduled the
    // next run (the renderer keeps its last good snapshot — no delivery happened).
    expect(runCount).toBe(1)
    expect(scheduled).toBe(1)
    expect(logged).toEqual(['[catalog-runner] refresh failed: worker blew up'])
    driver.stop()
  })

  test('fixed cadence: the next run is anchored to run START, not completion', async () => {
    // Before the fix the driver always scheduled `intervalMs` AFTER the run
    // settled, so the real refresh period was `intervalMs + runDuration` — the
    // measured 30.36 s ceiling against a 30 s freshness contract.
    const delays: number[] = []
    let clock = 0
    const runMs = 450
    const driver = createSingleFlightDriver({
      run: () => {
        clock += runMs // the run consumes wall time
        return Promise.resolve()
      },
      intervalMs: 30_000,
      logLabel: 'test-runner',
      now: () => clock,
      setTimer: (_cb, ms) => {
        delays.push(ms)
        return noopTimer()
      },
      clearTimer: () => {},
    })

    driver.start()
    await flush()
    driver.stop()
    // Period = interval exactly: the run's own 450 ms is absorbed, not added.
    expect(delays).toEqual([30_000 - runMs])
  })

  test('fixed cadence: a run that overruns the interval reschedules immediately, never stacks', async () => {
    const delays: number[] = []
    let clock = 0
    let running = 0
    let maxConcurrent = 0
    const driver = createSingleFlightDriver({
      run: async () => {
        running++
        maxConcurrent = Math.max(maxConcurrent, running)
        clock += 90_000 // three intervals long
        running--
      },
      intervalMs: 30_000,
      logLabel: 'test-runner',
      now: () => clock,
      setTimer: (_cb, ms) => {
        delays.push(ms)
        return noopTimer()
      },
      clearTimer: () => {},
    })

    driver.start()
    await flush()
    driver.stop()
    // Clamped to 0 (never negative), and the in-flight guard still serialized it.
    expect(delays).toEqual([0])
    expect(maxConcurrent).toBe(1)
  })

  test('stop() prevents any further scheduled runs', async () => {
    let runCount = 0
    let timerCb: (() => void) | null = null
    const driver = createSingleFlightDriver({
      run: () => {
        runCount++
        return Promise.resolve()
      },
      intervalMs: 0,
      logLabel: 'test-runner',
      setTimer: cb => {
        timerCb = cb
        return noopTimer()
      },
      clearTimer: () => {},
    })
    driver.start()
    await flush()
    expect(runCount).toBe(1)
    driver.stop()
    // Even if a pending timer callback fires after stop(), no run happens.
    timerCb!()
    await flush()
    expect(runCount).toBe(1)
  })

  test('start() after stop() never runs', async () => {
    let runCount = 0
    const driver = createSingleFlightDriver({
      run: async () => {
        runCount++
      },
      intervalMs: 0,
      logLabel: 'test-runner',
      setTimer: noopTimer,
      clearTimer: () => {},
    })
    driver.stop()
    driver.start()
    await flush()
    expect(runCount).toBe(0)
  })
})

describe('createSingleFlightDriver — refreshNow', () => {
  test('runs immediately instead of waiting out the interval', async () => {
    let runCount = 0
    const driver = createSingleFlightDriver({
      run: async () => {
        runCount++
      },
      intervalMs: 60_000,
      logLabel: 'test-runner',
      setTimer: noopTimer,
      clearTimer: () => {},
    })

    driver.start()
    await flush()
    expect(runCount).toBe(1)

    driver.refreshNow()
    await flush()
    expect(runCount).toBe(2)
    driver.stop()
  })

  test('clears the pending timer, so it cannot fork a second self-scheduling chain', async () => {
    // The regression this pins: `schedule()` overwrites `timer` without clearing
    // it. Ticking on top of a live timer leaves the old one armed, and every
    // refresh would then add one more chain that reschedules forever.
    let cleared = 0
    let scheduled = 0
    const driver = createSingleFlightDriver({
      run: async () => {},
      intervalMs: 60_000,
      logLabel: 'test-runner',
      setTimer: () => {
        scheduled++
        return noopTimer()
      },
      clearTimer: () => {
        cleared++
      },
    })

    driver.start()
    await flush()
    expect(scheduled).toBe(1)

    driver.refreshNow()
    await flush()
    // One armed timer at a time: the second schedule is preceded by a clear.
    expect(cleared).toBe(1)
    expect(scheduled).toBe(2)
    driver.stop()
  })

  test('a refresh during a run re-runs after it, rather than being dropped', async () => {
    // The in-flight run STARTED before the sign-in it is meant to observe, so
    // finishing it proves nothing. Dropping the request the way an ordinary tick
    // is dropped would leave the caller on the full interval.
    let runCount = 0
    let release: (() => void) | null = null
    const driver = createSingleFlightDriver({
      run: () =>
        new Promise<void>(resolve => {
          runCount++
          release = resolve
        }),
      intervalMs: 60_000,
      logLabel: 'test-runner',
      setTimer: noopTimer,
      clearTimer: () => {},
    })

    driver.start()
    await flush()
    expect(runCount).toBe(1)

    driver.refreshNow()
    driver.refreshNow()
    await flush()
    // Still single-flight: nothing starts while the first run is open.
    expect(runCount).toBe(1)

    release!()
    await flush()
    // One re-run however many requests arrived, not one per request.
    expect(runCount).toBe(2)

    release!()
    await flush()
    expect(runCount).toBe(2)
    driver.stop()
  })

  test('arming is idempotent: no entry point can leave two chains running', async () => {
    // The invariant lives in `schedule()`, not in `refreshNow`'s caller. Its
    // other entry point is a second `start()`, which before the move left the
    // first chain armed and permanently doubled the worker spawn rate.
    let cleared = 0
    let armed = 0
    const fire: Array<() => void> = []
    const driver = createSingleFlightDriver({
      run: async () => {},
      intervalMs: 60_000,
      logLabel: 'test-runner',
      setTimer: cb => {
        armed++
        fire.push(cb)
        return noopTimer()
      },
      clearTimer: () => {
        cleared++
      },
    })

    driver.start()
    await flush()
    driver.start()
    await flush()
    driver.refreshNow()
    await flush()

    // Three arm attempts, and every one past the first cleared its predecessor,
    // so exactly one chain is live however the runs were triggered.
    expect(armed - cleared).toBe(1)
    driver.stop()
  })

  test('is inert after stop()', async () => {
    let runCount = 0
    const driver = createSingleFlightDriver({
      run: async () => {
        runCount++
      },
      intervalMs: 60_000,
      logLabel: 'test-runner',
      setTimer: noopTimer,
      clearTimer: () => {},
    })

    driver.start()
    await flush()
    driver.stop()
    driver.refreshNow()
    await flush()
    expect(runCount).toBe(1)
  })
})
