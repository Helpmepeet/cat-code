import { expect, test } from 'bun:test'
import {
  createVerbAckResultState,
  forgetRecallRequests,
  RECALL_UNDELIVERABLE_MESSAGE,
  recallDeliveryFailureNotice,
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

function correlatedBadRequest(
  sessionId: string,
  message: string,
): VerbAckResultFrame {
  return {
    kind: 'error',
    protocolVersion: 1,
    sessionId,
    requestId: `bad-request-${sessionId}`,
    code: 'bad_request',
    message,
    retryable: false,
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

test('a correlated boundary rejection is stored and surfaces its redacted message', () => {
  const frame = correlatedBadRequest('s1', 'unexpected field')
  const state = reduceVerbAckResultState(createVerbAckResultState(), {
    type: 'frame',
    frame,
  })
  expect(selectLatestVerbAckResult(state, 's1')).toEqual(frame)
  expect(verbAckErrorToast(frame)).toEqual({
    message: 'unexpected field',
    tone: 'danger',
  })
})

test('an uncorrelated boundary rejection remains ignored', () => {
  const state = createVerbAckResultState()
  const frame: ServerFrame = {
    kind: 'error',
    protocolVersion: 1,
    sessionId: 's1',
    code: 'bad_request',
    message: 'framing error',
    retryable: false,
  }
  expect(reduceVerbAckResultState(state, { type: 'frame', frame })).toBe(state)
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
      model: {
        current: null,
        currentLabel: null,
        contextWindow: null,
        selected: null,
        provider: 'anthropic',
        providerSwitchLocked: false,
        options: [],
      },
      effort: { current: null, selected: null, supported: false, options: [] },
      fast: { active: false, supportedByModel: false, available: false, unavailableReason: null },
      autoCompact: { enabled: true, threshold: null, warningThreshold: null },
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

/* ── D1b: a recall that lost the race is a report, not a fault ─────────────── */

function promptRecallResult(
  ok: boolean,
  message: string,
  alreadyDelivered: number,
): VerbAckResultFrame {
  return {
    kind: 'prompt-recall.result',
    protocolVersion: 1,
    sessionId: 's1',
    requestId: `recall-${ok}`,
    ok,
    message,
    recalled: [],
    alreadyDelivered,
  }
}

test('D1b — a full recall says nothing; the text landing back in the composer is the story', () => {
  expect(
    verbAckErrorToast(promptRecallResult(true, 'Took the message back.', 0)),
  ).toBeNull()
})

test('D1b — a recall the engine beat warns in the softer tone, not danger', () => {
  // Danger red would claim something went wrong. Nothing did: the message is on
  // its way to the model, and saying so before the user retypes it is the whole
  // point of the frame.
  const message = 'That message already went to the model.'
  expect(verbAckErrorToast(promptRecallResult(false, message, 1))).toEqual({
    message,
    tone: 'warn',
  })
})

test('D1b — a recall that never reached the session says so', () => {
  // Electron main raises this when it cannot reach the session at all, and it
  // copies the renderer's own requestId onto it. It is not a `bad_request`, so
  // the reducer above ignores it and the recall was answered by silence: no
  // text came back, no message was shown, and the control sat there as if the
  // click had not happened.
  expect(
    recallDeliveryFailureNotice({
      kind: 'error',
      protocolVersion: 1,
      sessionId: 's1',
      requestId: 'recall-1',
      code: 'session_not_found',
      message: 'session 3f2 was not found',
      retryable: false,
    }),
  ).toBe(RECALL_UNDELIVERABLE_MESSAGE)
})

test('D1b — a boundary rejection is left to the verb-ack toast, not said twice', () => {
  // That frame IS folded above and toasts the sidecar's own redacted reason, so
  // a second line under the composer would restate it.
  expect(
    recallDeliveryFailureNotice(correlatedBadRequest('s1', 'unexpected field')),
  ).toBeNull()
})

test('D1b — the recall’s own answer is not a delivery failure', () => {
  expect(
    recallDeliveryFailureNotice(promptRecallResult(true, 'ok', 0)),
  ).toBeNull()
})

test('D1b — a session going away takes its unanswered recall ids with it', () => {
  // The minted ids are otherwise removed only by an answer, and a session whose
  // engine is gone never sends one, so the id stayed for the life of the page.
  const requests = new Map([
    ['recall-1', 's1'],
    ['recall-2', 's2'],
    ['recall-3', 's1'],
  ])
  forgetRecallRequests(requests, 's1')
  expect([...requests.keys()]).toEqual(['recall-2'])
  forgetRecallRequests(requests, 's3')
  expect([...requests.keys()]).toEqual(['recall-2'])
})

test('D1b — a recall result is kept per session like the other verb acks', () => {
  const state = reduceVerbAckResultState(createVerbAckResultState(), {
    type: 'frame',
    frame: promptRecallResult(false, 'already gone', 1) as ServerFrame,
  })
  expect(selectLatestVerbAckResult(state, 's1')?.kind).toBe(
    'prompt-recall.result',
  )
  expect(selectLatestVerbAckResult(state, 's2')).toBeNull()
})
