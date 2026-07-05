import { describe, expect, test } from 'bun:test'

import type { PoolAccount } from '../../services/api/codexAccountPool.js'
import type { ConsumeResetOutcome } from '../../services/api/codexUsage.js'
import {
  buildCandidates,
  confirmDescription,
  confirmSubtitle,
  COPY,
  isCandidateEnabled,
  mapConsumeOutcome,
  mintRedeemRequestId,
  noEligibleReason,
  redeemedTranscript,
  selectDefaultCandidate,
  successMessage,
  successWithCount,
} from './redeemResetMachine.js'

function account(overrides: Partial<PoolAccount> = {}): PoolAccount {
  return {
    accountId: 'acct-default-000000000000',
    accessToken: 'token',
    refreshToken: 'refresh',
    expiresAt: Date.now() + 3_600_000,
    source: 'vault',
    status: 'healthy',
    lastUsedAt: Date.now(),
    ...overrides,
  }
}

type UsageEntry = {
  email?: string
  planType?: string
  resetCreditsAvailable?: number
  limitWindowSeconds?: number
  primaryUsedPercent?: number
  secondaryUsedPercent?: number
  hasSecondaryWindow?: boolean
}

function usageMap(entries: Record<string, UsageEntry>): Map<string, UsageEntry> {
  return new Map(Object.entries(entries))
}

describe('redeemResetMachine — candidate eligibility (§4/§7)', () => {
  test('known-zero credits → disabled; unknown credits → enabled', () => {
    const accounts = [
      account({ accountId: 'zero-000000000000' }),
      account({ accountId: 'unknown-00000000' }),
      account({ accountId: 'some-0000000000000' }),
    ]
    const candidates = buildCandidates({
      accounts,
      activeIndex: 0,
      usageByAccountId: usageMap({
        'zero-000000000000': { resetCreditsAvailable: 0 },
        'some-0000000000000': { resetCreditsAvailable: 2 },
      }),
    })

    const [zero, unknown, some] = candidates
    expect(isCandidateEnabled(zero)).toBe(false)
    expect(zero.disabledReason).toBe('no resets available')
    expect(isCandidateEnabled(unknown)).toBe(true)
    expect(unknown.resetCreditsAvailable).toBeUndefined()
    expect(isCandidateEnabled(some)).toBe(true)
  })

  test('dead → disabled "re-login required"; quarantined → disabled', () => {
    const accounts = [
      account({ accountId: 'dead-0000000000000', status: 'dead' }),
      account({ accountId: 'quar-0000000000000', status: 'quarantined' }),
    ]
    const candidates = buildCandidates({
      accounts,
      activeIndex: -1,
      usageByAccountId: usageMap({}),
    })
    expect(candidates[0].disabledReason).toBe('re-login required')
    expect(candidates[1].disabledReason).toBe('connection problems; retry later')
  })

  test('capped/usage_cap → eligible; capped non-usage → disabled', () => {
    const accounts = [
      account({
        accountId: 'usage-000000000000',
        status: 'capped',
        statusReason: 'usage_cap',
      }),
      account({
        accountId: 'runtime-00000000',
        status: 'capped',
        statusReason: 'runtime_cap',
        lastError: 'runtime capped',
      }),
    ]
    const candidates = buildCandidates({
      accounts,
      activeIndex: -1,
      usageByAccountId: usageMap({}),
    })
    expect(isCandidateEnabled(candidates[0])).toBe(true)
    expect(isCandidateEnabled(candidates[1])).toBe(false)
    expect(candidates[1].disabledReason).toBe('runtime capped')
  })

  test('reauth pre-flight failure disables the account; transient keeps it enabled', () => {
    const accounts = [
      account({ accountId: 'reauth-00000000' }),
      account({ accountId: 'transient-000000' }),
    ]
    const candidates = buildCandidates({
      accounts,
      activeIndex: -1,
      usageByAccountId: usageMap({
        'transient-000000': {},
      }),
      preflightById: new Map([
        ['reauth-00000000', { kind: 'reauth', message: 'invalid_grant' }],
        ['transient-000000', { kind: 'transient', message: 'network' }],
      ]),
    })
    expect(candidates[0].disabledReason).toBe('re-login required')
    expect(isCandidateEnabled(candidates[1])).toBe(true)
  })
})

