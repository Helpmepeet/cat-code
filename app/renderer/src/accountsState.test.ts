import { describe, expect, test } from 'bun:test'
import type {
  AccountResultFrame,
  AccountsSnapshot,
  AccountsSnapshotFrame,
  LifecycleFrame,
} from '../../shared/protocol.js'
import {
  createAccountsState,
  reduceAccountsState,
  selectAccountRows,
  selectActiveAccount,
  selectActiveAnthropicAccount,
  selectCapAccount,
  selectFirstAccountsSnapshot,
  selectGlobalAccountsSnapshot,
  selectHasOtherSwitchable,
  selectOAuthProgress,
  selectReadyLabel,
  selectTakenAliases,
  selectUsageStatsForRange,
} from './accountsState.js'
import type { OAuthLoginProgressFrame } from '../../shared/protocol.js'

function snapshot(over: Partial<AccountsSnapshot> = {}): AccountsSnapshot {
  return {
    anthropicRouteAvailable: false,
    accounts: [
      {
        id: 'a',
        alias: 'main',
        status: 'healthy',
        statusReason: null,
        availability: 'available',
        availabilityLabel: 'Ready',
        isDefault: true,
        hasVaultProfile: true,
        source: 'vault',
        usagePrimary: 20,
        usageWeekly: 40,
        usageLimitReached: false,
        usageResetAt: null,
        lastRefreshIso: null,
        lastError: null,
        planType: 'plus',
        switchable: false,
      },
      {
        id: 'b',
        alias: 'backup',
        status: 'capped',
        statusReason: 'usage_cap',
        availability: 'blocked',
        availabilityLabel: 'Limit reached (resets in 2h)',
        isDefault: false,
        hasVaultProfile: true,
        source: 'vault',
        usagePrimary: 100,
        usageWeekly: 80,
        usageLimitReached: true,
        usageResetAt: 1_700_000_000,
        lastRefreshIso: null,
        lastError: null,
        planType: 'plus',
        switchable: false,
      },
    ],
    activeAccountId: 'a',
    readyCount: 1,
    poolCount: 2,
    initialized: true,
    anthropicAccounts: [],
    anthropicActiveAccountId: null,
    anthropicReadyCount: 0,
    anthropicPoolCount: 0,
    anthropicInitialized: true,
    ...over,
  }
}

function snapFrame(sessionId: string, accounts: AccountsSnapshot): AccountsSnapshotFrame {
  return { kind: 'accounts.snapshot', protocolVersion: 1, sessionId, accounts }
}

describe('accountsState reducer', () => {
  test('stores a snapshot per session', () => {
    let state = createAccountsState()
    state = reduceAccountsState(state, { type: 'frame', frame: snapFrame('s1', snapshot()) })
    expect(state.sessions.s1?.poolCount).toBe(2)
  })

  test('records the most recent account.result', () => {
    let state = createAccountsState()
    const result: AccountResultFrame = {
      kind: 'account.result',
      protocolVersion: 1,
      sessionId: 's1',
      requestId: 'r1',
      verb: 'account.switch',
      ok: true,
      message: 'Switched to backup',
    }
    state = reduceAccountsState(state, { type: 'frame', frame: result })
    expect(state.lastResult?.requestId).toBe('r1')
    expect(state.lastResult?.ok).toBe(true)
  })

  test('selectFirstAccountsSnapshot returns any available snapshot (P4-17 empty-state)', () => {
    let state = createAccountsState()
    expect(selectFirstAccountsSnapshot(state)).toBeNull() // cold start
    state = reduceAccountsState(state, { type: 'frame', frame: snapFrame('s2', snapshot()) })
    expect(selectFirstAccountsSnapshot(state)?.poolCount).toBe(2)
  })

  test('lifecycle death clears a known session snapshot only', () => {
    let state = createAccountsState()
    state = reduceAccountsState(state, { type: 'frame', frame: snapFrame('s1', snapshot()) })
    const death: LifecycleFrame = {
      kind: 'lifecycle',
      protocolVersion: 1,
      sessionId: 's1',
      status: 'exited',
    } as LifecycleFrame
    state = reduceAccountsState(state, { type: 'frame', frame: death })
    expect(state.sessions.s1).toBeNull()
  })
})

