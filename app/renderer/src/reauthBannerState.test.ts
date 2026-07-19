import { describe, expect, test } from 'bun:test'
import type { AccountStatus, AccountsSnapshot } from '../../shared/protocol.js'
import {
  REAUTH_ACTION_KEY,
  REAUTH_WALL_PREFIX,
  selectAuthSubmitBlocked,
  selectDeadAccounts,
  selectReauthBanners,
  selectReauthWall,
  selectVisibleReauthBanners,
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

  test('zero-ready mix of dead + capped → blocked (a death caused the wall)', () => {
    const snap = snapshot([
      account({ id: 'd', status: 'dead', statusReason: 'auth_dead' }),
      account({ id: 'c', status: 'capped' }),
    ])
    expect(selectAuthSubmitBlocked(snap)).toBe(true)
  })

  test('capped/quarantined-only pool with zero ready → NOT blocked (falls through to the engine quota error, not a silent block)', () => {
    expect(selectAuthSubmitBlocked(snapshot([account({ id: 'c', status: 'capped' })]))).toBe(false)
    expect(
      selectAuthSubmitBlocked(
        snapshot([
          account({ id: 'c', status: 'capped' }),
          account({ id: 'q', status: 'quarantined' }),
        ]),
      ),
    ).toBe(false)
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

  test('dead account among healthy → DISMISSABLE danger banner with reauth action + real reason', () => {
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
    // Non-blocking (a healthy account remains) → dismissable (pool fails over).
    expect(b.dismissable).toBe(true)
    expect(b.detail).toContain('personal')
    expect(b.detail).toContain('invalid_grant')
    expect(b.actions?.[0]?.key).toBe(REAUTH_ACTION_KEY)
    expect(b.actions?.[0]?.primary).toBe(true)
    // Not blocked (a healthy account remains) → title is the soft form.
    expect(b.title).toContain('needs re-authentication')
  })

  test('reason falls back to statusReason when lastError absent (non-blocking)', () => {
    const snap = snapshot([
      account({ id: 'h', isDefault: true }),
      account({ id: 'd', alias: null, status: 'dead', statusReason: 'auth_dead', lastError: null }),
    ])
    const [b] = selectReauthBanners(snap)
    // alias null → id used as label; statusReason underscores normalized.
    expect(b.detail).toContain('d')
    expect(b.detail).toContain('auth dead')
  })

  test('all accounts dead (blocked) → NO per-account banners (merged into the wall)', () => {
    const snap = snapshot([
      account({ id: 'd', alias: 'only', status: 'dead', statusReason: 'auth_dead' }),
    ])
    // The all-dead pool sentence is stated ONCE by the merged wall, not once per
    // account here (finding #1). selectReauthBanners covers non-blocking only.
    expect(selectReauthBanners(snap)).toEqual([])
  })

  test('multiple dead accounts among a healthy one → one banner each, stable ids', () => {
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

  test('all accounts dead (submit blocked) → selectReauthBanners is empty (wall takes over)', () => {
    const snap = snapshot([
      account({ id: 'd1', status: 'dead', statusReason: 'auth_dead' }),
      account({ id: 'd2', status: 'dead', statusReason: 'auth_dead' }),
    ])
    expect(selectReauthBanners(snap)).toEqual([])
  })
})

describe('selectVisibleReauthBanners (dismissed = never show again)', () => {
  const oneDeadAmongHealthy = snapshot([
    account({ id: 'h', isDefault: true }),
    account({ id: 'd', status: 'dead', statusReason: 'auth_dead' }),
  ])
  const allDead = snapshot([
    account({ id: 'd', status: 'dead', statusReason: 'auth_dead' }),
  ])

  test('a dismissed non-blocking banner is hidden', () => {
    expect(
      selectVisibleReauthBanners(oneDeadAmongHealthy, new Set(['reauth:d'])),
    ).toEqual([])
  })

  test('an un-dismissed banner still shows', () => {
    expect(
      selectVisibleReauthBanners(oneDeadAmongHealthy, new Set()).map(b => b.id),
    ).toEqual(['reauth:d'])
  })

  test('all-dead pool has NO per-account visible banners (the merged wall is separate)', () => {
    // Once the pool is fully dead the per-account list is empty regardless of the
    // dismissed set — the all-dead surface is the merged wall (`selectReauthWall`),
    // never this per-account BannerStack feed.
    expect(selectVisibleReauthBanners(allDead, new Set(['reauth:d']))).toEqual([])
    expect(selectVisibleReauthBanners(allDead, new Set())).toEqual([])
  })
})

describe('selectReauthWall (merged all-dead wall, P4-15 revision #1/#2/#8)', () => {
  test('non-blocking (a healthy account remains) → null', () => {
    const snap = snapshot([
      account({ id: 'h', isDefault: true }),
      account({ id: 'd', status: 'dead', statusReason: 'auth_dead' }),
    ])
    expect(selectReauthWall(snap)).toBeNull()
  })

  test('null / uninitialized / empty pool → null', () => {
    expect(selectReauthWall(null)).toBeNull()
    expect(selectReauthWall(snapshot([]))).toBeNull()
    expect(selectReauthWall(snapshot([], { initialized: false }))).toBeNull()
  })

  test('all dead → ONE wall: pool sentence stated once + a row per dead account with its OWN reason', () => {
    const snap = snapshot([
      account({
        id: 'main',
        alias: 'main',
        status: 'dead',
        statusReason: 'auth_dead',
        lastError: 'refresh_token_invalidated',
      }),
      account({
        id: 'p',
        alias: 'personal',
        status: 'dead',
        statusReason: 'auth_dead',
        lastError: 'Token expired (>7 days since last refresh)',
      }),
    ])
    const wall = selectReauthWall(snap)
    expect(wall).not.toBeNull()
    // The pool-level "blocked" sentence lives ONCE on the wall, not per row.
    expect(wall!.summary).toContain('No healthy account remains')
    expect(wall!.summary).toContain('blocked')
    // One row per dead account, EACH with its own distinct, preserved reason.
    expect(wall!.accounts.map(a => a.label)).toEqual(['main', 'personal'])
    expect(wall!.accounts[0]?.reason).toBe('refresh_token_invalidated')
    expect(wall!.accounts[1]?.reason).toBe('Token expired (>7 days since last refresh)')
    // No row repeats the pool sentence.
    for (const row of wall!.accounts) {
      expect(row.reason).not.toContain('No healthy account remains')
    }
    // Per-account re-auth action keys, scoped by id.
    expect(wall!.accounts.map(a => a.actionKey)).toEqual([
      `${REAUTH_ACTION_KEY}:main`,
      `${REAUTH_ACTION_KEY}:p`,
    ])
  })

  test('reason falls back to statusReason when lastError absent', () => {
    const snap = snapshot([
      account({ id: 'd', alias: null, status: 'dead', statusReason: 'auth_dead', lastError: null }),
    ])
    const wall = selectReauthWall(snap)
    // alias null → id is the label; statusReason underscores normalized.
    expect(wall!.accounts[0]?.label).toBe('d')
    expect(wall!.accounts[0]?.reason).toBe('auth dead')
  })

  test('dead + capped (zero ready) → wall lists ONLY the dead account', () => {
    const snap = snapshot([
      account({ id: 'd', status: 'dead', statusReason: 'auth_dead' }),
      account({ id: 'c', status: 'capped' }),
    ])
    const wall = selectReauthWall(snap)
    expect(wall!.accounts.map(a => a.id)).toEqual(['d'])
  })

  test('id is keyed to the pool-dead STATE (sorted dead ids), NOT a session', () => {
    const wall = selectReauthWall(
      snapshot([
        account({ id: 'zeta', status: 'dead', statusReason: 'auth_dead' }),
        account({ id: 'alpha', status: 'dead', statusReason: 'auth_dead' }),
      ]),
    )!
    // Sorted, session-free → the global pool re-derives the same id everywhere,
    // so a persisted acknowledge suppresses the re-nag across session switches.
    expect(wall.id).toBe(`${REAUTH_WALL_PREFIX}alpha,zeta`)
    // A genuinely different dead set → a different id → re-nags.
    const other = selectReauthWall(
      snapshot([account({ id: 'alpha', status: 'dead', statusReason: 'auth_dead' })]),
    )!
    expect(other.id).not.toBe(wall.id)
  })

  test('collapsedLabel pluralizes by dead count and always says turns are blocked', () => {
    const one = selectReauthWall(
      snapshot([account({ id: 'd', status: 'dead', statusReason: 'auth_dead' })]),
    )!
    const many = selectReauthWall(
      snapshot([
        account({ id: 'd1', status: 'dead', statusReason: 'auth_dead' }),
        account({ id: 'd2', status: 'dead', statusReason: 'auth_dead' }),
        account({ id: 'd3', status: 'dead', statusReason: 'auth_dead' }),
      ]),
    )!
    expect(one.collapsedLabel).toContain('blocked')
    expect(one.collapsedLabel).not.toContain('accounts')
    expect(many.collapsedLabel).toContain('blocked')
    expect(many.collapsedLabel).toContain('3 accounts')
  })

  test('the wall exists exactly when submit is blocked (collapse/acknowledge never unblocks submit)', () => {
    // selectAuthSubmitBlocked is a pure function of the snapshot — independent of
    // any acknowledge/collapse UI state — so a wall is present iff submit is
    // blocked. Acknowledging (a caller-persisted flag) cannot change either.
    const allDead = snapshot([
      account({ id: 'd', status: 'dead', statusReason: 'auth_dead' }),
    ])
    expect(selectAuthSubmitBlocked(allDead)).toBe(true)
    expect(selectReauthWall(allDead)).not.toBeNull()

    const healthy = snapshot([account({ id: 'h', isDefault: true })])
    expect(selectAuthSubmitBlocked(healthy)).toBe(false)
    expect(selectReauthWall(healthy)).toBeNull()
  })
})
