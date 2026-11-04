/**
 * The composer rail's display-vs-capability split.
 *
 * This file exists because the first attempt at pinning it was a source
 * tripwire over `App.tsx` text, and a review broke it in one edit: rebinding
 * `panelLastRunControls` to the LIVE selector restored the whole original bug —
 * blank rail on park, `panelProvider` gone, donut denominator gone — with every
 * asserted substring intact and all 2,894 tests green. A grep cannot read a
 * changed binding. These drive the real derivation instead.
 */

import { PROTOCOL_VERSION } from '../../shared/protocol.js'
import { expect, test } from 'bun:test'
import {
  createAccountsState,
  reduceAccountsState,
  type AccountsState,
} from './accountsState.js'
import { selectComposerRail } from './composerRailModel.js'
import {
  createPermissionState,
  reducePermissionState,
  type PermissionState,
} from './permissionState.js'
import {
  createRunControlsState,
  reduceRunControlsState,
  type RunControlsState,
} from './runControlsState.js'
import type {
  AccountsSnapshot,
  RunControlsSnapshot,
  ServerFrame,
} from '../../shared/protocol.js'

const SID = 'session-1'

const SNAPSHOT: RunControlsSnapshot = {
  model: {
    current: 'gpt-5.6-sol',
    currentLabel: 'GPT-5.6 Sol',
    contextWindow: 372_000,
    selected: 'gpt-5.6-sol',
    provider: 'openai',
    providerSwitchLocked: false,
    options: [
      {
        value: 'gpt-5.6-sol',
        label: 'GPT-5.6 Sol',
        provider: 'openai',
        effortOptions: ['low', 'medium', 'high'],
      },
    ],
  },
  effort: { current: 'high', selected: 'high', supported: true, options: ['high'] },
  fast: { active: true, supportedByModel: true, available: true, unavailableReason: null },
  autoCompact: { enabled: true, threshold: null, warningThreshold: null },
}

function accountsSnapshot(over: Partial<AccountsSnapshot> = {}): AccountsSnapshot {
  return {
    accounts: [],
    signedOutProfiles: [],
    activeAccountId: null,
    readyCount: 1,
    poolCount: 1,
    anthropicAccounts: [],
    ...over,
  } as AccountsSnapshot
}

const SESSION_POOL = accountsSnapshot({ readyCount: 1, poolCount: 3 })
const GLOBAL_POOL = accountsSnapshot({ readyCount: 3, poolCount: 3 })

function frame(f: ServerFrame): { type: 'frame'; frame: ServerFrame } {
  return { type: 'frame', frame: f }
}

function lifecycle(status: 'disconnected' | 'exited' = 'disconnected'): ServerFrame {
  return { kind: 'lifecycle', protocolVersion: PROTOCOL_VERSION, sessionId: SID, status }
}

function sources(over: {
  runControls?: RunControlsState
  permissions?: PermissionState
  accounts?: AccountsState
  connectionStatus?: Parameters<typeof selectComposerRail>[0]['connectionStatus']
} = {}) {
  return {
    runControls: over.runControls ?? createRunControlsState(),
    permissions: over.permissions ?? createPermissionState(),
    accounts: over.accounts ?? createAccountsState(),
    connectionStatus: over.connectionStatus ?? 'ready',
    sessionId: SID,
  }
}

/** A detached session whose fast state is `active`, on a model that may or may
 * not support fast at all. */
function detachedWithFast(active: boolean, supportedByModel = true) {
  const base = detached()
  return {
    ...base,
    runControls: reduceRunControlsState(
      base.runControls,
      frame({
        kind: 'run-controls.snapshot',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: SID,
        runControls: { ...SNAPSHOT, fast: { ...SNAPSHOT.fast, active, supportedByModel } },
      }),
    ),
  }
}

