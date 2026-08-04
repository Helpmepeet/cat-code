import { expect, test } from 'bun:test'
import type {
  LeaseOwnerRow,
  LeaseSnapshot,
  LeaseSnapshotFrame,
  LifecycleFrame,
} from '../../shared/protocol.js'
import {
  LEASE_STATE_META,
  createLeaseState,
  leaseAccountLabel,
  leaseHeldLabel,
  reduceLeaseState,
  selectActiveLeaseCount,
  selectLeaseForOwner,
  selectLeaseSnapshot,
} from './leaseState.js'

function owner(over: Partial<LeaseOwnerRow> = {}): LeaseOwnerRow {
  return {
    leaseId: 'agent_a',
    ownerId: 'agent_a',
    ownerType: 'subagent',
    ownerLabel: 'audit the auth path',
    accountId: 'acct-1111',
    accountAlias: 'work-laptop',
    strategy: 'spread',
    state: 'active',
    createdAt: 1_000,
    updatedAt: 1_000,
    failoverCount: 0,
    selectionReason: 'spread selected least crowded healthy account',
    ...over,
  }
}

function snapshot(over: Partial<LeaseSnapshot> = {}): LeaseSnapshot {
  return { strategy: 'spread', owners: [owner()], accounts: [], ...over }
}

function frame(sessionId: string, leases: LeaseSnapshot): LeaseSnapshotFrame {
  return { kind: 'lease.snapshot', protocolVersion: 1, sessionId, leases }
}

test('a lease snapshot lands under its own session and never leaks across sessions', () => {
  let state = createLeaseState()
  state = reduceLeaseState(state, { type: 'frame', frame: frame('s1', snapshot()) })
  expect(selectLeaseSnapshot(state, 's1')?.owners).toHaveLength(1)
  expect(selectLeaseSnapshot(state, 's2')).toBeNull()
  expect(selectLeaseSnapshot(state, null)).toBeNull()
})

test('a later snapshot replaces the earlier one for that session', () => {
  let state = createLeaseState()
  state = reduceLeaseState(state, { type: 'frame', frame: frame('s1', snapshot()) })
  state = reduceLeaseState(state, {
    type: 'frame',
    frame: frame('s1', snapshot({ strategy: 'follow-main', owners: [] })),
  })
  const current = selectLeaseSnapshot(state, 's1')
  expect(current?.strategy).toBe('follow-main')
  expect(current?.owners).toHaveLength(0)
})

test('a lifecycle frame drops the session slice (the lease map dies with the process)', () => {
  let state = createLeaseState()
  state = reduceLeaseState(state, { type: 'frame', frame: frame('s1', snapshot()) })
  const lifecycle: LifecycleFrame = {
    kind: 'lifecycle',
    protocolVersion: 1,
    sessionId: 's1',
    state: 'exited',
  } as unknown as LifecycleFrame
  state = reduceLeaseState(state, { type: 'frame', frame: lifecycle })
  expect(selectLeaseSnapshot(state, 's1')).toBeNull()
})

test('selectLeaseForOwner joins by the roster agentId, null-safe', () => {
  const snap = snapshot({
    owners: [
      owner({ ownerId: 'main-thread', ownerType: 'main', ownerLabel: 'Main thread' }),
      owner({ ownerId: 'agent_b', leaseId: 'agent_b' }),
    ],
  })
  expect(selectLeaseForOwner(snap, 'agent_b')?.leaseId).toBe('agent_b')
  expect(selectLeaseForOwner(snap, 'agent_missing')).toBeNull()
  expect(selectLeaseForOwner(snap, null)).toBeNull()
  expect(selectLeaseForOwner(null, 'agent_b')).toBeNull()
})

test('the tab count counts ACTIVE leases only', () => {
  const snap = snapshot({
    owners: [
      owner({ ownerId: 'a', state: 'active' }),
      owner({ ownerId: 'b', state: 'released' }),
      owner({ ownerId: 'c', state: 'failed' }),
    ],
  })
  expect(selectActiveLeaseCount(snap)).toBe(1)
  expect(selectActiveLeaseCount(null)).toBe(0)
})

test('held duration reads as a duration, not a relative time', () => {
  expect(leaseHeldLabel(0, 12_000)).toBe('12s')
  expect(leaseHeldLabel(0, 4 * 60_000)).toBe('4m')
  expect(leaseHeldLabel(0, 60 * 60_000)).toBe('1h')
  expect(leaseHeldLabel(0, 72 * 60_000)).toBe('1h 12m')
  // A clock that has drifted backwards must not print a negative duration.
  expect(leaseHeldLabel(10_000, 0)).toBe('0s')
})

test('the account label prefers the redacted alias and falls back to the identifier', () => {
  expect(leaseAccountLabel({ accountId: 'acct-1111', accountAlias: 'work' })).toBe('work')
  expect(leaseAccountLabel({ accountId: 'acct-1111', accountAlias: null })).toBe(
    'acct-1111',
  )
})

test('every lease-state class is a static Tailwind utility', () => {
  // Tailwind v4 only emits literals it can statically see: an interpolated
  // arbitrary value renders colourless (the P4-9 bug).
  for (const meta of Object.values(LEASE_STATE_META)) {
    for (const token of [meta.dot, meta.text]) {
      expect(token).not.toContain('${')
      expect(token).not.toContain('[#')
    }
  }
})

test('no user-visible lease string contains an em dash (operator rule)', () => {
  for (const meta of Object.values(LEASE_STATE_META)) {
    expect(meta.label).not.toContain('—')
  }
  expect(leaseHeldLabel(0, 0)).not.toContain('—')
})
