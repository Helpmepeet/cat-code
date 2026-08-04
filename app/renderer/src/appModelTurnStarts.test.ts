import { expect, test } from 'bun:test'
import type { SessionId } from '../../shared/protocol.js'
import { isTurnRunning, reduceTurnStarts } from './appModel.js'
import type { ConnectionSnapshot, ConnectionState } from './connectionState.js'

/**
 * The regression these pin: the activity clock used to be pane state keyed on
 * the active session, so selecting another tab restamped the start and the
 * count restarted at 0s (taking the 30s token byline with it). The start is now
 * recorded once per session, from connection frames that arrive whether or not
 * the pane is on screen.
 */
const A = 'session-a' as SessionId
const B = 'session-b' as SessionId

const snapshot = (
  status: ConnectionSnapshot['status'],
  inputEnabled: boolean,
): ConnectionSnapshot => ({ status, inputEnabled })

const state = (
  sessions: Record<string, ConnectionSnapshot>,
): ConnectionState => ({ sessions: sessions as ConnectionState['sessions'] })

const running = snapshot('ready', false)
const idle = snapshot('ready', true)

test('a turn is running only when the engine is ready and holds the input', () => {
  expect(isTurnRunning(running)).toBe(true)
  expect(isTurnRunning(idle)).toBe(false)
  expect(isTurnRunning(snapshot('connecting', false))).toBe(false)
  expect(isTurnRunning(snapshot('dead', false))).toBe(false)
})

test('the start is stamped once and survives later frames', () => {
  const first = reduceTurnStarts(new Map(), state({ [A]: running }), 1_000)
  expect(first.get(A)).toBe(1_000)

  // A later frame (another session appearing, a delta landing) must not move
  // the running session's start: that is the tab-switch bug.
  const second = reduceTurnStarts(first, state({ [A]: running, [B]: idle }), 9_000)
  expect(second.get(A)).toBe(1_000)
  expect(second.has(B)).toBe(false)
})

test('a background session keeps its start while another session runs', () => {
  const both = reduceTurnStarts(
    new Map(),
    state({ [A]: running, [B]: running }),
    1_000,
  )
  const later = reduceTurnStarts(both, state({ [A]: running, [B]: idle }), 5_000)
  expect(later.get(A)).toBe(1_000)
  expect(later.has(B)).toBe(false)
})

test('the start clears when the turn ends and restamps on the next turn', () => {
  const started = reduceTurnStarts(new Map(), state({ [A]: running }), 1_000)
  const ended = reduceTurnStarts(started, state({ [A]: idle }), 4_000)
  expect(ended.has(A)).toBe(false)

  const restarted = reduceTurnStarts(ended, state({ [A]: running }), 7_000)
  expect(restarted.get(A)).toBe(7_000)
})

test('a session that goes away drops its start', () => {
  const started = reduceTurnStarts(new Map(), state({ [A]: running }), 1_000)
  expect(reduceTurnStarts(started, state({}), 2_000).has(A)).toBe(false)
})

test('an unchanged reduction returns the same map', () => {
  const started = reduceTurnStarts(new Map(), state({ [A]: running }), 1_000)
  expect(reduceTurnStarts(started, state({ [A]: running }), 2_000)).toBe(started)
})
