import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { spawn } from 'node:child_process'

import type { AccountStatus, AccountsSnapshot } from '../shared/protocol.js'
import { ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION } from '../shared/accountsPoolWorker.js'
import {
  createAccountsPoolDriver,
  runAccountsPoolWorker,
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
