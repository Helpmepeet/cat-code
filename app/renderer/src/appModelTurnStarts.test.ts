import { expect, test } from 'bun:test'
import type { SessionId } from '../../shared/protocol.js'
import { isTurnRunning, reduceTurnStarts } from './appModel.js'
import type { ConnectionSnapshot, ConnectionState } from './connectionState.js'
import type { WorkspaceMoveDisplay } from '../../shared/hostApi.js'

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
const noMoves = {}

test('a turn is running only when the engine is ready and holds the input', () => {
  expect(isTurnRunning(running)).toBe(true)
  expect(isTurnRunning(idle)).toBe(false)
  expect(isTurnRunning(snapshot('connecting', false))).toBe(false)
  expect(isTurnRunning(snapshot('dead', false))).toBe(false)
})

test('the start is stamped once and survives later frames', () => {
  const first = reduceTurnStarts(new Map(), state({ [A]: running }), noMoves, 1_000)
  expect(first.get(A)?.at).toBe(1_000)

  // A later frame (another session appearing, a delta landing) must not move
  // the running session's start: that is the tab-switch bug.
  const second = reduceTurnStarts(first, state({ [A]: running, [B]: idle }), noMoves, 9_000)
  expect(second.get(A)?.at).toBe(1_000)
  expect(second.has(B)).toBe(false)
})

test('a background session keeps its start while another session runs', () => {
  const both = reduceTurnStarts(
    new Map(),
    state({ [A]: running, [B]: running }),
    noMoves,
    1_000,
  )
  const later = reduceTurnStarts(both, state({ [A]: running, [B]: idle }), noMoves, 5_000)
  expect(later.get(A)?.at).toBe(1_000)
  expect(later.has(B)).toBe(false)
})

test('the start clears when the turn ends and restamps on the next turn', () => {
  const started = reduceTurnStarts(new Map(), state({ [A]: running }), noMoves, 1_000)
  const ended = reduceTurnStarts(started, state({ [A]: idle }), noMoves, 4_000)
  expect(ended.has(A)).toBe(false)

  const restarted = reduceTurnStarts(ended, state({ [A]: running }), noMoves, 7_000)
  expect(restarted.get(A)?.at).toBe(7_000)
})

test('a session that goes away drops its start', () => {
  const started = reduceTurnStarts(new Map(), state({ [A]: running }), noMoves, 1_000)
  expect(reduceTurnStarts(started, state({}), noMoves, 2_000).has(A)).toBe(false)
})

test('an unchanged reduction returns the same map', () => {
  const started = reduceTurnStarts(new Map(), state({ [A]: running }), noMoves, 1_000)
  expect(reduceTurnStarts(started, state({ [A]: running }), noMoves, 2_000)).toBe(started)
})

test('a jump holds the original clock through arrival and clears on turn end before final status', () => {
  const move: WorkspaceMoveDisplay = {
    id: 'jump-1', phase: 'moving', agentJump: true, continuation: 'waiting',
    target: { kind: 'project', name: 'destination', path: '/tmp/destination' },
  }
  const withMove = (value: WorkspaceMoveDisplay) => ({ [A]: { workspaceMove: value } })
  const source = reduceTurnStarts(new Map(), state({ [A]: running }), noMoves, 1_000)
  const accepted = reduceTurnStarts(source, state({ [A]: running }), withMove(move), 2_000)
  const sourceIdle = reduceTurnStarts(accepted, state({ [A]: idle }), withMove(move), 3_000)
  const arrived = reduceTurnStarts(sourceIdle, state({ [A]: idle }), withMove({ ...move, phase: 'arrived' }), 4_000)
  const dispatched = reduceTurnStarts(arrived, state({ [A]: idle }), withMove({ ...move, phase: 'arrived', continuation: 'dispatched' }), 5_000)
  expect(dispatched.get(A)?.at).toBe(1_000)
  const continuing = reduceTurnStarts(dispatched, state({ [A]: running }), withMove({ ...move, phase: 'arrived', continuation: 'dispatched' }), 6_000)
  expect(continuing.get(A)).toEqual({ at: 1_000, jumpId: move.id, continuationStarted: true })
  const ended = reduceTurnStarts(continuing, state({ [A]: idle }), withMove({ ...move, phase: 'arrived', continuation: 'dispatched' }), 7_000)
  expect(ended.has(A)).toBe(false)
  expect(reduceTurnStarts(ended, state({ [A]: idle }), withMove({ ...move, phase: 'arrived', continuation: 'dispatched' }), 8_000).has(A)).toBe(false)
  const next = reduceTurnStarts(ended, state({ [A]: running }), withMove({ ...move, phase: 'arrived', continuation: 'finished' }), 9_000)
  expect(next.get(A)?.at).toBe(9_000)
})

test('failed and stopped jumps release the held start', () => {
  const move: WorkspaceMoveDisplay = {
    id: 'jump-1', phase: 'moving', agentJump: true, continuation: 'waiting',
    target: { kind: 'project', name: 'destination', path: '/tmp/destination' },
  }
  const started = reduceTurnStarts(new Map(), state({ [A]: running }), { [A]: { workspaceMove: move } }, 1_000)
  for (const phase of ['failed', 'stopped'] as const) {
    const ended = reduceTurnStarts(started, state({ [A]: idle }), { [A]: { workspaceMove: { ...move, phase, continuation: 'finished' } } }, 2_000)
    expect(ended.has(A)).toBe(false)
  }
})
