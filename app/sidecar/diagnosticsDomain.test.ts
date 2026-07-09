import { expect, test } from 'bun:test'
import { getDefaultAppState } from '../../src/state/AppStateStore.js'
import { createStore } from '../../src/state/store.js'
import { createSidecarDiagnosticsDomain } from './diagnosticsDomain.js'

// The compiled sidecar receives MACRO via Bun's build defines
// (initializeRuntime.ts); a bare unit test mirrors that same fallback so
// `MACRO.VERSION` is defined before the domain reads it.
;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??= {
  VERSION: 'test-version',
}

function makeAppStateStore(mainLoopModel: string | null = null) {
  const base = getDefaultAppState()
  return createStore({ ...base, mainLoopModel })
}

test('the domain reads once at spawn — getSnapshot returns a stable reference', async () => {
  const domain = await createSidecarDiagnosticsDomain(makeAppStateStore())
  const first = domain.getSnapshot()
  const second = domain.getSnapshot()
  expect(first).toBe(second)
})

test('reads the real MACRO version, sandbox flag, and mainLoopModel from the live app-state store', async () => {
  const domain = await createSidecarDiagnosticsDomain(makeAppStateStore('claude-opus-4-6'))
  const snapshot = domain.getSnapshot()
  expect(snapshot).not.toBeNull()
  expect(snapshot?.version).toBe('test-version')
  expect(snapshot?.mainLoopModel).toBe('claude-opus-4-6')
  expect(typeof snapshot?.sandboxEnabled).toBe('boolean')
  expect(Array.isArray(snapshot?.installationWarnings)).toBe(true)
  expect(Array.isArray(snapshot?.healthWarnings)).toBe(true)
  expect(Array.isArray(snapshot?.memoryWarnings)).toBe(true)
})

test('a null mainLoopModel (built-in default) round-trips as null, not a fabricated label', async () => {
  const domain = await createSidecarDiagnosticsDomain(makeAppStateStore(null))
  const snapshot = domain.getSnapshot()
  expect(snapshot?.mainLoopModel).toBeNull()
})
