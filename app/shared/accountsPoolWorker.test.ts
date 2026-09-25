import { describe, expect, test } from 'bun:test'

import type {
  AccountStatus,
  AccountsSnapshot,
  SignedOutCodexProfileStatus,
} from './protocol.js'
import {
  ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
  parseAccountDeleteMessage,
  parseAccountLogoutMessage,
  parseAccountsPoolWorkerDeleteRequest,
  parseAccountsPoolWorkerResult,
  parseAccountsPoolWorkerSignOutRequest,
  parseAccountSignOutReceipt,
  parseAccountsSnapshot,
} from './accountsPoolWorker.js'

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
    usagePrimaryWindowSeconds: 18_000,
    usageSecondaryWindowSeconds: 604_800,
    usageLimitReached: false,
    usageResetAt: 1_700_000_000,
    usageWeeklyResetAt: 1_700_200_000,
    lastRefreshIso: null,
    lastError: null,
    planType: 'plus',
    switchable: false,
    ...over,
  }
}

function signedOutProfile(
  over: Partial<SignedOutCodexProfileStatus> = {},
): SignedOutCodexProfileStatus {
  return {
    id: 'acct-signed-out',
    alias: 'former-work',
    state: 'signed_out',
    credentialGeneration: 4,
    lifecycleGeneration: 4,
    credentialGenerationState: 'lifecycle_bound',
    lifecycleState: 'signed_out',
    lifecycleReadStatus: 'valid',
    ...over,
  }
}

function pool(over: Partial<AccountsSnapshot> = {}): AccountsSnapshot {
  return {
    accounts: [account()],
    signedOutProfiles: [],
    activeAccountId: 'acct-1',
    readyCount: 1,
    poolCount: 1,
    initialized: true,
    anthropicAccounts: [
      {
        id: 'anth-1',
        alias: null,
        email: 'person@example.com',
        status: 'healthy',
        isDefault: true,
        hasVaultProfile: true,
        subscriptionType: 'max',
      },
    ],
    anthropicActiveAccountId: 'anth-1',
    anthropicReadyCount: 1,
    anthropicPoolCount: 1,
    anthropicInitialized: true,
    anthropicRouteAvailable: true,
    ...over,
  }
}

function record(snapshot: AccountsSnapshot): unknown {
  return {
    type: 'pool',
    version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
    pool: snapshot,
  }
}

