import { expect, test } from 'bun:test'
import {
  createVerbAckResultState,
  reduceVerbAckResultState,
  selectLatestVerbAckResult,
  verbAckErrorToast,
  type VerbAckResultFrame,
} from './verbAckResultState.js'
import type { ServerFrame } from '../../shared/protocol.js'

/* ── frame builders (the four previously-unconsumed verb-ack results) ──────── */

function agentModeResult(
  sessionId: string,
  ok: boolean,
  message: string,
): VerbAckResultFrame {
  return {
    kind: 'agent-mode.set.result',
    protocolVersion: 1,
    sessionId,
    requestId: `agent-${sessionId}-${ok}`,
    ok,
    message,
  }
}

function taskControlResult(
  sessionId: string,
  ok: boolean,
  message: string,
): VerbAckResultFrame {
  return {
    kind: 'task-control.result',
    protocolVersion: 1,
    sessionId,
    requestId: `task-${sessionId}-${ok}`,
    verb: 'task.stop',
    ok,
    message,
  }
}

function runControlResult(
  sessionId: string,
  ok: boolean,
  message: string,
): VerbAckResultFrame {
  return {
    kind: 'run-control.result',
    protocolVersion: 1,
    sessionId,
    requestId: `run-${sessionId}-${ok}`,
    verb: 'model.set',
    ok,
    message,
  }
}

function settingsResult(
  sessionId: string,
  ok: boolean,
  message: string,
): VerbAckResultFrame {
  return {
    kind: 'settings.result',
    protocolVersion: 1,
    sessionId,
    requestId: `settings-${sessionId}-${ok}`,
    verb: 'settings.setValue',
    ok,
    message,
  }
}

const BUILDERS = [
  ['agent-mode.set.result', agentModeResult],
  ['task-control.result', taskControlResult],
  ['run-control.result', runControlResult],
  ['settings.result', settingsResult],
] as const

/* ── reducer: each verb's result is stored per session ─────────────────────── */

for (const [kind, build] of BUILDERS) {
  test(`stores the latest ${kind} per session and selects it`, () => {
    let state = createVerbAckResultState()
    const frame = build('s1', false, 'boom')
    state = reduceVerbAckResultState(state, { type: 'frame', frame })
    expect(selectLatestVerbAckResult(state, 's1')).toEqual(frame)
    expect(selectLatestVerbAckResult(state, 's2')).toBeNull()
    expect(selectLatestVerbAckResult(state, null)).toBeNull()
  })
}

test('a later ack replaces the earlier one for the same session', () => {
  let state = createVerbAckResultState()
  state = reduceVerbAckResultState(state, {
    type: 'frame',
    frame: runControlResult('s1', false, 'first'),
  })
  const latest = settingsResult('s1', true, 'second')
  state = reduceVerbAckResultState(state, { type: 'frame', frame: latest })
  expect(selectLatestVerbAckResult(state, 's1')).toEqual(latest)
})

test('a lifecycle frame clears a tracked session but leaves untracked ones alone', () => {
  let state = createVerbAckResultState()
  state = reduceVerbAckResultState(state, {
    type: 'frame',
    frame: agentModeResult('s1', false, 'boom'),
  })
  const before = state
  state = reduceVerbAckResultState(state, {
    type: 'frame',
    frame: { kind: 'lifecycle', protocolVersion: 1, sessionId: 's2', status: 'disconnected' },
  })
  expect(state).toBe(before) // untracked session → no change
  state = reduceVerbAckResultState(state, {
    type: 'frame',
    frame: { kind: 'lifecycle', protocolVersion: 1, sessionId: 's1', status: 'disconnected' },
  })
  expect(selectLatestVerbAckResult(state, 's1')).toBeNull()
})

test('an unrelated frame kind is ignored (no consumer, no crash)', () => {
  let state = createVerbAckResultState()
  const before = state
  const unrelated: ServerFrame = {
    kind: 'run-controls.snapshot',
    protocolVersion: 1,
    sessionId: 's1',
    runControls: {
      model: { current: null, selected: null, options: [] },
      effort: { current: null, supported: false, options: [] },
      fast: { active: false, supportedByModel: false, available: false, unavailableReason: null },
    },
  }
  state = reduceVerbAckResultState(state, { type: 'frame', frame: unrelated })
  expect(state).toBe(before)
})

/* ── verbAckErrorToast: FAILURE → danger toast with the real text; SUCCESS → null ─ */

for (const [kind, build] of BUILDERS) {
  test(`${kind} FAILURE surfaces a danger toast carrying the frame's real message`, () => {
    const message = `${kind} rejected: not allowed`
    const toastPayload = verbAckErrorToast(build('s1', false, message))
    expect(toastPayload).toEqual({ message, tone: 'danger' })
  })

  test(`${kind} SUCCESS surfaces nothing (snapshot re-broadcast already updated the UI)`, () => {
    expect(verbAckErrorToast(build('s1', true, 'ok'))).toBeNull()
  })
}
