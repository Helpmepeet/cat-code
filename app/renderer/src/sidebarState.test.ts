import { describe, expect, test } from 'bun:test'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import { createShellState, reduceShellState } from './shellState.js'
import {
  compareSidebarActivity,
  deriveMergedRowVisual,
  deriveSidebarRowVisual,
  normalizeSidebarGroupExpansion,
  resolveNavSelection,
  selectSidebarRows,
  selectVisibleSidebarRows,
  shouldShowSidebarGroupExpansionToggle,
  sidebarActivityKey,
  sortSidebarSessionRows,
  type SidebarRow,
} from './sidebarState.js'
import type { MergedSessionRow } from './sessionsCatalogState.js'

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
  const result = selectVisibleSidebarRows(rows, () => false, 6, false)
  expect(result.overLimit).toBe(false)
  expect(result.hiddenCount).toBe(0)
  expect(result.visible).toHaveLength(6)
})

test('selectVisibleSidebarRows caps to the first N when collapsed', () => {
  const result = selectVisibleSidebarRows(rows10, () => false, 6, false)
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
  const result = selectVisibleSidebarRows(rows10, () => false, 6, true)
  expect(result.overLimit).toBe(true)
  expect(result.visible).toHaveLength(10)
  expect(result.hiddenCount).toBe(0)
})

