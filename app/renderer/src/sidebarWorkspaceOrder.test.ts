import { expect, test } from 'bun:test'
import {
  groupByWorkspace,
  type MergedSessionRow,
} from './sessionsCatalogState.js'
import {
  MAX_SIDEBAR_WORKSPACE_ORDER_ENTRIES,
  SIDEBAR_WORKSPACE_ORDER_STORAGE_KEY,
  createWorkspaceOrder,
  readWorkspaceOrderFromStorage,
  reduceWorkspaceOrderMoved,
  reduceWorkspaceOrderStepped,
  selectOrderedWorkspaceGroups,
  selectWorkspaceDropEdge,
  writeWorkspaceOrderToStorage,
  type WorkspaceOrder,
} from './sidebarWorkspaceOrder.js'

// The sidebar's workspace-group reorder is a pure module by necessity: the
// renderer suite is SSR-only (`renderToStaticMarkup`), so no drag, pointer
// event or effect can fire here. Everything the drop/keyboard handlers decide
// lives below and is exercised directly; the DOM wiring over it is asserted in
// `Sidebar.test.tsx`, and the live gesture is operator-GUI only.

function groups(...cwds: string[]): { cwd: string }[] {
  return cwds.map(cwd => ({ cwd }))
}

function cwdsOf(list: readonly { cwd: string }[]): string[] {
  return list.map(group => group.cwd)
}

function storage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    raw: store,
  }
}

// ── selectOrderedWorkspaceGroups ─────────────────────────────────────────────

test('an empty order degrades to the incoming (frozen-alphabetical) order', () => {
  const incoming = groups('/a/app', '/b/cat-code', '/c/tmp')
  expect(cwdsOf(selectOrderedWorkspaceGroups(incoming, createWorkspaceOrder()))).toEqual(
    ['/a/app', '/b/cat-code', '/c/tmp'],
  )
})

test('ranked groups lead in the stored order; unranked keep alphabetical behind them', () => {
  const incoming = groups('/a/app', '/b/cat-code', '/c/tmp', '/d/zeta')
  const ordered = selectOrderedWorkspaceGroups(incoming, ['/c/tmp', '/a/app'])
  expect(cwdsOf(ordered)).toEqual(['/c/tmp', '/a/app', '/b/cat-code', '/d/zeta'])
})

test('a NEW workspace joins after everything the operator placed, displacing nothing', () => {
  const placed: WorkspaceOrder = ['/c/tmp', '/a/app']
  const before = selectOrderedWorkspaceGroups(groups('/a/app', '/c/tmp'), placed)
  expect(cwdsOf(before)).toEqual(['/c/tmp', '/a/app'])

  // `/b/new` appears (alphabetically first) — the placed pair must not move.
  const after = selectOrderedWorkspaceGroups(
    groups('/a/app', '/b/new', '/c/tmp'),
    placed,
  )
  expect(cwdsOf(after)).toEqual(['/c/tmp', '/a/app', '/b/new'])
})

test('order entries for absent workspaces are skipped, never thrown on', () => {
  // The search box filters groups in and out constantly (`Sidebar.tsx:191-204`).
  const ordered = selectOrderedWorkspaceGroups(groups('/c/tmp'), [
    '/gone/one',
    '/c/tmp',
    '/gone/two',
  ])
  expect(cwdsOf(ordered)).toEqual(['/c/tmp'])
})

test('the "Unknown workspace" bucket (cwd === "") is pinned last and never ranked', () => {
  const incoming = groups('/b/cat-code', '', '/a/app')
  expect(cwdsOf(selectOrderedWorkspaceGroups(incoming, []))).toEqual([
    '/b/cat-code',
    '/a/app',
    '',
  ])
  // Even an order that names it cannot pull it up.
  expect(cwdsOf(selectOrderedWorkspaceGroups(incoming, ['', '/a/app']))).toEqual([
    '/a/app',
    '/b/cat-code',
    '',
  ])
})

test('the order never consults the active workspace (CC-2 warp-free)', () => {
  // `groupByWorkspace` marks `current`; nothing here reads it, so the same input
  // orders identically whichever group is active.
  const withCurrent = [
    { cwd: '/a/app', current: false },
    { cwd: '/b/cat-code', current: true },
  ]
  expect(cwdsOf(selectOrderedWorkspaceGroups(withCurrent, []))).toEqual([
    '/a/app',
    '/b/cat-code',
  ])
})