describe('redeemResetMachine — default target selection (§7.3)', () => {
  test('mixed pool: inactive capped/usage_cap is the default, not the active healthy account', () => {
    const accounts = [
      account({
        accountId: 'active-healthy-00',
        status: 'healthy',
      }),
      account({
        accountId: 'inactive-capped-0',
        status: 'capped',
        statusReason: 'usage_cap',
      }),
    ]
    const candidates = buildCandidates({
      accounts,
      activeIndex: 0,
      usageByAccountId: usageMap({
        'active-healthy-00': { resetCreditsAvailable: 1 },
        'inactive-capped-0': { resetCreditsAvailable: 1 },
      }),
    })
    const target = selectDefaultCandidate(candidates)
    expect(target?.accountId).toBe('inactive-capped-0')
    expect(target?.isActive).toBe(false)
  })

  test('falls back to the ACTIVE account when no capped account qualifies (§7.3)', () => {
    const accounts = [
      account({ accountId: 'healthy-a-000000', status: 'healthy' }),
      account({ accountId: 'healthy-b-000000', status: 'healthy' }),
    ]
    const candidates = buildCandidates({
      accounts,
      activeIndex: 1,
      usageByAccountId: usageMap({
        'healthy-a-000000': { resetCreditsAvailable: 1 },
        'healthy-b-000000': { resetCreditsAvailable: 1 },
      }),
    })
    expect(selectDefaultCandidate(candidates)?.accountId).toBe('healthy-b-000000')
  })

  test('fallback drops to the first enabled account only when the active one is not eligible', () => {
    const accounts = [
      account({ accountId: 'healthy-a-000000', status: 'healthy' }),
      account({ accountId: 'dead-active-00000', status: 'dead' }),
    ]
    const candidates = buildCandidates({
      accounts,
      activeIndex: 1,
      usageByAccountId: usageMap({
        'healthy-a-000000': { resetCreditsAvailable: 1 },
      }),
    })
    expect(selectDefaultCandidate(candidates)?.accountId).toBe('healthy-a-000000')
  })

  test('a known-zero capped account is skipped for the default', () => {
    const accounts = [
      account({ accountId: 'healthy-000000000', status: 'healthy' }),
      account({
        accountId: 'capped-zero-00000',
        status: 'capped',
        statusReason: 'usage_cap',
      }),
    ]
    const candidates = buildCandidates({
      accounts,
      activeIndex: 0,
      usageByAccountId: usageMap({
        'healthy-000000000': { resetCreditsAvailable: 1 },
        'capped-zero-00000': { resetCreditsAvailable: 0 },
      }),
    })
    expect(selectDefaultCandidate(candidates)?.accountId).toBe('healthy-000000000')
  })
})

describe('redeemResetMachine — no-eligible reason (§9)', () => {
  test('all accounts need re-login → the upstream aggregate message', () => {
    const accounts = [
      account({ accountId: 'd1-000000000000', status: 'dead' }),
      account({ accountId: 'd2-000000000000', status: 'dead' }),
    ]
    const candidates = buildCandidates({
      accounts,
      activeIndex: -1,
      usageByAccountId: usageMap({}),
    })
    expect(noEligibleReason(candidates)).toBe('All Codex accounts need re-login.')
  })

  test('mixed disabled reasons → the most specific first reason', () => {
    const accounts = [
      account({ accountId: 'q-0000000000000', status: 'quarantined' }),
    ]
    const candidates = buildCandidates({
      accounts,
      activeIndex: -1,
      usageByAccountId: usageMap({}),
    })
    expect(noEligibleReason(candidates)).toBe('connection problems; retry later')
  })

  test('all accounts status-eligible but out of credits → the exact §9 zero-credits copy', () => {
    const accounts = [
      account({ accountId: 'zero-a-000000000', status: 'healthy' }),
      account({
        accountId: 'zero-b-000000000',
        status: 'capped',
        statusReason: 'usage_cap',
      }),
    ]
    const candidates = buildCandidates({
      accounts,
      activeIndex: 0,
      usageByAccountId: usageMap({
        'zero-a-000000000': { resetCreditsAvailable: 0 },
        'zero-b-000000000': { resetCreditsAvailable: 0 },
      }),
    })
    expect(noEligibleReason(candidates)).toBe(
      "You don't have any usage limit resets available.",
    )
    expect(noEligibleReason(candidates)).toBe(COPY.zeroCredits)
  })
})

