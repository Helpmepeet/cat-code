import { describe, expect, test } from 'bun:test'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import type {
  SessionCatalogEntry,
  SessionsCatalogSnapshot,
} from '../../shared/protocol.js'
import {
  bucketByDate,
  collectSessionTags,
  countWorkspaces,
  createSessionsCatalogState,
  filterSessionRows,
  formatRelativeTime,
  groupByWorkspace,
  reduceSessionsCatalogState,
  resolveSessionLabel,
  selectMergedSessionRows,
  selectRecentWorkspaces,
  selectSessionsCatalog,
  sortSessionRows,
  type MergedSessionRow,
} from './sessionsCatalogState.js'

function entry(partial: Partial<SessionCatalogEntry> & { sessionId: string }): SessionCatalogEntry {
  return {
    cwd: '/w/proj',
    title: null,
    modifiedAtMs: 1000,
    createdAtMs: 500,
    messageCount: 0,
    gitBranch: null,
    tag: null,
    mode: null,
    agentSetting: null,
    prNumber: null,
    prRepository: null,
    ...partial,
  }
}

function snapshot(entries: SessionCatalogEntry[]): SessionsCatalogSnapshot {
  return { entries, truncated: false, notes: [] }
}

function descriptor(partial: Partial<SessionDescriptor> & { appSessionId: string }): SessionDescriptor {
  return {
    engineSessionId: null,
    cwd: '/w/proj',
    title: null,
    status: 'ready',
    restorable: false,
    createdAt: 100,
    lastAttachedAt: 2000,
    lastMessageSentAt: null,
    ...partial,
  }
}

describe('reduce / select (catalog owner decision #4 — single global source)', () => {
  test('a delivered catalog is stored as the latest good and select returns it', () => {
    let state = createSessionsCatalogState()
    state = reduceSessionsCatalogState(state, {
      type: 'catalog',
      snapshot: snapshot([entry({ sessionId: 'a' })]),
    })
    expect(state.latestGood?.entries).toHaveLength(1)
    expect(selectSessionsCatalog(state)?.entries.map(e => e.sessionId)).toEqual(['a'])
  })

  test('with nothing stored at all, select returns null', () => {
    const state = createSessionsCatalogState()
    expect(selectSessionsCatalog(state)).toBeNull()
  })

  test('a refreshed catalog replaces the stored one (de-stale, same freshness contract)', () => {
    let state = createSessionsCatalogState()
    state = reduceSessionsCatalogState(state, {
      type: 'catalog',
      snapshot: snapshot([entry({ sessionId: 'a' })]),
    })
    expect(selectSessionsCatalog(state)?.entries.map(e => e.sessionId)).toEqual(['a'])
    // The main-owned worker re-enumerates and delivers a fresher catalog with a
    // newly-created session — it replaces the stored one.
    state = reduceSessionsCatalogState(state, {
      type: 'catalog',
      snapshot: snapshot([entry({ sessionId: 'a' }), entry({ sessionId: 'b' })]),
    })
    expect(selectSessionsCatalog(state)?.entries.map(e => e.sessionId)).toEqual(['a', 'b'])
  })

  test('the same catalog reference is a no-op (referential stability)', () => {
    let state = createSessionsCatalogState()
    const snap = snapshot([entry({ sessionId: 'a' })])
    state = reduceSessionsCatalogState(state, { type: 'catalog', snapshot: snap })
    const after = reduceSessionsCatalogState(state, { type: 'catalog', snapshot: snap })
    expect(after).toBe(state)
  })

  test('F2 — a baseline is used when no live catalog exists, and a delivered catalog supersedes it', () => {
    let state = createSessionsCatalogState()
    // Cold launch: only the persisted baseline is available (read before the first
    // catalog worker run completes).
    state = reduceSessionsCatalogState(state, {
      type: 'baseline',
      snapshot: snapshot([entry({ sessionId: 'base' })]),
    })
    expect(selectSessionsCatalog(state)?.entries.map(e => e.sessionId)).toEqual(['base'])
    // The first worker run delivers a fresher catalog — it supersedes the baseline.
    state = reduceSessionsCatalogState(state, {
      type: 'catalog',
      snapshot: snapshot([entry({ sessionId: 'live' })]),
    })
    expect(selectSessionsCatalog(state)?.entries.map(e => e.sessionId)).toEqual(['live'])
  })

  test('F2 — a baseline arriving AFTER a delivered catalog never clobbers it', () => {
    let state = createSessionsCatalogState()
    state = reduceSessionsCatalogState(state, {
      type: 'catalog',
      snapshot: snapshot([entry({ sessionId: 'live' })]),
    })
    // A late baseline read lands after the live catalog — it only fills the
    // lowest-precedence slot, so the delivered catalog still wins.
    state = reduceSessionsCatalogState(state, {
      type: 'baseline',
      snapshot: snapshot([entry({ sessionId: 'base' })]),
    })
    expect(state.baseline?.entries.map(e => e.sessionId)).toEqual(['base'])
    expect(selectSessionsCatalog(state)?.entries.map(e => e.sessionId)).toEqual(['live'])
  })
})