describe('parseAccountsPoolWorkerResult — accepts', () => {
  test('a well-formed pool record round-trips field-for-field', () => {
    const snapshot = pool()
    const parsed = parseAccountsPoolWorkerResult(
      JSON.parse(JSON.stringify(record(snapshot))),
    )
    expect(parsed).not.toBeNull()
    expect(parsed?.type).toBe('pool')
    if (parsed?.type !== 'pool') throw new Error('expected a pool result')
    expect(parsed.pool).toEqual(snapshot)
  })

  test('the optional anthropicSubscriptionActive is preserved when present', () => {
    const snapshot = pool({ anthropicSubscriptionActive: true })
    const parsed = parseAccountsSnapshot(JSON.parse(JSON.stringify(snapshot)))
    expect(parsed?.anthropicSubscriptionActive).toBe(true)
  })

  test('an absent anthropicSubscriptionActive stays absent, not defaulted', () => {
    const parsed = parseAccountsSnapshot(JSON.parse(JSON.stringify(pool())))
    expect(parsed).not.toBeNull()
    expect('anthropicSubscriptionActive' in (parsed ?? {})).toBe(false)
  })

  test('accepts a weekly reset while rejecting an invalid value', () => {
    expect(parseAccountsSnapshot(pool())?.accounts[0]?.usageWeeklyResetAt).toBe(
      1_700_200_000,
    )
    expect(
      parseAccountsSnapshot(pool({
        accounts: [account({ usageWeeklyResetAt: 'tomorrow' as never })],
      })),
    ).toBeNull()
  })

  test('preserves usage-window durations and accepts omitted or null metadata', () => {
    expect(parseAccountsSnapshot(pool())?.accounts[0]).toMatchObject({
      usagePrimaryWindowSeconds: 18_000,
      usageSecondaryWindowSeconds: 604_800,
    })
    expect(parseAccountsSnapshot(pool({
      accounts: [account({
        usagePrimaryWindowSeconds: null,
        usageSecondaryWindowSeconds: null,
      })],
    }))).not.toBeNull()
    const omitted = { ...account() } as Record<string, unknown>
    delete omitted.usagePrimaryWindowSeconds
    delete omitted.usageSecondaryWindowSeconds
    expect(parseAccountsSnapshot(pool({ accounts: [omitted as never] }))).not.toBeNull()
  })

  test('an empty pool is valid (no accounts is a real state, not a failure)', () => {
    const parsed = parseAccountsSnapshot(
      pool({
        accounts: [],
        anthropicAccounts: [],
        activeAccountId: null,
        anthropicActiveAccountId: null,
        readyCount: 0,
        poolCount: 0,
        anthropicReadyCount: 0,
        anthropicPoolCount: 0,
      }),
    )
    expect(parsed?.accounts).toEqual([])
  })

  test('accepts signed-out profiles outside credentialed rows and counts', () => {
    const snapshot = pool({
      accounts: [account({ credentialGeneration: 7 })],
      signedOutProfiles: [signedOutProfile()],
      readyCount: 1,
      poolCount: 1,
    })
    const parsed = parseAccountsSnapshot(JSON.parse(JSON.stringify(snapshot)))
    expect(parsed).toEqual(snapshot)
    expect(parsed?.accounts).toHaveLength(1)
    expect(parsed?.signedOutProfiles).toHaveLength(1)
    expect(parsed?.readyCount).toBe(1)
    expect(parsed?.poolCount).toBe(1)
  })

  test('a worker-reported failure parses as a failure', () => {
    const parsed = parseAccountsPoolWorkerResult({
      type: 'failure',
      version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
      reason: 'internal',
    })
    expect(parsed?.type).toBe('failure')
  })
})

describe('session-independent account deletion boundary', () => {
  const verb = {
    type: 'account.delete',
    requestId: 'request-1',
    accountId: 'account-1',
    expectedCredentialGeneration: 4,
    confirm: true,
  } as const

  test('accepts only the explicit confirmed delete verb', () => {
    expect(parseAccountDeleteMessage(verb)).toEqual(verb)
    expect(parseAccountDeleteMessage({ ...verb, confirm: false })).toBeNull()
    expect(parseAccountDeleteMessage({ ...verb, extra: true })).toBeNull()
    expect(parseAccountDeleteMessage({ ...verb, accountId: '' })).toBeNull()
    expect(
      parseAccountDeleteMessage({
        ...verb,
        expectedCredentialGeneration: -1,
      }),
    ).toBeNull()
    const { expectedCredentialGeneration: _generation, ...withoutGeneration } =
      verb
    expect(parseAccountDeleteMessage(withoutGeneration)).toBeNull()
  })

  test('round-trips the closed stdin request and redacted worker result', () => {
    expect(
      parseAccountsPoolWorkerDeleteRequest({
        type: 'account-delete',
        version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
        verb,
      }),
    ).toEqual({
      type: 'account-delete',
      version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
      verb,
    })

    expect(
      parseAccountsPoolWorkerResult({
        type: 'account-delete',
        version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
        requestId: verb.requestId,
        verb: 'account.delete',
        ok: true,
        message: 'Account deleted.',
        pool: pool({ accounts: [], activeAccountId: null, readyCount: 0, poolCount: 0 }),
      }),
    ).toMatchObject({
      type: 'account-delete',
      requestId: verb.requestId,
      ok: true,
    })
  })

  test('rejects malformed or secret-bearing delete results', () => {
    const result = {
      type: 'account-delete',
      version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
      requestId: verb.requestId,
      verb: 'account.delete',
      ok: true,
      message: 'Account deleted.',
      pool: pool(),
    }
    expect(parseAccountsPoolWorkerResult({ ...result, extra: true })).toBeNull()
    expect(
      parseAccountsPoolWorkerResult({
        ...result,
        pool: {
          ...pool(),
          accounts: [{ ...account(), accessToken: 'must-not-cross' }],
        },
      }),
    ).toBeNull()
  })
})

