import { describe, expect, test } from 'bun:test'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import { createShellState, reduceShellState } from './shellState.js'
import {
  compareSidebarActivity,
  deriveMergedRowVisual,
  isSidebarVisibleRow,
  normalizeSidebarGroupExpansion,
  resolveNavSelection,
  selectSidebarNavFocusHandoff,
  selectSidebarOpen,
  selectShellDescriptors,
  selectVisibleSidebarRows,
  shouldShowSidebarGroupExpansionToggle,
  sidebarActivityKey,
  sortSidebarSessionRows,
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
    titleUpdatedAt: null,
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

const rows10 = Array.from({ length: 10 }, (_, i) => descriptor(`r${i}`))

describe('selectSidebarOpen', () => {
  test('focus within independently expands an otherwise collapsed rail', () => {
    expect(
      selectSidebarOpen({
        pinned: false,
        hovering: false,
        menuActive: false,
        focusWithin: true,
      }),
    ).toBe(true)
  })

  test('releasing focus ownership preserves pointer, pin, and menu ownership', () => {
    for (const source of ['pinned', 'hovering', 'menuActive'] as const) {
      expect(
        selectSidebarOpen({
          pinned: source === 'pinned',
          hovering: source === 'hovering',
          menuActive: source === 'menuActive',
          focusWithin: false,
        }),
      ).toBe(true)
    }
  })

  test('the rail collapses only when every open source is absent', () => {
    expect(
      selectSidebarOpen({
        pinned: false,
        hovering: false,
        menuActive: false,
        focusWithin: false,
      }),
    ).toBe(false)
  })
})

describe('selectSidebarNavFocusHandoff', () => {
  test('transfers any collapsed nav identity to its expanded counterpart', () => {
    for (const id of [
      'chat',
      'sessions',
      'goals',
      'accounts',
      'settings',
    ] as const) {
      expect(selectSidebarNavFocusHandoff(false, id)).toBe(id)
    }
  })

  test('does not request a handoff for the stable pin or an already-open rail', () => {
    expect(selectSidebarNavFocusHandoff(false, null)).toBeNull()
    expect(selectSidebarNavFocusHandoff(true, 'settings')).toBeNull()
  })
})

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
  expect(result.visible.map(r => r.appSessionId)).toEqual([
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
    r => r.appSessionId === 'r8',
    6,
    false,
  )
  expect(result.visible.map(r => r.appSessionId)).toEqual([
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
    r => r.appSessionId === 'r2',
    6,
    false,
  )
  expect(result.visible).toHaveLength(6)
  expect(
    result.visible.filter(r => r.appSessionId === 'r2'),
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
    r => r.appSessionId === 'r6',
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

test('selectShellDescriptors lists the full roster (live ∪ restorable)', () => {
  let state = createShellState()
  state = reduceShellState(state, added(descriptor('live', { status: 'ready' })))
  state = reduceShellState(
    state,
    added(descriptor('dead', { status: 'exited', restorable: true })),
  )

  const ids = selectShellDescriptors(state).map(r => r.appSessionId)
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
  expect(selectShellDescriptors(state).map(r => r.appSessionId)).toEqual([
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
  expect(selectShellDescriptors(state).map(r => r.appSessionId)).toEqual([
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
  expect(selectShellDescriptors(state).map(r => r.appSessionId)).toEqual(['a', 'b'])

  // 'a' closes → a restorable row.
  state = reduceShellState(state, {
    type: 'session-status',
    session: descriptor('a', { createdAt: 2, status: 'exited', restorable: true }),
  })
  expect(selectShellDescriptors(state).map(r => r.appSessionId)).toEqual(['a', 'b'])

  // 'a' restored → regains tab membership → shellState moves it to the END of
  // state.order. The Sidebar row STAYS first (the fix): it does not follow the warp.
  state = reduceShellState(
    state,
    added(descriptor('a', { createdAt: 2, status: 'spawning', restorable: false })),
  )
  expect(state.order).toEqual(['b', 'a']) // TabBar order DID move (unchanged behavior)
  expect(selectShellDescriptors(state).map(r => r.appSessionId)).toEqual(['a', 'b'])
})

// The per-row status VISUAL (kind/tone/label) is now derived by
// `deriveMergedRowVisual` (below) + the shared `sessionStatusVisual`
// (`sessionStatusVisual.test.ts`) — F9 deleted the `deriveSidebarRowVisual`
// twin, so its cases live in those two suites.

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
    cwdExists: true,
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

  test('a crash-marked (disconnected + restorable) registry row → crashed, restore intent', () => {
    const v = deriveMergedRowVisual(
      mergedRow({ status: 'disconnected', live: false, restorable: true }),
    )
    expect(v.kind).toBe('restorable')
    expect(v.intent).toBe('restore')
    expect(v.tone).toBe('dead')
    expect(v.label).toBe('crashed')
  })

  test('F13 — a LIVE socket-drop (disconnected, NOT restorable) stays kind:live/select, never crashed+restore', () => {
    // The overloaded-status guard the old deriveSidebarRowVisual test protected:
    // a live child whose socket dropped must not be mislabeled crashed nor offered
    // restore (`sidebarState.ts` disconnected arm / sessionStatusVisual).
    const v = deriveMergedRowVisual(
      mergedRow({ status: 'disconnected', live: true, restorable: false }),
    )
    expect(v.kind).toBe('live')
    expect(v.intent).toBe('select')
    expect(v.label).toBe('disconnected')
  })

  test('the restorable flag drives kind independently of status', () => {
    // If the host ever marks a row restorable while status is still nominal, kind
    // follows `restorable` (the process-gone truth), not status.
    const v = deriveMergedRowVisual(
      mergedRow({ status: 'ready', live: false, restorable: true }),
    )
    expect(v.kind).toBe('restorable')
    expect(v.intent).toBe('restore')
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

  test('bug-sweep #1 — a history row with a non-empty but DEAD cwd → not openable, none intent', () => {
    // The pre-fix gate (`cwd.trim().length > 0`) called this openable; it then
    // failed `invalid_cwd` only at open time. cwdExists closes the gate up front.
    const v = deriveMergedRowVisual(
      mergedRow({
        inRegistry: false,
        appSessionId: null,
        status: 'history',
        cwd: '/tmp/gone-fixture',
        cwdExists: false,
      }),
    )
    expect(v.kind).toBe('history')
    expect(v.openable).toBe(false)
    expect(v.intent).toBe('none')
  })
})

describe('isSidebarVisibleRow (bug-sweep #1 — HIDE dead-workspace rows from the rail)', () => {
  test('a history row whose workspace is gone (cwdExists:false) is HIDDEN', () => {
    expect(
      isSidebarVisibleRow(
        mergedRow({
          inRegistry: false,
          appSessionId: null,
          status: 'history',
          cwd: '/tmp/gone-fixture',
          cwdExists: false,
        }),
      ),
    ).toBe(false)
  })

  test('a history row with a still-existing workspace stays visible', () => {
    expect(
      isSidebarVisibleRow(
        mergedRow({
          inRegistry: false,
          appSessionId: null,
          status: 'history',
          cwd: '/tmp/alive',
          cwdExists: true,
        }),
      ),
    ).toBe(true)
  })

  test('an empty-cwd "Unknown workspace" history row stays visible (browse-only, not dead)', () => {
    expect(
      isSidebarVisibleRow(
        mergedRow({
          inRegistry: false,
          appSessionId: null,
          status: 'history',
          cwd: '',
          cwdExists: false,
        }),
      ),
    ).toBe(true)
  })

  test('a REGISTRY row is always visible, even if its recorded cwd no longer exists', () => {
    // A live/restorable session is addressed by appSessionId, not cwd.
    expect(
      isSidebarVisibleRow(
        mergedRow({ inRegistry: true, cwd: '/tmp/gone', cwdExists: false }),
      ),
    ).toBe(true)
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
