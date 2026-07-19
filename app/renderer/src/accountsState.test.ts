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
  selectCapAccount,
  selectFirstAccountsSnapshot,
  selectHasOtherSwitchable,
  selectOAuthProgress,
  selectReadyLabel,
  selectTakenAliases,
} from './accountsState.js'
import type { OAuthLoginProgressFrame } from '../../shared/protocol.js'

function snapshot(over: Partial<AccountsSnapshot> = {}): AccountsSnapshot {
  return {
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

describe('accountsState selectors', () => {
  const snap = snapshot()
  test('selectActiveAccount / selectReadyLabel', () => {
    expect(selectActiveAccount(snap)?.id).toBe('a')
    expect(selectReadyLabel(snap)).toBe('1 of 2 ready')
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
})
