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
  selectHasOtherSwitchable,
  selectReadyLabel,
  selectTakenAliases,
} from './accountsState.js'

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