describe('session-independent targeted account sign-out boundary', () => {
  const verb = {
    type: 'account.logout',
    requestId: 'request-logout',
    accountId: 'account-1',
    expectedCredentialGeneration: 7,
  } as const
  const receipt = {
    outcome: 'committed',
    accountId: 'account-1',
    expectedCredentialGeneration: 7,
    observedCredentialGeneration: 8,
    lifecycleState: 'signed_out',
    operationId: 'request-logout',
    targetWasActive: true,
    replacementActiveAccountId: 'account-2',
  } as const

  test('accepts the exact targeted input and receipt', () => {
    expect(parseAccountLogoutMessage(verb)).toEqual(verb)
    expect(
      parseAccountsPoolWorkerSignOutRequest({
        type: 'account-sign-out',
        version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
        verb,
      }),
    ).toEqual({
      type: 'account-sign-out',
      version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
      verb,
    })
    expect(parseAccountSignOutReceipt(receipt)).toEqual(receipt)
    expect(
      parseAccountsPoolWorkerResult({
        type: 'account-sign-out',
        version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
        requestId: verb.requestId,
        verb: 'account.logout',
        receipt,
      }),
    ).toEqual({
      type: 'account-sign-out',
      version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
      requestId: verb.requestId,
      verb: 'account.logout',
      receipt,
    })
  })

  test('rejects missing, negative, fractional, extra, and secret fields', () => {
    expect(parseAccountLogoutMessage({ ...verb, accountId: undefined })).toBeNull()
    expect(
      parseAccountLogoutMessage({ ...verb, expectedCredentialGeneration: -1 }),
    ).toBeNull()
    expect(
      parseAccountLogoutMessage({
        ...verb,
        expectedCredentialGeneration: 1.5,
      }),
    ).toBeNull()
    expect(parseAccountLogoutMessage({ ...verb, extra: true })).toBeNull()
    expect(
      parseAccountLogoutMessage({ ...verb, accessToken: 'secret' }),
    ).toBeNull()

    expect(parseAccountSignOutReceipt({ ...receipt, extra: true })).toBeNull()
    expect(
      parseAccountSignOutReceipt({
        ...receipt,
        refreshToken: 'secret',
      }),
    ).toBeNull()
    expect(
      parseAccountsPoolWorkerResult({
        type: 'account-sign-out',
        version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
        requestId: verb.requestId,
        verb: 'account.logout',
        receipt: { ...receipt, observedCredentialGeneration: -1 },
      }),
    ).toBeNull()
  })

  test('accepts every controlled outcome shape without a pool snapshot', () => {
    for (const outcome of [
      'committed',
      'already_committed',
      'superseded',
      'cleanup_pending',
      'retryable_unknown',
    ] as const) {
      const parsed = parseAccountsPoolWorkerResult({
        type: 'account-sign-out',
        version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
        requestId: verb.requestId,
        verb: 'account.logout',
        receipt: {
          ...receipt,
          outcome,
          observedCredentialGeneration:
            outcome === 'superseded' || outcome === 'retryable_unknown'
              ? null
              : receipt.observedCredentialGeneration,
          lifecycleState:
            outcome === 'superseded' || outcome === 'retryable_unknown'
              ? null
              : receipt.lifecycleState,
          targetWasActive: false,
          replacementActiveAccountId: null,
        },
      })
      expect(parsed?.type).toBe('account-sign-out')
    }
  })
})

