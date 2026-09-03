import { expect, test } from 'bun:test'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import {
  createShellState,
  reduceShellState,
  selectPaneSessions,
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
    forked: false,
    name: null,
    createdBy: null,
    peerWakeBlocked: false,
    titleUpdatedAt: null,
    status: 'ready',
    restorable: false,
    parked: false,
    createdAt: 0,
    lastAttachedAt: 0,
    lastMessageSentAt: null,
    ...overrides,
  }
}

function paneIds(state: ReturnType<typeof createShellState>): string[] {
  return selectPaneSessions(state).map(session => session.appSessionId)
}

test('opening a restorable sidebar row appends its preview tab', () => {
  let state = createShellState()

  // The restorable row arrives first from the host roster, but it is not open.
  state = reduceShellState(state, {
    type: 'session-added',
    session: descriptor('history', { status: 'exited', restorable: true }),
  })
  state = reduceShellState(state, {
    type: 'session-added',
    session: descriptor('tab-a'),
  })
  state = reduceShellState(state, {
    type: 'session-added',
    session: descriptor('tab-b'),
  })

  expect(paneIds(state)).toEqual(['tab-a', 'tab-b'])

  state = reduceShellState(state, {
    type: 'preview-open',
    sessionId: 'history',
  })

  // Opening from the recency-sorted sidebar must not reuse the row's old roster
  // position. It is a newly-opened tab, so it appends after the existing tabs.
  expect(paneIds(state)).toEqual(['tab-a', 'tab-b', 'history'])
})

test('session activity updates never reorder already-open tabs', () => {
  let state = createShellState()
  state = reduceShellState(state, {
    type: 'session-added',
    session: descriptor('tab-a', { lastMessageSentAt: 10 }),
  })
  state = reduceShellState(state, {
    type: 'session-added',
    session: descriptor('tab-b', { lastMessageSentAt: 20 }),
  })
  state = reduceShellState(state, {
    type: 'session-added',
    session: descriptor('tab-c', { lastMessageSentAt: 30 }),
  })

  expect(paneIds(state)).toEqual(['tab-a', 'tab-b', 'tab-c'])

  // This is the same metadata change that can float a row in the Sidebar.
  state = reduceShellState(state, {
    type: 'session-status',
    session: descriptor('tab-a', { lastMessageSentAt: 40 }),
  })

  expect(paneIds(state)).toEqual(['tab-a', 'tab-b', 'tab-c'])
})

test('opening preview state on an existing crashed tab keeps its slot', () => {
  let state = createShellState()
  state = reduceShellState(state, {
    type: 'session-added',
    session: descriptor('tab-a'),
  })
  state = reduceShellState(state, {
    type: 'session-added',
    session: descriptor('tab-b'),
  })
  state = reduceShellState(state, {
    type: 'session-status',
    session: descriptor('tab-a', {
      status: 'disconnected',
      restorable: true,
    }),
  })

  state = reduceShellState(state, {
    type: 'preview-open',
    sessionId: 'tab-a',
  })

  expect(paneIds(state)).toEqual(['tab-a', 'tab-b'])
})
