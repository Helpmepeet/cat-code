import { expect, test } from 'bun:test'
import type {
  AccountsSnapshot,
  AccountStatus,
  LiveWorkerItem,
  LeaseOwnerRow,
  LeaseSnapshot,
  LeaseSnapshotFrame,
  LifecycleFrame,
} from '../../shared/protocol.js'
import {
  createAccountsState,
  reduceAccountsState,
  type AccountsState,
} from './accountsState.js'
import {
  createLeaseState,
  leaseAccountLabel,
  leaseHeldLabel,
  reduceLeaseState,
  selectLeaseAgentCount,
  selectLeaseConcentrationNote,
  selectLeaseForLabel,
  selectLeaseForOwner,
  selectLeaseGroups,
  selectLeaseSnapshot,
  selectSessionCodexAccount,
} from './leaseState.js'

function workerFixture(over: Partial<LiveWorkerItem> = {}): LiveWorkerItem {
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
    selectionKind: 'initial',
    selectionReason: 'spread selected least crowded healthy account',
    ...over,
  }
}

function snapshot(over: Partial<LeaseSnapshot> = {}): LeaseSnapshot {
  return { strategy: 'spread', owners: [owner()], accounts: [], ...over }
}

function frame(sessionId: string, leases: LeaseSnapshot): LeaseSnapshotFrame {
  return { kind: 'lease.snapshot', protocolVersion: 2, sessionId, leases }
}

test('a lease snapshot lands under its own session and never leaks across sessions', () => {
  let state = createLeaseState()
  state = reduceLeaseState(state, { type: 'frame', frame: frame('s1', snapshot()) })
  expect(selectLeaseSnapshot(state, 's1')?.owners).toHaveLength(1)
  expect(selectLeaseSnapshot(state, 's2')).toBeNull()
  expect(selectLeaseSnapshot(state, null)).toBeNull()
})

test('session removal drops a retained lease key', () => {
  expect(reduceLeaseState({ bySession: { gone: undefined } }, { type: 'session-removed', sessionId: 'gone' }))
    .toEqual({ bySession: {} })
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
    protocolVersion: 2,
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

test('selectLeaseForLabel joins a RUNNING worker by the description both planes carry', () => {
  // The key `selectLeaseForOwner` cannot use while a foreground worker runs: its
  // agentId arrives with the result, i.e. only once the run is over. The engine
  // registers the lease under the Agent tool's own `description`
  // (`AgentTool.tsx:1502`), which is exactly what the card holds as `input.description`.
  const snap = snapshot({
    owners: [
      owner({ ownerId: 'main-thread', ownerType: 'main', ownerLabel: 'Main thread' }),
      owner({ ownerId: 'agent_b', leaseId: 'agent_b', ownerLabel: 'repair the sdk contract' }),
    ],
  })
  expect(selectLeaseForLabel(snap, 'repair the sdk contract')?.leaseId).toBe('agent_b')
  expect(selectLeaseForLabel(snap, 'no such task')).toBeNull()
  expect(selectLeaseForLabel(snap, '')).toBeNull()
  expect(selectLeaseForLabel(snap, null)).toBeNull()
  expect(selectLeaseForLabel(null, 'repair the sdk contract')).toBeNull()
})

test('selectLeaseForLabel never names an account for a description two workers share', () => {
  // A description is 3-5 words and is not unique. Picking the first match would
  // name an account the reader's worker may not be burning at all.
  const snap = snapshot({
    owners: [
      owner({ ownerId: 'agent_a', leaseId: 'agent_a', accountAlias: 'bluesky' }),
      owner({ ownerId: 'agent_b', leaseId: 'agent_b', accountAlias: 'onbi' }),
    ],
  })
  expect(snap.owners[0]?.ownerLabel).toBe(snap.owners[1]?.ownerLabel ?? '')
  expect(selectLeaseForLabel(snap, 'audit the auth path')).toBeNull()
})

test('selectLeaseForLabel ignores the main thread and any lease that is not holding', () => {
  // A failed lease keeps the account id it could NOT use, so naming it would
  // report a worker as burning an account that refused it.
  const failed = snapshot({
    owners: [owner({ ownerId: 'agent_b', leaseId: 'agent_b', state: 'failed' })],
  })
  expect(selectLeaseForLabel(failed, 'audit the auth path')).toBeNull()

  const released = snapshot({
    owners: [owner({ ownerId: 'agent_b', leaseId: 'agent_b', state: 'released' })],
  })
  expect(selectLeaseForLabel(released, 'audit the auth path')).toBeNull()

  const mainOnly = snapshot({
    owners: [owner({ ownerId: 'main-thread', ownerType: 'main', ownerLabel: 'shared label' })],
  })
  expect(selectLeaseForLabel(mainOnly, 'shared label')).toBeNull()
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
        selectionKind: 'failover',
        selectionReason: `failover from ${rawId}: Codex account ${rawId} is capped`,
        lastFailureReason: `Codex account ${rawId} is capped`,
      }),
    ],
  })
  const [group] = selectLeaseGroups(snap, [], 0)
  const agent = group?.agents[0]
  // `detail` is included: CLAUDE.md §7 counts a `title` as a text surface too.
  const visible = [
    group?.label,
    agent?.name,
    agent?.task,
    agent?.note?.text,
    agent?.note?.detail,
  ]
  for (const text of visible) {
    expect(text ?? '').not.toContain(rawId)
  }
  expect(agent?.name).toBe('Unnamed worker')
  // The reason itself survives redaction, which is the point of keeping it.
  expect(agent?.note?.detail).toBe('Codex account is capped')
})