// ── selectWorkspaceDropEdge ──────────────────────────────────────────────────

test('drop edge follows drag direction: down lands after, up lands before', () => {
  const cwds = ['/a', '/b', '/c']
  expect(selectWorkspaceDropEdge(cwds, '/a', '/c')).toBe('after')
  expect(selectWorkspaceDropEdge(cwds, '/c', '/a')).toBe('before')
  expect(selectWorkspaceDropEdge(cwds, '/a', '/b')).toBe('after')
  expect(selectWorkspaceDropEdge(cwds, '/b', '/a')).toBe('before')
})

test('no drop edge for self, an unknown-workspace end, or a group off screen', () => {
  const cwds = ['/a', '/b', '']
  expect(selectWorkspaceDropEdge(cwds, '/a', '/a')).toBeNull()
  expect(selectWorkspaceDropEdge(cwds, '/a', '')).toBeNull()
  expect(selectWorkspaceDropEdge(cwds, '', '/a')).toBeNull()
  expect(selectWorkspaceDropEdge(cwds, '/a', '/missing')).toBeNull()
  expect(selectWorkspaceDropEdge(cwds, '/missing', '/a')).toBeNull()
})

// ── reduceWorkspaceOrderMoved ────────────────────────────────────────────────

test('the first drag freezes the visible order and applies the move', () => {
  const cwds = ['/a', '/b', '/c']
  expect(reduceWorkspaceOrderMoved([], cwds, '/c', '/a')).toEqual([
    '/c',
    '/a',
    '/b',
  ])
  expect(reduceWorkspaceOrderMoved([], cwds, '/a', '/c')).toEqual([
    '/b',
    '/c',
    '/a',
  ])
})

test('a move onto an adjacent group swaps exactly those two', () => {
  const cwds = ['/a', '/b', '/c']
  expect(reduceWorkspaceOrderMoved([], cwds, '/b', '/a')).toEqual([
    '/b',
    '/a',
    '/c',
  ])
  expect(reduceWorkspaceOrderMoved([], cwds, '/b', '/c')).toEqual([
    '/a',
    '/c',
    '/b',
  ])
})

test('a no-op move returns the SAME reference so no state write happens', () => {
  const order: WorkspaceOrder = ['/a', '/b']
  const cwds = ['/a', '/b', '']
  expect(reduceWorkspaceOrderMoved(order, cwds, '/a', '/a')).toBe(order)
  expect(reduceWorkspaceOrderMoved(order, cwds, '/a', '')).toBe(order)
  expect(reduceWorkspaceOrderMoved(order, cwds, '/a', '/gone')).toBe(order)
})

test('a workspace hidden by the search box keeps its rank across a reorder', () => {
  // `/b` is ranked but filtered out of the rendered sequence; reordering the two
  // visible groups must not demote it.
  const order: WorkspaceOrder = ['/a', '/b', '/c']
  const visible = ['/a', '/c']
  expect(reduceWorkspaceOrderMoved(order, visible, '/c', '/a')).toEqual([
    '/c',
    '/a',
    '/b',
  ])
})

test('the reorder result is what the rail then renders (reducer ↔ selector agree)', () => {
  const incoming = groups('/a', '/b', '/c')
  const next = reduceWorkspaceOrderMoved([], cwdsOf(incoming), '/c', '/a')
  expect(cwdsOf(selectOrderedWorkspaceGroups(incoming, next))).toEqual([
    '/c',
    '/a',
    '/b',
  ])
})

test('the drop edge shown is the edge the move actually uses', () => {
  const cwds = ['/a', '/b', '/c']
  // Dragging /a down onto /c shows an "after" rule under /c — and /a lands there.
  expect(selectWorkspaceDropEdge(cwds, '/a', '/c')).toBe('after')
  expect(reduceWorkspaceOrderMoved([], cwds, '/a', '/c').slice(-1)).toEqual([
    '/a',
  ])
  // Dragging /c up onto /a shows a "before" rule over /a — and /c lands there.
  expect(selectWorkspaceDropEdge(cwds, '/c', '/a')).toBe('before')
  expect(reduceWorkspaceOrderMoved([], cwds, '/c', '/a')[0]).toBe('/c')
})

// ── reduceWorkspaceOrderStepped (⌥↑/⌥↓) ──────────────────────────────────────

