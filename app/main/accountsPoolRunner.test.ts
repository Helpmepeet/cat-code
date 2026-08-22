import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { spawn } from 'node:child_process'

import type {
  AccountStatus,
  AccountsSnapshot,
  UsageStatsByRange,
  UsageStatsRange,
  UsageStatsSnapshot,
} from '../shared/protocol.js'
import { ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION } from '../shared/accountsPoolWorker.js'
import {
  ACCOUNTS_POOL_REFRESH_INTERVAL_MS,
  createAccountsPoolDriver,
  runAccountsPoolWorker,
  runCarriesUsageStats,
  USAGE_STATS_EVERY_N_RUNS,
} from './accountsPoolRunner.js'

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

function account(over: Partial<AccountStatus> = {}): AccountStatus {
  return {
    id: 'acct-1',
    alias: 'work',
    status: 'healthy',
    statusReason: null,
    availability: 'available',
    availabilityLabel: 'Available',
    isDefault: true,
    hasVaultProfile: true,
    source: 'vault',
    usagePrimary: 42,
    usageWeekly: 17,
    usageLimitReached: false,
    usageResetAt: 1_700_000_000,
    lastRefreshIso: null,
    lastError: null,
    planType: 'plus',
    switchable: false,
    ...over,
  }
}

function pool(aliases: string[]): AccountsSnapshot {
  return {
    accounts: aliases.map((alias, i) =>
      account({ id: `acct-${i}`, alias, isDefault: i === 0 }),
    ),
    activeAccountId: aliases.length > 0 ? 'acct-0' : null,
    readyCount: aliases.length,
    poolCount: aliases.length,
    initialized: true,
    anthropicAccounts: [],
    anthropicActiveAccountId: null,
    anthropicReadyCount: 0,
    anthropicPoolCount: 0,
    anthropicInitialized: true,
    anthropicRouteAvailable: false,
  }
}

/**
 * A fake `spawn` that scripts the child's stdout + exit, mirroring the catalog
 * runner's harness. No real process (and no engine graph) is spawned.
 */
function fakeSpawn(script: {
  stdout?: string
  exitCode?: number
  signal?: NodeJS.Signals | null
  emitError?: Error
}): typeof spawn {
  return ((): unknown => {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null
      signalCode: NodeJS.Signals | null
      kill: (signal?: NodeJS.Signals) => boolean
      stdout: EventEmitter
      stderr: EventEmitter
      stdin: EventEmitter & { end: () => void }
    }
    child.exitCode = null
    child.signalCode = null
    child.kill = (signal?: NodeJS.Signals) => {
      child.signalCode = signal ?? 'SIGTERM'
      return true
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    const stdin = new EventEmitter() as EventEmitter & { end: () => void }
    stdin.end = () => {}
    child.stdin = stdin
    setTimeout(() => {
      if (script.emitError) {
        child.emit('error', script.emitError)
        return
      }
      if (script.stdout !== undefined) {
        child.stdout.emit('data', Buffer.from(script.stdout, 'utf8'))
      }
      child.exitCode = script.exitCode ?? 0
      child.emit('close', script.exitCode ?? 0, script.signal ?? null)
    }, 0)
    return child
  }) as unknown as typeof spawn
}

function ndjson(record: unknown): string {
  return `${JSON.stringify(record)}\n`
}

function usageStats(range: UsageStatsRange, totalTokens: number): UsageStatsSnapshot {
  return {
    range,
    totalTokens,
    dailyModelTokens: [
      { date: '2026-08-13', tokensByModel: { 'gpt-5.6-sol': totalTokens } },
    ],
    modelUsage: {
      'gpt-5.6-sol': {
        inputTokens: 400_000,
        outputTokens: 162_713,
        cacheCreationInputTokens: 12_000,
        cacheReadInputTokens: 900_000,
      },
    },
    dailyActivity: [
      { date: '2026-08-13', messageCount: 812, sessionCount: 9, toolCallCount: 240 },
    ],
    cacheHitRate: 68,
    cacheReadTokens: 900_000,
    cacheWriteTokens: 12_000,
    freshInputTokens: 400_000,
    totalSessions: 76,
    totalMessages: 33_482,
    activeDays: 4,
  }
}

