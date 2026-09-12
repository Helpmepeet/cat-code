import { expect, test } from 'bun:test'
import {
  createRunControlsState,
  reduceRunControlsState,
  selectLastRunControlsSnapshot,
  selectRunControlsSnapshot,
} from './runControlsState.js'
import type { RunControlsSnapshot, ServerFrame } from '../../shared/protocol.js'

const SNAPSHOT: RunControlsSnapshot = {
  model: {
    current: 'gpt-5.6-terra',
    currentLabel: 'GPT-5.6 Terra',
    contextWindow: 372_000,
    selected: 'gpt-5.6-terra',
    provider: 'openai',
    providerSwitchLocked: false,
    options: [
      {
        value: 'gpt-5.6-terra',
        label: 'GPT-5.6 Terra',
        provider: 'openai',
        effortOptions: ['low', 'medium', 'high'],
      },
    ],
  },
  effort: {
    current: 'high',
    selected: 'high',
    supported: true,
    options: ['low', 'medium', 'high'],
  },
  fast: { active: false, supportedByModel: true, available: true, unavailableReason: null },
  autoCompact: { enabled: true, threshold: null, warningThreshold: null },
}

function snapshotFrame(sessionId: string, runControls: RunControlsSnapshot): ServerFrame {
  return { kind: 'run-controls.snapshot', protocolVersion: 2, sessionId, runControls }
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
    frame: { kind: 'lifecycle', protocolVersion: 2, sessionId: 's2', status: 'disconnected' },
  })
  expect(state).toBe(before) // untracked session → no change
  state = reduceRunControlsState(state, {
    type: 'frame',
    frame: { kind: 'lifecycle', protocolVersion: 2, sessionId: 's1', status: 'disconnected' },
  })
  expect(selectRunControlsSnapshot(state, 's1')).toBeNull()
})

/* --------------------------------------------------------------------- *
 * display outlives the process (the disconnect/park rail)
 * --------------------------------------------------------------------- */

test('a disconnected session still reports what it ran on', () => {
  // The defect: losing the engine also erased the answer, so the composer rail's
  // model, effort and fast faces went blank on a session nothing had changed.
  let state = createRunControlsState()
  state = reduceRunControlsState(state, { type: 'frame', frame: snapshotFrame('s1', SNAPSHOT) })
  state = reduceRunControlsState(state, {
    type: 'frame',
    frame: { kind: 'lifecycle', protocolVersion: 2, sessionId: 's1', status: 'disconnected' },
  })
  // Capability: gone, so no picker can be armed.
  expect(selectRunControlsSnapshot(state, 's1')).toBeNull()
  // Display: unchanged, because none of it stopped being true.
  expect(selectLastRunControlsSnapshot(state, 's1')).toEqual(SNAPSHOT)
  expect(selectLastRunControlsSnapshot(state, 's1')?.model.contextWindow).toBe(372_000)
})

test('the display selector answers for every terminal status, and only for known sessions', () => {
  for (const status of ['disconnected', 'failed', 'exited'] as const) {
    let state = createRunControlsState()
    state = reduceRunControlsState(state, { type: 'frame', frame: snapshotFrame('s1', SNAPSHOT) })
    state = reduceRunControlsState(state, {
      type: 'frame',
      frame: { kind: 'lifecycle', protocolVersion: 2, sessionId: 's1', status },
    })
    expect(selectLastRunControlsSnapshot(state, 's1')?.effort.current).toBe('high')
  }
  const empty = createRunControlsState()
  expect(selectLastRunControlsSnapshot(empty, 's1')).toBeNull()
  expect(selectLastRunControlsSnapshot(empty, null)).toBeNull()
})

test('a re-attached session reports the FRESH snapshot, not the retained one', () => {
  let state = createRunControlsState()
  state = reduceRunControlsState(state, { type: 'frame', frame: snapshotFrame('s1', SNAPSHOT) })
  state = reduceRunControlsState(state, {
    type: 'frame',
    frame: { kind: 'lifecycle', protocolVersion: 2, sessionId: 's1', status: 'disconnected' },
  })
  const restored: RunControlsSnapshot = {
    ...SNAPSHOT,
    model: { ...SNAPSHOT.model, current: 'claude-opus-5', selected: 'claude-opus-5' },
  }
  state = reduceRunControlsState(state, { type: 'frame', frame: snapshotFrame('s1', restored) })
  expect(selectRunControlsSnapshot(state, 's1')?.model.current).toBe('claude-opus-5')
  expect(selectLastRunControlsSnapshot(state, 's1')?.model.current).toBe('claude-opus-5')
})