describe('resolveSessionLabel (the P4-6 title rider precedence)', () => {
  test('title wins, else cwd basename, else fallback', () => {
    expect(resolveSessionLabel('My session', '/a/b')).toBe('My session')
    expect(resolveSessionLabel(null, '/a/proj')).toBe('proj')
    expect(resolveSessionLabel('   ', '/a/proj')).toBe('proj')
    expect(resolveSessionLabel(null, '')).toBe('New session')
  })
})

describe('selectMergedSessionRows', () => {
  test('registry row merges catalog metadata by engineSessionId; registry title wins', () => {
    const descriptors = [
      descriptor({ appSessionId: 'app-1', engineSessionId: 'eng-1', title: 'Registry name' }),
    ]
    const cat = snapshot([
      entry({ sessionId: 'eng-1', title: 'Catalog name', gitBranch: 'main', messageCount: 9 }),
    ])
    const rows = selectMergedSessionRows(descriptors, cat)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      sessionId: 'eng-1',
      appSessionId: 'app-1',
      title: 'Registry name',
      displayLabel: 'Registry name',
      inRegistry: true,
      live: true,
      gitBranch: 'main',
      messageCount: 9,
    })
  })

  test('registry row with no title falls back to the catalog title (rider surface)', () => {
    const rows = selectMergedSessionRows(
      [descriptor({ appSessionId: 'app-1', engineSessionId: 'eng-1', title: null })],
      snapshot([entry({ sessionId: 'eng-1', title: 'AI generated title' })]),
    )
    expect(rows[0]?.title).toBe('AI generated title')
    expect(rows[0]?.displayLabel).toBe('AI generated title')
  })

  test('history-only sessions (no registry row) are included but not openable', () => {
    const rows = selectMergedSessionRows(
      [],
      snapshot([entry({ sessionId: 'hist-1', title: 'Old TUI session' })]),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      sessionId: 'hist-1',
      appSessionId: null,
      inRegistry: false,
      status: 'history',
      live: false,
      restorable: false,
    })
  })

  test('a registry row claims its catalog entry (no duplicate history row)', () => {
    const rows = selectMergedSessionRows(
      [descriptor({ appSessionId: 'app-1', engineSessionId: 'eng-1' })],
      snapshot([entry({ sessionId: 'eng-1' }), entry({ sessionId: 'eng-2' })]),
    )
    expect(rows.map(r => r.sessionId).sort()).toEqual(['eng-1', 'eng-2'])
    expect(rows.filter(r => r.sessionId === 'eng-1')).toHaveLength(1)
  })

  test('restorable + status derivation', () => {
    const rows = selectMergedSessionRows(
      [descriptor({ appSessionId: 'app-1', engineSessionId: 'eng-1', status: 'exited', restorable: true })],
      null,
    )
    expect(rows[0]).toMatchObject({ live: false, restorable: true, status: 'exited' })
  })

  test('sorted newest-first by mtime', () => {
    const rows = selectMergedSessionRows(
      [],
      snapshot([
        entry({ sessionId: 'old', modifiedAtMs: 100 }),
        entry({ sessionId: 'new', modifiedAtMs: 900 }),
        entry({ sessionId: 'mid', modifiedAtMs: 500 }),
      ]),
    )
    expect(rows.map(r => r.sessionId)).toEqual(['new', 'mid', 'old'])
  })
})

