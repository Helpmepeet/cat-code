import { expect, test } from 'bun:test'
import type {
  AgentModeWorkerItem,
  LeaseOwnerRow,
  LeaseSnapshot,
  LeaseSnapshotFrame,
  LifecycleFrame,
} from '../../shared/protocol.js'
import {
  createLeaseState,
  leaseAccountLabel,
  leaseHeldLabel,
  reduceLeaseState,
  selectLeaseAgentCount,
  selectLeaseConcentrationNote,
  selectLeaseForOwner,
  selectLeaseGroups,
  selectLeaseSnapshot,
} from './leaseState.js'

function workerFixture(over: Partial<AgentModeWorkerItem> = {}): AgentModeWorkerItem {
  return {
    agentId: 'agent_a',
    handle: 'Hopper',
    role: 'general-purpose',
    status: 'running',
    description: 'audit the auth path',
    ...over,
  }
}

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

test('the tab count equals the number of rows the panel prints', () => {
  const snap = snapshot({
    owners: [
      owner({ ownerId: 'a', state: 'active' }),
      owner({ ownerId: 'c', state: 'failed' }),
    ],
    // The engine rollup omits a synthesised main lease, so it is NOT the source:
    // when it was, the tab, the rollup and the list printed three different counts.
    accounts: [
      { accountId: 'acct-1111', accountAlias: 'work', leaseCount: 1, holders: ['a'] },
    ],
  })
  const total = selectLeaseGroups(snap, [], 0).reduce(
    (sum, group) => sum + group.agents.length,
    0,
  )
  expect(selectLeaseAgentCount(snap)).toBe(2)
  expect(selectLeaseAgentCount(snap)).toBe(total)
  expect(selectLeaseAgentCount(null)).toBe(0)
})

test('agents group under the account they hold, main thread first', () => {
  const snap = snapshot({
    owners: [
      owner({
        ownerId: 'main-thread',
        ownerType: 'main',
        ownerLabel: 'Main thread',
        accountId: 'acct-1111',
        accountAlias: 'bluesky',
      }),
      owner({ ownerId: 'agent_a', accountId: 'acct-2222', accountAlias: 'aurora' }),
      owner({ ownerId: 'agent_b', accountId: 'acct-1111', accountAlias: 'bluesky' }),
    ],
  })
  const groups = selectLeaseGroups(snap, [], 0)
  expect(groups.map(group => group.label)).toEqual(['bluesky', 'aurora'])
  expect(groups[0]?.agents).toHaveLength(2)
  expect(groups[0]?.agents[0]?.isMain).toBe(true)
})

test('a failed lease is stranded at the top, not filed under the account it could not use', () => {
  const snap = snapshot({
    owners: [
      owner({ ownerId: 'agent_a', accountId: 'acct-1111', accountAlias: 'bluesky' }),
      // `failoverCodexLease` keeps the old accountId on the failed lease
      // (`codexAccountLeaseManager.ts:356-362`).
      owner({
        ownerId: 'agent_b',
        state: 'failed',
        accountId: 'acct-1111',
        accountAlias: 'bluesky',
        failoverCount: 2,
        lastFailureReason: 'account is capped',
      }),
    ],
  })
  const groups = selectLeaseGroups(snap, [], 0)
  expect(groups[0]?.isStranded).toBe(true)
  expect(groups[0]?.label).toBe('No account')
  expect(groups[0]?.agents[0]?.note?.tone).toBe('stranded')
  // The healthy group keeps only the agent that really is on that account.
  expect(groups[1]?.label).toBe('bluesky')
  expect(groups[1]?.agents).toHaveLength(1)
  // A stranded agent holds nothing, so it shows no held duration.
  expect(groups[0]?.agents[0]?.held).toBeNull()
})

test('a row leads with the worker handle and falls back to its task text', () => {
  const snap = snapshot({
    owners: [
      owner({ ownerId: 'agent_a' }),
      owner({ ownerId: 'agent_b', ownerLabel: 'trace the resume path' }),
    ],
  })
  const [group] = selectLeaseGroups(snap, [workerFixture({ agentId: 'agent_a' })], 0)
  expect(group?.agents[0]?.name).toBe('Hopper')
  expect(group?.agents[0]?.task).toBe('audit the auth path')
  // No handle minted yet: the row leads with the task rather than an empty slot.
  expect(group?.agents[1]?.name).toBeNull()
  expect(group?.agents[1]?.task).toBe('trace the resume path')
})

