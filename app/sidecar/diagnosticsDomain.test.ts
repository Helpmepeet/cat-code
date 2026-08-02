import { expect, test } from 'bun:test'
import { getDefaultAppState, type AppState } from '../../src/state/AppStateStore.js'
import { createStore } from '../../src/state/store.js'
import { getBranch } from '../../src/utils/git.js'
import { createSidecarDiagnosticsDomain } from './diagnosticsDomain.js'

// The compiled sidecar receives MACRO via Bun's build defines
// (initializeRuntime.ts); a bare unit test mirrors that same fallback so
// `MACRO.VERSION` is defined before the domain reads it.
;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??= {
  VERSION: 'test-version',
}

function makeAppStateStore(overrides: Partial<AppState> = {}) {
  return createStore({ ...getDefaultAppState(), ...overrides })
}

test('the domain reads once at spawn — getSnapshot returns a stable reference', async () => {
  const domain = await createSidecarDiagnosticsDomain(makeAppStateStore())
  const first = domain.getSnapshot()
  const second = domain.getSnapshot()
  expect(first).toBe(second)
})

test('reads the real MACRO version, sandbox flag, and model/effort/fast from the live app-state store', async () => {
  const domain = await createSidecarDiagnosticsDomain(
    makeAppStateStore({
      mainLoopModel: 'claude-opus-4-6',
      mainLoopModelForSession: 'claude-opus-4-6',
      effortValue: 'high',
      fastMode: true,
    }),
  )
  const snapshot = domain.getSnapshot()
  expect(snapshot).not.toBeNull()
  expect(snapshot?.version).toBe('test-version')
  expect(snapshot?.mainLoopModel).toBe('claude-opus-4-6')
  expect(snapshot?.mainLoopModelForSession).toBe('claude-opus-4-6')
  expect(snapshot?.reasoningEffort).toBe('high')
  expect(snapshot?.fastMode).toBe(true)
  expect(typeof snapshot?.sandboxEnabled).toBe('boolean')
  expect(Array.isArray(snapshot?.installationWarnings)).toBe(true)
  expect(Array.isArray(snapshot?.healthWarnings)).toBe(true)
  expect(Array.isArray(snapshot?.memoryWarnings)).toBe(true)
})

test('a null mainLoopModel override still resolves a session model; unset effort/fast report honestly', async () => {
  const domain = await createSidecarDiagnosticsDomain(makeAppStateStore())
  const snapshot = domain.getSnapshot()
  // The raw override is null (built-in default), not a fabricated label.
  expect(snapshot?.mainLoopModel).toBeNull()
  // mainLoopModelForSession falls back to the engine's own resolver
  // (getMainLoopModel) — a real string, or null only if resolution throws.
  const resolved = snapshot?.mainLoopModelForSession
  expect(resolved === null || typeof resolved === 'string').toBe(true)
  // No explicit effort set → null (running at the provider default), not "High".
  expect(snapshot?.reasoningEffort).toBeNull()
  // Fast mode is off unless explicitly enabled.
  expect(snapshot?.fastMode).toBe(false)
})

test('an explicit mainLoopModelForSession is preferred over the resolver fallback', async () => {
  const domain = await createSidecarDiagnosticsDomain(
    makeAppStateStore({ mainLoopModel: null, mainLoopModelForSession: 'gpt-5.6-terra' }),
  )
  expect(domain.getSnapshot()?.mainLoopModelForSession).toBe('gpt-5.6-terra')
})

// Live path, not shape-only: the branch on the wire must be what the ENGINE's own
// reader says, because the transcript catalog stamps its `gitBranch` with that
// same call (`src/utils/sessionStorage.ts:1464`) and the two must never disagree.
// This suite runs inside a git checkout, so the guarded arm is the real one.
test('the branch is the engine own getBranch(), with HEAD normalised to null', async () => {
  const engineBranch = await getBranch()
  const snapshot = (
    await createSidecarDiagnosticsDomain(makeAppStateStore())
  ).getSnapshot()
  if (engineBranch && engineBranch !== 'HEAD') {
    expect(snapshot?.gitBranch).toBe(engineBranch)
    expect(snapshot?.gitBranch?.length).toBeGreaterThan(0)
  } else {
    // No repo, or a detached HEAD: neither is a branch, so nothing is claimed.
    expect(snapshot?.gitBranch).toBeNull()
  }
})

test('a numeric effort value serialises to its string form', async () => {
  const domain = await createSidecarDiagnosticsDomain(
    makeAppStateStore({ effortValue: 3 }),
  )
  expect(domain.getSnapshot()?.reasoningEffort).toBe('3')
})
