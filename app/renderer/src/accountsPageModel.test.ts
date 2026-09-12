import { describe, expect, test } from 'bun:test'
import type { AccountsSnapshot, AccountStatus } from '../../shared/protocol.js'
import {
  formatAccountsNeedingSignIn,
  logoutVerb,
  selectAccountMenuItems,
  selectAccountsNeedingSignIn,
} from './accountsPageModel.js'

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
    readyCount: accounts.filter(a => a.status === 'healthy').length,
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

const dead = (id: string) =>
  account({
    id,
    status: 'dead',
    statusReason: 'auth_dead',
    availability: 'blocked',
    availabilityLabel: 'Signed out',
    lastError: 'Reauthentication required',
    switchable: false,
  })

const menuKeys = (a: AccountStatus) => selectAccountMenuItems(a).map(i => i.key)

describe('selectAccountMenuItems — sign in again', () => {
  test('a dead account offers it', () => {
    expect(menuKeys(dead('a'))).toContain('relink')
  })

  test('a healthy account does not', () => {
    expect(menuKeys(account())).not.toContain('relink')
  })

  test('a capped account does not: the credential is live, the window is not', () => {
    const capped = account({
      status: 'capped',
      statusReason: 'usage_cap',
      availability: 'blocked',
      usageLimitReached: true,
      switchable: false,
    })
    expect(menuKeys(capped)).not.toContain('relink')
  })

  test('a quarantined account does not: the engine is still re-deriving the verdict', () => {
    const quarantined = account({
      status: 'quarantined',
      statusReason: 'probe_pending_transport',
      availability: 'blocked',
      switchable: false,
    })
    expect(menuKeys(quarantined)).not.toContain('relink')
  })

  test('it does not depend on a vault profile, unlike rename and delete', () => {
    // A fresh sign-in writes the profile; it does not edit an existing one.
    const keys = menuKeys(
      account({
        status: 'dead',
        statusReason: 'auth_dead',
        hasVaultProfile: false,
        switchable: false,
      }),
    )
    expect(keys).toContain('relink')
    expect(keys).not.toContain('rename')
    expect(keys).not.toContain('delete')
  })
})

test('logoutVerb carries the targeted account generation', () => {
  expect(logoutVerb('account-to-sign-out', 12)).toMatchObject({
    type: 'account.logout',
    accountId: 'account-to-sign-out',
    expectedCredentialGeneration: 12,
  })
})

describe('selectAccountsNeedingSignIn', () => {
  test('counts only dead accounts', () => {
    const count = selectAccountsNeedingSignIn(
      snapshot([
        account({ id: 'a' }),
        dead('b'),
        account({ id: 'c', status: 'capped', usageLimitReached: true }),
        account({ id: 'd', status: 'quarantined' }),
        dead('e'),
      ]),
    )
    expect(count).toBe(2)
  })

  test('a healthy pool and a missing snapshot are both zero', () => {
    expect(selectAccountsNeedingSignIn(snapshot([account()]))).toBe(0)
    expect(selectAccountsNeedingSignIn(null)).toBe(0)
  })

  test('an uninitialized pool counts nothing, matching the health bar', () => {
    // Reachable: initAccountPool resets the flag in its catch AFTER the pool has
    // been populated, so an unfinished read can carry dead rows. The bar refuses
    // to act on such a snapshot; marking off it would make the two disagree.
    const unfinished = { ...snapshot([dead('a')]), initialized: false }
    expect(selectAccountsNeedingSignIn(unfinished)).toBe(0)
  })

  test('the Anthropic pool is not counted, and the label says Codex', () => {
    // Those rows offer no repair at all, so counting them would advertise an
    // action that does not exist.
    const withAnthropic: AccountsSnapshot = {
      ...snapshot([account()]),
      anthropicAccounts: [
        {
          id: 'ant-1',
          alias: 'claude',
          status: 'dead',
          isDefault: true,
          hasVaultProfile: true,
          emailAddress: null,
          organizationName: null,
          subscriptionType: null,
          routeAvailable: false,
        } as unknown as AccountsSnapshot['anthropicAccounts'][number],
      ],
      anthropicPoolCount: 1,
    }
    expect(selectAccountsNeedingSignIn(withAnthropic)).toBe(0)
  })
})

describe('formatAccountsNeedingSignIn', () => {
  test('null at zero, so the mark renders nothing', () => {
    expect(formatAccountsNeedingSignIn(0)).toBeNull()
    expect(formatAccountsNeedingSignIn(-1)).toBeNull()
  })

  test('singular and plural', () => {
    expect(formatAccountsNeedingSignIn(1)).toBe('1 Codex account needs sign-in')
    expect(formatAccountsNeedingSignIn(3)).toBe('3 Codex accounts need sign-in')
  })
})