/** A session that reported everything, then lost its engine. */
function detached() {
  let runControls = reduceRunControlsState(
    createRunControlsState(),
    frame({
      kind: 'run-controls.snapshot',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SID,
      runControls: SNAPSHOT,
    }),
  )
  let permissions = reducePermissionState(
    createPermissionState(),
    frame({
      kind: 'ready',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SID,
      engineSessionId: 'engine-1',
      payload: {
        type: 'app.ready',
        protocolVersion: 1,
        inputEnabled: true,
        activeTurn: false,
        abort: { status: 'idle' },
        goalSnapshot: null,
        pendingPermissionRequests: [],
      },
    }),
  )
  permissions = reducePermissionState(
    permissions,
    frame({
      kind: 'permission.context',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SID,
      context: { mode: 'auto' } as never,
    }),
  )
  let accounts = reduceAccountsState(
    createAccountsState(),
    frame({
      kind: 'accounts.snapshot',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SID,
      accounts: SESSION_POOL,
    }),
  )
  runControls = reduceRunControlsState(runControls, frame(lifecycle()))
  permissions = reducePermissionState(permissions, frame(lifecycle()))
  accounts = reduceAccountsState(accounts, frame(lifecycle()))
  return { runControls, permissions, accounts }
}

test('a session that lost its engine still reports every display fact', () => {
  const rail = selectComposerRail(
    sources({ ...detached(), connectionStatus: 'dead' }),
  )
  expect(rail.model).toBe('gpt-5.6-sol')
  expect(rail.modelLabel).toBe('GPT-5.6 Sol')
  expect(rail.reasoningEffort).toBe('high')
  expect(rail.fastMode).toBe(true)
  expect(rail.contextWindow).toBe(372_000)
  // OFF is a real answer that must survive the park — the face vanishing on a
  // fast-off session is the operator report from 2026-08-09. A model that cannot
  // do fast at all reports null, so no face renders, as the live chip does.
  expect(
    selectComposerRail(sources({ ...detachedWithFast(false), connectionStatus: 'dead' }))
      .fastMode,
  ).toBe(false)
  expect(
    selectComposerRail(
      sources({ ...detachedWithFast(true, false), connectionStatus: 'dead' }),
    ).fastMode,
  ).toBeNull()
  expect(rail.lastPermissionMode).toBe('auto')
  expect(rail.provider).toBe('openai')
  expect(rail.readOnlyRunControls).toEqual(SNAPSHOT)
})

test('a parked snapshot retains implicit effort without keeping a live setter seam', () => {
  const snapshot = {
    ...SNAPSHOT,
    effort: { ...SNAPSHOT.effort, current: 'medium', selected: null },
  }
  let runControls = reduceRunControlsState(createRunControlsState(), frame({
    kind: 'run-controls.snapshot', protocolVersion: PROTOCOL_VERSION, sessionId: SID,
    runControls: snapshot,
  }))
  runControls = reduceRunControlsState(runControls, frame(lifecycle()))
  const rail = selectComposerRail(sources({ runControls, connectionStatus: 'disconnected' }))
  expect(rail.readOnlyRunControls?.effort).toEqual(snapshot.effort)
  expect(rail.readOnlyRunControls?.model.provider).toBe('openai')
  expect(rail.liveRunControls).toBeNull()
})

test('and arms nothing, because there is no engine to take a verb', () => {
  const rail = selectComposerRail(
    sources({ ...detached(), connectionStatus: 'dead' }),
  )
  expect(rail.liveRunControls).toBeNull()
  expect(rail.canSwitchAccount).toBe(false)
})

test('a live session arms both, and display equals the live values', () => {
  const runControls = reduceRunControlsState(
    createRunControlsState(),
    frame({
      kind: 'run-controls.snapshot',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SID,
      runControls: SNAPSHOT,
    }),
  )
  const rail = selectComposerRail(sources({ runControls, connectionStatus: 'ready' }))
  expect(rail.liveRunControls).toEqual(SNAPSHOT)
  expect(rail.canSwitchAccount).toBe(true)
  expect(rail.model).toBe('gpt-5.6-sol')
})

