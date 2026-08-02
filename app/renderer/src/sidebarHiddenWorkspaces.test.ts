import { expect, test } from 'bun:test'
import {
  MAX_SIDEBAR_HIDDEN_WORKSPACES,
  SIDEBAR_HIDDEN_WORKSPACES_STORAGE_KEY,
  createHiddenWorkspaces,
  readHiddenWorkspacesFromStorage,
  reduceHiddenWorkspacesCleared,
  reduceHiddenWorkspacesShown,
  reduceWorkspaceHidden,
  reduceWorkspaceShown,
  selectVisibleWorkspaceGroups,
  writeHiddenWorkspacesToStorage,
} from './sidebarHiddenWorkspaces.js'

// Hiding a project is a pure module by necessity: the renderer suite is SSR-only
// (`renderToStaticMarkup`), so the menu click that calls these reducers cannot
// fire there. The DOM wiring over it is asserted in `Sidebar.test.tsx`.

function group(cwd: string, activityAtMs: number) {
  return { cwd, activityAtMs }
}

const activityOf = (g: { activityAtMs: number }) => g.activityAtMs

function cwdsOf(list: readonly { cwd: string }[]): string[] {
  return list.map(g => g.cwd)
}

function storage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    raw: store,
  }
}

// ── hide membership ──────────────────────────────────────────────────────────

test('a fresh install hides nothing', () => {
  expect(createHiddenWorkspaces()).toEqual([])
})

test('hiding records the moment, newest first', () => {
  let hidden = createHiddenWorkspaces()
  hidden = reduceWorkspaceHidden(hidden, '/w/a', 100)
  hidden = reduceWorkspaceHidden(hidden, '/w/b', 200)
  expect(hidden).toEqual([
    { cwd: '/w/b', hiddenAt: 200 },
    { cwd: '/w/a', hiddenAt: 100 },
  ])
})

test('re-hiding refreshes the moment instead of duplicating the project', () => {
  const hidden = reduceWorkspaceHidden(
    [{ cwd: '/w/a', hiddenAt: 100 }],
    '/w/a',
    900,
  )
  expect(hidden).toEqual([{ cwd: '/w/a', hiddenAt: 900 }])
})

test('the "Unknown workspace" bucket is not hideable and returns the same reference', () => {
  const hidden = createHiddenWorkspaces()
  expect(reduceWorkspaceHidden(hidden, '', 100)).toBe(hidden)
  expect(reduceWorkspaceHidden(hidden, '   ', 100)).toBe(hidden)
})

test('showing removes only that project; showing an absent one is a no-op reference', () => {
  const hidden = [
    { cwd: '/w/a', hiddenAt: 100 },
    { cwd: '/w/b', hiddenAt: 200 },
  ]
  expect(reduceWorkspaceShown(hidden, '/w/a')).toEqual([
    { cwd: '/w/b', hiddenAt: 200 },
  ])
  expect(reduceWorkspaceShown(hidden, '/w/z')).toBe(hidden)
})

test('clearing empties the list, and is a no-op reference when nothing is hidden', () => {
  const empty = createHiddenWorkspaces()
  expect(reduceHiddenWorkspacesCleared(empty)).toBe(empty)
  expect(
    reduceHiddenWorkspacesCleared([{ cwd: '/w/a', hiddenAt: 100 }]),
  ).toEqual([])
})

// ── the restore button (BUG: it used to call reduceHiddenWorkspacesCleared,
// which emptied the WHOLE persisted list even when a search-narrowed render's
// label named a smaller count) ───────────────────────────────────────────────

test('restoring shows back exactly the groups named, nothing more', () => {
  const hidden = [
    { cwd: '/w/a', hiddenAt: 100 },
    { cwd: '/w/b', hiddenAt: 200 },
  ]
  expect(
    reduceHiddenWorkspacesShown(hidden, [{ cwd: '/w/a' }, { cwd: '/w/b' }]),
  ).toEqual([])
})

test('REGRESSION: a search-narrowed restore leaves the un-enumerated hidden project alone', () => {
  // The rail hides two projects: alpha and beta ("Show 2 hidden projects").
  // The operator searches "alpha" — beta's rows never match the query, so
  // Sidebar.tsx's own `groupRows.filter(matchesQuery)` drops beta's group
  // BEFORE `selectVisibleWorkspaceGroups` ever sees it. Only alpha survives
  // into this render's group list, so the button now reads "Show 1 hidden
  // project". The bug: clicking it called `reduceHiddenWorkspacesCleared`,
  // which emptied the whole persisted list — beta reappeared too, the moment
  // the search box was cleared, with no click on it at all.
  const hidden = [
    { cwd: '/w/beta', hiddenAt: 200 },
    { cwd: '/w/alpha', hiddenAt: 100 },
  ]
  const groups = [{ cwd: '/w/alpha' }] // search-narrowed: beta isn't here.
  const { hidden: hiddenGroups } = selectVisibleWorkspaceGroups(
    groups,
    hidden,
    () => 0,
  )
  expect(hiddenGroups).toHaveLength(1) // the button's label: "Show 1 hidden project"

  const next = reduceHiddenWorkspacesShown(hidden, hiddenGroups)
  expect(next).toEqual([{ cwd: '/w/beta', hiddenAt: 200 }])
})

test('a group naming a cwd this list never hid is a no-op for that entry', () => {
  const hidden = [{ cwd: '/w/a', hiddenAt: 100 }]
  expect(reduceHiddenWorkspacesShown(hidden, [{ cwd: '/w/z' }])).toBe(hidden)
})

