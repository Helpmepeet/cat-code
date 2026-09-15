/**
 * What the boundary row's control knows about its own read.
 *
 * Pure, so the decisions can be proven despite the SSR-only renderer harness:
 * which answers count, which are ignored, and what the row says afterwards.
 */

import { expect, test } from 'bun:test'
import {
  createHistoryLoadEarlierState,
  reduceHistoryLoadEarlierState,
  selectHistoryLoadEarlierFailure,
  selectHistoryLoadEarlierPending,
  HISTORY_LOAD_EARLIER_UNREACHABLE,
} from './historyLoadEarlierState.js'
import type { HistoryLoadEarlierResultFrame } from '../../shared/protocol.js'

function result(
  over: Partial<HistoryLoadEarlierResultFrame> & { requestId: string },
): HistoryLoadEarlierResultFrame {
  return {
    kind: 'history.loadEarlier.result',
    protocolVersion: 2,
    sessionId: 'a',
    ok: true,
    message: 'Loaded the rest of this session.',
    added: 12,
    complete: true,
    ...over,
  }
}

test('a fresh state has nothing pending and nothing to say', () => {
  const state = createHistoryLoadEarlierState()
  expect(selectHistoryLoadEarlierPending(state, 'a')).toBe(false)
  expect(selectHistoryLoadEarlierFailure(state, 'a')).toBeNull()
  expect(selectHistoryLoadEarlierPending(state, null)).toBe(false)
})

test('a sent request is pending until it is answered', () => {
  let state = reduceHistoryLoadEarlierState(createHistoryLoadEarlierState(), {
    type: 'requested',
    sessionId: 'a',
    requestId: 'r1',
  })
  expect(selectHistoryLoadEarlierPending(state, 'a')).toBe(true)
  // Nobody else's control moves.
  expect(selectHistoryLoadEarlierPending(state, 'b')).toBe(false)

  state = reduceHistoryLoadEarlierState(state, {
    type: 'result',
    frame: result({ requestId: 'r1' }),
  })
  expect(selectHistoryLoadEarlierPending(state, 'a')).toBe(false)
  expect(selectHistoryLoadEarlierFailure(state, 'a')).toBeNull()
})

test('a refusal is quoted back in the words it arrived in', () => {
  let state = reduceHistoryLoadEarlierState(createHistoryLoadEarlierState(), {
    type: 'requested',
    sessionId: 'a',
    requestId: 'r1',
  })
  state = reduceHistoryLoadEarlierState(state, {
    type: 'result',
    frame: result({
      requestId: 'r1',
      ok: false,
      message: 'Already loading earlier messages.',
      added: 0,
      complete: false,
    }),
  })

  // Answered, so the control is usable again — and it says why it is being
  // offered a second time.
  expect(selectHistoryLoadEarlierPending(state, 'a')).toBe(false)
  expect(selectHistoryLoadEarlierFailure(state, 'a')).toBe(
    'Already loading earlier messages.',
  )
})

test('trying again clears what the last attempt said', () => {
  let state = reduceHistoryLoadEarlierState(createHistoryLoadEarlierState(), {
    type: 'requested',
    sessionId: 'a',
    requestId: 'r1',
  })
  state = reduceHistoryLoadEarlierState(state, {
    type: 'result',
    frame: result({ requestId: 'r1', ok: false, message: 'No luck.' }),
  })
  state = reduceHistoryLoadEarlierState(state, {
    type: 'requested',
    sessionId: 'a',
    requestId: 'r2',
  })

  expect(selectHistoryLoadEarlierPending(state, 'a')).toBe(true)
  expect(selectHistoryLoadEarlierFailure(state, 'a')).toBeNull()
})

test('an ask that never left the window says so in words a reader can act on', () => {
  let state = reduceHistoryLoadEarlierState(createHistoryLoadEarlierState(), {
    type: 'requested',
    sessionId: 'a',
    requestId: 'r1',
  })
  state = reduceHistoryLoadEarlierState(state, {
    type: 'unreachable',
    sessionId: 'a',
    requestId: 'r1',
  })

  expect(selectHistoryLoadEarlierPending(state, 'a')).toBe(false)
  expect(selectHistoryLoadEarlierFailure(state, 'a')).toBe(
    HISTORY_LOAD_EARLIER_UNREACHABLE,
  )
})

test('a throw from a stale attempt does not disturb the live one', () => {
  let state = reduceHistoryLoadEarlierState(createHistoryLoadEarlierState(), {
    type: 'requested',
    sessionId: 'a',
    requestId: 'r2',
  })
  state = reduceHistoryLoadEarlierState(state, {
    type: 'unreachable',
    sessionId: 'a',
    requestId: 'r1',
  })

  expect(selectHistoryLoadEarlierPending(state, 'a')).toBe(true)
  expect(selectHistoryLoadEarlierFailure(state, 'a')).toBeNull()
})

test('an answer to a request this page never made is ignored', () => {
  // The result is retained and replayed, so a reload is handed the answer to
  // the PREVIOUS page's press. Acting on it would open a window with a failure
  // standing over a transcript nobody touched.
  const replayed = reduceHistoryLoadEarlierState(
    createHistoryLoadEarlierState(),
    { type: 'result', frame: result({ requestId: 'r1', ok: false, message: 'No luck.' }) },
  )
  expect(selectHistoryLoadEarlierFailure(replayed, 'a')).toBeNull()

  // And an answer that names a different press than the one outstanding.
  let state = reduceHistoryLoadEarlierState(createHistoryLoadEarlierState(), {
    type: 'requested',
    sessionId: 'a',
    requestId: 'r2',
  })
  state = reduceHistoryLoadEarlierState(state, {
    type: 'result',
    frame: result({ requestId: 'r1', ok: false, message: 'No luck.' }),
  })
  expect(selectHistoryLoadEarlierPending(state, 'a')).toBe(true)
  expect(selectHistoryLoadEarlierFailure(state, 'a')).toBeNull()
})

test('a session that lost its engine stops waiting for an answer', () => {
  let state = reduceHistoryLoadEarlierState(createHistoryLoadEarlierState(), {
    type: 'requested',
    sessionId: 'a',
    requestId: 'r1',
  })
  state = reduceHistoryLoadEarlierState(state, {
    type: 'engine-gone',
    sessionId: 'a',
  })

  expect(selectHistoryLoadEarlierPending(state, 'a')).toBe(false)
  // Nothing to say: the pane is about to lose the control altogether, and a
  // failure line under a row nobody can act on is noise.
  expect(selectHistoryLoadEarlierFailure(state, 'a')).toBeNull()
})

test('an untracked session is left exactly as it was', () => {
  const state = createHistoryLoadEarlierState()
  expect(
    reduceHistoryLoadEarlierState(state, { type: 'engine-gone', sessionId: 'a' }),
  ).toBe(state)
})
