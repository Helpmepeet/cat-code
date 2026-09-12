import { describe, expect, test } from 'bun:test'
import type { AccountsSnapshot, AccountStatus } from '../../shared/protocol.js'
import {
  ACCOUNT_HEALTH_ACTION_KEY,
  ACCOUNT_HEALTH_CAPACITY_ID,
  ACCOUNT_HEALTH_SIGNIN_ID,
  selectAccountHealthBanner,
} from './accountHealthBanner.js'

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)

function account(overrides: Partial<AccountStatus> = {}): AccountStatus {
  return {
    id: 'acct-1',
    credentialGeneration: 0,
    alias: 'one',
    status: 'healthy',
    statusReason: null,
    availability: 'available',
    availabilityLabel: 'Ready',
    isDefault: false,
    hasVaultProfile: true,
    source: 'vault',
    usagePrimary: null,
    usageWeekly: null,
    usageLimitReached: false,
    usageResetAt: null,
    lastRefreshIso: null,
    lastError: null,
    planType: null,
    switchable: true,
    ...overrides,
  }
}

function snapshot(accounts: AccountStatus[]): AccountsSnapshot {
  return {
    accounts,
    signedOutProfiles: [],
    activeAccountId: accounts[0]?.id ?? null,
    readyCount: accounts.filter(
      a => a.status === 'healthy' && !a.usageLimitReached,
    ).length,
    poolCount: accounts.length,
    initialized: true,
    anthropicAccounts: [],
    anthropicActiveAccountId: null,
    anthropicReadyCount: 0,
    anthropicPoolCount: 0,
    anthropicInitialized: true,
    anthropicRouteAvailable: false,
  }
}

const capped = (id: string, usageResetAt: number | null = null) =>
  account({
    id,
    status: 'capped',
    statusReason: 'usage_cap',
    availability: 'blocked',
    availabilityLabel: 'Usage limit reached',
    usageLimitReached: true,
    usageResetAt,
    switchable: false,
  })

const dead = (id: string) =>
  account({
    id,
    status: 'dead',
    statusReason: 'auth_dead',
    availability: 'blocked',
    availabilityLabel: 'Needs re-login',
    switchable: false,
  })

describe('nothing worth interrupting for', () => {
  test('no snapshot yields no banner', () => {
    expect(selectAccountHealthBanner(null, NOW)).toBeNull()
  })

  test('an uninitialized pool yields no banner', () => {
    const state = { ...snapshot([capped('a')]), initialized: false }
    expect(selectAccountHealthBanner(state, NOW)).toBeNull()
  })

  test('an empty pool yields no banner (setup is not a degradation)', () => {
    expect(selectAccountHealthBanner(snapshot([]), NOW)).toBeNull()
  })

  test('a healthy pool yields no banner', () => {
    expect(
      selectAccountHealthBanner(snapshot([account(), account({ id: 'b' })]), NOW),
    ).toBeNull()
  })

  // The pool fails over on its own while ONE account can still serve a request,
  // so a capped account beside an available one is not the user's problem.
  test('one blocked account beside an available one yields no banner', () => {
    expect(
      selectAccountHealthBanner(snapshot([capped('a'), account({ id: 'b' })]), NOW),
    ).toBeNull()
  })

  test('a warned account still counts as usable', () => {
    const warned = account({ id: 'b', availability: 'warned' })
    expect(selectAccountHealthBanner(snapshot([capped('a'), warned]), NOW)).toBeNull()
  })
})