test('an empty group list is a no-op reference', () => {
  const hidden = [{ cwd: '/w/a', hiddenAt: 100 }]
  expect(reduceHiddenWorkspacesShown(hidden, [])).toBe(hidden)
})

// ── what the rail shows ──────────────────────────────────────────────────────

test('nothing hidden leaves the rendered sequence untouched', () => {
  const groups = [group('/w/a', 10), group('/w/b', 20)]
  const { visible, hidden } = selectVisibleWorkspaceGroups(
    groups,
    createHiddenWorkspaces(),
    activityOf,
  )
  expect(cwdsOf(visible)).toEqual(['/w/a', '/w/b'])
  expect(hidden).toEqual([])
})

test('a hidden project is held back and the rest keep their order', () => {
  const groups = [group('/w/a', 10), group('/w/b', 20), group('/w/c', 30)]
  const { visible, hidden } = selectVisibleWorkspaceGroups(
    groups,
    [{ cwd: '/w/b', hiddenAt: 100 }],
    activityOf,
  )
  expect(cwdsOf(visible)).toEqual(['/w/a', '/w/c'])
  expect(cwdsOf(hidden)).toEqual(['/w/b'])
})

// The self-heal rule, which is why `hiddenAt` exists at all: picking a hidden
// project's folder from "Add project" creates a session there, and the group
// must come back rather than swallow it.
test('activity newer than the hide brings the project back on its own', () => {
  const { visible, hidden } = selectVisibleWorkspaceGroups(
    [group('/w/a', 150)],
    [{ cwd: '/w/a', hiddenAt: 100 }],
    activityOf,
  )
  expect(cwdsOf(visible)).toEqual(['/w/a'])
  expect(hidden).toEqual([])
})

test('activity older than the hide keeps the project hidden', () => {
  const { visible, hidden } = selectVisibleWorkspaceGroups(
    [group('/w/a', 50)],
    [{ cwd: '/w/a', hiddenAt: 100 }],
    activityOf,
  )
  expect(visible).toEqual([])
  expect(cwdsOf(hidden)).toEqual(['/w/a'])
})

// A hidden project that came back must be hideable again — the refresh in
// `reduceWorkspaceHidden` is what makes the second hide stick.
test('hiding again after a self-heal holds the project back once more', () => {
  const groups = [group('/w/a', 150)]
  const hidden = reduceWorkspaceHidden(
    [{ cwd: '/w/a', hiddenAt: 100 }],
    '/w/a',
    200,
  )
  expect(
    cwdsOf(selectVisibleWorkspaceGroups(groups, hidden, activityOf).visible),
  ).toEqual([])
})

// ── persistence ──────────────────────────────────────────────────────────────

test('a round trip through storage preserves the list', () => {
  const store = storage()
  const hidden = [{ cwd: '/w/a', hiddenAt: 100 }]
  writeHiddenWorkspacesToStorage(store, hidden)
  expect(readHiddenWorkspacesFromStorage(store)).toEqual(hidden)
})

test('no storage means no persistence, never a throw', () => {
  expect(readHiddenWorkspacesFromStorage(null)).toBeNull()
  expect(() => writeHiddenWorkspacesToStorage(null, [])).not.toThrow()
})

test('a missing, corrupt or wrong-version record reads as nothing hidden', () => {
  expect(readHiddenWorkspacesFromStorage(storage())).toBeNull()
  expect(
    readHiddenWorkspacesFromStorage(
      storage({ [SIDEBAR_HIDDEN_WORKSPACES_STORAGE_KEY]: '{oops' }),
    ),
  ).toBeNull()
  expect(
    readHiddenWorkspacesFromStorage(
      storage({
        [SIDEBAR_HIDDEN_WORKSPACES_STORAGE_KEY]: JSON.stringify({
          version: 2,
          workspaces: [{ cwd: '/w/a', hiddenAt: 1 }],
        }),
      }),
    ),
  ).toBeNull()
})

test('malformed entries are dropped at the storage boundary', () => {
  const read = readHiddenWorkspacesFromStorage(
    storage({
      [SIDEBAR_HIDDEN_WORKSPACES_STORAGE_KEY]: JSON.stringify({
        version: 1,
        workspaces: [
          { cwd: '/w/a', hiddenAt: 100 },
          { cwd: '/w/a', hiddenAt: 999 },
          { cwd: '', hiddenAt: 1 },
          { cwd: '/w/b' },
          { hiddenAt: 2 },
          'nope',
          null,
        ],
      }),
    }),
  )
  expect(read).toEqual([{ cwd: '/w/a', hiddenAt: 100 }])
})

test('the written list is capped at the oldest-hidden end', () => {
  const store = storage()
  const over = Array.from(
    { length: MAX_SIDEBAR_HIDDEN_WORKSPACES + 5 },
    (_, index) => ({ cwd: `/w/${index}`, hiddenAt: index }),
  )
  writeHiddenWorkspacesToStorage(store, over)
  const read = readHiddenWorkspacesFromStorage(store)
  expect(read).toHaveLength(MAX_SIDEBAR_HIDDEN_WORKSPACES)
  expect(read?.[0]).toEqual({ cwd: '/w/0', hiddenAt: 0 })
})

test('a storage that throws never breaks the rail', () => {
  const throwing = {
    getItem: () => {
      throw new Error('nope')
    },
    setItem: () => {
      throw new Error('nope')
    },
  }
  expect(readHiddenWorkspacesFromStorage(throwing)).toBeNull()
  expect(() =>
    writeHiddenWorkspacesToStorage(throwing, [{ cwd: '/w/a', hiddenAt: 1 }]),
  ).not.toThrow()
})
