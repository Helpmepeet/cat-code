import { expect, test } from 'bun:test'
import type { LiveWorkerItem, LiveWorkersSnapshot, ServerFrame, SessionId } from '../../shared/protocol.js'
import type { ConnectionSnapshot } from './connectionState.js'
import { createWorkersState, reduceWorkersState } from './workersState.js'
import {
  INITIAL_SESSION_WORK_STATE,
  reduceSessionWork,
  selectSessionWorkMark,
  type SessionWorkState,
} from './sessionWorkState.js'

const A = 'a' as SessionId
const B = 'b' as SessionId
const NONE: ReadonlySet<SessionId> = new Set()

const event = (sessionId: SessionId, payload: unknown, extra: object = {}) =>
  ({ kind: 'event', protocolVersion: 4, sessionId, event: payload, ...extra }) as unknown as ServerFrame
const turn = (sessionId: SessionId, activeTurn: boolean, extra: object = {}) =>
  event(sessionId, { type: 'turn.status', activeTurn }, extra)
const result = (sessionId: SessionId, isError: boolean, subtype: string) =>
  event(sessionId, { type: 'message', message: { type: 'result', subtype, is_error: isError } })

function apply(
  frames: ServerFrame[],
  { state = INITIAL_SESSION_WORK_STATE, visible = NONE, baseline = false }:
    { state?: SessionWorkState; visible?: ReadonlySet<SessionId>; baseline?: boolean } = {},
): SessionWorkState {
  return reduceSessionWork(state, { type: 'frames', frames, visible, baseline })
}

const ready: ConnectionSnapshot = { status: 'ready', inputEnabled: true }
const busy: ConnectionSnapshot = { status: 'ready', inputEnabled: false }
const mark = (state: SessionWorkState, id: SessionId, connection: ConnectionSnapshot | undefined = ready, pendingPermissionCount = 0) =>
  selectSessionWorkMark({ connection, pendingPermissionCount, work: state.sessions[id] })

const worker = (agentId: string, status: LiveWorkerItem['status'] = 'running', isBackgrounded = true): LiveWorkerItem => ({
  agentId, status, isBackgrounded, handle: null, role: null, description: null,
})
const workersFrame = (sessionId: SessionId, workers: LiveWorkerItem[]): ServerFrame => ({
  kind: 'workers.snapshot', protocolVersion: 4, sessionId, workers: { workers },
})
const workerMark = (workers: LiveWorkersSnapshot | undefined, connection = ready, pendingPermissionCount = 0) =>
  selectSessionWorkMark({ connection, pendingPermissionCount, work: undefined, workers })

test('an idle parent stays working until its last running subagent settles', () => {
  let workers = createWorkersState()
  const update = (items: LiveWorkerItem[]) => {
    workers = reduceWorkersState(workers, { type: 'frame', frame: workersFrame(A, items) })
    return workerMark(workers.bySession[A])
  }
  expect(update([worker('first'), worker('second')])).toBe('working')
  expect(workerMark(workers.bySession[B])).toBeNull()
  expect(update([worker('first', 'completed'), worker('second')])).toBe('working')
  expect(update([worker('first', 'completed'), worker('second', 'completed')])).toBeNull()
  // A resumed foreground worker is active too.
  expect(update([worker('second', 'running', false)])).toBe('working')
  expect(update([])).toBeNull()
})

test('settled subagents never spin, including a blocked handoff', () => {
  expect(workerMark({ workers: [
    worker('done', 'completed'),
    worker('failed', 'failed'),
    worker('stopped', 'killed'),
    { ...worker('blocked', 'completed'), handoffStatus: 'blocked' },
  ] })).toBeNull()
})

test('active subagents respect attention priority and connection liveness', () => {
  const workers = { workers: [worker('background')] }
  expect(workerMark(workers, ready, 1)).toBe('needs-you')
  for (const status of ['connecting', 'starting', 'disconnected', 'dead', 'parked', 'restore_failed'] as const) {
    expect(workerMark(workers, { status, inputEnabled: false })).toBeNull()
  }
  const work = apply([turn(A, true), result(A, true, 'error_max_turns'), turn(A, false)]).sessions[A]
  expect(selectSessionWorkMark({ connection: ready, pendingPermissionCount: 0, work, workers })).toBe('working')
  expect(selectSessionWorkMark({ connection: ready, pendingPermissionCount: 0, work, workers: { workers: [] } })).toBe('failed')
})