describe('P4-15 OAuth login progress projection', () => {
  function progressFrame(
    progress: OAuthLoginProgressFrame['progress'],
    sessionId = 's1',
  ): OAuthLoginProgressFrame {
    return { kind: 'oauth.login.progress', protocolVersion: 1, sessionId, progress }
  }

  test('reduces oauth.login.progress into the per-session view; selector reads it', () => {
    let state = createAccountsState()
    expect(selectOAuthProgress(state, 's1')).toBeNull()
    state = reduceAccountsState(state, {
      type: 'frame',
      frame: progressFrame({ state: 'waiting_for_login', url: 'https://auth.example/x' }),
    })
    expect(selectOAuthProgress(state, 's1')).toEqual({
      state: 'waiting_for_login',
      url: 'https://auth.example/x',
    })
    // Latest frame wins; other sessions are untouched.
    state = reduceAccountsState(state, {
      type: 'frame',
      frame: progressFrame({ state: 'waiting_for_alias' }),
    })
    expect(selectOAuthProgress(state, 's1')?.state).toBe('waiting_for_alias')
    expect(selectOAuthProgress(state, 's2')).toBeNull()
  })

  test('oauthReset clears the session progress (cancel / back / dwell)', () => {
    let state = createAccountsState()
    state = reduceAccountsState(state, {
      type: 'frame',
      frame: progressFrame({ state: 'error', message: 'timed_out' }),
    })
    expect(selectOAuthProgress(state, 's1')?.state).toBe('error')
    state = reduceAccountsState(state, { type: 'oauthReset', sessionId: 's1' })
    expect(selectOAuthProgress(state, 's1')).toBeNull()
  })

  test('lifecycle death clears any in-flight OAuth progress for that session', () => {
    let state = createAccountsState()
    state = reduceAccountsState(state, {
      type: 'frame',
      frame: progressFrame({ state: 'waiting_for_login', url: 'u' }),
    })
    // Seed the session so the lifecycle branch (which requires membership) runs.
    state = {
      ...state,
      sessions: { ...state.sessions, s1: null },
    }
    state = reduceAccountsState(state, {
      type: 'frame',
      frame: {
        kind: 'lifecycle',
        protocolVersion: 1,
        sessionId: 's1',
        status: 'exited',
      } as never,
    })
    expect(selectOAuthProgress(state, 's1')).toBeNull()
  })
})

/**
 * Accounts owner (`decisions/ACCOUNTS-OWNERSHIP.md`). The defect these cover:
 * the Accounts page is an unconditional sidebar item, but the pool read used to
 * be keyed on the ACTIVE session, so opening the page with no session showed an
 * empty state forever even though the pool is process-global vault state.
 */
describe('global accounts pool (session-independent feed)', () => {
  test('the pool host event populates state with NO session ever reporting', () => {
    let state = createAccountsState()
    expect(selectGlobalAccountsSnapshot(state)).toBeNull()

    const snap = snapshot()
    state = reduceAccountsState(state, { type: 'pool', pool: snap })

    // No session key was ever written, which is the whole point.
    expect(state.sessions).toEqual({})
    expect(selectGlobalAccountsSnapshot(state)).toEqual(snap)
  })

  test('a later pool event replaces the previous one (the poll keeps it fresh)', () => {
    let state = createAccountsState()
    state = reduceAccountsState(state, { type: 'pool', pool: snapshot() })
    const refreshed = snapshot({ readyCount: 0 })
    state = reduceAccountsState(state, { type: 'pool', pool: refreshed })
    expect(selectGlobalAccountsSnapshot(state)?.readyCount).toBe(0)
  })

  test('the global pool outranks a session snapshot (freshness beats spawn-time)', () => {
    const sessionSnap = snapshot({ readyCount: 2 })
    const globalSnap = snapshot({ readyCount: 0 })
    let state = createAccountsState()
    state = reduceAccountsState(state, {
      type: 'frame',
      frame: {
        kind: 'accounts.snapshot',
        protocolVersion: 1,
        sessionId: 's1',
        accounts: sessionSnap,
      } as AccountsSnapshotFrame,
    })
    state = reduceAccountsState(state, { type: 'pool', pool: globalSnap })
    expect(selectGlobalAccountsSnapshot(state)?.readyCount).toBe(0)
  })

  test('before the first poll lands, an attached session covers the launch gap', () => {
    const sessionSnap = snapshot({ readyCount: 2 })
    let state = createAccountsState()
    state = reduceAccountsState(state, {
      type: 'frame',
      frame: {
        kind: 'accounts.snapshot',
        protocolVersion: 1,
        sessionId: 's1',
        accounts: sessionSnap,
      } as AccountsSnapshotFrame,
    })
    expect(state.pool).toBeNull()
    expect(selectGlobalAccountsSnapshot(state)?.readyCount).toBe(2)
  })

  test('a session teardown never clears the global pool', () => {
    let state = createAccountsState()
    state = reduceAccountsState(state, {
      type: 'frame',
      frame: {
        kind: 'accounts.snapshot',
        protocolVersion: 1,
        sessionId: 's1',
        accounts: snapshot(),
      } as AccountsSnapshotFrame,
    })
    state = reduceAccountsState(state, { type: 'pool', pool: snapshot() })
    state = reduceAccountsState(state, {
      type: 'frame',
      frame: {
        kind: 'lifecycle',
        protocolVersion: 1,
        sessionId: 's1',
        status: 'exited',
      } as LifecycleFrame,
    })
    expect(state.sessions.s1).toBeNull()
    expect(selectGlobalAccountsSnapshot(state)).not.toBeNull()
  })
})