test('an account with no alias heads its group with a short id, not a 36-char one', () => {
  // The pool's alias is optional, set only by an explicit rename, so this is the
  // ORDINARY case and it is the panel's most prominent text.
  const rawId = 'ca889574-256c-4f04-8d5f-f80004f1a8e1'
  const snap = snapshot({
    owners: [owner({ accountId: rawId, accountAlias: null })],
  })
  const [group] = selectLeaseGroups(snap, [], 0)
  expect(group?.label).toBe('ca889574')
  expect(group?.label).not.toBe(rawId)

  // Two un-aliased accounts must still read as two different groups.
  const second = 'f0e1d2c3-1111-2222-3333-444455556666'
  const both = selectLeaseGroups(
    snapshot({
      owners: [
        owner({ ownerId: 'a', accountId: rawId, accountAlias: null }),
        owner({ ownerId: 'b', accountId: second, accountAlias: null }),
      ],
    }),
    [],
    0,
  )
  expect(both).toHaveLength(2)
  expect(both[0]?.label).not.toBe(both[1]?.label)
})

test('the main thread is named by the renderer, not by whichever engine path minted it', () => {
  // The synthesised lease says 'main thread' and the registered one 'Main thread'
  // (`codexAccountLeaseManager.ts:432` vs `src/query.ts:328`).
  for (const engineLabel of ['main thread', 'Main thread', '']) {
    const snap = snapshot({
      owners: [
        owner({ ownerId: 'main-thread', ownerType: 'main', ownerLabel: engineLabel }),
      ],
    })
    const [group] = selectLeaseGroups(snap, [], 0)
    expect(group?.agents[0]?.name).toBe('Main thread')
    // The main thread has no delegated task, so nothing trails the name.
    expect(group?.agents[0]?.task).toBeNull()
  }
})

test('an empty engine label never yields a row with no identity at all', () => {
  const snap = snapshot({
    owners: [owner({ ownerId: 'agent_a', ownerLabel: '' })],
  })
  const [group] = selectLeaseGroups(snap, [], 0)
  const agent = group?.agents[0]
  expect(agent?.task).toBeNull()
  expect(agent?.name).toBe('Unnamed worker')
})

test('a released lease renders no row and is not counted', () => {
  // Unreachable today (`releaseCodexLease` deletes the entry), but the union still
  // carries the state, so the panel has to say what it means rather than assume.
  const snap = snapshot({
    owners: [
      owner({ ownerId: 'a', state: 'active' }),
      owner({ ownerId: 'b', state: 'released' }),
    ],
  })
  const groups = selectLeaseGroups(snap, [], 0)
  expect(groups.flatMap(group => group.agents)).toHaveLength(1)
  expect(selectLeaseAgentCount(snap)).toBe(1)
})

