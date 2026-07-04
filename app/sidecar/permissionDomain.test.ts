import { expect, test } from 'bun:test'
import { getDefaultAppState } from '../../src/state/AppStateStore.js'
import { createStore } from '../../src/state/store.js'
import type { ToolPermissionContext } from '../../src/Tool.js'
import { createSidecarPermissionDomain } from './permissionDomain.js'

function makeStore(context?: Partial<ToolPermissionContext>) {
  const base = getDefaultAppState()
  return createStore({
    ...base,
    toolPermissionContext: { ...base.toolPermissionContext, ...context },
  })
}

test('setMode applies the requested external mode to the live context', () => {
  const store = makeStore()
  const domain = createSidecarPermissionDomain(store)

  domain.setMode('acceptEdits')

  expect(store.getState().toolPermissionContext.mode).toBe('acceptEdits')
  expect(domain.getToolPermissionContext().mode).toBe('acceptEdits')
})

test('setMode runs the REAL engine transition, not a bare mode assignment', () => {
  // transitionPermissionMode clears the prePlanMode stash on plan exit
  // (permissionSetup.ts — the cleanup a bare `applyPermissionUpdate({type:
  // 'setMode'})` would skip). If the stash survives, the idiom regressed.
  const store = makeStore({ mode: 'plan', prePlanMode: 'acceptEdits' })
  const domain = createSidecarPermissionDomain(store)

  domain.setMode('default')

  const context = store.getState().toolPermissionContext
  expect(context.mode).toBe('default')
  expect(context.prePlanMode).toBeUndefined()
})

test('setMode to the current mode preserves the context reference (no churn)', () => {
  const store = makeStore({ mode: 'dontAsk' })
  const domain = createSidecarPermissionDomain(store)
  const before = store.getState().toolPermissionContext

  domain.setMode('dontAsk')

  expect(store.getState().toolPermissionContext).toBe(before)
})

test('subscribeToolPermissionContext fires only on context changes', () => {
  const store = makeStore()
  const domain = createSidecarPermissionDomain(store)
  const seen: string[] = []
  const unsubscribe = domain.subscribeToolPermissionContext(context => {
    seen.push(context.mode)
  })

  // Unrelated app-state change: context reference untouched → no callback.
  store.setState(prev => ({ ...prev, thinkingEnabled: !prev.thinkingEnabled }))
  expect(seen).toEqual([])

  domain.setMode('plan')
  expect(seen).toEqual(['plan'])

  unsubscribe()
  domain.setMode('default')
  expect(seen).toEqual(['plan'])
})
