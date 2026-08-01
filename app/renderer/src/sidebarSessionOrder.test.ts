import { expect, test } from 'bun:test'
import {
  MAX_SIDEBAR_ORDERED_SESSIONS_PER_WORKSPACE,
  MAX_SIDEBAR_ORDERED_WORKSPACES,
  SIDEBAR_SESSION_ORDER_STORAGE_KEY,
  createSessionOrder,
  readSessionOrderFromStorage,
  reduceSessionOrderMoved,
  reduceSessionOrderStepped,
  selectOrderedGroupRows,
  selectSessionDropEdge,
  writeSessionOrderToStorage,
} from './sidebarSessionOrder.js'

// Dragging a session row inside its project is a pure module by necessity: the
// renderer suite is SSR-only (`renderToStaticMarkup`), so no drag, pointer event
// or effect can fire there. Everything the drop/keyboard handlers decide is
// exercised here; the DOM wiring over it is asserted in `Sidebar.test.tsx`, and
// the live gesture is operator-GUI only.

const CWD = '/tmp/proj'

function rows(...ids: string[]): { sessionId: string }[] {
  return ids.map(sessionId => ({ sessionId }))
}

function idsOf(list: readonly { sessionId: string }[]): string[] {
  return list.map(row => row.sessionId)
}

function storage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  }
}

// ── coexistence with CC-2 activity order ─────────────────────────────────────

test('a group nobody has dragged keeps the incoming activity order exactly', () => {
  const list = rows('a', 'b', 'c')
  expect(idsOf(selectOrderedGroupRows(list, createSessionOrder(), CWD))).toEqual(
    ['a', 'b', 'c'],
  )
})

test('a ranked row holds its slot, so a message no longer floats it', () => {
  // The roster arrives in activity order (c messaged most recently); the stored
  // arrangement overrides that for the rows the operator placed.
  const list = rows('c', 'a', 'b')
  const order = { [CWD]: ['a', 'b', 'c'] }
  expect(idsOf(selectOrderedGroupRows(list, order, CWD))).toEqual([
    'a',
    'b',
    'c',
  ])
})

test('a new, never-dragged session lands ABOVE the arrangement, not under it', () => {
  // `d` is unranked. Burying it below the shelf would hide the session the
  // operator just created.
  const list = rows('d', 'a', 'b')
  const order = { [CWD]: ['a', 'b'] }
  expect(idsOf(selectOrderedGroupRows(list, order, CWD))).toEqual([
    'd',
    'a',
    'b',
  ])
})

test('unranked rows keep activity order among themselves', () => {
  const list = rows('e', 'd', 'a')
  const order = { [CWD]: ['a'] }
  expect(idsOf(selectOrderedGroupRows(list, order, CWD))).toEqual([
    'e',
    'd',
    'a',
  ])
})

test('an order entry for a row this render does not hold is skipped, not lost', () => {
  const list = rows('a')
  expect(idsOf(selectOrderedGroupRows(list, { [CWD]: ['gone', 'a'] }, CWD))).toEqual(
    ['a'],
  )
})

test('one workspace order never leaks into another', () => {
  const order = { [CWD]: ['b', 'a'] }
  const list = rows('a', 'b')
  expect(idsOf(selectOrderedGroupRows(list, order, '/other'))).toEqual(['a', 'b'])
  // The "Unknown workspace" bucket carries no order at all.
  expect(idsOf(selectOrderedGroupRows(list, { '': ['b', 'a'] }, ''))).toEqual([
    'a',
    'b',
  ])
})

// ── the drop itself ──────────────────────────────────────────────────────────

test('the drop edge follows the drag direction', () => {
  const ids = ['a', 'b', 'c']
  expect(selectSessionDropEdge(ids, 'a', 'c')).toBe('after')
  expect(selectSessionDropEdge(ids, 'c', 'a')).toBe('before')
  expect(selectSessionDropEdge(ids, 'a', 'a')).toBeNull()
  expect(selectSessionDropEdge(ids, 'a', 'gone')).toBeNull()
})

test('the first drag freezes the whole group, not just the two rows involved', () => {
  // Without the freeze, b and c would stay unranked and would sort ABOVE the
  // ranked block — jumping the arrangement the operator just made.
  const next = reduceSessionOrderMoved(
    createSessionOrder(),
    CWD,
    ['a', 'b', 'c'],
    'c',
    'a',
  )
  expect(next[CWD]).toEqual(['c', 'a', 'b'])
})

test('dragging down lands after the hovered row, dragging up lands before it', () => {
  const ids = ['a', 'b', 'c']
  expect(reduceSessionOrderMoved({}, CWD, ids, 'a', 'c')[CWD]).toEqual([
    'b',
    'c',
    'a',
  ])
  expect(reduceSessionOrderMoved({}, CWD, ids, 'c', 'a')[CWD]).toEqual([
    'c',
    'a',
    'b',
  ])
})

test('a row hidden by search or the row cap keeps its slot across a reorder', () => {
  // Rendered sequence is a,c — b is filtered out but must not be demoted.
  const next = reduceSessionOrderMoved(
    { [CWD]: ['a', 'b', 'c'] },
    CWD,
    ['a', 'c'],
    'a',
    'c',
    ['a', 'b', 'c'],
  )
  expect(next[CWD]).toEqual(['b', 'c', 'a'])
})