test('engine selection prose never renders as body text', () => {
  const snap = snapshot({
    owners: [
      owner({ ownerId: 'a', selectionReason: 'spread selected least crowded healthy account' }),
      owner({ ownerId: 'b', selectionReason: 'synthetic main lease from active pool account' }),
      owner({
        ownerId: 'c',
        selectionKind: 'repaired',
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
  expect(selectLeaseConcentrationNote(four.strategy, selectLeaseGroups(four, [], 0))).toBe(
    'All 4 agents landed on one account.',
  )

  // One agent on one account is not a failure to spread.
  const one = oneAccount(1)
  expect(selectLeaseConcentrationNote(one.strategy, selectLeaseGroups(one, [], 0))).toBeNull()

  // follow-main is SUPPOSED to pile up, so saying so would be noise.
  const followMain = snapshot({
    strategy: 'follow-main',
    owners: [owner({ ownerId: 'a' }), owner({ ownerId: 'b' })],
  })
  expect(
    selectLeaseConcentrationNote(followMain.strategy, selectLeaseGroups(followMain, [], 0)),
  ).toBeNull()

  // Genuinely spread across two accounts: nothing surprising to report.
  const spread = snapshot({
    owners: [
      owner({ ownerId: 'a', accountId: 'acct-1' }),
      owner({ ownerId: 'b', accountId: 'acct-2' }),
    ],
  })
  expect(selectLeaseConcentrationNote(spread.strategy, selectLeaseGroups(spread, [], 0))).toBeNull()

  // With an agent stranded alongside, "All N agents" would contradict the tab
  // count on the same screen, so it stays silent rather than print a false total.
  const withStranded = snapshot({
    owners: [
      owner({ ownerId: 'a' }),
      owner({ ownerId: 'b' }),
      owner({ ownerId: 'c', state: 'failed' }),
    ],
  })
  const strandedGroups = selectLeaseGroups(withStranded, [], 0)
  expect(selectLeaseAgentCount(withStranded)).toBe(3)
  expect(
    selectLeaseConcentrationNote(withStranded.strategy, strandedGroups),
  ).toBeNull()
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
      owner({
        ownerId: 'a',
        failoverCount: 1,
        selectionKind: 'failover',
        selectionReason: 'failover from acct-9: capped',
      }),
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
    selectLeaseConcentrationNote(snap.strategy, groups) ?? '',
  ).not.toContain('—')
  expect(leaseHeldLabel(0, 0)).not.toContain('—')
})

test('a moved agent names the account it came from, when the sidecar could resolve one', () => {
  const moved = (over: Partial<LeaseOwnerRow>) =>
    selectLeaseGroups(snapshot({ owners: [owner(over)] }), [], 0)[0]?.agents[0]?.note?.text

  // Resolved alias: the whole point of carrying `movedFrom` across the seam.
  expect(
    moved({
      selectionKind: 'failover',
      movedFrom: { accountId: 'acct-9', accountAlias: 'aurora' },
    }),
  ).toBe('moved here from aurora')
  expect(
    moved({
      selectionKind: 'repaired',
      movedFrom: { accountId: 'acct-9', accountAlias: 'aurora' },
    }),
  ).toBe('moved here, aurora could not be used')

  // The sidecar omits `movedFrom` when the pool no longer knows that account (it
  // was deleted). The wording goes anonymous rather than inventing a name.
  expect(moved({ selectionKind: 'failover' })).toBe('moved here from another account')
  expect(moved({ selectionKind: 'repaired' })).toBe(
    'moved here, its account could not be used',
  )

  // An un-aliased source account is an id we must not print, so it reads anonymous.
  expect(
    moved({
      selectionKind: 'failover',
      movedFrom: { accountId: 'ca889574-256c-4f04-8d5f-f80004f1a8e1', accountAlias: null },
    }),
  ).toBe('moved here from another account')
})

test('the note branches on selectionKind, never on the reason prose', () => {
  // The engine is free to reword `selectionReason`; a renderer that parsed it
  // would silently stop noticing. Same prose, opposite outcomes.
  const prose = 'failover from acct-9: Codex account acct-9 is capped'
  const withKind = selectLeaseGroups(
    snapshot({ owners: [owner({ selectionKind: 'failover', selectionReason: prose })] }),
    [],
    0,
  )
  expect(withKind[0]?.agents[0]?.note?.text).toBe('moved here from another account')

  const withoutKind = selectLeaseGroups(
    snapshot({ owners: [owner({ selectionKind: 'initial', selectionReason: prose })] }),
    [],
    0,
  )
  expect(withoutKind[0]?.agents[0]?.note).toBeNull()

  // `/switch-account` is the user's own doing, so saying it back is noise.
  const manual = selectLeaseGroups(
    snapshot({
      owners: [owner({ selectionKind: 'manual', movedFrom: { accountId: 'acct-9', accountAlias: 'aurora' } })],
    }),
    [],
    0,
  )
  expect(manual[0]?.agents[0]?.note).toBeNull()
})

/* ── selectSessionCodexAccount ─────────────────────────────────────────────── */

function poolRow(over: Partial<AccountStatus> = {}): AccountStatus {
  return {
    id: 'acct-a',
    credentialGeneration: 0,
    alias: 'aurora',
    status: 'healthy',
    statusReason: null,
    availability: 'available',
    availabilityLabel: 'Ready',
    isDefault: false,
    hasVaultProfile: true,
    source: 'vault',
    usagePrimary: 20,
    usageWeekly: 40,
    usageLimitReached: false,
    usageResetAt: null,
    lastRefreshIso: null,
    lastError: null,
    planType: 'plus',
    switchable: true,
    ...over,
  }
}

function accountsSnapshot(rows: AccountStatus[]): AccountsSnapshot {
  return {
    signedOutProfiles: [],
    anthropicRouteAvailable: false,
    accounts: rows,
    activeAccountId: rows.find(row => row.isDefault)?.id ?? null,
    readyCount: rows.filter(row => row.status === 'healthy').length,
    poolCount: rows.length,
    initialized: true,
    anthropicAccounts: [],
    anthropicActiveAccountId: null,
    anthropicReadyCount: 0,
    anthropicPoolCount: 0,
    anthropicInitialized: true,
  }
}

/** The host-global roster every pane renders: A is the PERSISTED active account. */
const ROSTER = accountsSnapshot([
  poolRow({ id: 'acct-a', alias: 'aurora', isDefault: true, usagePrimary: 11 }),
  poolRow({ id: 'acct-b', alias: 'basalt', usagePrimary: 77 }),
])

function accountsStateWithSession(
  sessionId: string,
  snap: AccountsSnapshot,
): AccountsState {
  return reduceAccountsState(createAccountsState(), {
    type: 'frame',
    frame: { kind: 'accounts.snapshot', protocolVersion: 2, sessionId, accounts: snap },
  })
}

test('the main lease outranks the pool default, so a failover renames the face', () => {
  // The pool still persists A as active; this session failed over to B.
  const resolved = selectSessionCodexAccount({
    roster: ROSTER,
    leases: snapshot({
      owners: [
        owner({
          ownerId: 'main-thread',
          ownerType: 'main',
          ownerLabel: 'Main thread',
          accountId: 'acct-b',
          selectionKind: 'failover',
        }),
      ],
    }),
    accounts: createAccountsState(),
    sessionId: 's1',
  })
  expect(resolved?.id).toBe('acct-b')
  // Metadata stays the roster's fresh copy, not anything re-derived from the lease.
  expect(resolved?.alias).toBe('basalt')
  expect(resolved?.usagePrimary).toBe(77)
})

test('a subagent lease never names the main face', () => {
  const resolved = selectSessionCodexAccount({
    roster: ROSTER,
    leases: snapshot({ owners: [owner({ accountId: 'acct-b' })] }),
    accounts: createAccountsState(),
    sessionId: 's1',
  })
  expect(resolved?.id).toBe('acct-a')
})

test('a failed main lease keeps an account id it could not use, so it is refused', () => {
  const resolved = selectSessionCodexAccount({
    roster: ROSTER,
    leases: snapshot({
      owners: [
        owner({
          ownerId: 'main-thread',
          ownerType: 'main',
          ownerLabel: 'Main thread',
          accountId: 'acct-b',
          state: 'failed',
        }),
      ],
    }),
    accounts: createAccountsState(),
    sessionId: 's1',
  })
  expect(resolved?.id).toBe('acct-a')
})

test('between turns there is no main lease, so the session own snapshot carries it', () => {
  // Another pane switched to A and persisted it; this session still runs on B.
  const accounts = accountsStateWithSession(
    's1',
    accountsSnapshot([
      poolRow({ id: 'acct-a', alias: 'aurora' }),
      poolRow({ id: 'acct-b', alias: 'basalt', isDefault: true }),
    ]),
  )
  const resolved = selectSessionCodexAccount({
    roster: ROSTER,
    leases: snapshot({ owners: [] }),
    accounts,
    sessionId: 's1',
  })
  expect(resolved?.id).toBe('acct-b')
  expect(resolved?.usagePrimary).toBe(77)
})

test('a parked session keeps naming what it ran on, not the persisted account', () => {
  // The lifecycle frame drops both the live lease snapshot and the session's
  // current accounts snapshot, so a parked pane has only `lastSessions` left.
  // Falling through to the roster would name an account this session never used.
  const attached = accountsStateWithSession(
    's1',
    accountsSnapshot([
      poolRow({ id: 'acct-a', alias: 'aurora' }),
      poolRow({ id: 'acct-b', alias: 'basalt', isDefault: true }),
    ]),
  )
  const parked = reduceAccountsState(attached, {
    type: 'frame',
    frame: {
      kind: 'lifecycle',
      protocolVersion: 2,
      sessionId: 's1',
      status: 'exited',
    } satisfies LifecycleFrame,
  })
  const resolved = selectSessionCodexAccount({
    roster: ROSTER,
    leases: null,
    accounts: parked,
    sessionId: 's1',
  })
  expect(resolved?.id).toBe('acct-b')
})

test('with neither a lease nor a session snapshot the pool default still answers', () => {
  const resolved = selectSessionCodexAccount({
    roster: ROSTER,
    leases: null,
    accounts: createAccountsState(),
    sessionId: 's1',
  })
  expect(resolved?.id).toBe('acct-a')
})

test('an id the displayed roster does not carry falls through instead of inventing a row', () => {
  // A deleted account can still be named by a live lease and by the session's own
  // stale snapshot. Neither may synthesise a row the pool no longer has.
  const accounts = accountsStateWithSession(
    's1',
    accountsSnapshot([poolRow({ id: 'acct-gone', alias: 'ghost', isDefault: true })]),
  )
  const resolved = selectSessionCodexAccount({
    roster: ROSTER,
    leases: snapshot({
      owners: [
        owner({
          ownerId: 'main-thread',
          ownerType: 'main',
          ownerLabel: 'Main thread',
          accountId: 'acct-gone',
        }),
      ],
    }),
    accounts,
    sessionId: 's1',
  })
  expect(resolved?.id).toBe('acct-a')
})

test('no roster means no face, whatever the lease says', () => {
  expect(
    selectSessionCodexAccount({
      roster: null,
      leases: snapshot({
        owners: [owner({ ownerId: 'main-thread', ownerType: 'main', accountId: 'acct-b' })],
      }),
      accounts: createAccountsState(),
      sessionId: 's1',
    }),
  ).toBeNull()
})

test('a lease from another session never reaches this face', () => {
  // `selectLeaseSnapshot` is session-scoped upstream; this asserts the selector
  // itself reads only what it was handed.
  let leaseStore = createLeaseState()
  leaseStore = reduceLeaseState(leaseStore, {
    type: 'frame',
    frame: frame(
      's2',
      snapshot({
        owners: [owner({ ownerId: 'main-thread', ownerType: 'main', accountId: 'acct-b' })],
      }),
    ),
  })
  const resolved = selectSessionCodexAccount({
    roster: ROSTER,
    leases: selectLeaseSnapshot(leaseStore, 's1'),
    accounts: createAccountsState(),
    sessionId: 's1',
  })
  expect(resolved?.id).toBe('acct-a')
})