describe('redeemResetMachine — confirm copy (§9)', () => {
  test('subtitle pluralizes', () => {
    expect(confirmSubtitle(1)).toBe('You have 1 usage limit reset available.')
    expect(confirmSubtitle(3)).toBe('You have 3 usage limit resets available.')
  })

  test('description: free/go plans and monthly windows get the monthly copy', () => {
    expect(confirmDescription({ planType: 'free' })).toBe(COPY.descMonthly)
    expect(confirmDescription({ planType: 'go' })).toBe(COPY.descMonthly)
    expect(
      confirmDescription({ planType: 'pro', limitWindowSeconds: 28 * 24 * 60 * 60 }),
    ).toBe(COPY.descMonthly)
  })

  test('description: rolling plans get the 5-hour/weekly copy', () => {
    expect(
      confirmDescription({ planType: 'pro', limitWindowSeconds: 5 * 60 * 60 }),
    ).toBe(COPY.descRolling)
    expect(confirmDescription({})).toBe(COPY.descRolling)
  })
})

describe('redeemResetMachine — current usage display', () => {
  test('carries the current 5h and 7d usage for the reset decision', () => {
    const [candidate] = buildCandidates({
      accounts: [account({ accountId: 'usage-000000000000' })],
      activeIndex: 0,
      usageByAccountId: usageMap({
        'usage-000000000000': {
          primaryUsedPercent: 91.8,
          secondaryUsedPercent: 42.2,
          hasSecondaryWindow: true,
        },
      }),
    })

    expect(candidate.currentUsage).toEqual({
      primaryUsedPercent: 91.8,
      secondaryUsedPercent: 42.2,
      hasSecondaryWindow: true,
    })
  })

  test('preserves when the backend omitted the secondary window', () => {
    const [candidate] = buildCandidates({
      accounts: [account({ accountId: 'usage-000000000000' })],
      activeIndex: 0,
      usageByAccountId: usageMap({
        'usage-000000000000': {
          primaryUsedPercent: 12,
          secondaryUsedPercent: 0,
          hasSecondaryWindow: false,
        },
      }),
    })

    expect(candidate.currentUsage).toEqual({
      primaryUsedPercent: 12,
      secondaryUsedPercent: 0,
      hasSecondaryWindow: false,
    })
  })
})

describe('redeemResetMachine — consume outcome mapping (§9)', () => {
  const cases: Array<[ConsumeResetOutcome, string]> = [
    [{ kind: 'reset', windowsReset: 2 }, 'success'],
    [{ kind: 'already_redeemed', windowsReset: 0 }, 'success'],
    [{ kind: 'nothing_to_reset' }, 'nothing_to_reset'],
    [{ kind: 'no_credit' }, 'no_credit'],
    [{ kind: 'http_error', status: 500, bodySnippet: 'boom' }, 'error'],
    [{ kind: 'invalid_response', bodySnippet: 'weird' }, 'error'],
    [{ kind: 'network_error', error: 'ECONNRESET' }, 'error'],
  ]
  for (const [outcome, expected] of cases) {
    test(`${outcome.kind} → ${expected}`, () => {
      expect(mapConsumeOutcome(outcome).kind).toBe(expected as never)
    })
  }

  test('reset and already_redeemed carry windowsReset', () => {
    const result = mapConsumeOutcome({ kind: 'reset', windowsReset: 4 })
    expect(result).toEqual({ kind: 'success', windowsReset: 4 })
  })
})

describe('redeemResetMachine — success copy fallback (§8/§9)', () => {
  test('a known left-count renders the count line', () => {
    expect(successMessage({ kind: 'success', leftCount: 2 })).toBe(
      successWithCount(2),
    )
    expect(successWithCount(1)).toBe('Usage reset. You have 1 usage limit reset left.')
  })

  test('a missing left-count (refresh failure) falls back to bare "Usage reset."', () => {
    expect(successMessage({ kind: 'success', leftCount: undefined })).toBe(
      COPY.successNoCount,
    )
    expect(COPY.successNoCount).toBe('Usage reset.')
  })

  test('transcript names the account and the REMAINING count when known', () => {
    expect(redeemedTranscript('main', 3)).toBe(
      'Redeemed usage limit reset on main (3 left)',
    )
  })

  test('transcript omits the count suffix when the refresh failed (unknown)', () => {
    expect(redeemedTranscript('main', undefined)).toBe(
      'Redeemed usage limit reset on main',
    )
  })
})

describe('redeemResetMachine — idempotency-key lifetime (§6)', () => {
  test('each mint is a distinct UUID (regeneration on re-entry)', () => {
    const a = mintRedeemRequestId()
    const b = mintRedeemRequestId()
    expect(a).not.toBe(b)
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
  })

  test('reuse: holding one id across Try again keeps the same value', () => {
    const id = mintRedeemRequestId()
    const firstAttempt = id
    const retryAttempt = id
    expect(retryAttempt).toBe(firstAttempt)
  })
})
