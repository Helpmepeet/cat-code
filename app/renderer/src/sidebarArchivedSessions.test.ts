import { expect, test } from 'bun:test'
import { sessionDescriptor } from './sessionDescriptorFixture.js'
import { selectMergedSessionRows, type MergedSessionRow } from './sessionsCatalogState.js'
import {
  SIDEBAR_ARCHIVED_SESSIONS_STORAGE_KEY,
  createArchivedSessions,
  readArchivedSessionsFromStorage,
  reduceArchivedSessionsReconciled,
  reduceSessionArchived,
  reduceSessionUnarchived,
  selectArchivedSidebarRows,
  writeArchivedSessionsToStorage,
} from './sidebarArchivedSessions.js'
import { memoryStorage, throwingStorage } from './viewPreferenceStorageFixture.js'

function row(id: string, over: Partial<MergedSessionRow> = {}): MergedSessionRow {
  return {
    ...selectMergedSessionRows([sessionDescriptor(id)], null)[0]!,
    lastMessageSentAt: null,
    transcriptActivityAtMs: null,
    ...over,
  }
}

test('archive and unarchive use the merged key and leave unrelated marks alone', () => {
  const a = row('a')
  const b = row('b')
  expect(createArchivedSessions()).toEqual([])
  const state = reduceSessionArchived(reduceSessionArchived([], a, 100), b, 200)
  expect(state).toEqual([
    { sessionId: 'engine-b', archivedAt: 200 },
    { sessionId: 'engine-a', archivedAt: 100 },
  ])
  expect(reduceSessionUnarchived(state, a)).toEqual([
    { sessionId: 'engine-b', archivedAt: 200 },
  ])
  expect(reduceSessionUnarchived(state, row('missing'))).toBe(state)
  expect(reduceSessionArchived(state, a, 300)).toEqual([
    { sessionId: 'engine-a', archivedAt: 300 },
    { sessionId: 'engine-b', archivedAt: 200 },
  ])
})

test('invalid archive keys and timestamps are no-ops', () => {
  const state = createArchivedSessions()
  expect(reduceSessionArchived(state, row('a', { sessionId: ' ' }), 100)).toBe(state)
  for (const at of [NaN, Infinity, -1]) {
    expect(reduceSessionArchived(state, row('a'), at)).toBe(state)
  }
})

test('selector partitions once in incoming order, including history without an app id', () => {
  const a = row('a')
  const b = row('b', { appSessionId: null, inRegistry: false, modifiedAtMs: 100 })
  const c = row('c')
  const state = reduceSessionArchived([], b, 100)
  expect(selectArchivedSidebarRows([a, b, c], state)).toEqual({
    visible: [a, c],
    archived: [b],
  })
})

test('pre-ready app fallback is reconciled to the durable engine key without losing absent entries', () => {
  const spawning = row('a', { sessionId: 'a' })
  const state = reduceSessionArchived(
    [{ sessionId: 'not-enumerated', archivedAt: 50 }],
    spawning,
    100,
  )
  const ready = row('a')
  const next = reduceArchivedSessionsReconciled(state, [ready])
  expect(next).toEqual([
    { sessionId: 'engine-a', archivedAt: 100 },
    { sessionId: 'not-enumerated', archivedAt: 50 },
  ])
  expect(selectArchivedSidebarRows([ready], state).archived).toEqual([ready])
  expect(reduceArchivedSessionsReconciled(next, [ready])).toBe(next)
  expect(reduceArchivedSessionsReconciled(next, [])).toBe(next)
  expect(reduceSessionUnarchived(state, ready)).toEqual([
    { sessionId: 'not-enumerated', archivedAt: 50 },
  ])
})

test('reconciliation collapses app and engine marks using the latest archive moment', () => {
  const ready = row('a', { sessionActivityAtMs: 150 })
  const state = [
    { sessionId: 'a', archivedAt: 200 },
    { sessionId: 'engine-a', archivedAt: 100 },
  ]
  expect(reduceArchivedSessionsReconciled(state, [ready])).toEqual([
    { sessionId: 'engine-a', archivedAt: 200 },
  ])
})

test('strictly newer real activity returns a row and removes its obsolete archive mark', () => {
  const archived = row('a', { lastMessageSentAt: 100, sessionActivityAtMs: 200 })
  const state = reduceSessionArchived([], archived, 200)
  expect(reduceArchivedSessionsReconciled(state, [archived])).toBe(state)
  for (const active of [
    { ...archived, lastMessageSentAt: 201 },
    { ...archived, sessionActivityAtMs: 201 },
  ]) {
    expect(selectArchivedSidebarRows([active], state).visible).toEqual([active])
    const next = reduceArchivedSessionsReconciled(state, [active])
    expect(next).toEqual([])
    expect(selectArchivedSidebarRows([archived], next).archived).toEqual([])
  }
})

