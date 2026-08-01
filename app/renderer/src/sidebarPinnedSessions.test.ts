import { expect, test } from 'bun:test'
import {
  MAX_SIDEBAR_PINNED_SESSIONS,
  SIDEBAR_PINNED_SESSIONS_STORAGE_KEY,
  createPinnedSessions,
  isSessionPinned,
  readPinnedSessionsFromStorage,
  reducePinnedSessionsMoved,
  reducePinnedSessionsStepped,
  reducePinnedSessionsToggled,
  selectPinnedDropEdge,
  selectPinnedRows,
  selectUnpinnedRows,
  writePinnedSessionsToStorage,
} from './sidebarPinnedSessions.js'

// The Pinned section's behaviour is a pure module by necessity: the renderer
// suite is SSR-only (`renderToStaticMarkup`), so no drag, pointer event or
// effect can fire there. Everything the pin/drop/keyboard handlers decide is
// exercised here; the DOM wiring over it is asserted in `Sidebar.test.tsx`, and
// the live gesture is operator-GUI only.

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
    raw: store,
  }
}

// ── pin membership ───────────────────────────────────────────────────────────

test('a fresh install pins nothing', () => {
  expect(createPinnedSessions()).toEqual([])
})

test('pinning appends, so an existing arrangement is never displaced', () => {
  let pinned = createPinnedSessions()
  pinned = reducePinnedSessionsToggled(pinned, 'a')
  pinned = reducePinnedSessionsToggled(pinned, 'b')
  expect(pinned).toEqual(['a', 'b'])
  expect(isSessionPinned(pinned, 'a')).toBe(true)
  expect(isSessionPinned(pinned, 'z')).toBe(false)
})

test('unpinning removes only that session and keeps the rest in order', () => {
  const pinned = reducePinnedSessionsToggled(['a', 'b', 'c'], 'b')
  expect(pinned).toEqual(['a', 'c'])
})

test('an empty key is not pinnable and returns the same reference', () => {
  const pinned = ['a']
  expect(reducePinnedSessionsToggled(pinned, '  ')).toBe(pinned)
})

// ── partition (lifted, never duplicated) ─────────────────────────────────────

test('pinned rows render in PIN order, not the roster order', () => {
  // The roster arrives in CC-2 activity order; the Pinned section overrides it.
  const list = rows('a', 'b', 'c')
  expect(idsOf(selectPinnedRows(list, ['c', 'a']))).toEqual(['c', 'a'])
})

test('a pinned row is lifted out of its project group, not shown twice', () => {
  const list = rows('a', 'b', 'c')
  expect(idsOf(selectPinnedRows(list, ['b']))).toEqual(['b'])
  expect(idsOf(selectUnpinnedRows(list, ['b']))).toEqual(['a', 'c'])
})

test('a pin naming a session this render has not enumerated is skipped, not lost', () => {
  // The search box filtering, or a relaunch that has not read that transcript
  // yet — neither may drop the pin itself (that lives in storage).
  const list = rows('a')
  expect(idsOf(selectPinnedRows(list, ['gone', 'a']))).toEqual(['a'])
})

test('with nothing pinned every row stays in its group', () => {
  const list = rows('a', 'b')
  expect(idsOf(selectUnpinnedRows(list, []))).toEqual(['a', 'b'])
  expect(selectPinnedRows(list, [])).toEqual([])
})

// ── reorder within the Pinned section ────────────────────────────────────────

test('the drop edge follows the drag direction', () => {
  const ids = ['a', 'b', 'c']
  expect(selectPinnedDropEdge(ids, 'a', 'c')).toBe('after')
  expect(selectPinnedDropEdge(ids, 'c', 'a')).toBe('before')
  expect(selectPinnedDropEdge(ids, 'a', 'a')).toBeNull()
  expect(selectPinnedDropEdge(ids, 'a', 'gone')).toBeNull()
})

test('dragging down lands after the hovered row, dragging up lands before it', () => {
  expect(reducePinnedSessionsMoved(['a', 'b', 'c'], ['a', 'b', 'c'], 'a', 'c')).toEqual(
    ['b', 'c', 'a'],
  )
  expect(reducePinnedSessionsMoved(['a', 'b', 'c'], ['a', 'b', 'c'], 'c', 'a')).toEqual(
    ['c', 'a', 'b'],
  )
})