test('a turn that ends off screen is unseen until the session is viewed', () => {
  let state = apply([turn(A, true), turn(A, false)])
  expect(mark(state, A)).toBe('unseen')
  state = reduceSessionWork(state, { type: 'seen', sessionIds: [A] })
  expect(mark(state, A)).toBeNull()
})

test('a turn that ends on screen is never unseen', () => {
  const state = apply([turn(A, true), turn(A, false)], { visible: new Set([A]) })
  expect(mark(state, A)).toBeNull()
})

test('the renderer\'s first batch (attachment replay after a reload) marks nothing unseen', () => {
  const state = apply([turn(A, true), turn(A, false), turn(B, true), turn(B, false)], { baseline: true })
  expect(mark(state, A)).toBeNull()
  expect(mark(state, B)).toBeNull()
  // A later live turn end still counts.
  expect(mark(apply([turn(A, true), turn(A, false)], { state }), A)).toBe('unseen')
})

test('restored-history frames from a resumed sidecar are ignored', () => {
  const state = apply([turn(A, true, { replay: true }), turn(A, false, { replay: true })])
  expect(state).toBe(INITIAL_SESSION_WORK_STATE)
})

test('an error result marks the session failed until the next turn starts', () => {
  let state = apply([turn(A, true), result(A, true, 'error_during_execution'), turn(A, false)])
  expect(mark(state, A)).toBe('failed')
  // Viewing it does not clear a failure.
  state = reduceSessionWork(state, { type: 'seen', sessionIds: [A] })
  expect(mark(state, A)).toBe('failed')
  state = apply([turn(A, true)], { state })
  expect(mark(state, A, busy)).toBe('working')
  state = apply([result(A, false, 'success'), turn(A, false)], { state })
  expect(mark(state, A)).toBe('unseen')
})

test('a user stop is not a failure', () => {
  const state = apply([turn(A, true), result(A, true, 'interrupted'), turn(A, false)], { visible: new Set([A]) })
  expect(mark(state, A)).toBeNull()
})

test('a subagent result does not decide the parent turn outcome', () => {
  const state = apply([
    turn(A, true),
    event(A, { type: 'message', message: { type: 'result', subtype: 'error_during_execution', is_error: true, parent_tool_use_id: 'tool-1' } }),
    turn(A, false),
  ], { visible: new Set([A]) })
  expect(mark(state, A)).toBeNull()
})

test('a waiting request outranks a running turn, which outranks failed and unseen', () => {
  const state = apply([turn(A, true), result(A, true, 'error_max_turns'), turn(A, false)])
  expect(mark(state, A, busy, 1)).toBe('needs-you')
  expect(mark(state, A, busy, 0)).toBe('working')
  expect(mark(state, A, ready, 0)).toBe('failed')
})

test('connection state alone never produces a mark', () => {
  for (const status of ['connecting', 'starting', 'dead', 'parked', 'restore_failed'] as const) {
    expect(mark(INITIAL_SESSION_WORK_STATE, A, { status, inputEnabled: false }, 1)).toBeNull()
  }
  expect(mark(INITIAL_SESSION_WORK_STATE, A, undefined)).toBeNull()
  expect(mark(INITIAL_SESSION_WORK_STATE, A, ready)).toBeNull()
})

test('a parked session keeps its unread reply', () => {
  const state = apply([turn(A, true), turn(A, false)])
  expect(mark(state, A, { status: 'parked', inputEnabled: false })).toBe('unseen')
})

test('session removal drops its entry; no-op actions keep identity', () => {
  const state = apply([turn(A, true), turn(A, false)])
  expect(reduceSessionWork(state, { type: 'session-removed', sessionId: A }).sessions[A]).toBeUndefined()
  expect(reduceSessionWork(state, { type: 'session-removed', sessionId: B })).toBe(state)
  const seen = reduceSessionWork(state, { type: 'seen', sessionIds: [A] })
  expect(reduceSessionWork(seen, { type: 'seen', sessionIds: [A, B] })).toBe(seen)
})
