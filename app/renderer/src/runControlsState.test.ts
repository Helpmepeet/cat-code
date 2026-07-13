import { expect, test } from 'bun:test'
import {
  createRunControlsState,
  reduceRunControlsState,
  selectRunControlsSnapshot,
} from './runControlsState.js'
import type { RunControlsSnapshot, ServerFrame } from '../../shared/protocol.js'

const SNAPSHOT: RunControlsSnapshot = {
  model: {
    current: 'gpt-5.6-terra',
    selected: 'gpt-5.6-terra',
    options: [{ value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', provider: 'openai' }],
  },
  effort: { current: 'high', supported: true, options: ['low', 'medium', 'high'] },
  fast: { active: false, supportedByModel: true, available: true, unavailableReason: null },
}

function snapshotFrame(sessionId: string, runControls: RunControlsSnapshot): ServerFrame {
  return { kind: 'run-controls.snapshot', protocolVersion: 1, sessionId, runControls }
}

test('stores the latest run-controls snapshot per session and selects it', () => {
  let state = createRunControlsState()
  state = reduceRunControlsState(state, { type: 'frame', frame: snapshotFrame('s1', SNAPSHOT) })
  expect(selectRunControlsSnapshot(state, 's1')).toEqual(SNAPSHOT)
  expect(selectRunControlsSnapshot(state, 's2')).toBeNull()
  expect(selectRunControlsSnapshot(state, null)).toBeNull()
})

test('a later snapshot replaces the earlier one (live update)', () => {
  let state = createRunControlsState()
  state = reduceRunControlsState(state, { type: 'frame', frame: snapshotFrame('s1', SNAPSHOT) })
  const next: RunControlsSnapshot = {
    ...SNAPSHOT,
    model: { ...SNAPSHOT.model, current: 'opus', selected: 'opus' },
    fast: { ...SNAPSHOT.fast, active: true },
  }
  state = reduceRunControlsState(state, { type: 'frame', frame: snapshotFrame('s1', next) })
  expect(selectRunControlsSnapshot(state, 's1')?.model.current).toBe('opus')
  expect(selectRunControlsSnapshot(state, 's1')?.fast.active).toBe(true)
})

test('a lifecycle frame clears a tracked session but leaves untracked ones alone', () => {
  let state = createRunControlsState()
  state = reduceRunControlsState(state, { type: 'frame', frame: snapshotFrame('s1', SNAPSHOT) })
  const before = state
  state = reduceRunControlsState(state, {
    type: 'frame',
    frame: { kind: 'lifecycle', protocolVersion: 1, sessionId: 's2', status: 'disconnected' },
  })
  expect(state).toBe(before) // untracked session → no change
  state = reduceRunControlsState(state, {
    type: 'frame',
    frame: { kind: 'lifecycle', protocolVersion: 1, sessionId: 's1', status: 'disconnected' },
  })
  expect(selectRunControlsSnapshot(state, 's1')).toBeNull()
})