describe('accountsState selectors', () => {
  const snap = snapshot()
  test('selectActiveAccount / selectReadyLabel', () => {
    expect(selectActiveAccount(snap)?.id).toBe('a')
    expect(selectReadyLabel(snap)).toBe('1 of 2 ready')
  })

  test('selectActiveAnthropicAccount returns the provider-local active row', () => {
    const anthropic = {
      id: 'claude-a',
      alias: 'work-claude',
      email: 'work@example.com',
      status: 'healthy' as const,
      isDefault: true,
      hasVaultProfile: true,
      subscriptionType: 'pro',
    }
    expect(
      selectActiveAnthropicAccount(
        snapshot({
          anthropicAccounts: [anthropic],
          anthropicActiveAccountId: anthropic.id,
          anthropicReadyCount: 1,
          anthropicPoolCount: 1,
        }),
      ),
    ).toEqual(anthropic)
  })
  test('selectCapAccount finds the capped account', () => {
    expect(selectCapAccount(snap)?.id).toBe('b')
  })
  test('selectTakenAliases lists non-null aliases', () => {
    expect(selectTakenAliases(snap)).toEqual(['main', 'backup'])
  })
  test('selectHasOtherSwitchable is false when the only other account is capped', () => {
    expect(selectHasOtherSwitchable(snap, 'a')).toBe(false)
  })
  test('selectAccountRows returns [] for a null snapshot', () => {
    expect(selectAccountRows(null)).toEqual([])
  })

  test('reduces stats.usage.snapshot and selectUsageStatsForRange resolves by range', () => {
    let state = createAccountsState()
    expect(selectUsageStatsForRange(state, '7d')).toBeNull()

    const snap7d = {
      range: '7d' as const,
      totalTokens: 100000,
      dailyModelTokens: [],
      modelUsage: {},
      dailyActivity: [],
      cacheHitRate: 85,
      cacheReadTokens: 50000,
      cacheWriteTokens: 10000,
      freshInputTokens: 20000,
      totalSessions: 5,
      totalMessages: 50,
      activeDays: 3,
    }

    state = reduceAccountsState(state, {
      type: 'frame',
      frame: {
        kind: 'stats.usage.snapshot',
        protocolVersion: 1,
        sessionId: 's1',
        stats: snap7d,
      },
    })

    expect(state.usageStats['7d']).toEqual(snap7d)
    expect(state.latestUsageStats).toEqual(snap7d)
    expect(selectUsageStatsForRange(state, '7d')).toEqual(snap7d)
    expect(selectUsageStatsForRange(state, '30d')).toBeNull()

    state = reduceAccountsState(state, {
      type: 'set-stats-range',
      range: '30d',
    })
    expect(state.activeStatsRange).toBe('30d')
  })
})
