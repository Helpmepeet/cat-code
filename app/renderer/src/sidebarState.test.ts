import { expect, test } from 'bun:test'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import { createShellState, reduceShellState } from './shellState.js'
import {
  deriveSidebarRowVisual,
  resolveNavSelection,
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

test('rows are in stable arrival order, NOT sorted by lastAttachedAt', () => {
  // Prototype parity (see module doc): Sidebar.jsx never re-sorts rows within
  // a group by recency, only arrival order — a row with a MORE recent
  // lastAttachedAt does not jump ahead of one that arrived earlier.
  let state = createShellState()
  state = reduceShellState(state, added(descriptor('old', { lastAttachedAt: 100 })))
  state = reduceShellState(state, added(descriptor('new', { lastAttachedAt: 300 })))
  state = reduceShellState(state, added(descriptor('mid', { lastAttachedAt: 200 })))

  expect(selectSidebarRows(state).map(r => r.descriptor.appSessionId)).toEqual([
    'old',
    'new',
    'mid',
  ])
})

test('restoring a closed session appends its row after tabs opened since, not to the top', () => {
  // The regression this order fix targets: restoreSession fires session-added
  // for an already-known id, which only reorders `order` when the id is just
  // regaining tab membership (shellState.ts's reorderOnArrival) — so a
  // restored session's Sidebar row settles at the END, matching where it now
  // sits in the TabBar, instead of jumping to the top of its group.
  let state = createShellState()
  state = reduceShellState(state, added(descriptor('a', { status: 'ready' })))
  state = reduceShellState(state, added(descriptor('b', { status: 'ready' })))
  state = reduceShellState(state, {
    type: 'session-status',
    session: descriptor('a', { status: 'exited', restorable: true }),
  })
  expect(selectSidebarRows(state).map(r => r.descriptor.appSessionId)).toEqual([
    'a',
    'b',
  ])

  state = reduceShellState(
    state,
    added(descriptor('a', { status: 'spawning', restorable: false })),
  )
  expect(selectSidebarRows(state).map(r => r.descriptor.appSessionId)).toEqual([
    'b',
    'a',
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
  // The P3-5b kill/close parity descriptor (host surfaces disconnected +
  // restorable for a crash-marked dead row): the Sidebar row must be a working
  // restore-offer AND visibly crashed — never the clean-close "closed" label.
  const visual = deriveSidebarRowVisual(
    descriptor('x', { status: 'disconnected', restorable: true }),
  )
  expect(visual.kind).toBe('restorable')
  expect(visual.tone).toBe('dead')
  expect(visual.label).toBe('crashed')
  expect(visual.restorable).toBe(true)
})

test('a LIVE socket-drop (disconnected, not restorable) is NOT labeled crashed', () => {
  // The other half of the overloaded status (P3-5 review): a live session
  // whose socket dropped (F13 — the child may still be alive) surfaces
  // status:'disconnected' with restorable:false. It is kind:live (selecting it
  // focuses the tab, no restore) and must not claim a crash.
  const visual = deriveSidebarRowVisual(
    descriptor('x', { status: 'disconnected', restorable: false }),
  )
  expect(visual.kind).toBe('live')
  expect(visual.tone).toBe('dead')
  expect(visual.label).toBe('disconnected')
  expect(visual.restorable).toBe(false)
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

test('resolveNavSelection routes every enabled Sidebar.tsx NAV id to itself', () => {
  // Mirrors Sidebar.tsx's NAV list (all six entries are enabled:true) — the
  // regression this guards is the P4-REVIEW B2 bug: a per-id allowlist in the
  // onClick handler omitted 'sessions', so clicking it never called
  // onSelectView even though the item rendered as enabled/clickable. This is
  // the routing-decision half of the fix; it cannot exercise a live click
  // (no jsdom in this repo — see module doc), only that the pure decision is
  // correct for every id BOTH NavItemExpanded and NavItemRail call it with.
  const ids = ['chat', 'sessions', 'goals', 'accounts', 'settings'] as const
  for (const id of ids) {
    expect(resolveNavSelection({ id, enabled: true })).toBe(id)
  }
})

test('resolveNavSelection returns null for a disabled item, never the id', () => {
  expect(resolveNavSelection({ id: 'sessions', enabled: false })).toBeNull()
})
