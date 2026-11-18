import { expect, test } from 'bun:test'
import { sessionDescriptor } from './sessionDescriptorFixture.js'
import { dismissSession, reopenSession } from './sessionDismissal.js'
import { createShellState, reduceShellState, withReloadedStopAttempts, type ShellState } from './shellState.js'
import { classifyStopResult, selectStopNotices, type StopOutcome } from './stopAttempts.js'

const chat = sessionDescriptor('a', { title: 'Investigate command permission prompts' })

function closedChat(): ShellState {
  let state = reduceShellState(createShellState(), { type: 'session-added', session: chat })
  state = reduceShellState(state, { type: 'session-dismissals', dismissals: dismissSession([], chat) })
  return state
}

function settle(state: ShellState, attempt: number, outcome: StopOutcome): ShellState {
  return reduceShellState(state, { type: 'stop-settled', sessionId: 'a', attempt, outcome })
}

function notices(state: ShellState) {
  return selectStopNotices(state.stopAttempts ?? {}, state.byId, state.dismissals ?? [])
}

test('host results map to stopped, unconfirmed, or a refusal with its reason', () => {
  expect(classifyStopResult({ ok: true, value: undefined })).toEqual({ kind: 'stopped' })
  expect(classifyStopResult({ ok: false, error: { code: 'session_not_found', message: 'unknown session a' } }))
    .toEqual({ kind: 'stopped' })
  expect(classifyStopResult({ ok: false, error: { code: 'stop_unconfirmed', message: 'Stop is not confirmed.' } }))
    .toEqual({ kind: 'unconfirmed' })
  expect(classifyStopResult({ ok: false, error: { code: 'session_unreachable', message: 'This Chat is moving' } }))
    .toEqual({ kind: 'refused', reason: 'This Chat is moving' })
})

test('a stop still running shows nothing, and a confirmed stop never shows', () => {
  let state = reduceShellState(closedChat(), { type: 'stop-requested', sessionId: 'a', attempt: 1 })
  expect(notices(state)).toHaveLength(0)
  state = settle(state, 1, { kind: 'stopped' })
  expect(notices(state)).toHaveLength(0)
  expect(state.stopAttempts?.a).toBeUndefined()
})

test('an unconfirmed stop names the chat in quotes and offers retry and open', () => {
  const state = settle(reduceShellState(closedChat(), { type: 'stop-requested', sessionId: 'a', attempt: 1 }), 1, { kind: 'unconfirmed' })
  const [notice] = notices(state)
  expect(notice?.banner).toMatchObject({
    tone: 'warn',
    title: 'Couldn\'t confirm "Investigate command permission prompts" stopped.',
    actions: [{ key: 'retry', label: 'Retry stop' }, { key: 'open', label: 'Open chat' }],
  })
  expect(notice?.banner.detail).toBeUndefined()
  expect(notice?.banner.dismissable).not.toBe(false)
})

test('a refusal says why nothing stopped', () => {
  const state = settle(reduceShellState(closedChat(), { type: 'stop-requested', sessionId: 'a', attempt: 1 }), 1,
    { kind: 'refused', reason: 'This Chat is moving' })
  expect(notices(state)[0]?.banner).toMatchObject({
    title: 'Couldn\'t stop "Investigate command permission prompts".',
    detail: 'This Chat is moving',
  })
})

test('dismissing hides only that attempt, so a failed retry shows again', () => {
  let state = settle(reduceShellState(closedChat(), { type: 'stop-requested', sessionId: 'a', attempt: 1 }), 1, { kind: 'unconfirmed' })
  state = reduceShellState(state, { type: 'stop-notice-dismissed', sessionId: 'a', attempt: 1 })
  expect(notices(state)).toHaveLength(0)
  state = reduceShellState(state, { type: 'stop-requested', sessionId: 'a', attempt: 2 })
  expect(notices(state)).toHaveLength(0)
  // A late answer for the first attempt cannot overwrite the retry.
  state = settle(state, 1, { kind: 'stopped' })
  expect(state.stopAttempts?.a?.phase).toBe('pending')
  state = settle(state, 2, { kind: 'unconfirmed' })
  expect(notices(state).map(notice => notice.attempt)).toEqual([2])
})

test('a late exit, a crash, removal, or reopening the chat clears the warning', () => {
  const failed = settle(reduceShellState(closedChat(), { type: 'stop-requested', sessionId: 'a', attempt: 1 }), 1, { kind: 'unconfirmed' })
  expect(notices(failed)).toHaveLength(1)
  const exited = reduceShellState(failed, { type: 'session-status', session: { ...chat, status: 'exited', restorable: true } })
  expect(exited.stopAttempts?.a).toBeUndefined()
  const crashed = reduceShellState(failed, { type: 'session-status', session: { ...chat, status: 'disconnected', restorable: true } })
  expect(crashed.stopAttempts?.a).toBeUndefined()
  const removed = reduceShellState(failed, { type: 'session-removed', appSessionId: 'a' })
  expect(removed.stopAttempts?.a).toBeUndefined()
  const reopened = reduceShellState(failed, { type: 'session-dismissals', dismissals: reopenSession(failed.dismissals ?? [], chat) })
  expect(reopened.stopAttempts?.a).toBeUndefined()
})

test('unrelated roster changes keep the warning and its identity', () => {
  const failed = settle(reduceShellState(closedChat(), { type: 'stop-requested', sessionId: 'a', attempt: 1 }), 1, { kind: 'unconfirmed' })
  const other = reduceShellState(failed, { type: 'session-added', session: sessionDescriptor('b') })
  expect(other.stopAttempts).toBe(failed.stopAttempts)
})

test('after a reload, a closed chat that is still running reads as unconfirmed', () => {
  const reloaded = withReloadedStopAttempts(closedChat())
  expect(notices(reloaded)[0]?.banner.title).toBe('Couldn\'t confirm "Investigate command permission prompts" stopped.')
  const stoppedRow = reduceShellState(createShellState(), { type: 'session-added', session: { ...chat, status: 'exited', restorable: true } })
  const closedStopped = reduceShellState(stoppedRow, { type: 'session-dismissals', dismissals: dismissSession([], chat) })
  expect(withReloadedStopAttempts(closedStopped)).toBe(closedStopped)
  const open = reduceShellState(createShellState(), { type: 'session-added', session: chat })
  expect(withReloadedStopAttempts(open)).toBe(open)
})
