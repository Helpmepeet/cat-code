import { describe, expect, test } from 'bun:test'

import {
  describeChildExit,
  describeReadinessFailure,
  isCleanExit,
  resolveLauncherExitCode,
  terminateChild,
  waitForRendererReady,
  type ChildExit,
} from './devLauncher.js'

const noSleep = async (): Promise<void> => {}

describe('resolveLauncherExitCode', () => {
  test('propagates a plain status', () => {
    expect(resolveLauncherExitCode({ code: 0, signal: null })).toBe(0)
    expect(resolveLauncherExitCode({ code: 7, signal: null })).toBe(7)
  })

  test('maps a known signal to 128 + signum', () => {
    expect(resolveLauncherExitCode({ code: null, signal: 'SIGINT' })).toBe(130)
    expect(resolveLauncherExitCode({ code: null, signal: 'SIGTERM' })).toBe(143)
    expect(resolveLauncherExitCode({ code: null, signal: 'SIGKILL' })).toBe(137)
  })

  test('a signal wins over a status, and an unknown signal still fails', () => {
    expect(resolveLauncherExitCode({ code: 0, signal: 'SIGTERM' })).toBe(143)
    expect(
      resolveLauncherExitCode({ code: 0, signal: 'SIGUSR2' as NodeJS.Signals }),
    ).toBe(1)
  })

  test('an unknown ending fails rather than reporting success', () => {
    expect(resolveLauncherExitCode({ code: null, signal: null })).toBe(1)
  })
})

describe('isCleanExit', () => {
  test('only status 0 with no signal is clean', () => {
    expect(isCleanExit({ code: 0, signal: null })).toBe(true)
    expect(isCleanExit({ code: 1, signal: null })).toBe(false)
    expect(isCleanExit({ code: 0, signal: 'SIGTERM' })).toBe(false)
  })
})

describe('waitForRendererReady', () => {
  const clock = () => {
    let t = 0
    return {
      now: () => t,
      advance: (ms: number) => {
        t += ms
      },
    }
  }

  test('resolves once the probe succeeds', async () => {
    const { now } = clock()
    let probes = 0
    const outcome = await waitForRendererReady({
      probe: async () => {
        probes += 1
        return probes >= 2
      },
      childExit: () => null,
      now,
      sleep: noSleep,
      timeoutMs: 1000,
      pollMs: 10,
    })
    expect(outcome).toEqual({ ok: true })
    expect(probes).toBe(2)
  })

  /**
   * The stale-Vite regression: a leftover server answers the probe while OUR
   * child is already dead from the strictPort collision. Readiness must follow
   * the child we own, never the port.
   */
  test('a dead child beats a probe that would have succeeded', async () => {
    const exit: ChildExit = { code: 1, signal: null }
    let probed = false
    const outcome = await waitForRendererReady({
      probe: async () => {
        probed = true
        return true
      },
      childExit: () => exit,
      now: () => 0,
      sleep: noSleep,
      timeoutMs: 1000,
      pollMs: 10,
    })
    expect(outcome).toEqual({ ok: false, reason: 'child-exited', exit })
    expect(probed).toBe(false)
  })

  test('a child that dies during the probe reports child-exited, not timeout', async () => {
    const exit: ChildExit = { code: 1, signal: null }
    let dead = false
    const outcome = await waitForRendererReady({
      probe: async () => {
        dead = true
        return false
      },
      childExit: () => (dead ? exit : null),
      now: () => 0,
      sleep: noSleep,
      timeoutMs: 1000,
      pollMs: 10,
    })
    expect(outcome).toEqual({ ok: false, reason: 'child-exited', exit })
  })

  test('gives up after the timeout while the child is still alive', async () => {
    const { now, advance } = clock()
    const outcome = await waitForRendererReady({
      probe: async () => false,
      childExit: () => null,
      now,
      sleep: async () => advance(100),
      timeoutMs: 250,
      pollMs: 100,
    })
    expect(outcome).toEqual({ ok: false, reason: 'timeout' })
  })
})

describe('terminateChild', () => {
  test('does nothing for a child that already exited', async () => {
    const signals: NodeJS.Signals[] = []
    const result = await terminateChild({
      kill: signal => signals.push(signal),
      hasExited: () => true,
      sleep: noSleep,
      now: () => 0,
      graceMs: 100,
      pollMs: 10,
    })
    expect(result).toBe('already-exited')
    expect(signals).toEqual([])
  })

  test('stops at SIGTERM when the child goes away inside the grace window', async () => {
    let t = 0
    let exited = false
    const signals: NodeJS.Signals[] = []
    const result = await terminateChild({
      kill: signal => {
        signals.push(signal)
        exited = true
      },
      hasExited: () => exited,
      sleep: async () => {
        t += 10
      },
      now: () => t,
      graceMs: 100,
      pollMs: 10,
    })
    expect(result).toBe('terminated')
    expect(signals).toEqual(['SIGTERM'])
  })

  test('escalates to SIGKILL when the grace window expires', async () => {
    let t = 0
    const signals: NodeJS.Signals[] = []
    const result = await terminateChild({
      kill: signal => signals.push(signal),
      hasExited: () => false,
      sleep: async () => {
        t += 10
      },
      now: () => t,
      graceMs: 50,
      pollMs: 10,
    })
    expect(result).toBe('killed')
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  })
})

describe('operator messages', () => {
  test('describeChildExit names the status or the signal', () => {
    expect(describeChildExit('(vite)', { code: 1, signal: null })).toBe(
      '(vite) exited with status 1',
    )
    expect(describeChildExit('(vite)', { code: null, signal: 'SIGKILL' })).toBe(
      '(vite) was killed by SIGKILL',
    )
  })

  test('the stale-server case gets the actionable check, the timeout does not', () => {
    const staleServer = describeReadinessFailure(
      { ok: false, reason: 'child-exited', exit: { code: 1, signal: null } },
      'http://localhost:5173',
    )
    expect(staleServer).toContain('lsof -ti:5173')
    expect(staleServer).toContain('not launching Electron')

    const timedOut = describeReadinessFailure(
      { ok: false, reason: 'timeout' },
      'http://localhost:5173',
    )
    expect(timedOut).toContain('did not come up')
    expect(timedOut).not.toContain('lsof')
  })
})