test('a keyboard step moves the workspace one slot in either direction', () => {
  const cwds = ['/a', '/b', '/c']
  expect(reduceWorkspaceOrderStepped([], cwds, '/b', 'up')).toEqual([
    '/b',
    '/a',
    '/c',
  ])
  expect(reduceWorkspaceOrderStepped([], cwds, '/b', 'down')).toEqual([
    '/a',
    '/c',
    '/b',
  ])
})

test('a step past either end, or past the pinned Unknown bucket, is a no-op', () => {
  const order: WorkspaceOrder = ['/a', '/b']
  const cwds = ['/a', '/b', '']
  expect(reduceWorkspaceOrderStepped(order, cwds, '/a', 'up')).toBe(order)
  // `/b`'s down-neighbour is the Unknown bucket, which is not a drop target.
  expect(reduceWorkspaceOrderStepped(order, cwds, '/b', 'down')).toBe(order)
  expect(reduceWorkspaceOrderStepped(order, cwds, '', 'up')).toBe(order)
  expect(reduceWorkspaceOrderStepped(order, cwds, '/missing', 'up')).toBe(order)
})

test('repeated steps walk a workspace to the top and stop there', () => {
  const cwds = ['/a', '/b', '/c']
  let order = reduceWorkspaceOrderStepped([], cwds, '/c', 'up')
  expect(order).toEqual(['/a', '/c', '/b'])
  // The rendered sequence changes with the order, so re-derive it each step.
  let rendered = cwdsOf(selectOrderedWorkspaceGroups(groups(...cwds), order))
  order = reduceWorkspaceOrderStepped(order, rendered, '/c', 'up')
  expect(order).toEqual(['/c', '/a', '/b'])
  rendered = cwdsOf(selectOrderedWorkspaceGroups(groups(...cwds), order))
  expect(reduceWorkspaceOrderStepped(order, rendered, '/c', 'up')).toBe(order)
})

// ── persistence ──────────────────────────────────────────────────────────────

test('an order round-trips through storage (the restart path)', () => {
  const store = storage()
  writeWorkspaceOrderToStorage(store, ['/c', '/a', '/b'])
  expect(readWorkspaceOrderFromStorage(store)).toEqual(['/c', '/a', '/b'])
  expect(store.raw.get(SIDEBAR_WORKSPACE_ORDER_STORAGE_KEY)).toBe(
    JSON.stringify({ version: 1, cwds: ['/c', '/a', '/b'] }),
  )
})

test('an empty, missing, corrupt, or wrong-version store degrades to no order', () => {
  expect(readWorkspaceOrderFromStorage(null)).toBeNull()
  expect(readWorkspaceOrderFromStorage(storage())).toBeNull()
  expect(
    readWorkspaceOrderFromStorage(
      storage({ [SIDEBAR_WORKSPACE_ORDER_STORAGE_KEY]: '{oops' }),
    ),
  ).toBeNull()
  expect(
    readWorkspaceOrderFromStorage(
      storage({
        [SIDEBAR_WORKSPACE_ORDER_STORAGE_KEY]: JSON.stringify({
          version: 2,
          cwds: ['/a'],
        }),
      }),
    ),
  ).toBeNull()
  expect(
    readWorkspaceOrderFromStorage(
      storage({
        [SIDEBAR_WORKSPACE_ORDER_STORAGE_KEY]: JSON.stringify({
          version: 1,
          cwds: '/a',
        }),
      }),
    ),
  ).toBeNull()
})

test('a stored order with junk entries is sanitized rather than rejected', () => {
  const read = readWorkspaceOrderFromStorage(
    storage({
      [SIDEBAR_WORKSPACE_ORDER_STORAGE_KEY]: JSON.stringify({
        version: 1,
        cwds: ['/a', 7, '/a', '', '   ', null, '/b'],
      }),
    }),
  )
  expect(read).toEqual(['/a', '/b'])
})

test('persistence is capped so the kept-forever order cannot grow without bound', () => {
  const many = Array.from(
    { length: MAX_SIDEBAR_WORKSPACE_ORDER_ENTRIES + 10 },
    (_, index) => `/w/${index}`,
  )
  const store = storage()
  writeWorkspaceOrderToStorage(store, many)
  const read = readWorkspaceOrderFromStorage(store)
  expect(read).toHaveLength(MAX_SIDEBAR_WORKSPACE_ORDER_ENTRIES)
  // The tail (least-preferred) is what is dropped.
  expect(read?.[0]).toBe('/w/0')
  expect(read?.at(-1)).toBe(
    `/w/${MAX_SIDEBAR_WORKSPACE_ORDER_ENTRIES - 1}`,
  )
})

