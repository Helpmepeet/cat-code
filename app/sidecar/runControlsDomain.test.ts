import { expect, test } from 'bun:test'
import {
  getMainLoopModel,
} from '../../src/utils/model/model.js'
import {
  getMainLoopModelOverride,
  getSessionProvider,
  isProviderSwitchLocked,
  setMainLoopModelOverride,
  setProviderSwitchLocked,
  setSessionProvider,
} from '../../src/bootstrap/state.js'
import { getDefaultAppState } from '../../src/state/AppStateStore.js'
import type { AppState } from '../../src/state/AppStateStore.js'
import { createStore, type Store } from '../../src/state/store.js'
import {
  buildRunControlsSnapshot,
  createSidecarRunControlsDomain,
  type RunControlExecutor,
} from './runControlsDomain.js'

function makeStore(over: Partial<AppState> = {}): Store<AppState> {
  return createStore<AppState>({ ...getDefaultAppState(), ...over })
}

/** A fake executor that only mutates the store — proves the domain's set → store →
 * snapshot → change-detected-subscribe wiring without touching real process globals. */
function snapshotWithTerra(state: AppState) {
  const snapshot = buildRunControlsSnapshot(state)
  return {
    ...snapshot,
    model: {
      ...snapshot.model,
      options: [
        ...snapshot.model.options,
        { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', provider: 'openai' as const },
      ],
    },
  }
}

function snapshotWithDefault(state: AppState) {
  const snapshot = snapshotWithTerra(state)
  return {
    ...snapshot,
    model: {
      ...snapshot.model,
      options: [
        { value: null, label: 'Default', provider: snapshot.model.provider },
        ...snapshot.model.options,
      ],
    },
  }
}

function snapshotWithTerraAndFast(state: AppState) {
  const snapshot = snapshotWithTerra(state)
  return {
    ...snapshot,
    fast: {
      active: state.fastMode ?? false,
      supportedByModel: true,
      available: true,
      unavailableReason: null,
    },
  }
}

function snapshotWithTerraAndOpus(state: AppState) {
  const snapshot = snapshotWithTerra(state)
  return {
    ...snapshot,
    model: {
      ...snapshot.model,
      options: [
        ...snapshot.model.options,
        { value: 'opus', label: 'Opus', provider: 'anthropic' as const },
      ],
    },
  }
}

function snapshotWithTerraAndSonnet(state: AppState) {
  const snapshot = snapshotWithTerra(state)
  return {
    ...snapshot,
    model: {
      ...snapshot.model,
      options: [
        ...snapshot.model.options,
        { value: 'sonnet', label: 'Sonnet', provider: 'anthropic' as const },
      ],
    },
  }
}

function fakeExecutor(store: Store<AppState>): {
  executor: RunControlExecutor
  calls: string[]
} {
  const calls: string[] = []
  return {
    executor: {
      setModel(model) {
        calls.push(`model:${model}`)
        store.setState(prev => ({
          ...prev,
          mainLoopModel: model,
          mainLoopModelForSession: null,
        }))
      },
      setEffort(effort) {
        calls.push(`effort:${effort}`)
        const value: AppState['effortValue'] =
          effort === 'auto' ? undefined : (effort as AppState['effortValue'])
        store.setState(prev => ({ ...prev, effortValue: value }))
        return `Effort set to ${effort}.`
      },
      setFast(active) {
        calls.push(`fast:${active}`)
        store.setState(prev => ({ ...prev, fastMode: active }))
      },
      activateProvider(provider) {
        calls.push(`provider:${provider}`)
      },
    },
    calls,
  }
}

test('setModel via the executor mutates the store, reports changed, and notifies subscribers (idempotent no-op)', () => {
  const previousProvider = getSessionProvider()
  setSessionProvider('openai')
  const store = makeStore()
  const { executor, calls } = fakeExecutor(store)
  const domain = createSidecarRunControlsDomain(store, { executor, buildSnapshot: snapshotWithTerra })

  let notified = 0
  const unsub = domain.subscribe(() => {
    notified += 1
  })

  const first = domain.setModel('gpt-5.6-terra')
  expect(calls).toEqual(['model:gpt-5.6-terra'])
  expect(first).toMatchObject({ ok: true, changed: true })
  expect(store.getState().mainLoopModel).toBe('gpt-5.6-terra')
  expect(notified).toBe(1)

  // Same model again → the change-detected subscription stays silent and `changed`
  // is false (no re-broadcast), even though the executor still runs.
  const again = domain.setModel('gpt-5.6-terra')
  expect(again.changed).toBe(false)
  expect(notified).toBe(1)

  unsub()
  setSessionProvider(previousProvider)
})

test('setEffort and setFast route through the executor and reflect in the snapshot', () => {
  const store = makeStore({ mainLoopModel: 'gpt-5.6-terra' })
  const { executor, calls } = fakeExecutor(store)
  const domain = createSidecarRunControlsDomain(store, {
    executor,
    buildSnapshot: snapshotWithTerraAndFast,
  })

  const effortResult = domain.setEffort('high')
  expect(effortResult).toMatchObject({ ok: true, changed: true })
  expect(store.getState().effortValue).toBe('high')

  const fastResult = domain.setFast(true)
  expect(fastResult).toMatchObject({ ok: true, changed: true })
  expect(store.getState().fastMode).toBe(true)

  expect(calls).toEqual(['effort:high', 'fast:true'])
})

test('provider-local Default clears an explicit model override', () => {
  const store = makeStore({ mainLoopModel: 'gpt-5.6-terra' })
  const { executor, calls } = fakeExecutor(store)
  const domain = createSidecarRunControlsDomain(store, {
    executor,
    buildSnapshot: snapshotWithDefault,
  })

  expect(domain.setModel(null)).toMatchObject({
    ok: true,
    changed: true,
    message: 'Model set to provider default.',
  })
  expect(calls).toEqual(['model:null'])
  expect(store.getState().mainLoopModel).toBeNull()
})

test('first-run provider activation routes through the run-control executor', () => {
  const store = makeStore()
  const { executor, calls } = fakeExecutor(store)
  const domain = createSidecarRunControlsDomain(store, {
    executor,
    buildSnapshot: snapshotWithTerraAndOpus,
  })

  expect(domain.activateProvider('anthropic')).toMatchObject({
    ok: true,
    changed: false,
  })
  expect(calls).toEqual(['provider:anthropic'])
})

test('accepting the first turn locks cross-provider model changes and notifies the picker', () => {
  const previousProvider = getSessionProvider()
  const previousLock = isProviderSwitchLocked()
  try {
    setProviderSwitchLocked(false)
    setSessionProvider('openai')
    const store = makeStore({ mainLoopModel: 'gpt-5.6-terra' })
    const { executor, calls } = fakeExecutor(store)
    const domain = createSidecarRunControlsDomain(store, {
      executor,
      buildSnapshot: snapshotWithTerraAndOpus,
    })
    let notified = 0
    const unsubscribe = domain.subscribe(() => {
      notified++
    })

    expect(domain.lockProviderSwitches()).toBe(true)
    expect(domain.getSnapshot().model.providerSwitchLocked).toBe(true)
    expect(notified).toBe(1)
    expect(domain.setModel('opus')).toMatchObject({
      ok: false,
      changed: false,
    })
    expect(domain.setModel('gpt-5.6-terra')).toMatchObject({ ok: true })
    expect(calls).toEqual(['model:gpt-5.6-terra'])
    unsubscribe()
  } finally {
    setProviderSwitchLocked(previousLock)
    setSessionProvider(previousProvider)
  }
})

test('restored provider-bound history starts locked even when cost tokens were not restored', () => {
  const previousProvider = getSessionProvider()
  const previousLock = isProviderSwitchLocked()
  try {
    setProviderSwitchLocked(false)
    setSessionProvider('openai')
    const store = makeStore({ mainLoopModel: 'gpt-5.6-terra' })
    const { executor, calls } = fakeExecutor(store)
    const domain = createSidecarRunControlsDomain(store, {
      executor,
      buildSnapshot: snapshotWithTerraAndOpus,
      providerSwitchLocked: true,
    })

    expect(domain.getSnapshot().model.providerSwitchLocked).toBe(true)
    expect(domain.setModel('opus')).toMatchObject({ ok: false, changed: false })
    expect(calls).toEqual([])
  } finally {
    setProviderSwitchLocked(previousLock)
    setSessionProvider(previousProvider)
  }
})

test('rejects unsupported model and effort values without calling the executor', () => {
  const store = makeStore({ mainLoopModel: 'gpt-5.6-terra' })
  const { executor, calls } = fakeExecutor(store)
  const domain = createSidecarRunControlsDomain(store, { executor })

  expect(domain.setModel('forged-model')).toMatchObject({ ok: false, changed: false })
  expect(domain.setEffort('forged-effort')).toMatchObject({ ok: false, changed: false })
  expect(calls).toEqual([])
})

test('rejects enabling fast mode when the live model/account gates do not allow it', () => {
  const store = makeStore({ mainLoopModel: 'claude-haiku-4-5-20251001' })
  const { executor, calls } = fakeExecutor(store)
  const domain = createSidecarRunControlsDomain(store, {
    executor,
    buildSnapshot(state) {
      const snapshot = buildRunControlsSnapshot(state)
      return {
        ...snapshot,
        fast: {
          active: false,
          supportedByModel: false,
          available: false,
          unavailableReason: 'Fast mode requires an eligible subscription.',
        },
      }
    },
  })

  expect(domain.setFast(true)).toMatchObject({ ok: false, changed: false })
  expect(calls).toEqual([])
})

test('buildRunControlsSnapshot degrades gracefully and reports effective plus selected effort', () => {
  const snap = buildRunControlsSnapshot({
    ...getDefaultAppState(),
    effortValue: 'high',
    fastMode: true,
  })
  expect(snap.effort.current).toBe('high')
  expect(snap.effort.selected).toBe('high')
  expect(snap.fast.active).toBe(true)
  // getModelOptions is engine-tier-dependent; the builder is throw-free so options
  // is always an array (degrades to [] on any failure), never a crash.
  expect(Array.isArray(snap.model.options)).toBe(true)
  expect(
    snap.model.options.every(
      option => option.provider === 'openai' || option.provider === 'anthropic',
    ),
  ).toBe(true)
})

test('LIVE: the real executor wires the engine setters — model override flips, effort + fast take effect', () => {
  const prevOverride = getMainLoopModelOverride()
  const prevProvider = getSessionProvider()
  const prevEffortEnv = process.env.CLAUDE_CODE_EFFORT_LEVEL
  const previousLock = isProviderSwitchLocked()
  try {
    setProviderSwitchLocked(false)
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    setSessionProvider('openai')
    const store = makeStore()
    // Default (real) executor → the engine's OWN setters.
    const domain = createSidecarRunControlsDomain(store, {
      buildSnapshot: snapshotWithTerraAndFast,
    })

    // model.set → `setMainLoopModelOverride` so `getMainLoopModel()` (the SAME
    // resolver QueryEngine reads per turn) returns it; gpt-* → openai provider.
    const modelResult = domain.setModel('gpt-5.6-terra')
    expect(modelResult).toMatchObject({ ok: true, changed: true })
    expect(getMainLoopModelOverride()).toBe('gpt-5.6-terra')
    expect(getMainLoopModel()).toBe('gpt-5.6-terra')
    expect(getSessionProvider()).toBe('openai')
    expect(store.getState().mainLoopModel).toBe('gpt-5.6-terra')

    // effort.set → `AppState.effortValue` (QueryEngine reads it per request).
    // 'xhigh' is non-persistable (toPersistableEffort → undefined), so this LIVE
    // path writes NO settings file — only the in-memory store.
    domain.setEffort('xhigh')
    expect(store.getState().effortValue).toBe('xhigh')

    // fast.set → the engine's own `applyFastMode` (gpt-5.6-terra supports fast).
    domain.setFast(true)
    expect(store.getState().fastMode).toBe(true)
    domain.setFast(false)
    expect(store.getState().fastMode).toBe(false)

    // A raw selection unsupported by the next model must return to Auto rather
    // than leaving a clamped effective face with no checked picker row.
    const sonnetDomain = createSidecarRunControlsDomain(store, {
      buildSnapshot: snapshotWithTerraAndSonnet,
    })
    expect(sonnetDomain.setModel('sonnet')).toMatchObject({
      ok: true,
      changed: true,
    })
    expect(store.getState().effortValue).toBeUndefined()

    // Selecting a Claude alias from an OpenAI session must cross the provider
    // boundary too. Merely changing the model string leaves the request routed
    // through the Codex adapter and is the production failure that originally
    // forced the desktop picker to hide Anthropic options.
    const crossProviderDomain = createSidecarRunControlsDomain(store, {
      buildSnapshot: snapshotWithTerraAndOpus,
    })
    const opusResult = crossProviderDomain.setModel('opus')
    expect(opusResult).toMatchObject({ ok: true, changed: true })
    expect(getMainLoopModelOverride()).toBe('opus')
    expect(getSessionProvider()).toBe('firstParty')
  } finally {
    setProviderSwitchLocked(previousLock)
    setMainLoopModelOverride(prevOverride)
    setSessionProvider(prevProvider)
    if (prevEffortEnv === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    else process.env.CLAUDE_CODE_EFFORT_LEVEL = prevEffortEnv
  }
})