test('new terminal conversation activity wins even when the host message marker is older', () => {
  const active = row('a', { lastMessageSentAt: 50, sessionActivityAtMs: 201 })
  expect(reduceArchivedSessionsReconciled(
    [{ sessionId: active.sessionId, archivedAt: 200 }],
    [active],
  )).toEqual([])
})

test('close bookkeeping and host-only attach never return registry or history rows', () => {
  const registry = row('a', {
    modifiedAtMs: 5000, createdAtMs: 5000,
    transcriptActivityAtMs: 5000, sessionActivityAtMs: 50,
  })
  const state = reduceSessionArchived([], registry, 100)
  expect(reduceArchivedSessionsReconciled(state, [registry])).toBe(state)
  const history = {
    ...registry, appSessionId: null, inRegistry: false,
  }
  expect(reduceArchivedSessionsReconciled(state, [history])).toBe(state)
})

test('older cached rows without conversation evidence stay archived, but host peer messages return', () => {
  for (const inRegistry of [true, false]) {
    for (const sessionActivityAtMs of [undefined, null]) {
      const cached = row('a', {
        inRegistry, sessionActivityAtMs,
        modifiedAtMs: 5000, transcriptActivityAtMs: 5000,
      })
      const state = reduceSessionArchived([], cached, 100)
      expect(reduceArchivedSessionsReconciled(state, [cached])).toBe(state)
      const peerMessage = { ...cached, lastMessageSentAt: 101 }
      expect(reduceArchivedSessionsReconciled(state, [peerMessage])).toEqual([])
    }
  }
})

test('storage round-trip retains all archived sessions with no silent retention cap', () => {
  const storage = memoryStorage()
  const state = Array.from({ length: 1000 }, (_, i) => ({
    sessionId: `session-${i}`, archivedAt: i,
  }))
  writeArchivedSessionsToStorage(storage, state)
  expect(JSON.parse(storage.map.get(SIDEBAR_ARCHIVED_SESSIONS_STORAGE_KEY)!)).toEqual({
    version: 1, sessions: state,
  })
  expect(readArchivedSessionsFromStorage(storage)).toEqual(state)
})

test('storage rejects invalid envelopes and normalizes malformed entries and duplicates', () => {
  for (const raw of ['{', 'null', '[]', '{"version":2,"sessions":[]}', '{"version":1,"sessions":{}}']) {
    expect(readArchivedSessionsFromStorage(memoryStorage({
      [SIDEBAR_ARCHIVED_SESSIONS_STORAGE_KEY]: raw,
    }))).toBeNull()
  }
  const storage = memoryStorage({
    [SIDEBAR_ARCHIVED_SESSIONS_STORAGE_KEY]: JSON.stringify({
      version: 1,
      sessions: [
        null, {}, 'a', { sessionId: ' ', archivedAt: 10 },
        { sessionId: 'a', archivedAt: '10' },
        { sessionId: 'a', archivedAt: -1 },
        { sessionId: 'a', archivedAt: 10, extra: true },
        { sessionId: 'a', archivedAt: 20 },
        { sessionId: 'b', archivedAt: 0 },
      ],
    }),
  })
  expect(readArchivedSessionsFromStorage(storage)).toEqual([
    { sessionId: 'a', archivedAt: 20 },
    { sessionId: 'b', archivedAt: 0 },
  ])
  writeArchivedSessionsToStorage(storage, [
    { sessionId: 'a', archivedAt: Infinity }, { sessionId: 'b', archivedAt: 10 },
  ])
  expect(readArchivedSessionsFromStorage(storage)).toEqual([
    { sessionId: 'b', archivedAt: 10 },
  ])
})

test('unavailable storage remains best-effort', () => {
  expect(readArchivedSessionsFromStorage(null)).toBeNull()
  expect(readArchivedSessionsFromStorage(memoryStorage())).toBeNull()
  expect(readArchivedSessionsFromStorage(throwingStorage())).toBeNull()
  expect(() => writeArchivedSessionsToStorage(throwingStorage(), [])).not.toThrow()
  expect(() => writeArchivedSessionsToStorage(null, [])).not.toThrow()
})
