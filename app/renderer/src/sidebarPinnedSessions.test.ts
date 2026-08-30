import { expect, test } from 'bun:test'
import {
  MAX_SIDEBAR_PINNED_SESSIONS,
  SIDEBAR_PINNED_SESSIONS_STORAGE_KEY,
  createPinnedSessions,
  isSessionPinned,
  readPinnedSessionsFromStorage,
  reducePinnedSessionsMoved,
  reducePinnedSessionsReconciled,
  reducePinnedSessionsStepped,
  reducePinnedSessionsToggled,
  selectPinnedDropEdge,
  selectPinnedRows,
  selectUnpinnedRows,
  writePinnedSessionsToStorage,
  type PinnedSessions,
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

// ── the app-id → engine-id handover ──────────────────────────────────────────

function mergedRows(
  ...pairs: [sessionId: string, appSessionId: string | null][]
): { sessionId: string; appSessionId: string | null }[] {
  return pairs.map(([sessionId, appSessionId]) => ({ sessionId, appSessionId }))
}

test('REGRESSION: a pin set before the engine id lands survives the handover', () => {
  // The bug: the merge key is `engineSessionId ?? appSessionId`
  // (`sessionsCatalogState.ts` `selectMergedSessionRows`), so a session pinned
  // during the ~1-3s pre-ready window is stored under its APP id, and the pin
  // stopped resolving the moment the ready frame supplied the engine id.
  const pinned = reducePinnedSessionsToggled(createPinnedSessions(), 'app-1')
  expect(selectPinnedRows(mergedRows(['app-1', 'app-1']), pinned)).toHaveLength(1)

  // …the ready frame lands and the row re-keys to its engine id.
  const afterReady = mergedRows(['engine-1', 'app-1'])
  const next = reducePinnedSessionsReconciled(pinned, afterReady)
  expect(next).toEqual(['engine-1'])
  expect(isSessionPinned(next, 'engine-1')).toBe(true)
  expect(idsOf(selectPinnedRows(afterReady, next))).toEqual(['engine-1'])
  expect(selectUnpinnedRows(afterReady, next)).toEqual([])
})

test('the dead app id is gone from storage once reconciled', () => {
  const store = storage()
  writePinnedSessionsToStorage(store, ['keep', 'app-1'])
  const next = reducePinnedSessionsReconciled(
    readPinnedSessionsFromStorage(store) ?? [],
    mergedRows(['engine-1', 'app-1']),
  )
  writePinnedSessionsToStorage(store, next)
  const read = readPinnedSessionsFromStorage(store)
  expect(read).toEqual(['keep', 'engine-1'])
  expect(read).not.toContain('app-1')
})

test('reconciling keeps the pin slot rather than re-appending it at the tail', () => {
  const next = reducePinnedSessionsReconciled(
    ['app-1', 'b', 'c'],
    mergedRows(['engine-1', 'app-1']),
  )
  expect(next).toEqual(['engine-1', 'b', 'c'])
})

test('a pre-ready row is left alone while its key is still the app id', () => {
  const pinned: PinnedSessions = ['app-1']
  expect(
    reducePinnedSessionsReconciled(pinned, mergedRows(['app-1', 'app-1'])),
  ).toBe(pinned)
})

test('history rows carry no app id and are never rewritten', () => {
  const pinned: PinnedSessions = ['engine-history', 'engine-1']
  expect(
    reducePinnedSessionsReconciled(
      pinned,
      mergedRows(['engine-history', null], ['engine-1', 'app-1']),
    ),
  ).toBe(pinned)
})

test('reconciling both ids of one session collapses them to a single pin', () => {
  expect(
    reducePinnedSessionsReconciled(
      ['engine-1', 'app-1'],
      mergedRows(['engine-1', 'app-1']),
    ),
  ).toEqual(['engine-1'])
})

test('the cap still holds after a reconcile', () => {
  const pinned: PinnedSessions = [
    ...Array.from(
      { length: MAX_SIDEBAR_PINNED_SESSIONS },
      (_, index) => `s${index}`,
    ),
    'app-1',
  ]
  const next = reducePinnedSessionsReconciled(
    pinned,
    mergedRows(['engine-1', 'app-1']),
  )
  expect(next).toHaveLength(MAX_SIDEBAR_PINNED_SESSIONS + 1)

  const store = storage()
  writePinnedSessionsToStorage(store, next)
  const read = readPinnedSessionsFromStorage(store)
  expect(read).toHaveLength(MAX_SIDEBAR_PINNED_SESSIONS)
  expect(read).toContain('engine-1')
  expect(read).not.toContain('s0')
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

test('the storage boundary caps the oldest-pinned HEAD, never the newest tail', () => {
  // A new pin lands at the TAIL (`reducePinnedSessionsToggled`), so the cap
  // must drop overflow from the HEAD — the entries pinned longest ago — or a
  // pin created right at the cap would always be the one silently lost.
  const many = Array.from(
    { length: MAX_SIDEBAR_PINNED_SESSIONS + 5 },
    (_, index) => `s${index}`,
  )
  const store = storage()
  writePinnedSessionsToStorage(store, many)
  const read = readPinnedSessionsFromStorage(store)
  expect(read).toHaveLength(MAX_SIDEBAR_PINNED_SESSIONS)
  expect(read?.[0]).toBe('s5')
  expect(read?.at(-1)).toBe(`s${MAX_SIDEBAR_PINNED_SESSIONS + 4}`)
})

test('REGRESSION: a new pin past the cap survives a relaunch; the oldest pin yields instead', () => {
  // The bug: MAX_SIDEBAR_PINNED_SESSIONS truncated the tail while
  // reducePinnedSessionsToggled appends new pins to the tail, so the pin the
  // operator JUST created was always the one dropped on the next launch — the
  // UI showed it succeed (in-memory state is uncapped) right up until then.
  let pinned: PinnedSessions = Array.from(
    { length: MAX_SIDEBAR_PINNED_SESSIONS },
    (_, index) => `s${index}`,
  )
  pinned = reducePinnedSessionsToggled(pinned, 'new')
  expect(pinned).toHaveLength(MAX_SIDEBAR_PINNED_SESSIONS + 1) // in-memory: uncapped

  const store = storage()
  writePinnedSessionsToStorage(store, pinned)
  const read = readPinnedSessionsFromStorage(store)
  expect(read).toHaveLength(MAX_SIDEBAR_PINNED_SESSIONS)
  expect(read).toContain('new')
  expect(read).not.toContain('s0')
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