test('no account id ever reaches display text', () => {
  const rawId = 'ca889574-256c-4f04-8d5f-f80004f1a8e1'
  const snap = snapshot({
    owners: [
      owner({
        ownerId: 'agent_a',
        // `claude.ts:1177` labels this lease with the raw agent id.
        ownerLabel: `Subagent ${rawId}`,
        failoverCount: 1,
        selectionReason: `failover from ${rawId}: Codex account ${rawId} is capped`,
        lastFailureReason: `Codex account ${rawId} is capped`,
      }),
    ],
  })
  const [group] = selectLeaseGroups(snap, [], 0)
  const agent = group?.agents[0]
  const visible = [group?.label, agent?.name, agent?.task, agent?.note?.text]
  for (const text of visible) {
    expect(text ?? '').not.toContain(rawId)
  }
  expect(agent?.name).toBe('Unnamed worker')
  // The engine's own text survives for the hover detail, and only there.
  expect(agent?.note?.detail).toContain(rawId)
})

test('engine selection prose never renders as body text', () => {
  const snap = snapshot({
    owners: [
      owner({ ownerId: 'a', selectionReason: 'spread selected least crowded healthy account' }),
      owner({ ownerId: 'b', selectionReason: 'synthetic main lease from active pool account' }),
      owner({
        ownerId: 'c',
        selectionReason: 'repaired from non-selectable account acct-9: spread selected least crowded healthy account',
      }),
    ],
  })
  const agents = selectLeaseGroups(snap, [], 0).flatMap(group => group.agents)
  // An ordinary selection is not news, so it prints nothing at all.
  expect(agents[0]?.note).toBeNull()
  expect(agents[1]?.note).toBeNull()
  expect(agents[2]?.note?.text).toBe('moved here, its account could not be used')
  for (const agent of agents) {
    expect(agent.note?.text ?? '').not.toContain('spread selected')
  }
})

test('the concentration note fires only when a spread session did not spread', () => {
  const oneAccount = (count: number) =>
    snapshot({
      owners: Array.from({ length: count }, (_, index) =>
        owner({ ownerId: `agent_${index}` }),
      ),
    })

  const four = oneAccount(4)
  expect(selectLeaseConcentrationNote(four, selectLeaseGroups(four, [], 0))).toBe(
    'All 4 agents landed on one account.',
  )

  // One agent on one account is not a failure to spread.
  const one = oneAccount(1)
  expect(selectLeaseConcentrationNote(one, selectLeaseGroups(one, [], 0))).toBeNull()

  // follow-main is SUPPOSED to pile up, so saying so would be noise.
  const followMain = snapshot({
    strategy: 'follow-main',
    owners: [owner({ ownerId: 'a' }), owner({ ownerId: 'b' })],
  })
  expect(
    selectLeaseConcentrationNote(followMain, selectLeaseGroups(followMain, [], 0)),
  ).toBeNull()

  // Genuinely spread across two accounts: nothing surprising to report.
  const spread = snapshot({
    owners: [
      owner({ ownerId: 'a', accountId: 'acct-1' }),
      owner({ ownerId: 'b', accountId: 'acct-2' }),
    ],
  })
  expect(selectLeaseConcentrationNote(spread, selectLeaseGroups(spread, [], 0))).toBeNull()
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

test('no user-visible account string contains an em dash or engine vocabulary', () => {
  const snap = snapshot({
    owners: [
      owner({ ownerId: 'main-thread', ownerType: 'main', ownerLabel: 'Main thread' }),
      owner({ ownerId: 'a', failoverCount: 1, selectionReason: 'failover from acct-9: capped' }),
      owner({ ownerId: 'b', state: 'failed' }),
    ],
  })
  const groups = selectLeaseGroups(snap, [], 0)
  const strings = groups.flatMap(group => [
    group.label,
    ...group.agents.flatMap(agent => [agent.name, agent.task, agent.note?.text]),
  ])
  for (const text of strings) {
    expect(text ?? '').not.toContain('—')
    // "lease" is the engine's noun for this, and the operator rejected it on screen.
    expect((text ?? '').toLowerCase()).not.toContain('lease')
  }
  expect(
    selectLeaseConcentrationNote(snap, groups) ?? '',
  ).not.toContain('—')
  expect(leaseHeldLabel(0, 0)).not.toContain('—')
})