describe('every account blocked', () => {
  // Mirrors `emitCodexUnavailableDiagnostic` (src/services/api/client.ts): a
  // fully capped pool is the wait-for-reset case, anything else needs repair.
  test('a fully capped pool reads as a usage limit, with the earliest reset', () => {
    const banner = selectAccountHealthBanner(
      snapshot([
        capped('a', Math.floor(NOW / 1000) + 3 * 3600),
        capped('b', Math.floor(NOW / 1000) + 45 * 60),
      ]),
      NOW,
    )
    expect(banner?.id).toBe(ACCOUNT_HEALTH_CAPACITY_ID)
    expect(banner?.tone).toBe('warn')
    expect(banner?.title).toBe('Codex usage limit reached')
    expect(banner?.detail).toBe(
      'Sending will keep failing until an account resets. The first one is back in 45m.',
    )
  })

  test('a fully capped pool with no known reset drops the reset sentence', () => {
    const banner = selectAccountHealthBanner(snapshot([capped('a'), capped('b')]), NOW)
    expect(banner?.id).toBe(ACCOUNT_HEALTH_CAPACITY_ID)
    expect(banner?.detail).toBe('Sending will keep failing until an account resets.')
  })

  // 0 is the engine's "unknown" sentinel for usageResetAt, not a reset in 1970.
  test('the zero reset sentinel is not formatted as a time', () => {
    const banner = selectAccountHealthBanner(snapshot([capped('a', 0)]), NOW)
    expect(banner?.detail).toBe('Sending will keep failing until an account resets.')
  })

  test('a mixed capped-and-dead pool needs repair, not a wait', () => {
    const banner = selectAccountHealthBanner(
      snapshot([capped('a', Math.floor(NOW / 1000) + 600), dead('b')]),
      NOW,
    )
    expect(banner?.id).toBe(ACCOUNT_HEALTH_SIGNIN_ID)
    expect(banner?.tone).toBe('danger')
    expect(banner?.title).toBe('No Codex account is ready to use')
    expect(banner?.detail).toBe(
      'Sending will keep failing until an account recovers.',
    )
  })

  test('an all-dead pool needs repair', () => {
    expect(selectAccountHealthBanner(snapshot([dead('a'), dead('b')]), NOW)?.id).toBe(
      ACCOUNT_HEALTH_SIGNIN_ID,
    )
  })

  test('an all-quarantined pool needs repair', () => {
    const stuck = account({
      status: 'quarantined',
      availability: 'blocked',
      availabilityLabel: 'Connection issue (retrying)',
      switchable: false,
    })
    expect(selectAccountHealthBanner(snapshot([stuck]), NOW)?.id).toBe(
      ACCOUNT_HEALTH_SIGNIN_ID,
    )
  })
})

describe('the ruling constraints, pinned', () => {
  const variants = [
    selectAccountHealthBanner(snapshot([capped('a'), capped('b')]), NOW),
    selectAccountHealthBanner(snapshot([dead('a')]), NOW),
  ]

  test('both variants are always dismissable', () => {
    for (const banner of variants) expect(banner?.dismissable).toBe(true)
  })

  // Dismissing the self-healing variant must not suppress the one that needs the
  // user, because App keys the dismissal on this id.
  test('the two variants carry different ids', () => {
    expect(variants[0]?.id).not.toBe(variants[1]?.id)
  })

  // A banner action needs a session to run an account verb, and this bar is
  // session-free, so its single action navigates instead of acting.
  test('each variant offers exactly one action, and it navigates', () => {
    for (const banner of variants) {
      expect(banner?.actions).toHaveLength(1)
      expect(banner?.actions?.[0]?.key).toBe(ACCOUNT_HEALTH_ACTION_KEY)
      expect(banner?.actions?.[0]?.label).toBe('Open Accounts')
      expect(banner?.actions?.[0]?.primary).toBeUndefined()
    }
  })

  // CLAUDE.md §7: no em dash, and no engine discriminant printed at the user.
  test('no copy carries an em dash or a status word', () => {
    for (const banner of variants) {
      const copy = [
        banner?.title,
        banner?.detail,
        ...(banner?.actions ?? []).map(a => a.label),
      ].join(' ')
      expect(copy).not.toContain('—')
      for (const word of [
        'capped',
        'blocked',
        'dead',
        'quarantined',
        'healthy',
        'availability',
        'pool',
      ]) {
        expect(copy.toLowerCase()).not.toContain(word)
      }
    }
  })
})