describe('runAccountsPoolWorker — accept + deliver', () => {
  test('delivers the single pool record to onPool', async () => {
    const delivered: AccountsSnapshot[] = []
    const outcome = await runAccountsPoolWorker({
      command: 'bun',
      args: [],
      cwd: process.cwd(),
      spawnWorker: fakeSpawn({
        stdout: ndjson({
          type: 'pool',
          version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
          pool: pool(['work', 'personal']),
        }),
      }),
      onPool: snapshot => delivered.push(snapshot),
    })
    expect(outcome).toBe('delivered')
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.accounts.map(a => a.alias)).toEqual(['work', 'personal'])
  })

  test('an empty pool still delivers (no accounts is a real state to render)', async () => {
    const delivered: AccountsSnapshot[] = []
    const outcome = await runAccountsPoolWorker({
      command: 'bun',
      args: [],
      cwd: process.cwd(),
      spawnWorker: fakeSpawn({
        stdout: ndjson({
          type: 'pool',
          version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
          pool: pool([]),
        }),
      }),
      onPool: snapshot => delivered.push(snapshot),
    })
    expect(outcome).toBe('delivered')
    expect(delivered[0]!.accounts).toEqual([])
  })

  test('usageStats reaches onUsageStats when the record carries it', async () => {
    const stats: UsageStatsByRange = {
      '7d': usageStats('7d', 2_138_901),
      '30d': usageStats('30d', 4_421_134),
    }
    const pools: AccountsSnapshot[] = []
    const delivered: UsageStatsByRange[] = []
    const outcome = await runAccountsPoolWorker({
      command: 'bun',
      args: [],
      cwd: process.cwd(),
      spawnWorker: fakeSpawn({
        stdout: ndjson({
          type: 'pool',
          version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
          pool: pool(['work']),
          usageStats: stats,
        }),
      }),
      onPool: snapshot => pools.push(snapshot),
      onUsageStats: value => delivered.push(value),
    })
    expect(outcome).toBe('delivered')
    expect(pools).toHaveLength(1)
    expect(delivered).toEqual([stats])
  })

  test('a record without usageStats still delivers the pool and skips onUsageStats', async () => {
    // The stats read is best-effort; failing it must not cost the pool its
    // delivery, and must not publish a zeroed snapshot as the user's history.
    const pools: AccountsSnapshot[] = []
    let statsCalls = 0
    const outcome = await runAccountsPoolWorker({
      command: 'bun',
      args: [],
      cwd: process.cwd(),
      spawnWorker: fakeSpawn({
        stdout: ndjson({
          type: 'pool',
          version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
          pool: pool(['work']),
        }),
      }),
      onPool: snapshot => pools.push(snapshot),
      onUsageStats: () => {
        statsCalls += 1
      },
    })
    expect(outcome).toBe('delivered')
    expect(pools).toHaveLength(1)
    expect(statsCalls).toBe(0)
  })

  test('a malformed usageStats rejects the WHOLE record, pool included', async () => {
    await expect(
      runAccountsPoolWorker({
        command: 'bun',
        args: [],
        cwd: process.cwd(),
        spawnWorker: fakeSpawn({
          stdout: ndjson({
            type: 'pool',
            version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
            pool: pool(['work']),
            usageStats: { '7d': 'nope', '30d': 'nope' },
          }),
        }),
        onPool: () => {
          throw new Error('onPool must not run for a rejected record')
        },
      }),
    ).rejects.toThrow(/failed validation/)
  })

  test('a clean worker-reported failure resolves "failure" and never calls onPool (keeps last good)', async () => {
    let called = false
    const outcome = await runAccountsPoolWorker({
      command: 'bun',
      args: [],
      cwd: process.cwd(),
      spawnWorker: fakeSpawn({
        stdout: ndjson({
          type: 'failure',
          version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
          reason: 'internal',
        }),
      }),
      onPool: () => {
        called = true
      },
    })
    expect(outcome).toBe('failure')
    expect(called).toBe(false)
  })
})

