import { describe, expect, test } from 'bun:test'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import { createShellState, reduceShellState } from './shellState.js'
import {
  deriveSidebarRowVisual,
  normalizeSidebarGroupExpansion,
  resolveNavSelection,
  selectSidebarRows,
  selectVisibleSidebarRows,
  shouldShowSidebarGroupExpansionToggle,
  type SidebarRow,
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
    lastMessageSentAt: null,
    ...overrides,
  }
}

function added(session: SessionDescriptor) {
  return { type: 'session-added', session } as const
}

function row(id: string): SidebarRow {
  const d = descriptor(id)
  return { descriptor: d, visual: deriveSidebarRowVisual(d) }
}

const rows10 = Array.from({ length: 10 }, (_, i) => row(`r${i}`))

test('selectVisibleSidebarRows shows every row at/under the cap (no toggle)', () => {
  const rows = rows10.slice(0, 6)
  const result = selectVisibleSidebarRows(rows, null, 6, false)
  expect(result.overLimit).toBe(false)
  expect(result.hiddenCount).toBe(0)
  expect(result.visible).toHaveLength(6)
})

test('selectVisibleSidebarRows caps to the first N when collapsed', () => {
  const result = selectVisibleSidebarRows(rows10, null, 6, false)
  expect(result.overLimit).toBe(true)
  expect(result.visible.map(r => r.descriptor.appSessionId)).toEqual([
    'r0',
    'r1',
    'r2',
    'r3',
    'r4',
    'r5',
  ])
  expect(result.hiddenCount).toBe(4)
})

test('selectVisibleSidebarRows expanded shows all, toggle still offered', () => {
  const result = selectVisibleSidebarRows(rows10, null, 6, true)
  expect(result.overLimit).toBe(true)
  expect(result.visible).toHaveLength(10)
  expect(result.hiddenCount).toBe(0)
})

test('selectVisibleSidebarRows keeps the active session visible past the cap', () => {
  // Active 'r8' is in the hidden tail → appended so it never disappears.
  const result = selectVisibleSidebarRows(rows10, 'r8', 6, false)
  expect(result.visible.map(r => r.descriptor.appSessionId)).toEqual([
    'r0',
    'r1',
    'r2',
    'r3',
    'r4',
    'r5',
    'r8',
  ])
  expect(result.hiddenCount).toBe(3)
})

test('selectVisibleSidebarRows does not duplicate an active session already in the head', () => {
  const result = selectVisibleSidebarRows(rows10, 'r2', 6, false)
  expect(result.visible).toHaveLength(6)
  expect(
    result.visible.filter(r => r.descriptor.appSessionId === 'r2'),
  ).toHaveLength(1)
  expect(result.hiddenCount).toBe(4)
})

// ── SIDEBAR-1: the limit+1 boundary where the sole overflow row is the kept
// active session — every row is already visible, so there is nothing left to
// reveal and the toggle must not render "Show 0 more".

test('selectVisibleSidebarRows at the limit+1 boundary with the active row as the sole overflow reports zero hidden', () => {
  const rows7 = rows10.slice(0, 7)
  const result = selectVisibleSidebarRows(rows7, 'r6', 6, false)
  expect(result.overLimit).toBe(true)
  expect(result.hiddenCount).toBe(0)
  expect(result.visible).toHaveLength(7)
})

describe('shouldShowSidebarGroupExpansionToggle (SIDEBAR-1)', () => {
  test('does not render collapsed with zero hidden rows (the limit+1 boundary)', () => {
    expect(shouldShowSidebarGroupExpansionToggle(false, 0, true)).toBe(false)
  })

  test('renders collapsed "Show N more" once rows are actually hidden', () => {
    expect(shouldShowSidebarGroupExpansionToggle(false, 4, true)).toBe(true)
  })

  test('renders expanded "Show less" whenever the group is still over the cap', () => {
    expect(shouldShowSidebarGroupExpansionToggle(true, 0, true)).toBe(true)
  })

  test('does not render expanded once the group is no longer over the cap', () => {
    expect(shouldShowSidebarGroupExpansionToggle(true, 0, false)).toBe(false)
  })
})