test('the account switch stays disarmed while a restore is still spawning', () => {
  // `connectionHasEngine` is true for these two, and `provider` now survives the
  // lifecycle null — so gating on it armed the switcher for the whole spawn
  // window, where the supervisor answers `session_not_ready`. The verb is
  // fire-and-forget, so that refusal surfaces nowhere and the pane is left
  // tracking a requestId that never resolves.
  for (const status of ['connecting', 'starting'] as const) {
    const rail = selectComposerRail(sources({ ...detached(), connectionStatus: status }))
    expect(rail.canSwitchAccount).toBe(false)
    // Display is unaffected: the rail keeps reading through the restore.
    expect(rail.model).toBe('gpt-5.6-sol')
  }
})

test('an Anthropic session arms account switching only for a ready subscription route', () => {
  const runControls = reduceRunControlsState(
    createRunControlsState(),
    frame({
      kind: 'run-controls.snapshot',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SID,
      runControls: {
        ...SNAPSHOT,
        model: { ...SNAPSHOT.model, provider: 'anthropic' },
      },
    }),
  )
  const rail = selectComposerRail(sources({ runControls, connectionStatus: 'ready' }))
  expect(rail.canSwitchAccount).toBe(false)
  expect(rail.provider).toBe('anthropic')
  for (const status of ['ready', 'starting', 'parked', 'disconnected'] as const) {
    const subscription = selectComposerRail(sources({
      runControls,
      connectionStatus: status,
      accounts: {
        ...createAccountsState(),
        sessions: { [SID]: accountsSnapshot({ anthropicSubscriptionActive: true }) },
      },
    }))
    expect(subscription.canSwitchAccount).toBe(status === 'ready')
  }
})

/* --------------------------------------------------------------------- *
 * accounts freshness — the half that must NOT be retained
 * --------------------------------------------------------------------- */

test('a detached pane reads the POLLED pool, not its own frozen copy', () => {
  // The retained snapshot's fields keep moving after the engine dies:
  // `availabilityLabel` is a countdown computed at snapshot time, and an account
  // healthy at park can be capped an hour later. The next submit restores the
  // engine and re-picks from the pool as it is NOW, so the current feed is both
  // fresher and the one that answers the question being asked.
  const base = detached()
  const accounts = reduceAccountsState(base.accounts, {
    type: 'pool',
    pool: GLOBAL_POOL,
  })
  const rail = selectComposerRail(
    sources({ ...base, accounts, connectionStatus: 'dead' }),
  )
  expect(rail.accountsSnapshot?.readyCount).toBe(3)
})

test('with no polled pool yet, the retained copy keeps the face from blanking', () => {
  const rail = selectComposerRail(
    sources({ ...detached(), connectionStatus: 'dead' }),
  )
  expect(rail.accountsSnapshot?.readyCount).toBe(1)
  expect(rail.accountsSnapshot?.poolCount).toBe(3)
})

test('a ready composer rail uses the current global pool over its attachment snapshot', () => {
  let accounts = reduceAccountsState(
    createAccountsState(),
    frame({
      kind: 'accounts.snapshot',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SID,
      accounts: SESSION_POOL,
    }),
  )
  accounts = reduceAccountsState(accounts, { type: 'pool', pool: GLOBAL_POOL })
  const rail = selectComposerRail(sources({ accounts, connectionStatus: 'ready' }))
  expect(rail.accountsSnapshot?.readyCount).toBe(3)
})

test('a session that never reported anything claims nothing', () => {
  const rail = selectComposerRail(sources({ connectionStatus: 'dead' }))
  expect(rail.model).toBeNull()
  expect(rail.modelLabel).toBeNull()
  expect(rail.reasoningEffort).toBeNull()
  // null, not false: nothing reported, which is not the same as "fast is off".
  // Only the first renders no face at all.
  expect(rail.fastMode).toBeNull()
  expect(rail.contextWindow).toBeNull()
  expect(rail.lastPermissionMode).toBeNull()
  expect(rail.accountsSnapshot).toBeNull()
  expect(rail.canSwitchAccount).toBe(false)
})