describe('runAccountsPoolWorker — fail closed', () => {
  test('rejects on non-JSON stdout and never calls onPool', async () => {
    let called = false
    await expect(
      runAccountsPoolWorker({
        command: 'bun',
        args: [],
        cwd: process.cwd(),
        spawnWorker: fakeSpawn({ stdout: 'not json\n' }),
        onPool: () => {
          called = true
        },
      }),
    ).rejects.toThrow()
    expect(called).toBe(false)
  })

  test('rejects a schema-invalid record', async () => {
    await expect(
      runAccountsPoolWorker({
        command: 'bun',
        args: [],
        cwd: process.cwd(),
        spawnWorker: fakeSpawn({
          stdout: ndjson({ type: 'pool', version: 999, pool: pool([]) }),
        }),
        onPool: () => {},
      }),
    ).rejects.toThrow()
  })

  /**
   * The boundary must not let a credential reach main even if a compromised
   * child tries: the extra key fails the closed-vocabulary gate before
   * `secretGuard` is reached, and nothing is delivered either way.
   */
  test('rejects a record whose account row carries a token, delivering nothing', async () => {
    let called = false
    await expect(
      runAccountsPoolWorker({
        command: 'bun',
        args: [],
        cwd: process.cwd(),
        spawnWorker: fakeSpawn({
          stdout: ndjson({
            type: 'pool',
            version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
            pool: {
              ...pool(['work']),
              accounts: [{ ...account(), accessToken: 'sk-should-never-cross' }],
            },
          }),
        }),
        onPool: () => {
          called = true
        },
      }),
    ).rejects.toThrow()
    expect(called).toBe(false)
  })

  test('rejects when the worker emits more than one record', async () => {
    const one = {
      type: 'pool',
      version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
      pool: pool(['work']),
    }
    await expect(
      runAccountsPoolWorker({
        command: 'bun',
        args: [],
        cwd: process.cwd(),
        spawnWorker: fakeSpawn({ stdout: ndjson(one) + ndjson(one) }),
        onPool: () => {},
      }),
    ).rejects.toThrow()
  })

  test('rejects on a non-zero exit with no record', async () => {
    await expect(
      runAccountsPoolWorker({
        command: 'bun',
        args: [],
        cwd: process.cwd(),
        spawnWorker: fakeSpawn({ exitCode: 1 }),
        onPool: () => {},
      }),
    ).rejects.toThrow()
  })

  test('rejects when the child fails to spawn', async () => {
    await expect(
      runAccountsPoolWorker({
        command: 'bun',
        args: [],
        cwd: process.cwd(),
        spawnWorker: fakeSpawn({ emitError: new Error('ENOENT') }),
        onPool: () => {},
      }),
    ).rejects.toThrow()
  })
})

