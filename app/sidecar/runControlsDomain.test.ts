import { expect, test } from 'bun:test'
import {
  getMainLoopModel,
} from '../../src/utils/model/model.js'
import {
  getMainLoopModelOverride,
  getSessionProvider,
  setMainLoopModelOverride,
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
    },
    calls,
  }
}

test('setModel via the executor mutates the store, reports changed, and notifies subscribers (idempotent no-op)', () => {
  const store = makeStore()
  const { executor, calls } = fakeExecutor(store)
  const domain = createSidecarRunControlsDomain(store, { executor })

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
})

test('setEffort and setFast route through the executor and reflect in the snapshot', () => {
  const store = makeStore({ mainLoopModel: 'gpt-5.6-terra' })
  const { executor, calls } = fakeExecutor(store)
  const domain = createSidecarRunControlsDomain(store, { executor })

  const effortResult = domain.setEffort('high')
  expect(effortResult).toMatchObject({ ok: true, changed: true })
  expect(store.getState().effortValue).toBe('high')

  const fastResult = domain.setFast(true)
  expect(fastResult).toMatchObject({ ok: true, changed: true })
  expect(store.getState().fastMode).toBe(true)

  expect(calls).toEqual(['effort:high', 'fast:true'])
})

test('buildRunControlsSnapshot degrades gracefully and reflects the store effort/fast', () => {
  const snap = buildRunControlsSnapshot({
    ...getDefaultAppState(),
    effortValue: 'high',
    fastMode: true,
  })
  expect(snap.effort.current).toBe('high')
  expect(snap.fast.active).toBe(true)
  // getModelOptions is engine-tier-dependent; the builder is throw-free so options
  // is always an array (degrades to [] on any failure), never a crash.
  expect(Array.isArray(snap.model.options)).toBe(true)
  // Anthropic models are filtered out — the desktop picker is Codex/OpenAI only.
  expect(snap.model.options.every(o => o.provider === 'openai')).toBe(true)
})

test('LIVE: the real executor wires the engine setters — model override flips, effort + fast take effect', () => {
  const prevOverride = getMainLoopModelOverride()
  const prevProvider = getSessionProvider()
  const prevEffortEnv = process.env.CLAUDE_CODE_EFFORT_LEVEL
  try {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    const store = makeStore()
    // Default (real) executor → the engine's OWN setters.
    const domain = createSidecarRunControlsDomain(store)

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
  } finally {
    setMainLoopModelOverride(prevOverride)
    setSessionProvider(prevProvider)
    if (prevEffortEnv === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    else process.env.CLAUDE_CODE_EFFORT_LEVEL = prevEffortEnv
  }
})