test('reordering one workspace leaves every other workspace untouched', () => {
  const next = reduceSessionOrderMoved(
    { '/other': ['x', 'y'] },
    CWD,
    ['a', 'b'],
    'b',
    'a',
  )
  expect(next['/other']).toEqual(['x', 'y'])
  expect(next[CWD]).toEqual(['b', 'a'])
})

test('an illegal move returns the same reference so the caller can skip the write', () => {
  const order = { [CWD]: ['a', 'b'] }
  expect(reduceSessionOrderMoved(order, CWD, ['a', 'b'], 'a', 'a')).toBe(order)
  expect(reduceSessionOrderMoved(order, CWD, ['a', 'b'], 'a', 'gone')).toBe(order)
  // The "Unknown workspace" bucket is not orderable.
  expect(reduceSessionOrderMoved(order, '', ['a', 'b'], 'a', 'b')).toBe(order)
})

test('⌥↑/⌥↓ steps one slot and no-ops at either end', () => {
  const ids = ['a', 'b', 'c']
  expect(reduceSessionOrderStepped({}, CWD, ids, 'b', 'up')[CWD]).toEqual([
    'b',
    'a',
    'c',
  ])
  expect(reduceSessionOrderStepped({}, CWD, ids, 'b', 'down')[CWD]).toEqual([
    'a',
    'c',
    'b',
  ])
  const order = { [CWD]: ['a', 'b', 'c'] }
  expect(reduceSessionOrderStepped(order, CWD, ids, 'a', 'up')).toBe(order)
  expect(reduceSessionOrderStepped(order, CWD, ids, 'c', 'down')).toBe(order)
  expect(reduceSessionOrderStepped(order, CWD, ids, 'gone', 'up')).toBe(order)
})

test('a drag and the equivalent keyboard step produce the same order', () => {
  const ids = ['a', 'b', 'c']
  expect(reduceSessionOrderStepped({}, CWD, ids, 'c', 'up')).toEqual(
    reduceSessionOrderMoved({}, CWD, ids, 'c', 'b'),
  )
})

// ── persistence ──────────────────────────────────────────────────────────────

test('the order round-trips through storage', () => {
  const store = storage()
  writeSessionOrderToStorage(store, { [CWD]: ['a', 'b'], '/other': ['x'] })
  expect(readSessionOrderFromStorage(store)).toEqual({
    [CWD]: ['a', 'b'],
    '/other': ['x'],
  })
})

test('a missing, unparseable, wrong-version or wrong-shaped record reads as null', () => {
  expect(readSessionOrderFromStorage(storage())).toBeNull()
  expect(
    readSessionOrderFromStorage(
      storage({ [SIDEBAR_SESSION_ORDER_STORAGE_KEY]: '{' }),
    ),
  ).toBeNull()
  expect(
    readSessionOrderFromStorage(
      storage({
        [SIDEBAR_SESSION_ORDER_STORAGE_KEY]: JSON.stringify({
          version: 2,
          byWorkspace: { [CWD]: ['a'] },
        }),
      }),
    ),
  ).toBeNull()
  expect(
    readSessionOrderFromStorage(
      storage({
        [SIDEBAR_SESSION_ORDER_STORAGE_KEY]: JSON.stringify({
          version: 1,
          byWorkspace: [['a']],
        }),
      }),
    ),
  ).toBeNull()
})

test('the storage boundary drops non-strings, blanks, duplicates and empty groups', () => {
  const store = storage({
    [SIDEBAR_SESSION_ORDER_STORAGE_KEY]: JSON.stringify({
      version: 1,
      byWorkspace: {
        [CWD]: ['a', 7, '', 'a', 'b'],
        '': ['x'],
        '/empty': [],
        '/bad': 'nope',
      },
    }),
  })
  expect(readSessionOrderFromStorage(store)).toEqual({ [CWD]: ['a', 'b'] })
})

test('the storage boundary caps both axes at the least-preferred tail', () => {
  const ids = Array.from(
    { length: MAX_SIDEBAR_ORDERED_SESSIONS_PER_WORKSPACE + 5 },
    (_, index) => `s${index}`,
  )
  const many: Record<string, string[]> = {}
  for (let i = 0; i < MAX_SIDEBAR_ORDERED_WORKSPACES + 5; i += 1) {
    many[`/w${i}`] = ids
  }
  const store = storage()
  writeSessionOrderToStorage(store, many)
  const read = readSessionOrderFromStorage(store)!
  expect(Object.keys(read)).toHaveLength(MAX_SIDEBAR_ORDERED_WORKSPACES)
  expect(read['/w0']).toHaveLength(MAX_SIDEBAR_ORDERED_SESSIONS_PER_WORKSPACE)
  expect(read['/w0']?.[0]).toBe('s0')
})

test('a null storage disables persistence without throwing', () => {
  expect(() => writeSessionOrderToStorage(null, { [CWD]: ['a'] })).not.toThrow()
  expect(readSessionOrderFromStorage(null)).toBeNull()
})

test('a throwing storage never propagates (view state is best-effort)', () => {
  const hostile = {
    getItem: () => {
      throw new Error('denied')
    },
    setItem: () => {
      throw new Error('denied')
    },
  }
  expect(readSessionOrderFromStorage(hostile)).toBeNull()
  expect(() =>
    writeSessionOrderToStorage(hostile, { [CWD]: ['a'] }),
  ).not.toThrow()
})
