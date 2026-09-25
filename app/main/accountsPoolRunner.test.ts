import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { spawn } from 'node:child_process'

import type {
  AccountStatus,
  AccountsSnapshot,
} from '../shared/protocol.js'
import {
  ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
  type AccountsPoolWorkerSignOutRequest,
  type AccountsPoolWorkerSignOutResult,
} from '../shared/accountsPoolWorker.js'
import {
  createAccountsPoolPublicationGate,
  runAccountsPoolWorker,
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

function deleteInput(
  accountId = 'acct-0',
  requestId = 'request-1',
  expectedCredentialGeneration = 4,
) {
  return {
    type: 'account-delete',
    version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
    verb: {
      type: 'account.delete',
      requestId,
      accountId,
      expectedCredentialGeneration,
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

function signOutInput(
  accountId = 'acct-0',
  requestId = 'request-logout',
  expectedCredentialGeneration = 4,
): AccountsPoolWorkerSignOutRequest {
  return {
    type: 'account-sign-out',
    version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
    verb: {
      type: 'account.logout',
      requestId,
      accountId,
      expectedCredentialGeneration,
    },
  }
}

function signOutResult(
  input = signOutInput(),
  outcome: AccountsPoolWorkerSignOutResult['receipt']['outcome'] = 'committed',
  overrides: Partial<AccountsPoolWorkerSignOutResult['receipt']> = {},
): AccountsPoolWorkerSignOutResult {
  const observed =
    outcome === 'superseded' || outcome === 'retryable_unknown'
      ? null
      : input.verb.expectedCredentialGeneration + 1
  const lifecycleState =
    outcome === 'superseded' || outcome === 'retryable_unknown'
      ? null
      : 'signed_out'
  return {
    type: 'account-sign-out',
    version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
    requestId: input.verb.requestId,
    verb: 'account.logout',
    receipt: {
      outcome,
      accountId: input.verb.accountId,
      expectedCredentialGeneration: input.verb.expectedCredentialGeneration,
      observedCredentialGeneration: observed,
      lifecycleState,
      operationId: input.verb.requestId,
      targetWasActive: false,
      replacementActiveAccountId: null,
      ...overrides,
    },
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

  test('writes one targeted sign-out request and delivers its receipt without a pool', async () => {
    const input = signOutInput()
    let stdin = ''
    const delivered: AccountsPoolWorkerSignOutResult[] = []
    const outcome = await runAccountsPoolWorker({
      command: 'bun',
      args: ['--account-sign-out'],
      cwd: process.cwd(),
      input,
      spawnWorker: fakeSpawn({
        onStdinEnd: data => {
          stdin = String(data)
        },
        stdout: ndjson(signOutResult(input)),
      }),
      onAccountSignOut: result => delivered.push(result),
    })

    expect(outcome).toBe('delivered')
    expect(JSON.parse(stdin)).toEqual(input)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.receipt.outcome).toBe('committed')
  })

  test('correlates and semantically validates every sign-out outcome', async () => {
    for (const outcome of [
      'committed',
      'already_committed',
      'superseded',
      'cleanup_pending',
      'retryable_unknown',
    ] as const) {
      const input = signOutInput()
      const delivered: AccountsPoolWorkerSignOutResult[] = []
      const result = signOutResult(input, outcome)
      await expect(
        runAccountsPoolWorker({
          command: 'bun',
          args: ['--account-sign-out'],
          cwd: process.cwd(),
          input,
          spawnWorker: fakeSpawn({ stdout: ndjson(result) }),
          onAccountSignOut: value => delivered.push(value),
        }),
      ).resolves.toBe('delivered')
      expect(delivered[0]?.receipt.outcome).toBe(outcome)
    }
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

  test('rejects sign-out correlation mismatches and inconsistent committed receipts', async () => {
    const input = signOutInput()
    const cases: Array<{ result: AccountsPoolWorkerSignOutResult; error: RegExp }> = [
      {
        result: { ...signOutResult(input), requestId: 'different-request' },
        error: /requestId mismatch/,
      },
      {
        result: {
          ...signOutResult(input),
          receipt: { ...signOutResult(input).receipt, accountId: 'other-account' },
        },
        error: /accountId mismatch/,
      },
      {
        result: {
          ...signOutResult(input),
          receipt: {
            ...signOutResult(input).receipt,
            expectedCredentialGeneration: 2,
          },
        },
        error: /generation mismatch/,
      },
      {
        result: {
          ...signOutResult(input),
          receipt: { ...signOutResult(input).receipt, operationId: 'other-op' },
        },
        error: /operationId mismatch/,
      },
      {
        result: {
          ...signOutResult(input),
          receipt: {
            ...signOutResult(input).receipt,
            observedCredentialGeneration: 4,
          },
        },
        error: /committed receipt is inconsistent/,
      },
      {
        result: {
          ...signOutResult(input),
          receipt: {
            ...signOutResult(input).receipt,
            targetWasActive: false,
            replacementActiveAccountId: 'replacement',
          },
        },
        error: /replacement is inconsistent/,
      },
    ]

    for (const item of cases) {
      let called = false
      await expect(
        runAccountsPoolWorker({
          command: 'bun',
          args: ['--account-sign-out'],
          cwd: process.cwd(),
          input,
          spawnWorker: fakeSpawn({ stdout: ndjson(item.result) }),
          onAccountSignOut: () => {
            called = true
          },
        }),
      ).rejects.toThrow(item.error)
      expect(called).toBe(false)
    }
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
