import { expect, test } from 'bun:test'
import { EMPTY_SCREEN_ACTIVITY, reduceScreenActivity } from './screenActivityState.js'

const initial = { runKey: 'turn-1', running: true, computerId: null, browserSequence: null }
test('screen activity reveals only once per turn, rather than on every tool call', () => {
  const first = reduceScreenActivity(EMPTY_SCREEN_ACTIVITY, { ...initial, browserSequence: 1 })
  expect(first.reveal).toBe('browser')
  const second = reduceScreenActivity(first.state, { ...initial, browserSequence: 2 })
  expect(second.reveal).toBeNull()
  expect(second.state.latest).toBe('browser')
  const nextTurn = reduceScreenActivity(second.state, { ...initial, runKey: 'turn-2', browserSequence: 3 })
  expect(nextTurn.reveal).toBe('browser')
})

test('restored history is available without opening a panel or marking it as live', () => {
  const history = reduceScreenActivity(EMPTY_SCREEN_ACTIVITY, { ...initial, running: false, computerId: 'old' })
  expect(history.reveal).toBeNull()
  expect(history.state.revealed).toBe(false)
  const start = reduceScreenActivity(history.state, { ...initial, computerId: 'old' })
  expect(start.reveal).toBeNull()
  const live = reduceScreenActivity(start.state, { ...initial, computerId: 'new' })
  expect(live.reveal).toBe('computer')
})

test('hiding a screen remains respected while more steps arrive in that turn', () => {
  const seen = reduceScreenActivity(EMPTY_SCREEN_ACTIVITY, { ...initial, computerId: 'one' }).state
  const hidden = { ...seen, revealed: true }
  expect(reduceScreenActivity(hidden, { ...initial, computerId: 'two' }).reveal).toBeNull()
  expect(reduceScreenActivity(hidden, { ...initial, browserSequence: 1, computerId: 'two' }).reveal).toBeNull()
})

test('finishing a turn preserves reopening suppression and unchanged observations keep identity', () => {
  const seen = reduceScreenActivity(EMPTY_SCREEN_ACTIVITY, { ...initial, browserSequence: 1 }).state
  const finished = reduceScreenActivity(seen, { ...initial, running: false, browserSequence: 1 })
  expect(finished.reveal).toBeNull()
  expect(finished.state).toBe(seen)
})