describe('parseAccountsPoolWorkerResult — fails closed', () => {
  test('a wrong boundary version is rejected', () => {
    expect(
      parseAccountsPoolWorkerResult({ ...(record(pool()) as object), version: 2 }),
    ).toBeNull()
  })

  test('an unknown discriminant is rejected', () => {
    expect(
      parseAccountsPoolWorkerResult({ ...(record(pool()) as object), type: 'other' }),
    ).toBeNull()
  })

  test('an extra top-level key is rejected', () => {
    expect(
      parseAccountsPoolWorkerResult({ ...(record(pool()) as object), extra: 1 }),
    ).toBeNull()
  })

  /**
   * The closed-vocabulary gate is what makes a credential structurally
   * unrepresentable on this boundary: a token key cannot ride along even before
   * `secretGuard` runs. This is the projection-omits + guard-would-block pair the
   * accounts seam states, asserted at the parse end.
   */
  test('an account row carrying a token key is rejected outright', () => {
    const snapshot = pool()
    const smuggled = {
      ...snapshot,
      accounts: [{ ...account(), accessToken: 'sk-should-never-cross' }],
    }
    expect(parseAccountsSnapshot(smuggled)).toBeNull()
  })

  test('a missing account field fails the WHOLE snapshot, not just the row', () => {
    const partial = { ...account() } as Record<string, unknown>
    delete partial.switchable
    expect(parseAccountsSnapshot(pool({ accounts: [partial as never] }))).toBeNull()
  })

  test('rejects malformed credential and signed-out profile generations', () => {
    expect(
      parseAccountsSnapshot(
        pool({
          accounts: [account({ credentialGeneration: -1 as never })],
        }),
      ),
    ).toBeNull()
    expect(
      parseAccountsSnapshot(
        pool({
          signedOutProfiles: [
            signedOutProfile({ lifecycleGeneration: 1.5 as never }),
          ],
        }),
      ),
    ).toBeNull()
    expect(
      parseAccountsSnapshot(
        pool({
          signedOutProfiles: [
            signedOutProfile({ credentialGeneration: '4' as never }),
          ],
        }),
      ),
    ).toBeNull()
  })

  test('rejects an extra signed-out profile path or secret key', () => {
    expect(
      parseAccountsSnapshot(
        pool({
          signedOutProfiles: [
            { ...signedOutProfile(), vaultFilePath: '/secret/profile.json' } as never,
          ],
        }),
      ),
    ).toBeNull()
    expect(
      parseAccountsSnapshot(
        pool({
          signedOutProfiles: [
            { ...signedOutProfile(), accessToken: 'must-not-cross' } as never,
          ],
        }),
      ),
    ).toBeNull()
  })

  test('an out-of-vocabulary status is rejected', () => {
    expect(
      parseAccountsSnapshot(
        pool({ accounts: [account({ status: 'sleepy' as never })] }),
      ),
    ).toBeNull()
  })

  test('an out-of-vocabulary availability is rejected', () => {
    expect(
      parseAccountsSnapshot(
        pool({ accounts: [account({ availability: 'maybe' as never })] }),
      ),
    ).toBeNull()
  })

  test('a string where a number belongs is rejected', () => {
    expect(
      parseAccountsSnapshot(
        pool({ accounts: [account({ usagePrimary: '42' as never })] }),
      ),
    ).toBeNull()
  })

  test('a present-but-wrong-typed optional flag is rejected', () => {
    expect(
      parseAccountsSnapshot(
        pool({ anthropicSubscriptionActive: 'yes' as never }),
      ),
    ).toBeNull()
  })

  test('rejects malformed usage-window durations', () => {
    for (const field of [
      'usagePrimaryWindowSeconds',
      'usageSecondaryWindowSeconds',
    ] as const) {
      for (const duration of ['18000', -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(
          parseAccountsSnapshot(pool({
            accounts: [account({ [field]: duration as never })],
          })),
        ).toBeNull()
      }
    }
  })

  test('a malformed Anthropic row fails the whole snapshot', () => {
    expect(
      parseAccountsSnapshot(
        pool({ anthropicAccounts: [{ id: 'anth-1' } as never] }),
      ),
    ).toBeNull()
  })

  test('non-record input is rejected', () => {
    expect(parseAccountsPoolWorkerResult(null)).toBeNull()
    expect(parseAccountsPoolWorkerResult('pool')).toBeNull()
    expect(parseAccountsPoolWorkerResult([])).toBeNull()
  })
})