describe('normalizeSidebarGroupExpansion (SIDEBAR-2)', () => {
  test('resets a sticky expanded flag once the group shrinks to/below the cap', () => {
    expect(normalizeSidebarGroupExpansion(true, false)).toBe(false)
  })

  test('preserves expanded while the group remains over the cap', () => {
    expect(normalizeSidebarGroupExpansion(true, true)).toBe(true)
  })

  test('leaves a collapsed group collapsed regardless of overLimit', () => {
    expect(normalizeSidebarGroupExpansion(false, true)).toBe(false)
    expect(normalizeSidebarGroupExpansion(false, false)).toBe(false)
  })

  test('does not silently re-expand after the group regrows past the cap', () => {
    // Expand while over the cap, shrink under it (resets), then grow back over
    // it — the flag must come back false (a fresh collapse), never re-derive
    // true from the stale pre-shrink value.
    let expanded = true
    expanded = normalizeSidebarGroupExpansion(expanded, false) // shrank ≤ cap
    expect(expanded).toBe(false)
    expanded = normalizeSidebarGroupExpansion(expanded, true) // grew > cap again
    expect(expanded).toBe(false)
  })
})

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

test('rows are in stable creation order, NOT reordered by lastAttachedAt', () => {
  // CC-2 / prototype parity (see module doc): rows order by the immutable
  // createdAt and are never re-sorted by recency — a row with a MORE recent
  // lastAttachedAt does not jump ahead of one created earlier.
  let state = createShellState()
  state = reduceShellState(state, added(descriptor('old', { createdAt: 1, lastAttachedAt: 100 })))
  state = reduceShellState(state, added(descriptor('new', { createdAt: 2, lastAttachedAt: 300 })))
  state = reduceShellState(state, added(descriptor('mid', { createdAt: 3, lastAttachedAt: 200 })))

  expect(selectSidebarRows(state).map(r => r.descriptor.appSessionId)).toEqual([
    'old',
    'new',
    'mid',
  ])
})

test('CC-2: lastMessageSentAt drives the displayed time but NOT row order (float-to-top still deferred)', () => {
  // The subtitle recency now reads lastMessageSentAt (Sidebar.tsx), but row
  // ORDER must stay the immutable createdAt sort — floating a row to the top on
  // send is a separate deferred piece (see the module doc). A newer message must
  // never jump a row ahead of one created earlier.
  let state = createShellState()
  state = reduceShellState(state, added(descriptor('old', { createdAt: 1, lastMessageSentAt: 999 })))
  state = reduceShellState(state, added(descriptor('new', { createdAt: 2, lastMessageSentAt: 1 })))
  state = reduceShellState(state, added(descriptor('mid', { createdAt: 3, lastMessageSentAt: 500 })))

  expect(selectSidebarRows(state).map(r => r.descriptor.appSessionId)).toEqual([
    'old',
    'new',
    'mid',
  ])
})

test('CC-2: restoring a closed session does NOT move its Sidebar row', () => {
  // The warp this fix targets: restoreSession fires session-added for a known id
  // regaining tab membership, which shellState's reorderOnArrival moves to the
  // END of state.order (correct for the TabBar's fresh tab). The Sidebar must NOT
  // follow that — ordering by the immutable createdAt keeps 'a' in place across
  // the close→restore round-trip, so the row the operator just clicked stays put.
  let state = createShellState()
  state = reduceShellState(state, added(descriptor('a', { createdAt: 1, status: 'ready' })))
  state = reduceShellState(state, added(descriptor('b', { createdAt: 2, status: 'ready' })))
  expect(selectSidebarRows(state).map(r => r.descriptor.appSessionId)).toEqual(['a', 'b'])

  // 'a' closes → a restorable row.
  state = reduceShellState(state, {
    type: 'session-status',
    session: descriptor('a', { createdAt: 1, status: 'exited', restorable: true }),
  })
  expect(selectSidebarRows(state).map(r => r.descriptor.appSessionId)).toEqual(['a', 'b'])

  // 'a' is restored → regains tab membership → shellState moves it to the END of
  // state.order. The Sidebar row STAYS put (this is the fix; the old test asserted
  // the warp — ['b','a']).
  state = reduceShellState(
    state,
    added(descriptor('a', { createdAt: 1, status: 'spawning', restorable: false })),
  )
  expect(state.order).toEqual(['b', 'a']) // TabBar order DID move (unchanged behavior)
  expect(selectSidebarRows(state).map(r => r.descriptor.appSessionId)).toEqual(['a', 'b'])
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
