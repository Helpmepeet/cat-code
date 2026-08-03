import { expect, test } from 'bun:test'
import {
  getMainLoopModel,
} from '../../src/utils/model/model.js'
import {
  getMainLoopModelOverride,
  getSdkBetas,
  getSessionProvider,
  isProviderSwitchLocked,
  setMainLoopModelOverride,
  setProviderSwitchLocked,
  setSessionProvider,
} from '../../src/bootstrap/state.js'
import { getContextWindowForModel } from '../../src/utils/context.js'
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

test('selected always names one of the offered options, so a row is always highlighted', () => {
  // The renderer highlights by plain string equality (`ComposerActionsBar.tsx`
  // `selected === option.value`). The engine offers each model under whichever
  // spelling its tier list uses — the family alias `sonnet` on first party, the
  // canonical `claude-sonnet-5` inside a Codex session — while the saved setting
  // keeps whatever spelling was persisted. If the two disagree, the picker opens
  // with NO row highlighted, so the sidecar must align them.
  const prevOverride = getMainLoopModelOverride()
  const prevProvider = getSessionProvider()
  const prevApiKey = process.env.ANTHROPIC_API_KEY
  try {
    setSessionProvider('firstParty')
    // Unmocked engine auth reads throw under NODE_ENV=test with no credential
    // env var, which would degrade the option list to [] and prove nothing.
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-api-key'

    for (const setting of [
      'claude-fable-5',
      'claude-sonnet-5',
      'claude-opus-5',
      'sonnet',
      'opusplan',
    ]) {
      setMainLoopModelOverride(setting)
      const snapshot = buildRunControlsSnapshot(getDefaultAppState())
      expect(snapshot.model.options.length).toBeGreaterThan(0)
      expect(snapshot.model.options.map(option => option.value)).toContain(
        snapshot.model.selected,
      )
    }

    // No override keeps the provider-default row (value null) highlighted.
    setMainLoopModelOverride(null)
    expect(
      buildRunControlsSnapshot(getDefaultAppState()).model.selected,
    ).toBeNull()
  } finally {
    setMainLoopModelOverride(prevOverride)
    setSessionProvider(prevProvider)
    if (prevApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = prevApiKey
  }
})

/**
 * LIVE: the two composer-face facts about the CURRENT model.
 *
 * Both defects fixed on 2026-07-29 were the absence of these. The face printed
 * `current`, which is the model ID the engine resolves a selection to, so
 * picking "Haiku 4.5" read `claude-haiku-4-5-20251001`. And nothing on the wire
 * stated a context window before the first turn, so the gauge divided every
 * model by the renderer's 200k default.
 *
 * Neither is derivable in the renderer: a name needs the engine's marketing
 * table, and a window depends on betas, the model-capability cache, and env
 * overrides. So this asserts they come from the engine's OWN functions, on real
 * process state, not from a second table in app/ (§10). Comparing the window
 * against `getContextWindowForModel` is what pins the SOURCE; the literal 1M is
 * what pins the VALUE, since a Claude 5 model gets a 1M window with no `[1m]`
 * suffix (`src/utils/context.ts:56`) and 200k for it is simply wrong.
 */
test('LIVE: the snapshot carries the engine display name and context window for the current model', () => {
  const prevOverride = getMainLoopModelOverride()
  const prevProvider = getSessionProvider()
  const prevApiKey = process.env.ANTHROPIC_API_KEY
  try {
    setSessionProvider('firstParty')
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-api-key'

    setMainLoopModelOverride('claude-opus-5')
    const opus = buildRunControlsSnapshot(getDefaultAppState()).model
    expect(opus.current).toBe('claude-opus-5')
    expect(opus.currentLabel).toBe('Opus 5')
    expect(opus.contextWindow).toBe(1_000_000)
    expect(opus.contextWindow).toBe(
      getContextWindowForModel('claude-opus-5', getSdkBetas()),
    )

    // A family ALIAS is the case the operator hit: the picker offers `haiku`,
    // the engine resolves it to a dated id, and the face must still read the
    // name. The window comes from the same engine call, whatever it answers.
    setMainLoopModelOverride('haiku')
    const haiku = buildRunControlsSnapshot(getDefaultAppState()).model
    expect(haiku.current).toContain('claude-haiku-4-5')
    expect(haiku.currentLabel).toBe('Haiku 4.5')
    expect(haiku.contextWindow).toBe(
      getContextWindowForModel(haiku.current ?? '', getSdkBetas()),
    )
    // …and the window genuinely MOVED with the selection. A snapshot that
    // reported one constant for every model is the reported bug.
    expect(haiku.contextWindow).not.toBe(opus.contextWindow)

    // No override: the face describes what the provider default RESOLVES to,
    // not the "Default (recommended)" row, which names no model at all.
    setMainLoopModelOverride(null)
    const fallback = buildRunControlsSnapshot(getDefaultAppState()).model
    expect(fallback.selected).toBeNull()
    expect(fallback.current).not.toBeNull()
    expect(fallback.currentLabel).not.toBe('Default (recommended)')
    expect(fallback.contextWindow).toBeGreaterThan(0)
  } finally {
    setMainLoopModelOverride(prevOverride)
    setSessionProvider(prevProvider)
    if (prevApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = prevApiKey
  }
})

test('LIVE: the desktop Fast control is not supported for Anthropic models', () => {
  const previousOverride = getMainLoopModelOverride()
  const previousProvider = getSessionProvider()
  const previousApiKey = process.env.ANTHROPIC_API_KEY
  try {
    setSessionProvider('firstParty')
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-api-key'
    setMainLoopModelOverride('claude-opus-5')

    const snapshot = buildRunControlsSnapshot({
      ...getDefaultAppState(),
      fastMode: true,
    })
    expect(snapshot.model.provider).toBe('anthropic')
    expect(snapshot.fast.active).toBe(true)
    expect(snapshot.fast.supportedByModel).toBe(false)
  } finally {
    setMainLoopModelOverride(previousOverride)
    setSessionProvider(previousProvider)
    if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previousApiKey
  }
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
    domain.setFast(true)
    expect(store.getState().fastMode).toBe(true)

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
    expect(store.getState().fastMode).toBe(false)
    expect(crossProviderDomain.getSnapshot().fast.supportedByModel).toBe(false)
  } finally {
    setProviderSwitchLocked(previousLock)
    setMainLoopModelOverride(prevOverride)
    setSessionProvider(prevProvider)
    if (prevEffortEnv === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    else process.env.CLAUDE_CODE_EFFORT_LEVEL = prevEffortEnv
  }
})