function identityPool(active: string, usage = 10): AccountsSnapshot {
  return accountsSnapshot({
    activeAccountId: active,
    anthropicActiveAccountId: active,
    anthropicRouteAvailable: true,
    anthropicSubscriptionActive: true,
    accounts: ['a', 'b', 'blocked'].map(id => ({
      id,
      isDefault: id === active,
      availability: id === 'blocked' ? 'blocked' : 'available',
      switchable: id !== active && id !== 'blocked',
      usagePrimary: usage,
    })) as AccountsSnapshot['accounts'],
    anthropicAccounts: ['a', 'b'].map(id => ({
      id,
      alias: id,
      email: `${id}@example.com`,
      status: 'healthy',
      isDefault: id === active,
      hasVaultProfile: true,
      subscriptionType: 'max',
      usageFiveHour: usage,
    })),
  })
}

test('a selected Claude row missing from inventory survives only as dead recovery metadata', () => {
  const selected = identityPool('a')
  selected.anthropicSubscriptionActive = false
  const inventory = identityPool('b')
  inventory.anthropicAccounts = inventory.anthropicAccounts.filter(row => row.id !== 'a')
  const accounts = { ...createAccountsState(), pool: inventory, sessions: { [SID]: selected } }
  const runControls = reduceRunControlsState(createRunControlsState(), frame({
    kind: 'run-controls.snapshot', protocolVersion: PROTOCOL_VERSION, sessionId: SID,
    runControls: { ...SNAPSHOT, model: { ...SNAPSHOT.model, provider: 'anthropic' } },
  } as ServerFrame))
  const rail = selectComposerRail(sources({ accounts, runControls }))
  expect(rail.accountsSnapshot?.anthropicAccounts.find(row => row.id === 'a')).toMatchObject({
    isDefault: true, status: 'dead', credentialHealth: 'sign_in_required',
  })
  expect(rail.canSwitchAccount).toBe(true)
  expect(rail.accountsSnapshot?.anthropicAccounts.find(row => row.id === 'b')?.status).toBe('healthy')
})

function reportAccounts(state: AccountsState, sessionId: string, snapshot: AccountsSnapshot) {
  return reduceAccountsState(state, frame({
    kind: 'accounts.snapshot', protocolVersion: PROTOCOL_VERSION,
    sessionId, accounts: snapshot,
  }))
}

test('two Claude panes keep their own identity through global polls and sibling switches', () => {
  let accounts = reportAccounts(createAccountsState(), SID, identityPool('a'))
  accounts = reportAccounts(accounts, 'session-2', identityPool('b'))
  for (const active of ['b', 'a']) {
    accounts = reduceAccountsState(accounts, { type: 'pool', pool: identityPool(active, 75) })
    for (const [sessionId, identity] of [[SID, 'a'], ['session-2', 'b']]) {
      const snapshot = selectComposerRail({ ...sources({ accounts }), sessionId: sessionId! }).accountsSnapshot!
      expect(snapshot.activeAccountId).toBe(identity)
      expect(snapshot.anthropicActiveAccountId).toBe(identity)
      expect(snapshot.accounts.filter(row => row.isDefault).map(row => row.id)).toEqual([identity!])
      expect(snapshot.anthropicAccounts.filter(row => row.isDefault).map(row => row.id)).toEqual([identity!])
      expect(snapshot.accounts.find(row => row.id === identity)?.switchable).toBe(false)
      expect(snapshot.accounts.find(row => row.id === (identity === 'a' ? 'b' : 'a'))?.switchable).toBe(true)
      expect(snapshot.accounts.find(row => row.id === 'blocked')?.switchable).toBe(false)
      expect(snapshot.anthropicAccounts[0]?.usageFiveHour).toBe(75)
    }
  }
  accounts = reportAccounts(accounts, 'session-2', identityPool('a'))
  expect(selectComposerRail(sources({ accounts })).accountsSnapshot?.anthropicActiveAccountId).toBe('a')
})

