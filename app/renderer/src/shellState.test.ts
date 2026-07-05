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

test('a crash (restorable + disconnected) keeps the session a tab AND in the roster (kill/close parity)', () => {
  // The P3-5b kill/close parity descriptor: a killed sidecar surfaces
  // restorable + disconnected. The tab STAYS (restart-in-place is still
  // host-accepted off the tombstone record) while the same row is the
  // Sidebar's crashed restore-offer.
  let state = createShellState()
  state = reduceShellState(state, added(descriptor('crashed', { status: 'ready' })))
  state = reduceShellState(state, {
    type: 'session-status',
    session: descriptor('crashed', { status: 'disconnected', restorable: true }),
  })
  expect(selectLiveSessions(state).map(s => s.appSessionId)).toEqual(['crashed'])
  expect(selectSessions(state).map(s => s.appSessionId)).toEqual(['crashed'])
})

test('a clean close (restorable + exited) revokes tab membership', () => {
  let state = createShellState()
  state = reduceShellState(state, added(descriptor('a', { status: 'ready' })))
  state = reduceShellState(state, {
    type: 'session-status',
    session: descriptor('a', { status: 'exited', restorable: true }),
  })
  expect(selectLiveSessions(state)).toEqual([])
  // Roster keeps it — the Sidebar restore-offer.
  expect(selectSessions(state).map(s => s.appSessionId)).toEqual(['a'])
})

test('a crashed row hydrated from a previous run is a restore-offer, never a tab', () => {
  // Hydrate folds snapshot rows via session-added; a restorable+disconnected
  // row that was never live THIS run has no restart tombstone, so it must not
  // become a tab (its restart would be refused by the host).
  let state = createShellState()
  state = reduceShellState(
    state,
    added(descriptor('old-crash', { status: 'disconnected', restorable: true })),
  )
  expect(selectLiveSessions(state)).toEqual([])
  expect(selectSessions(state).map(s => s.appSessionId)).toEqual(['old-crash'])
})

test('restoring a crashed row makes it a tab again once it goes live', () => {
  let state = createShellState()
  state = reduceShellState(
    state,
    added(descriptor('x', { status: 'disconnected', restorable: true })),
  )
  expect(selectLiveSessions(state)).toEqual([])
  // restoreSession re-spawns → session-added with a live (non-restorable)
  // descriptor grants membership.
  state = reduceShellState(
    state,
    added(descriptor('x', { status: 'spawning', restorable: false })),
  )
  expect(selectLiveSessions(state).map(s => s.appSessionId)).toEqual(['x'])
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
