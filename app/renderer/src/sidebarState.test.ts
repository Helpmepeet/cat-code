import { expect, test } from 'bun:test'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import { createShellState, reduceShellState } from './shellState.js'
import {
  deriveSidebarRowVisual,
  selectSidebarRows,
} from './sidebarState.js'

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

function added(session: SessionDescriptor) {
  return { type: 'session-added', session } as const
}

test('selectSidebarRows lists the full roster (live ∪ restorable)', () => {
  let state = createShellState()
  state = reduceShellState(state, added(descriptor('live', { status: 'ready' })))
  state = reduceShellState(
    state,
    added(descriptor('dead', { status: 'exited', restorable: true })),
  )

  const ids = selectSidebarRows(state).map(r => r.descriptor.appSessionId)
  expect(ids.sort()).toEqual(['dead', 'live'])
})

test('rows are ordered by lastAttachedAt (most recent first)', () => {
  let state = createShellState()
  state = reduceShellState(state, added(descriptor('old', { lastAttachedAt: 100 })))
  state = reduceShellState(state, added(descriptor('new', { lastAttachedAt: 300 })))
  state = reduceShellState(state, added(descriptor('mid', { lastAttachedAt: 200 })))

  expect(selectSidebarRows(state).map(r => r.descriptor.appSessionId)).toEqual([
    'new',
    'mid',
    'old',
  ])
})

test('recency ties break by createdAt then id (stable order)', () => {
  let state = createShellState()
  state = reduceShellState(
    state,
    added(descriptor('b', { lastAttachedAt: 5, createdAt: 1 })),
  )
  state = reduceShellState(
    state,
    added(descriptor('a', { lastAttachedAt: 5, createdAt: 1 })),
  )
  state = reduceShellState(
    state,
    added(descriptor('c', { lastAttachedAt: 5, createdAt: 9 })),
  )

  // createdAt 9 wins recency tie; then a before b by id.
  expect(selectSidebarRows(state).map(r => r.descriptor.appSessionId)).toEqual([
    'c',
    'a',
    'b',
  ])
})

test('a live ready row is kind:live, tone:live, and shows no chip', () => {
  const visual = deriveSidebarRowVisual(descriptor('x', { status: 'ready' }))
  expect(visual.kind).toBe('live')
  expect(visual.tone).toBe('live')
  expect(visual.restorable).toBe(false)
})

test('an exited restorable row is the restore candidate (kind:restorable, tone:dead)', () => {
  const visual = deriveSidebarRowVisual(
    descriptor('x', { status: 'exited', restorable: true }),
  )
  expect(visual.kind).toBe('restorable')
  expect(visual.tone).toBe('dead')
  expect(visual.label).toBe('closed')
  expect(visual.restorable).toBe(true)
})

test('a crashed (disconnected) restorable row flags dead/crashed', () => {
  const visual = deriveSidebarRowVisual(
    descriptor('x', { status: 'disconnected', restorable: true }),
  )
  expect(visual.kind).toBe('restorable')
  expect(visual.tone).toBe('dead')
  expect(visual.label).toBe('crashed')
})

test('a spawning row reads as starting (warn), not yet restorable', () => {
  const visual = deriveSidebarRowVisual(descriptor('x', { status: 'spawning' }))
  expect(visual.tone).toBe('warn')
  expect(visual.label).toBe('starting')
  expect(visual.kind).toBe('live')
})

test('the restorable flag drives kind independently of status', () => {
  // Defensive: if the host ever marks a row restorable while status is still
  // nominal, kind follows `restorable` (the process-gone truth), not status.
  const visual = deriveSidebarRowVisual(
    descriptor('x', { status: 'ready', restorable: true }),
  )
  expect(visual.kind).toBe('restorable')
})
