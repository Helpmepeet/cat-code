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
  createAccountsPoolPublicationGate,
  runAccountsPoolWorker,
  runCarriesUsageStats,
  USAGE_STATS_EVERY_N_RUNS,
} from './accountsPoolRunner.js'

function account(over: Partial<AccountStatus> = {}): AccountStatus {
  return {
    id: 'acct-1',
    credentialGeneration: 0,
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
    signedOutProfiles: [],
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
  onStdinEnd?: (data: unknown) => void
  autoClose?: boolean
  onKill?: (signal: NodeJS.Signals) => void
}): typeof spawn {
  return ((): unknown => {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null
      signalCode: NodeJS.Signals | null
      kill: (signal?: NodeJS.Signals) => boolean
      stdout: EventEmitter
      stderr: EventEmitter
      stdin: EventEmitter & { end: (data?: unknown) => void }
    }
    child.exitCode = null
    child.signalCode = null
    child.kill = (signal?: NodeJS.Signals) => {
      const sent = signal ?? 'SIGTERM'
      script.onKill?.(sent)
      child.signalCode = sent
      if (script.autoClose === false && sent === 'SIGKILL') {
        child.emit('close', null, sent)
      }
      return true
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    const stdin = new EventEmitter() as EventEmitter & {
      end: (data?: unknown) => void
    }
    stdin.end = data => {
      script.onStdinEnd?.(data)
    }
    child.stdin = stdin
    if (script.autoClose !== false) {
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
    }
    return child
  }) as unknown as typeof spawn
}

function ndjson(record: unknown): string {
  return `${JSON.stringify(record)}\n`
}

function deleteInput(accountId = 'acct-0', requestId = 'request-1') {
  return {
    type: 'account-delete',
    version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
    verb: {
      type: 'account.delete',
      requestId,
      accountId,
      confirm: true,
    },
  } as const
}

function deleteResult(
  overrides: Partial<{
    requestId: string
    ok: boolean
    accounts: string[]
  }> = {},
) {
  return {
    type: 'account-delete',
    version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
    requestId: overrides.requestId ?? 'request-1',
    verb: 'account.delete',
    ok: overrides.ok ?? true,
    message: 'Account deleted.',
    pool: pool(overrides.accounts ?? []),
  }
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

  test('writes one confirmed delete request to stdin and delivers its result', async () => {
    const input = deleteInput()
    let stdin = ''
    const delivered: string[] = []
    const outcome = await runAccountsPoolWorker({
      command: 'bun',
      args: ['--account-delete'],
      cwd: process.cwd(),
      input,
      spawnWorker: fakeSpawn({
        onStdinEnd: data => {
          stdin = String(data)
        },
        stdout: ndjson(deleteResult()),
      }),
      onAccountDelete: result => delivered.push(result.requestId),
    })

    expect(outcome).toBe('delivered')
    expect(JSON.parse(stdin)).toEqual(input)
    expect(delivered).toEqual(['request-1'])
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
    let called = false
    await expect(
      runAccountsPoolWorker({
        command: 'bun',
        args: [],
        cwd: process.cwd(),
        spawnWorker: fakeSpawn({ stdout: ndjson(one) + ndjson(one) }),
        onPool: () => {
          called = true
        },
      }),
    ).rejects.toThrow()
    expect(called).toBe(false)
  })

  test('rejects a mismatched delete result without delivering it', async () => {
    let called = false
    await expect(
      runAccountsPoolWorker({
        command: 'bun',
        args: ['--account-delete'],
        cwd: process.cwd(),
        input: deleteInput(),
        spawnWorker: fakeSpawn({
          stdout: ndjson(deleteResult({ requestId: 'different-request' })),
        }),
        onAccountDelete: () => {
          called = true
        },
      }),
    ).rejects.toThrow(/requestId mismatch/)
    expect(called).toBe(false)
  })

  test('rejects a successful delete result that still contains the target', async () => {
    let called = false
    await expect(
      runAccountsPoolWorker({
        command: 'bun',
        args: ['--account-delete'],
        cwd: process.cwd(),
        input: deleteInput(),
        spawnWorker: fakeSpawn({
          stdout: ndjson(deleteResult({ accounts: ['work'] })),
        }),
        onAccountDelete: () => {
          called = true
        },
      }),
    ).rejects.toThrow(/retained target/)
    expect(called).toBe(false)
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

  test('escalates a timed-out worker from SIGTERM to SIGKILL', async () => {
    const signals: NodeJS.Signals[] = []
    await expect(
      runAccountsPoolWorker({
        command: 'bun',
        args: [],
        cwd: process.cwd(),
        timeoutMs: 1,
        spawnWorker: fakeSpawn({
          autoClose: false,
          onKill: signal => signals.push(signal),
        }),
        onPool: () => {},
      }),
    ).rejects.toThrow(/timed out/)
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  }, 5_000)

  test('force-kills a destructive worker immediately when teardown aborts', async () => {
    const controller = new AbortController()
    const signals: NodeJS.Signals[] = []
    const run = runAccountsPoolWorker({
      command: 'bun',
      args: ['--account-delete'],
      cwd: process.cwd(),
      signal: controller.signal,
      forceKillOnAbort: true,
      input: deleteInput(),
      spawnWorker: fakeSpawn({
        autoClose: false,
        onKill: signal => signals.push(signal),
      }),
      onAccountDelete: () => {},
    })

    controller.abort()

    await expect(run).rejects.toThrow(/aborted/)
    expect(signals).toEqual(['SIGKILL'])
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

describe('accounts-pool publication gate', () => {
  test('a deletion invalidates any pool read that started before it', () => {
    const gate = createAccountsPoolPublicationGate()
    const staleRead = gate.beginRead()

    gate.invalidate()

    expect(gate.canPublish(staleRead)).toBe(false)
    expect(gate.canPublish(gate.beginRead())).toBe(true)
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