describe('browse selectors', () => {
  const rows: MergedSessionRow[] = [
    row({ sessionId: 'a', displayLabel: 'Alpha parser', cwd: '/w/proj', tag: 'bug', messageCount: 5, modifiedAtMs: 900 }),
    row({ sessionId: 'b', displayLabel: 'Beta ui', cwd: '/w/proj', gitBranch: 'feat/ui', messageCount: 20, modifiedAtMs: 500 }),
    row({ sessionId: 'c', displayLabel: 'Gamma', cwd: '/w/other', tag: 'chore', messageCount: 2, modifiedAtMs: 100 }),
  ]

  test('filter by query over label/branch/tag/cwd', () => {
    expect(filterSessionRows(rows, { query: 'parser' }).map(r => r.sessionId)).toEqual(['a'])
    expect(filterSessionRows(rows, { query: 'feat/ui' }).map(r => r.sessionId)).toEqual(['b'])
    expect(filterSessionRows(rows, { query: 'other' }).map(r => r.sessionId)).toEqual(['c'])
  })

  test('filter by tag tab', () => {
    expect(filterSessionRows(rows, { tag: 'bug' }).map(r => r.sessionId)).toEqual(['a'])
    expect(filterSessionRows(rows, { tag: 'all' }).map(r => r.sessionId)).toEqual(['a', 'b', 'c'])
  })

  test('filter by workspace scope (allWorkspaces=false keeps the active cwd only)', () => {
    expect(
      filterSessionRows(rows, { allWorkspaces: false, activeCwd: '/w/proj' }).map(r => r.sessionId),
    ).toEqual(['a', 'b'])
  })

  test('sort recent/name (the message-count "Most active" sort was removed, §I.7)', () => {
    expect(sortSessionRows(rows, 'recent').map(r => r.sessionId)).toEqual(['a', 'b', 'c'])
    expect(sortSessionRows(rows, 'name').map(r => r.sessionId)).toEqual(['a', 'b', 'c'])
  })

  test('collect tags + count workspaces', () => {
    expect(collectSessionTags(rows)).toEqual(['bug', 'chore'])
    expect(countWorkspaces(rows)).toBe(2)
  })

  test('group by workspace, current first', () => {
    const groups = groupByWorkspace(rows, '/w/other')
    expect(groups.map(g => g.name)).toEqual(['other', 'proj'])
    expect(groups[0]?.current).toBe(true)
  })

  test('MAJOR-1 — two same-workspace sessions (reconciled to one real cwd) form ONE group', () => {
    // The sidecar reconciles a projectPath-less transcript onto its sibling's real
    // cwd, so both rows share the SAME cwd here — they must land in one group.
    const groups = groupByWorkspace(
      [
        row({ sessionId: 'has-cwd', cwd: '/Users/me/proj' }),
        row({ sessionId: 'no-cwd', cwd: '/Users/me/proj' }),
      ],
      null,
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.name).toBe('proj')
    expect(groups[0]?.rows.map(r => r.sessionId).sort()).toEqual(['has-cwd', 'no-cwd'])
  })

  test('MAJOR-1 — an empty cwd collects under a clearly-labeled "Unknown workspace" bucket', () => {
    const groups = groupByWorkspace(
      [row({ sessionId: 'orphan', cwd: '' }), row({ sessionId: 'known', cwd: '/w/proj' })],
      null,
    )
    const names = groups.map(g => g.name)
    expect(names).toContain('Unknown workspace')
    expect(names).toContain('proj')
  })

  test('bucket by date into today/older, empty buckets dropped', () => {
    const now = new Date('2026-07-10T12:00:00Z').getTime()
    const today = now - 60_000
    const lastWeek = now - 10 * 24 * 60 * 60 * 1000
    const buckets = bucketByDate(
      [row({ sessionId: 't', modifiedAtMs: today }), row({ sessionId: 'o', modifiedAtMs: lastWeek })],
      now,
    )
    expect(buckets.map(b => b.label)).toEqual(['Today', 'Older'])
  })

  test('relative time formatting', () => {
    const now = 10_000_000
    expect(formatRelativeTime(now, now)).toBe('just now')
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago')
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3h ago')
  })
})

function row(partial: Partial<MergedSessionRow> & { sessionId: string }): MergedSessionRow {
  return {
    appSessionId: null,
    cwd: '/w/proj',
    title: null,
    displayLabel: partial.sessionId,
    live: false,
    restorable: false,
    status: 'history',
    inRegistry: false,
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
    ...partial,
  }
}

describe('selectRecentWorkspaces (P4-17 Welcome recents)', () => {
  // A registry-openable session in /w/one, a history-only session in /w/one,
  // and a history-only session in /w/two — the shared merge feeds this.
  const rows = selectMergedSessionRows(
    [
      descriptor({
        appSessionId: 'a',
        engineSessionId: 'ea',
        cwd: '/w/one',
        status: 'ready',
        restorable: false,
        lastAttachedAt: 3000,
      }),
    ],
    snapshot([
      entry({ sessionId: 'ea', cwd: '/w/one', modifiedAtMs: 3000 }),
      entry({ sessionId: 'eb', cwd: '/w/one', modifiedAtMs: 2500 }),
      entry({ sessionId: 'ec', cwd: '/w/two', modifiedAtMs: 4000 }),
    ]),
  )

  test('collapses sessions by workspace, newest cwd first', () => {
    const recents = selectRecentWorkspaces(rows, new Map())
    expect(recents.map(r => r.cwd)).toEqual(['/w/two', '/w/one'])
    const one = recents.find(r => r.cwd === '/w/one')!
    expect(one.sessionCount).toBe(2)
    expect(one.modifiedAtMs).toBe(3000)
    expect(one.name).toBe('one')
  })

  test('adopts an openable registry id; history-only stays non-openable', () => {
    const recents = selectRecentWorkspaces(rows, new Map())
    const one = recents.find(r => r.cwd === '/w/one')!
    expect(one.appSessionId).toBe('a')
    expect(one.live).toBe(true)
    const two = recents.find(r => r.cwd === '/w/two')!
    expect(two.appSessionId).toBeNull() // history-only → browse-only (HC1/P4-6b)
  })

  test('trust flag joins from the cwd map; unknown ⇒ null', () => {
    const recents = selectRecentWorkspaces(rows, new Map([['/w/one', false]]))
    expect(recents.find(r => r.cwd === '/w/one')!.trusted).toBe(false)
    expect(recents.find(r => r.cwd === '/w/two')!.trusted).toBeNull()
  })

  test('caps to the limit', () => {
    expect(selectRecentWorkspaces(rows, new Map(), 1).map(r => r.cwd)).toEqual([
      '/w/two',
    ])
  })

  test('empty input ⇒ empty list', () => {
    expect(selectRecentWorkspaces([], new Map())).toEqual([])
  })
})