test('selectVisibleSidebarRows keeps the active session visible past the cap', () => {
  // Active 'r8' is in the hidden tail → appended so it never disappears.
  const result = selectVisibleSidebarRows(
    rows10,
    r => r.descriptor.appSessionId === 'r8',
    6,
    false,
  )
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
  const result = selectVisibleSidebarRows(
    rows10,
    r => r.descriptor.appSessionId === 'r2',
    6,
    false,
  )
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
  const result = selectVisibleSidebarRows(
    rows7,
    r => r.descriptor.appSessionId === 'r6',
    6,
    false,
  )
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

test('rows are NOT reordered by lastAttachedAt (falls back to createdAt desc)', () => {
  // Order is by lastMessageSentAt (null here) → createdAt, DESCENDING; a more
  // recent lastAttachedAt never drives order, so it cannot jump a row ahead.
  let state = createShellState()
  state = reduceShellState(state, added(descriptor('c1', { createdAt: 1, lastAttachedAt: 100 })))
  state = reduceShellState(state, added(descriptor('c2', { createdAt: 2, lastAttachedAt: 300 })))
  state = reduceShellState(state, added(descriptor('c3', { createdAt: 3, lastAttachedAt: 200 })))

  // createdAt-desc (newest-created first); c2's larger lastAttachedAt is ignored.
  expect(selectSidebarRows(state).map(r => r.descriptor.appSessionId)).toEqual([
    'c3',
    'c2',
    'c1',
  ])
})

test('float-to-top: rows order by lastMessageSentAt, most-recent message first', () => {
  // The message-sent time now drives BOTH the displayed recency (Sidebar.tsx) and
  // row ORDER: a session floats to the top when it sends a message, regardless of
  // creation order. (createdAt is only the fallback when nothing has been sent.)
  let state = createShellState()
  state = reduceShellState(state, added(descriptor('a', { createdAt: 1, lastMessageSentAt: 999 })))
  state = reduceShellState(state, added(descriptor('b', { createdAt: 2, lastMessageSentAt: 1 })))
  state = reduceShellState(state, added(descriptor('c', { createdAt: 3, lastMessageSentAt: 500 })))

  // by lastMessageSentAt desc: a(999) > c(500) > b(1) — newest-created 'c' is NOT first.
  expect(selectSidebarRows(state).map(r => r.descriptor.appSessionId)).toEqual([
    'a',
    'c',
    'b',
  ])
})

test('CC-2: restoring a closed session does NOT move its Sidebar row', () => {
  // The warp this fix targets: restoreSession fires session-added for a known id
  // regaining tab membership, which shellState's reorderOnArrival moves to the
  // END of state.order (correct for the TabBar's fresh tab). The Sidebar must NOT
  // follow that — its order (lastMessageSentAt→createdAt desc; nothing sent here)
  // keeps 'a' in its slot across the close→restore round-trip. 'a' is created
  // LATER (createdAt 2) so it sorts FIRST — the opposite of the state.order warp
  // that would push it last, so the two genuinely diverge.
  let state = createShellState()
  state = reduceShellState(state, added(descriptor('a', { createdAt: 2, status: 'ready' })))
  state = reduceShellState(state, added(descriptor('b', { createdAt: 1, status: 'ready' })))
  expect(selectSidebarRows(state).map(r => r.descriptor.appSessionId)).toEqual(['a', 'b'])

  // 'a' closes → a restorable row.
  state = reduceShellState(state, {
    type: 'session-status',
    session: descriptor('a', { createdAt: 2, status: 'exited', restorable: true }),
  })
  expect(selectSidebarRows(state).map(r => r.descriptor.appSessionId)).toEqual(['a', 'b'])

  // 'a' restored → regains tab membership → shellState moves it to the END of
  // state.order. The Sidebar row STAYS first (the fix): it does not follow the warp.
  state = reduceShellState(
    state,
    added(descriptor('a', { createdAt: 2, status: 'spawning', restorable: false })),
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

/* ── SESSIONS-UNIFICATION: merged-row visual + warp-free activity order ──────── */

function mergedRow(over: Partial<MergedSessionRow> = {}): MergedSessionRow {
  return {
    sessionId: 'engine-x',
    appSessionId: 'app-x',
    cwd: '/tmp/proj',
    title: null,
    displayLabel: 'X',
    live: true,
    restorable: false,
    status: 'ready',
    inRegistry: true,
    modifiedAtMs: 0,
    createdAtMs: 0,
    lastMessageSentAt: null,
    transcriptActivityAtMs: null,
    messageCount: 0,
    gitBranch: null,
    tag: null,
    mode: null,
    agentSetting: null,
    prNumber: null,
    prRepository: null,
    ...over,
  }
}

describe('deriveMergedRowVisual', () => {
  test('a live registry row → select intent, no restore', () => {
    const v = deriveMergedRowVisual(mergedRow({ status: 'ready', live: true }))
    expect(v.kind).toBe('live')
    expect(v.intent).toBe('select')
    expect(v.openable).toBe(true)
  })

  test('a restorable registry row → restore intent, dead tone', () => {
    const v = deriveMergedRowVisual(
      mergedRow({ status: 'exited', live: false, restorable: true }),
    )
    expect(v.kind).toBe('restorable')
    expect(v.intent).toBe('restore')
    expect(v.label).toBe('closed')
  })

  test('a history row WITH a cwd → open-history intent, history kind', () => {
    const v = deriveMergedRowVisual(
      mergedRow({ inRegistry: false, appSessionId: null, status: 'history', cwd: '/tmp/w' }),
    )
    expect(v.kind).toBe('history')
    expect(v.intent).toBe('open-history')
    expect(v.openable).toBe(true)
    expect(v.label).toBe('history')
  })

  test('a history row with an EMPTY cwd → not openable, none intent (browse-only)', () => {
    const v = deriveMergedRowVisual(
      mergedRow({ inRegistry: false, appSessionId: null, status: 'history', cwd: '   ' }),
    )
    expect(v.kind).toBe('history')
    expect(v.openable).toBe(false)
    expect(v.intent).toBe('none')
  })
})

describe('sidebarActivityKey / compareSidebarActivity (CC-2 warp-free)', () => {
  test('a registry row keys on lastMessageSentAt, NOT modifiedAtMs (no warp on open)', () => {
    // modifiedAtMs folds in lastAttachedAt (bumps on open); the key ignores it.
    const row = mergedRow({
      inRegistry: true,
      lastMessageSentAt: 100,
      createdAtMs: 5,
      modifiedAtMs: 999_999,
    })
    expect(sidebarActivityKey(row)).toBe(100)
  })

  test('a registry row that never messaged falls back to createdAtMs (never modifiedAtMs)', () => {
    const row = mergedRow({
      inRegistry: true,
      lastMessageSentAt: null,
      createdAtMs: 42,
      transcriptActivityAtMs: null,
      modifiedAtMs: 999_999,
    })
    expect(sidebarActivityKey(row)).toBe(42)
  })

  // Opening a TERMINAL session mints a registry row whose createdAt is the click
  // instant. Keying on that floats every opened session to the top of the sidebar
  // with no message sent — the warp CC-2 removed. Its transcript activity wins.
  test('an opened terminal session keys on transcript activity, NOT its click-time createdAt', () => {
    const clickedNow = 1_800_000_000_000
    const row = mergedRow({
      inRegistry: true,
      lastMessageSentAt: null,
      createdAtMs: clickedNow,
      transcriptActivityAtMs: 700,
    })
    expect(sidebarActivityKey(row)).toBe(700)
  })

  test('opening an old terminal session does not jump it above a recently-messaged row', () => {
    const opened = mergedRow({
      sessionId: 'opened-from-history',
      inRegistry: true,
      lastMessageSentAt: null,
      createdAtMs: 1_800_000_000_000, // clicked just now
      transcriptActivityAtMs: 100, // but last real work was long ago
    })
    const messaged = mergedRow({
      sessionId: 'recently-messaged',
      inRegistry: true,
      lastMessageSentAt: 900,
    })
    expect(
      sortSidebarSessionRows([opened, messaged]).map(r => r.sessionId),
    ).toEqual(['recently-messaged', 'opened-from-history'])
  })

  test('a history row keys on modifiedAtMs (its real last-activity)', () => {
    const row = mergedRow({
      inRegistry: false,
      appSessionId: null,
      status: 'history',
      lastMessageSentAt: null,
      modifiedAtMs: 700,
    })
    expect(sidebarActivityKey(row)).toBe(700)
  })

  test('sort orders by activity desc; a stale open does NOT jump a registry row', () => {
    const rows = [
      mergedRow({ sessionId: 'a', lastMessageSentAt: 10, modifiedAtMs: 9_999 }),
      mergedRow({ sessionId: 'b', lastMessageSentAt: 500, modifiedAtMs: 1 }),
      mergedRow({
        sessionId: 'c',
        inRegistry: false,
        appSessionId: null,
        status: 'history',
        lastMessageSentAt: null,
        modifiedAtMs: 300,
      }),
    ]
    // b(500) > c(300 history mtime) > a(10) — a's big modifiedAtMs is ignored.
    expect(sortSidebarSessionRows(rows).map(r => r.sessionId)).toEqual([
      'b',
      'c',
      'a',
    ])
    // Comparator is deterministic on ties (immutable sessionId).
    const tieA = mergedRow({ sessionId: 'z', lastMessageSentAt: 1 })
    const tieB = mergedRow({ sessionId: 'y', lastMessageSentAt: 1 })
    expect(compareSidebarActivity(tieA, tieB)).toBeGreaterThan(0)
  })
})
