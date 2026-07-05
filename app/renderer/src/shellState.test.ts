import { expect, test } from 'bun:test'
import type { HostEvent, SessionDescriptor } from '../../shared/hostApi.js'
import {
  activeAfterLiveChange,
  createShellState,
  reduceShellState,
  selectLiveSessions,
  selectSession,
  selectSessions,
  sessionAtSlot,
} from './shellState.js'

function descriptor(
  id: string,
  overrides: Partial<SessionDescriptor> = {},
): SessionDescriptor {
  return {
    appSessionId: id,
    engineSessionId: `engine-${id}`,
    cwd: `/tmp/${id}`,
    title: null,
    status: 'ready',
    restorable: false,
    createdAt: 0,
    lastAttachedAt: 0,
    ...overrides,
  }
}

function added(session: SessionDescriptor): HostEvent {
  return { type: 'session-added', session }
}

test('session-added appends a tab in arrival order', () => {
  let state = createShellState()
  state = reduceShellState(state, added(descriptor('a')))
  state = reduceShellState(state, added(descriptor('b')))
  state = reduceShellState(state, added(descriptor('c')))

  expect(selectSessions(state).map(s => s.appSessionId)).toEqual([
    'a',
    'b',
    'c',
  ])
})

test('a re-added id refreshes in place and never duplicates the tab', () => {
  let state = createShellState()
  state = reduceShellState(state, added(descriptor('a', { title: 'first' })))
  state = reduceShellState(state, added(descriptor('a', { title: 'second' })))

  const sessions = selectSessions(state)
  expect(sessions).toHaveLength(1)
  expect(sessions[0]?.title).toBe('second')
})

test('session-status replaces the descriptor without reordering', () => {
  let state = createShellState()
  state = reduceShellState(state, added(descriptor('a')))
  state = reduceShellState(state, added(descriptor('b')))
  state = reduceShellState(state, {
    type: 'session-status',
    session: descriptor('a', { status: 'exited', restorable: true }),
  })

  expect(selectSessions(state).map(s => s.appSessionId)).toEqual(['a', 'b'])
  expect(selectSession(state, 'a')?.status).toBe('exited')
})

test('session-status for an unknown id is ADOPTED (it carries a full descriptor)', () => {
  // A status that races ahead of its session-added is not a ghost — it carries
  // the full descriptor (hostApi.ts:115), so the roster adopts it (F3).
  let state = createShellState()
  state = reduceShellState(state, added(descriptor('a')))
  state = reduceShellState(state, {
    type: 'session-status',
    session: descriptor('ghost', { status: 'ready' }),
  })

  expect(selectSessions(state).map(s => s.appSessionId)).toEqual(['a', 'ghost'])
  expect(selectSession(state, 'ghost')?.status).toBe('ready')
})

test('session-removed drops the id from order and map', () => {
  let state = createShellState()
  state = reduceShellState(state, added(descriptor('a')))
  state = reduceShellState(state, added(descriptor('b')))
  state = reduceShellState(state, {
    type: 'session-removed',
    appSessionId: 'a',
  })

  expect(selectSessions(state).map(s => s.appSessionId)).toEqual(['b'])
  expect(selectSession(state, 'a')).toBeNull()
})

test('sessionAtSlot maps ⌘1..9 to 1-based tab order, out-of-range → null', () => {
  let state = createShellState()
  state = reduceShellState(state, added(descriptor('a')))
  state = reduceShellState(state, added(descriptor('b')))

  expect(sessionAtSlot(state, 1)).toBe('a')
  expect(sessionAtSlot(state, 2)).toBe('b')
  expect(sessionAtSlot(state, 3)).toBeNull() // empty slot
  expect(sessionAtSlot(state, 0)).toBeNull()
  expect(sessionAtSlot(state, 10)).toBeNull()
})

test('selectLiveSessions excludes a closed (restorable) session but keeps it in the roster (F1)', () => {
  let state = createShellState()
  state = reduceShellState(state, added(descriptor('live', { status: 'ready' })))
  state = reduceShellState(
    state,
    added(descriptor('closed', { status: 'exited', restorable: true })),
  )

  // TabBar view = live only; the closed row is gone from the bar…
  expect(selectLiveSessions(state).map(s => s.appSessionId)).toEqual(['live'])
  // …but still present in the full roster for the Sidebar to show restorable.
  expect(selectSessions(state).map(s => s.appSessionId)).toEqual([
    'live',
    'closed',
  ])
})

test('selectLiveSessions keeps a crashed-but-not-reaped session (restart still valid)', () => {
  // A crashed sidecar is still live process-wise (restorable:false) until
  // reaped, so it stays a TabBar tab where restart is host-accepted.
  let state = createShellState()
  state = reduceShellState(
    state,
    added(descriptor('crashed', { status: 'disconnected', restorable: false })),
  )
  expect(selectLiveSessions(state).map(s => s.appSessionId)).toEqual(['crashed'])
})

test('activeAfterLiveChange: active session that left the live set moves to first live tab', () => {
  expect(activeAfterLiveChange('closed', ['live'])).toBe('live')
})

test('activeAfterLiveChange: active session still live stays put', () => {
  expect(activeAfterLiveChange('live', ['live', 'other'])).toBe('live')
})

test('activeAfterLiveChange: no live tabs left → null (empty shell)', () => {
  expect(activeAfterLiveChange('closed', [])).toBeNull()
})

test('activeAfterLiveChange: a null active stays null', () => {
  expect(activeAfterLiveChange(null, ['live'])).toBeNull()
})