test('a pin the search box is hiding keeps its slot across a reorder of two visible ones', () => {
  // Rendered sequence is 'a','c' — 'b' is filtered out but must not be demoted.
  expect(reducePinnedSessionsMoved(['a', 'b', 'c'], ['a', 'c'], 'a', 'c')).toEqual([
    'b',
    'c',
    'a',
  ])
})

test('an illegal move returns the same reference so the caller can skip the write', () => {
  const pinned = ['a', 'b']
  expect(reducePinnedSessionsMoved(pinned, ['a', 'b'], 'a', 'a')).toBe(pinned)
  expect(reducePinnedSessionsMoved(pinned, ['a', 'b'], 'a', 'gone')).toBe(pinned)
  // A row that is not pinned at all cannot be dropped into the pinned order.
  expect(reducePinnedSessionsMoved(pinned, ['a', 'b', 'x'], 'x', 'a')).toBe(pinned)
})

test('⌥↑/⌥↓ steps one slot and no-ops at either end', () => {
  const ids = ['a', 'b', 'c']
  expect(reducePinnedSessionsStepped(['a', 'b', 'c'], ids, 'b', 'up')).toEqual([
    'b',
    'a',
    'c',
  ])
  expect(reducePinnedSessionsStepped(['a', 'b', 'c'], ids, 'b', 'down')).toEqual([
    'a',
    'c',
    'b',
  ])
  const pinned = ['a', 'b', 'c']
  expect(reducePinnedSessionsStepped(pinned, ids, 'a', 'up')).toBe(pinned)
  expect(reducePinnedSessionsStepped(pinned, ids, 'c', 'down')).toBe(pinned)
  expect(reducePinnedSessionsStepped(pinned, ids, 'gone', 'up')).toBe(pinned)
})

// ── persistence ──────────────────────────────────────────────────────────────

test('the pin list round-trips through storage', () => {
  const store = storage()
  writePinnedSessionsToStorage(store, ['a', 'b'])
  expect(readPinnedSessionsFromStorage(store)).toEqual(['a', 'b'])
})

test('a missing, unparseable, wrong-version or wrong-shaped record reads as null', () => {
  expect(readPinnedSessionsFromStorage(storage())).toBeNull()
  expect(
    readPinnedSessionsFromStorage(
      storage({ [SIDEBAR_PINNED_SESSIONS_STORAGE_KEY]: '{' }),
    ),
  ).toBeNull()
  expect(
    readPinnedSessionsFromStorage(
      storage({
        [SIDEBAR_PINNED_SESSIONS_STORAGE_KEY]: JSON.stringify({
          version: 2,
          sessionIds: ['a'],
        }),
      }),
    ),
  ).toBeNull()
  expect(
    readPinnedSessionsFromStorage(
      storage({
        [SIDEBAR_PINNED_SESSIONS_STORAGE_KEY]: JSON.stringify({
          version: 1,
          sessionIds: 'a',
        }),
      }),
    ),
  ).toBeNull()
})

test('the storage boundary drops non-strings, blanks and duplicates', () => {
  const store = storage({
    [SIDEBAR_PINNED_SESSIONS_STORAGE_KEY]: JSON.stringify({
      version: 1,
      sessionIds: ['a', 3, '', 'a', 'b'],
    }),
  })
  expect(readPinnedSessionsFromStorage(store)).toEqual(['a', 'b'])
})

test('the storage boundary caps the least-preferred tail', () => {
  const many = Array.from(
    { length: MAX_SIDEBAR_PINNED_SESSIONS + 5 },
    (_, index) => `s${index}`,
  )
  const store = storage()
  writePinnedSessionsToStorage(store, many)
  expect(readPinnedSessionsFromStorage(store)).toHaveLength(
    MAX_SIDEBAR_PINNED_SESSIONS,
  )
  expect(readPinnedSessionsFromStorage(store)?.[0]).toBe('s0')
})

test('a null storage disables persistence without throwing', () => {
  expect(() => writePinnedSessionsToStorage(null, ['a'])).not.toThrow()
  expect(readPinnedSessionsFromStorage(null)).toBeNull()
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
  expect(readPinnedSessionsFromStorage(hostile)).toBeNull()
  expect(() => writePinnedSessionsToStorage(hostile, ['a'])).not.toThrow()
})
