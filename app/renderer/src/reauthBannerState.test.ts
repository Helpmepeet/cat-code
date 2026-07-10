import { describe, expect, test } from 'bun:test'
import type { AccountStatus, AccountsSnapshot } from '../../shared/protocol.js'
import {
  REAUTH_ACTION_KEY,
  selectAuthSubmitBlocked,
  selectDeadAccounts,
  selectReauthBanners,
} from './reauthBannerState.js'

function account(overrides: Partial<AccountStatus> = {}): AccountStatus {
  return {
    id: 'acct-1',
    alias: 'work',
    status: 'healthy',
    statusReason: null,
    availability: 'available',
    availabilityLabel: 'Available',
    isDefault: false,
    hasVaultProfile: true,
    source: 'vault',
    usagePrimary: 10,
    usageWeekly: 20,
    usageLimitReached: false,
    usageResetAt: null,
    lastRefreshIso: null,
    lastError: null,
    planType: null,
    switchable: true,
    ...overrides,
  }
}

function snapshot(
  accounts: AccountStatus[],
  overrides: Partial<AccountsSnapshot> = {},
): AccountsSnapshot {
  const readyCount = accounts.filter(
    a => a.status === 'healthy' && !a.usageLimitReached,
  ).length
  return {
    accounts,
    activeAccountId: accounts.find(a => a.isDefault)?.id ?? null,
    readyCount,
    poolCount: accounts.length,
    initialized: true,
    ...overrides,
  }
}

describe('selectDeadAccounts', () => {
  test('returns only dead accounts (capped/quarantined excluded)', () => {
    const dead = account({ id: 'd', status: 'dead', statusReason: 'auth_dead' })
    const snap = snapshot([
      account({ id: 'h', isDefault: true }),
      account({ id: 'c', status: 'capped' }),
      account({ id: 'q', status: 'quarantined' }),
      dead,
    ])
    expect(selectDeadAccounts(snap).map(a => a.id)).toEqual(['d'])
  })

  test('null snapshot → no dead accounts', () => {
    expect(selectDeadAccounts(null)).toEqual([])
  })
})

describe('selectAuthSubmitBlocked (zero-healthy-blocks-submit threshold)', () => {
  test('one dead among healthy → NOT blocked (failover)', () => {
    const snap = snapshot([
      account({ id: 'h', isDefault: true }),
      account({ id: 'd', status: 'dead', statusReason: 'auth_dead' }),
    ])
    expect(selectAuthSubmitBlocked(snap)).toBe(false)
  })

  test('all accounts dead → blocked', () => {
    const snap = snapshot([
      account({ id: 'd1', status: 'dead', statusReason: 'auth_dead' }),
      account({ id: 'd2', status: 'dead', statusReason: 'auth_dead' }),
    ])
    expect(selectAuthSubmitBlocked(snap)).toBe(true)
  })

  test('capped-but-not-dead pool with zero ready → blocked (no healthy remains)', () => {
    const snap = snapshot([account({ id: 'c', status: 'capped' })])
    expect(selectAuthSubmitBlocked(snap)).toBe(true)
  })

  test('empty / uninitialized pool → NOT blocked (that is first-run, not reauth)', () => {
    expect(selectAuthSubmitBlocked(snapshot([]))).toBe(false)
    expect(
      selectAuthSubmitBlocked(snapshot([], { initialized: false })),
    ).toBe(false)
    expect(selectAuthSubmitBlocked(null)).toBe(false)
  })
})

describe('selectReauthBanners', () => {
  test('no dead accounts → no banners', () => {
    expect(selectReauthBanners(snapshot([account({ isDefault: true })]))).toEqual([])
  })

  test('dead account → non-dismissable danger banner with reauth action + real reason', () => {
    const snap = snapshot([
      account({ id: 'h', isDefault: true }),
      account({
        id: 'd',
        alias: 'personal',
        status: 'dead',
        statusReason: 'auth_dead',
        lastError: 'invalid_grant',
      }),
    ])
    const banners = selectReauthBanners(snap)
    expect(banners).toHaveLength(1)
    const [b] = banners
    expect(b.id).toBe('reauth:d')
    expect(b.tone).toBe('danger')
    expect(b.dismissable).toBe(false)
    expect(b.detail).toContain('personal')
    expect(b.detail).toContain('invalid_grant')
    expect(b.actions?.[0]?.key).toBe(REAUTH_ACTION_KEY)
    expect(b.actions?.[0]?.primary).toBe(true)
    // Not blocked (a healthy account remains) → title is the soft form.
    expect(b.title).toContain('needs re-authentication')
  })

  test('reason falls back to statusReason when lastError absent', () => {
    const snap = snapshot([
      account({ id: 'd', alias: null, status: 'dead', statusReason: 'auth_dead', lastError: null }),
    ])
    const [b] = selectReauthBanners(snap)
    // alias null → id used as label; statusReason underscores normalized.
    expect(b.detail).toContain('d')
    expect(b.detail).toContain('auth dead')
  })

  test('zero-healthy → banner title/detail says submit is blocked', () => {
    const snap = snapshot([
      account({ id: 'd', alias: 'only', status: 'dead', statusReason: 'auth_dead' }),
    ])
    const [b] = selectReauthBanners(snap)
    expect(b.title).toContain('Sign in again')
    expect(b.detail).toContain('blocked')
  })

  test('multiple dead accounts → one banner each, stable ids', () => {
    const snap = snapshot([
      account({ id: 'h', isDefault: true }),
      account({ id: 'd1', status: 'dead', statusReason: 'auth_dead' }),
      account({ id: 'd2', status: 'dead', statusReason: 'auth_dead' }),
    ])
    expect(selectReauthBanners(snap).map(b => b.id)).toEqual([
      'reauth:d1',
      'reauth:d2',
    ])
  })
})