test('a throwing storage never breaks the reorder (best-effort persistence)', () => {
  const hostile = {
    getItem: () => {
      throw new Error('denied')
    },
    setItem: () => {
      throw new Error('denied')
    },
  }
  expect(readWorkspaceOrderFromStorage(hostile)).toBeNull()
  expect(() => writeWorkspaceOrderToStorage(hostile, ['/a'])).not.toThrow()
})

// ── the composed production path ─────────────────────────────────────────────

function row(cwd: string, id: string): MergedSessionRow {
  return {
    sessionId: `engine-${id}`,
    appSessionId: null,
    cwd,
    cwdExists: true,
    title: id,
    displayLabel: id,
    live: false,
    restorable: false,
    parked: false,
    status: 'history',
    inRegistry: false,
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
  }
}

test('drop → persist → relaunch → render, over the REAL shared grouping selector', () => {
  const rows = [
    row('/Users/pt/cat-code', 'a'),
    row('/Users/pt/PTClove/app', 'b'),
    row('/tmp', 'c'),
    row('', 'orphan'),
  ]

  // What the rail shows today: `groupByWorkspace`'s frozen-alphabetical order.
  const graph = groupByWorkspace(rows, null)
  expect(graph.map(group => group.name)).toEqual([
    'app',
    'cat-code',
    'tmp',
    'Unknown workspace',
  ])

  // Session 1 — the operator drags `tmp` to the top, exactly as the Sidebar's
  // drop handler does it, and the result is written to storage.
  const store = storage()
  const session1Order = readWorkspaceOrderFromStorage(store) ?? createWorkspaceOrder()
  const rendered1 = selectOrderedWorkspaceGroups(graph, session1Order)
  const moved = reduceWorkspaceOrderMoved(
    session1Order,
    cwdsOf(rendered1),
    '/tmp',
    '/Users/pt/PTClove/app',
  )
  writeWorkspaceOrderToStorage(store, moved)
  expect(
    cwdsOf(selectOrderedWorkspaceGroups(graph, moved)).slice(0, 1),
  ).toEqual(['/tmp'])

  // Session 2 — a fresh mount reads the same store and re-renders the choice.
  const session2Order = readWorkspaceOrderFromStorage(store) ?? createWorkspaceOrder()
  const rendered2 = selectOrderedWorkspaceGroups(groupByWorkspace(rows, null), session2Order)
  expect(rendered2.map(group => group.name)).toEqual([
    'tmp',
    'app',
    'cat-code',
    'Unknown workspace',
  ])
})

test('the order survives a label change — it is keyed on cwd, never the label', () => {
  // CC-14/CC-15: opening a SECOND workspace whose basename is `app` widens both
  // labels (`app` → `PTClove/app`, `cat-code/app`). An order keyed on the label
  // would lose its match here; keyed on cwd it does not.
  const before = [row('/Users/pt/PTClove/app', 'a'), row('/tmp', 'b')]
  const beforeGroups = groupByWorkspace(before, null)
  expect(beforeGroups.map(group => group.name)).toEqual(['app', 'tmp'])

  const order = reduceWorkspaceOrderMoved(
    [],
    cwdsOf(beforeGroups),
    '/tmp',
    '/Users/pt/PTClove/app',
  )
  expect(cwdsOf(selectOrderedWorkspaceGroups(beforeGroups, order))).toEqual([
    '/tmp',
    '/Users/pt/PTClove/app',
  ])

  const after = [...before, row('/Users/pt/cat-code/app', 'c')]
  const afterGroups = groupByWorkspace(after, null)
  expect(afterGroups.map(group => group.name)).toEqual([
    'cat-code/app',
    'PTClove/app',
    'tmp',
  ])
  // The renamed group keeps its placement below `/tmp`; the newcomer appends.
  expect(cwdsOf(selectOrderedWorkspaceGroups(afterGroups, order))).toEqual([
    '/tmp',
    '/Users/pt/PTClove/app',
    '/Users/pt/cat-code/app',
  ])
})