describe('createAccountsPoolDriver — single-flight + keeps-last-good', () => {
  test('single-flight: a tick while a run is in flight never starts a second worker', async () => {
    let runCount = 0
    let running = 0
    let maxConcurrent = 0
    let release: (() => void) | null = null
    const driver = createAccountsPoolDriver({
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
      setTimer: () => ({ unref() {} }) as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    })

    driver.start()
    await flush()
    expect(runCount).toBe(1)

    driver.start()
    driver.start()
    await flush()
    expect(runCount).toBe(1)
    expect(maxConcurrent).toBe(1)

    release!()
    await flush()
    driver.stop()
    expect(maxConcurrent).toBe(1)
  })

  test('keeps last good: a rejected run is swallowed and the driver reschedules', async () => {
    let runCount = 0
    const logged: string[] = []
    let scheduled = 0
    const driver = createAccountsPoolDriver({
      run: () => {
        runCount++
        return Promise.reject(new Error('worker blew up'))
      },
      intervalMs: 0,
      log: line => logged.push(line),
      setTimer: () => {
        scheduled++
        return { unref() {} } as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {},
    })

    driver.start()
    await flush()
    expect(runCount).toBe(1)
    expect(scheduled).toBe(1)
    expect(logged.some(line => line.includes('refresh failed'))).toBe(true)
    driver.stop()
  })

  test('fixed cadence: the next run is anchored to run START, not completion', async () => {
    const delays: number[] = []
    let clock = 0
    const runMs = 450
    const driver = createAccountsPoolDriver({
      run: async () => {
        clock += runMs
      },
      intervalMs: 60_000,
      now: () => clock,
      setTimer: (_cb, ms) => {
        delays.push(ms)
        return { unref() {} } as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {},
    })

    driver.start()
    await flush()
    // Anchored on start: 60_000 - 450. Anchoring on completion would schedule a
    // full 60_000 here, stretching the real period to interval + run duration.
    expect(delays).toEqual([60_000 - runMs])
    driver.stop()
  })

  test('stop() prevents any further scheduled run', async () => {
    let runCount = 0
    const driver = createAccountsPoolDriver({
      run: async () => {
        runCount++
      },
      intervalMs: 0,
      setTimer: () => ({ unref() {} }) as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    })
    driver.stop()
    driver.start()
    await flush()
    expect(runCount).toBe(0)
  })
})

describe('createAccountsPoolDriver — refreshNow', () => {
  test('runs immediately instead of waiting out the interval', async () => {
    let runCount = 0
    const driver = createAccountsPoolDriver({
      run: async () => {
        runCount++
      },
      intervalMs: 60_000,
      setTimer: () => ({ unref() {} }) as unknown as ReturnType<typeof setTimeout>,
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
    const driver = createAccountsPoolDriver({
      run: async () => {},
      intervalMs: 60_000,
      setTimer: () => {
        scheduled++
        return { unref() {} } as unknown as ReturnType<typeof setTimeout>
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
    const driver = createAccountsPoolDriver({
      run: () =>
        new Promise<void>(resolve => {
          runCount++
          release = resolve
        }),
      intervalMs: 60_000,
      setTimer: () => ({ unref() {} }) as unknown as ReturnType<typeof setTimeout>,
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
    // The invariant lives in `schedule()` now, not in `refreshNow`'s caller. Its
    // other entry point is a second `start()`, which before the move left the
    // first chain armed and permanently doubled the worker spawn rate.
    let cleared = 0
    let armed = 0
    const fire: Array<() => void> = []
    const driver = createAccountsPoolDriver({
      run: async () => {},
      intervalMs: 60_000,
      setTimer: cb => {
        armed++
        fire.push(cb)
        return { unref() {} } as unknown as ReturnType<typeof setTimeout>
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
    const driver = createAccountsPoolDriver({
      run: async () => {
        runCount++
      },
      intervalMs: 60_000,
      setTimer: () => ({ unref() {} }) as unknown as ReturnType<typeof setTimeout>,
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

describe('usage-stats cadence', () => {
  test('the FIRST run always carries them (cold launch must not wait)', () => {
    // The Accounts page exists to be readable with no session open. If run 0
    // skipped the analytics, a fresh launch would sit on "Loading" for five
    // minutes, which is the state this feed was added to remove.
    expect(runCarriesUsageStats(0)).toBe(true)
  })

  test('then every Nth run, and no others', () => {
    const carried = Array.from({ length: 12 }, (_, i) => i).filter(
      runCarriesUsageStats,
    )
    expect(carried).toEqual([0, 5, 10])
    expect(USAGE_STATS_EVERY_N_RUNS).toBe(5)
  })

  test('skipped runs still deliver the pool at the full interval', () => {
    // The cadence gate is about the transcript aggregation only. Every run is
    // still a pool run; the analytics just do not ride most of them.
    expect(runCarriesUsageStats(1)).toBe(false)
    expect(ACCOUNTS_POOL_REFRESH_INTERVAL_MS).toBe(60_000)
  })
})