test('parked identity and auth survive while inventory and usage stay fresh', () => {
  let accounts = reportAccounts(createAccountsState(), SID, identityPool('a'))
  accounts = reduceAccountsState(accounts, frame(lifecycle()))
  const pool = identityPool('b', 90)
  pool.anthropicSubscriptionActive = false
  pool.anthropicRouteAvailable = false
  accounts = reduceAccountsState(accounts, { type: 'pool', pool })
  for (const connectionStatus of ['parked', 'disconnected', 'starting', 'ready'] as const) {
    const rail = selectComposerRail(sources({ accounts, connectionStatus }))
    expect(rail.accountsSnapshot?.anthropicActiveAccountId).toBe('a')
    expect(rail.accountsSnapshot?.anthropicSubscriptionActive).toBe(true)
    expect(rail.accountsSnapshot?.anthropicRouteAvailable).toBe(true)
    expect(rail.accountsSnapshot?.anthropicAccounts[0]?.usageFiveHour).toBe(90)
    expect(rail.canSwitchAccount).toBe(false)
  }
})

test('inventory without session evidence never supplies identity or effective auth', () => {
  let accounts = reportAccounts(createAccountsState(), 'other', identityPool('b'))
  for (const pool of [null, identityPool('b', 60)]) {
    accounts = { ...accounts, pool }
    const runControls = reduceRunControlsState(createRunControlsState(), frame({
      kind: 'run-controls.snapshot', protocolVersion: PROTOCOL_VERSION, sessionId: SID,
      runControls: { ...SNAPSHOT, model: { ...SNAPSHOT.model, provider: 'anthropic' } },
    }))
    const rail = selectComposerRail(sources({ accounts, runControls }))
    expect(rail.accountsSnapshot?.activeAccountId).toBeNull()
    expect(rail.accountsSnapshot?.anthropicActiveAccountId).toBeNull()
    expect(rail.accountsSnapshot?.accounts.some(row => row.isDefault)).toBe(false)
    expect(rail.accountsSnapshot?.anthropicAccounts.some(row => row.isDefault)).toBe(false)
    expect(rail.accountsSnapshot?.anthropicRouteAvailable).toBe(false)
    expect(rail.canSwitchAccount).toBe(false)
  }
})

/* --------------------------------------------------------------------- *
 * removal — retention is scoped to a session that still exists
 * --------------------------------------------------------------------- */

test('a removed row drops every retained snapshot, a lifecycle frame keeps them', () => {
  // The distinction the retention rests on. "No engine right now" must keep the
  // facts, or the rail blanks again; "this row is gone" must drop them, or a
  // long-running window accumulates full model option lists and account
  // snapshots keyed by ids nothing can display.
  const detachedSources = { ...detached(), connectionStatus: 'dead' as const }
  expect(
    selectComposerRail(sources(detachedSources)).model,
  ).toBe('gpt-5.6-sol')

  const removed = {
    runControls: reduceRunControlsState(detachedSources.runControls, {
      type: 'session-removed',
      sessionId: SID,
    }),
    permissions: reducePermissionState(detachedSources.permissions, {
      type: 'session-removed',
      sessionId: SID,
    }),
    accounts: reduceAccountsState(detachedSources.accounts, {
      type: 'session-removed',
      sessionId: SID,
    }),
  }
  const rail = selectComposerRail(sources({ ...removed, connectionStatus: 'dead' }))
  expect(rail.model).toBeNull()
  expect(rail.lastPermissionMode).toBeNull()
  expect(rail.accountsSnapshot).toBeNull()

  // And the maps are genuinely empty, not merely null-valued.
  expect(Object.keys(removed.runControls.last)).toEqual([])
  expect(Object.keys(removed.runControls.sessions)).toEqual([])
  expect(Object.keys(removed.accounts.lastSessions)).toEqual([])
  expect(Object.keys(removed.permissions.sessions)).toEqual([])
})
