import { expect, test } from 'bun:test'
import type { DiagnosticsSnapshot, ServerFrame } from '../../shared/protocol.js'
import {
  createDiagnosticsState,
  reduceDiagnosticsState,
  selectDiagnosticsSnapshot,
} from './diagnosticsState.js'

const SNAPSHOT: DiagnosticsSnapshot = {
  version: '2.1.87-dev',
  mainLoopModel: null,
  mainLoopModelForSession: 'gpt-5.6-terra',
  reasoningEffort: null,
  fastMode: false,
  sandboxEnabled: true,
  gitBranch: null,
  installationWarnings: [],
  healthWarnings: ['Found invalid settings files: /tmp/x.json. They will be ignored.'],
  memoryWarnings: [],
}

function snapshotFrame(sessionId: string, diagnostics: DiagnosticsSnapshot): ServerFrame {
  return { kind: 'diagnostics.snapshot', protocolVersion: 1, sessionId, diagnostics }
}

function lifecycleFrame(sessionId: string): ServerFrame {
  return { kind: 'lifecycle', protocolVersion: 1, sessionId, status: 'exited' }
}

test('diagnostics.snapshot frame stores the snapshot per session', () => {
  const state = reduceDiagnosticsState(createDiagnosticsState(), {
    type: 'frame',
    frame: snapshotFrame('a', SNAPSHOT),
  })
  expect(selectDiagnosticsSnapshot(state, 'a')).toEqual(SNAPSHOT)
  expect(selectDiagnosticsSnapshot(state, 'b')).toBeNull()
  expect(selectDiagnosticsSnapshot(state, null)).toBeNull()
})

test('snapshots are isolated across sessions', () => {
  let state = createDiagnosticsState()
  state = reduceDiagnosticsState(state, { type: 'frame', frame: snapshotFrame('a', SNAPSHOT) })
  const other: DiagnosticsSnapshot = {
    ...SNAPSHOT,
    mainLoopModel: 'claude-opus-4-6',
    healthWarnings: [],
  }
  state = reduceDiagnosticsState(state, { type: 'frame', frame: snapshotFrame('b', other) })
  expect(selectDiagnosticsSnapshot(state, 'a')).toEqual(SNAPSHOT)
  expect(selectDiagnosticsSnapshot(state, 'b')).toEqual(other)
})

test('lifecycle resets a tracked snapshot but ignores an untracked session', () => {
  let state = reduceDiagnosticsState(createDiagnosticsState(), {
    type: 'frame',
    frame: snapshotFrame('a', SNAPSHOT),
  })
  const before = state
  state = reduceDiagnosticsState(state, { type: 'frame', frame: lifecycleFrame('unknown') })
  expect(state).toBe(before)
  state = reduceDiagnosticsState(state, { type: 'frame', frame: lifecycleFrame('a') })
  expect(selectDiagnosticsSnapshot(state, 'a')).toBeNull()
})

test('unrelated frame kinds are ignored', () => {
  const state = createDiagnosticsState()
  const next = reduceDiagnosticsState(state, {
    type: 'frame',
    frame: { kind: 'pong', protocolVersion: 1, sessionId: 'a', nonce: 'x' },
  })
  expect(next).toBe(state)
})
