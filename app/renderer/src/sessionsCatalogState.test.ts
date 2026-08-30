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
  filterInteractiveSessionDescriptors,
  formatRelativeTime,
  groupByWorkspace,
  reduceSessionsCatalogState,
  resolveRecentOpenRoute,
  resolveSessionLabel,
  resolveSessionOpenRoute,
  selectMergedSessionRows,
  selectRecentWorkspaces,
  selectRowEngineSessionId,
  selectSessionsCatalog,
  sortSessionRows,
  withResolvedTitle,
  type MergedSessionRow,
  type RecentWorkspace,
} from './sessionsCatalogState.js'
import { tabLabel } from './tabBarModel.js'

function entry(partial: Partial<SessionCatalogEntry> & { sessionId: string }): SessionCatalogEntry {
  return {
    forked: false,
    cwd: '/w/proj',
    cwdExists: true,
    title: null,
    transcriptTitle: null,
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

function snapshot(
  entries: SessionCatalogEntry[],
  capturedAtMs = 5000,
): SessionsCatalogSnapshot {
  return { entries, truncated: false, capturedAtMs }
}

// Every slice on this snapshot must reach the renderer. A field that crosses the
// wire and is read by nothing is the defect this record catches: adding one
// leaves a key missing here and fails tsc. `notes` was removed for exactly that.
const READ_CATALOG_SLICES: Record<keyof SessionsCatalogSnapshot, true> = {
  entries: true,
  truncated: true,
  capturedAtMs: true,
}

function descriptor(partial: Partial<SessionDescriptor> & { appSessionId: string }): SessionDescriptor {
  return {
    engineSessionId: null,
    cwd: '/w/proj',
    title: null,
    forked: false,
    titleUpdatedAt: null,
    status: 'ready',
    restorable: false,
    parked: false,
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
    })
  })

  test('hides a noninteractive SDK transcript even when an earlier open created a registry row', () => {
    const rows = selectMergedSessionRows(
      [descriptor({ appSessionId: 'app-sdk', engineSessionId: 'sdk-run' })],
      snapshot([entry({ sessionId: 'sdk-run', isInteractive: false })]),
    )
    expect(rows).toEqual([])
  })

  test('filters a noninteractive SDK registry row before raw-descriptor surfaces use it', () => {
    const rows = filterInteractiveSessionDescriptors(
      [descriptor({ appSessionId: 'app-sdk', engineSessionId: 'sdk-run' })],
      snapshot([entry({ sessionId: 'sdk-run', isInteractive: false })]),
    )
    expect(rows).toEqual([])
  })

  test('keeps a legacy registry row when its catalog entry lacks eligibility provenance', () => {
    const descriptorRow = descriptor({
      appSessionId: 'app-legacy',
      engineSessionId: 'legacy-run',
    })
    const rows = filterInteractiveSessionDescriptors(
      [descriptorRow],
      snapshot([entry({ sessionId: 'legacy-run' })]),
    )
    expect(rows).toEqual([descriptorRow])
  })

  // Regression: opening a session from history mints a registry row with a FRESH
  // appSessionId, and the host now seeds its `engineSessionId` from the resume
  // target at spawn instead of waiting for the ready frame to echo it back
  // (`app/host/host.ts` spawn → `registry.upsertOnSpawn`). While that id was
  // null the descriptor could not claim its own catalog entry, so the merge
  // emitted the history row AND a brand-new registry row, the latter with no
  // `transcriptActivityAtMs` — which sorts on `createdAtMs` (= the click) and
  // sent it straight to the top of the sidebar until the frame landed. The
  // operator saw a row jump to the top on open, then drop back.
  test('a spawning resume claims its own transcript immediately — no duplicate, no fake recency', () => {
    const rows = selectMergedSessionRows(
      [
        descriptor({
          appSessionId: 'app-new',
          engineSessionId: 'eng-old',
          status: 'spawning',
          createdAt: 1_800_000_000_000, // clicked just now
        }),
      ],
      snapshot([entry({ sessionId: 'eng-old', modifiedAtMs: 100 })]),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.sessionId).toBe('eng-old')
    // The transcript's real activity is present, so `sidebarActivityKey` keys on
    // it rather than falling through to the just-now `createdAtMs`.
    expect(rows[0]?.transcriptActivityAtMs).toBe(100)
    expect(rows[0]?.lastMessageSentAt).toBeNull()
  })

  test('registry row with no title falls back to the catalog title (rider surface)', () => {
    const rows = selectMergedSessionRows(
      [descriptor({ appSessionId: 'app-1', engineSessionId: 'eng-1', title: null })],
      snapshot([entry({ sessionId: 'eng-1', title: 'AI generated title' })]),
    )
    expect(rows[0]?.title).toBe('AI generated title')
    expect(rows[0]?.displayLabel).toBe('AI generated title')
  })

  /**
   * The terminal-rename fix. A `/rename` in the CLI writes ONLY the engine
   * transcript (`src/commands/rename/rename.ts:57` → `saveCustomTitle`); the app's
   * registry row is untouched and nothing re-reads the title on attach
   * (`app/sidecar/sidecarServer.ts:2484`). Before the fix `pickTitle` returned the
   * registry title whenever it was non-empty, so the new name was invisible
   * forever on any row the app had ever opened — while a never-opened history row
   * (no registry title) showed it fine. Both halves are pinned here.
   */
  describe('title precedence — registry vs engine transcript (terminal /rename)', () => {
    test('a transcript title read AFTER the app recorded its own outranks it', () => {
      const rows = selectMergedSessionRows(
        [
          descriptor({
            appSessionId: 'app-1',
            engineSessionId: 'eng-1',
            title: 'Opened from history',
            titleUpdatedAt: 1_000,
          }),
        ],
        // Enumeration started at 2_000 — after the app's write — so this read of
        // the transcript provably saw the terminal rename.
        snapshot(
          [
            entry({
              sessionId: 'eng-1',
              title: 'Renamed in the terminal',
              transcriptTitle: 'Renamed in the terminal',
            }),
          ],
          2_000,
        ),
      )
      expect(rows[0]?.title).toBe('Renamed in the terminal')
      expect(rows[0]?.displayLabel).toBe('Renamed in the terminal')
    })

    test('a desktop rename is NOT reverted by an older catalog snapshot', () => {
      // The desktop rename verb writes BOTH sides (`sessionActionsDomain.ts:76` +
      // broadcastSessionTitle → host.setTitle), but the catalog only re-enumerates
      // on its timer. The in-hand snapshot still carries the pre-rename title;
      // preferring the transcript unconditionally would flash the old name back.
      const rows = selectMergedSessionRows(
        [
          descriptor({
            appSessionId: 'app-1',
            engineSessionId: 'eng-1',
            title: 'Renamed in the app',
            titleUpdatedAt: 9_000,
          }),
        ],
        snapshot(
          [
            entry({
              sessionId: 'eng-1',
              title: 'Stale name',
              transcriptTitle: 'Stale name',
            }),
          ],
          2_000,
        ),
      )
      expect(rows[0]?.title).toBe('Renamed in the app')
    })

    test('only a RECORDED transcript title outranks — the display cascade cannot', () => {
      // `entry.title` falls through to the summary / first prompt / cwd basename
      // (`sessionsCatalogDomain.ts` resolveEntryTitle). Letting that outrank would
      // replace a real app title with prompt text as soon as the `ai-title` entry
      // scrolled out of the bounded read windows.
      const rows = selectMergedSessionRows(
        [
          descriptor({
            appSessionId: 'app-1',
            engineSessionId: 'eng-1',
            title: 'AI generated title',
            titleUpdatedAt: 1_000,
          }),
        ],
        snapshot(
          [
            entry({
              sessionId: 'eng-1',
              title: 'please fix the parser bug in',
              transcriptTitle: null,
            }),
          ],
          9_000,
        ),
      )
      expect(rows[0]?.title).toBe('AI generated title')
    })

    test('a snapshot of unknown age (capturedAtMs 0 — a pre-field cache) never outranks', () => {
      const rows = selectMergedSessionRows(
        [
          descriptor({
            appSessionId: 'app-1',
            engineSessionId: 'eng-1',
            title: 'Registry name',
            titleUpdatedAt: null,
          }),
        ],
        snapshot(
          [
            entry({
              sessionId: 'eng-1',
              title: 'Terminal name',
              transcriptTitle: 'Terminal name',
            }),
          ],
          0,
        ),
      )
      expect(rows[0]?.title).toBe('Registry name')
    })

    test('a row that never recorded a title yields to any real transcript title', () => {
      // Rows persisted before `titleUpdatedAt` existed read as null ⇒ 0, so a
      // rename made before this shipped still surfaces on the first live run.
      const rows = selectMergedSessionRows(
        [
          descriptor({
            appSessionId: 'app-1',
            engineSessionId: 'eng-1',
            title: 'Seeded at open',
            titleUpdatedAt: null,
          }),
        ],
        snapshot(
          [
            entry({
              sessionId: 'eng-1',
              title: 'Terminal name',
              transcriptTitle: 'Terminal name',
            }),
          ],
          1,
        ),
      )
      expect(rows[0]?.title).toBe('Terminal name')
    })

    test('the never-opened history row keeps showing the transcript title', () => {
      // The half that always worked (no registry row ⇒ no registry title). Pinned
      // so the fix cannot regress it.
      const rows = selectMergedSessionRows(
        [],
        snapshot(
          [
            entry({
              sessionId: 'hist-1',
              title: 'Renamed in the terminal',
              transcriptTitle: 'Renamed in the terminal',
            }),
          ],
          0,
        ),
      )
      expect(rows[0]?.title).toBe('Renamed in the terminal')
    })
  })

  describe('withResolvedTitle (the TabBar half — one precedence rule)', () => {
    test('the tab descriptor picks up a newer transcript title', () => {
      const resolved = withResolvedTitle(
        descriptor({
          appSessionId: 'app-1',
          engineSessionId: 'eng-1',
          title: 'Opened from history',
          titleUpdatedAt: 1_000,
        }),
        snapshot(
          [
            entry({
              sessionId: 'eng-1',
              title: 'Renamed in the terminal',
              transcriptTitle: 'Renamed in the terminal',
            }),
          ],
          2_000,
        ),
      )
      expect(tabLabel(resolved)).toBe('Renamed in the terminal')
    })

    test('an unmatched / pre-ready descriptor is returned untouched (identity)', () => {
      const pending = descriptor({ appSessionId: 'app-1', engineSessionId: null })
      expect(withResolvedTitle(pending, snapshot([entry({ sessionId: 'eng-1' })]))).toBe(
        pending,
      )
      const unmatched = descriptor({ appSessionId: 'app-2', engineSessionId: 'eng-9' })
      expect(withResolvedTitle(unmatched, snapshot([entry({ sessionId: 'eng-1' })]))).toBe(
        unmatched,
      )
      expect(withResolvedTitle(unmatched, null)).toBe(unmatched)
    })
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
      parked: false,
    })
  })

  test('a matching catalog entry supplies cwd evidence for a registry row', () => {
    const rows = selectMergedSessionRows(
      [descriptor({ appSessionId: 'app-1', engineSessionId: 'eng-1', cwd: '/dead/reg' })],
      snapshot([
        entry({ sessionId: 'eng-1', cwdExists: false }),
        entry({ sessionId: 'hist-dead', cwdExists: false }),
        entry({ sessionId: 'hist-live', cwdExists: true }),
      ]),
    )
    const byId = new Map(rows.map(r => [r.sessionId, r.cwdExists]))
    expect(byId.get('eng-1')).toBe(false)
    expect(byId.get('hist-dead')).toBe(false) // history row → from the catalog
    expect(byId.get('hist-live')).toBe(true)
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
    row({ sessionId: 'a', displayLabel: 'Alpha parser', cwd: '/w/proj', tag: 'bug', modifiedAtMs: 900 }),
    row({ sessionId: 'b', displayLabel: 'Beta ui', cwd: '/w/proj', gitBranch: 'feat/ui', modifiedAtMs: 500 }),
    row({ sessionId: 'c', displayLabel: 'Gamma', cwd: '/w/other', tag: 'chore', modifiedAtMs: 100 }),
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

  test('group by workspace, alphabetical — active workspace does NOT float to top', () => {
    // Active = '/w/proj' (alphabetically last). Old code sorted active-first and
    // would return ['proj', 'other']; groups now stay frozen-alphabetical.
    const groups = groupByWorkspace(rows, '/w/proj')
    expect(groups.map(g => g.name)).toEqual(['other', 'proj'])
    // `current` is still computed (Sessions-page highlight), it just no longer drives order.
    expect(groups.find(g => g.name === 'proj')?.current).toBe(true)
    expect(groups.find(g => g.name === 'other')?.current).toBe(false)
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

  // Operator, 2026-07-26: the sidebar showed two adjacent groups both labelled
  // APP (`/Users/pt/cat-code/app` and `/Users/pt/PTClove/app`) with nothing to
  // tell them apart, and the wrong one was nearly deleted.
  test('colliding basenames get distinguishable labels; an uncontested basename stays bare', () => {
    const groups = groupByWorkspace(
      [
        row({ sessionId: 'cc', cwd: '/Users/pt/cat-code/app' }),
        row({ sessionId: 'pt', cwd: '/Users/pt/PTClove/app' }),
        row({ sessionId: 'db', cwd: '/Users/pt/discordbot' }),
      ],
      null,
    )
    const byCwd = new Map(groups.map(g => [g.cwd, g.name]))
    expect(byCwd.get('/Users/pt/cat-code/app')).not.toBe(byCwd.get('/Users/pt/PTClove/app'))
    // Enough leading path to name the PROJECT, and no more.
    expect(byCwd.get('/Users/pt/cat-code/app')).toBe('cat-code/app')
    expect(byCwd.get('/Users/pt/PTClove/app')).toBe('PTClove/app')
    // A basename nobody contests must not pay for someone else's collision.
    expect(byCwd.get('/Users/pt/discordbot')).toBe('discordbot')
  })

  test('labels widen progressively — one parent segment is not enough when the parents also collide', () => {
    const groups = groupByWorkspace(
      [
        row({ sessionId: 'a', cwd: '/home/alice/x/app' }),
        row({ sessionId: 'b', cwd: '/home/bob/x/app' }),
      ],
      null,
    )
    const names = groups.map(g => g.name)
    expect(new Set(names).size).toBe(2)
    // A fixed one-segment prefix would leave both at 'x/app' — the exact defect.
    expect(names.every(name => name !== 'x/app')).toBe(true)
    expect(names.sort()).toEqual(['alice/x/app', 'bob/x/app'])
  })

  test('three-way collision at mixed depths — every label distinct, shallowest widens least', () => {
    const groups = groupByWorkspace(
      [
        row({ sessionId: 'a', cwd: '/home/alice/x/app' }),
        row({ sessionId: 'b', cwd: '/home/bob/x/app' }),
        row({ sessionId: 'c', cwd: '/srv/app' }),
      ],
      null,
    )
    const names = groups.map(g => g.name)
    expect(new Set(names).size).toBe(3)
    const byCwd = new Map(groups.map(g => [g.cwd, g.name]))
    expect(byCwd.get('/home/alice/x/app')).toBe('alice/x/app')
    expect(byCwd.get('/home/bob/x/app')).toBe('bob/x/app')
    // Exhausting a short path falls back to the whole cwd — always unique,
    // since the cwd is the group key.
    expect(byCwd.get('/srv/app')).toBe('/srv/app')
  })

  test('degenerate paths stay sane — trailing slash, empty basename, and an empty cwd bucket', () => {
    const groups = groupByWorkspace(
      [
        row({ sessionId: 'trail', cwd: '/Users/pt/cat-code/app/' }),
        row({ sessionId: 'other', cwd: '/Users/pt/PTClove/app' }),
        row({ sessionId: 'root', cwd: '/' }),
        row({ sessionId: 'orphan', cwd: '' }),
      ],
      null,
    )
    const byCwd = new Map(groups.map(g => [g.cwd, g.name]))
    // A trailing separator must not defeat the collision detection.
    expect(byCwd.get('/Users/pt/cat-code/app/')).toBe('cat-code/app')
    expect(byCwd.get('/Users/pt/PTClove/app')).toBe('PTClove/app')
    // basename('/') is empty — the header must never render blank.
    expect(byCwd.get('/')).toBe('/')
    // The unknown bucket has no path to widen and keeps its label.
    expect(byCwd.get('')).toBe('Unknown workspace')
    expect(new Set(groups.map(g => g.name)).size).toBe(4)
  })

  test('group order stays FROZEN against the active session even when labels are disambiguated', () => {
    const rows2 = [
      row({ sessionId: 'a', cwd: '/home/alice/x/app' }),
      row({ sessionId: 'b', cwd: '/home/bob/x/app' }),
      row({ sessionId: 'z', cwd: '/home/alice/zeta' }),
    ]
    const order = (activeCwd: string | null) =>
      groupByWorkspace(rows2, activeCwd).map(g => g.name)
    const frozen = order(null)
    expect(order('/home/bob/x/app')).toEqual(frozen)
    expect(order('/home/alice/x/app')).toEqual(frozen)
    expect(order('/home/alice/zeta')).toEqual(frozen)
    // Alphabetical by the label the operator actually reads.
    expect(frozen).toEqual(['alice/x/app', 'bob/x/app', 'zeta'])
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

  test('day boundaries stay on local midnight across a DST transition', () => {
    const priorTz = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      // US spring-forward is 2026-03-08, so 03-08 is a 23-hour local day.
      const now = new Date('2026-03-09T12:00:00-04:00').getTime()
      // Two days back: belongs in 'This week', never in 'Yesterday'.
      const twoDaysBack = new Date('2026-03-07T23:30:00-05:00').getTime()
      const yesterday = new Date('2026-03-08T12:00:00-04:00').getTime()
      const buckets = bucketByDate(
        [
          row({ sessionId: 'y', modifiedAtMs: yesterday }),
          row({ sessionId: 'd', modifiedAtMs: twoDaysBack }),
        ],
        now,
      )
      expect(buckets.map(b => b.label)).toEqual(['Yesterday', 'This week'])
      expect(buckets[0]!.rows.map(r => r.sessionId)).toEqual(['y'])
      expect(buckets[1]!.rows.map(r => r.sessionId)).toEqual(['d'])
    } finally {
      if (priorTz === undefined) delete process.env.TZ
      else process.env.TZ = priorTz
    }
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
    cwdExists: true,
    title: null,
    displayLabel: partial.sessionId,
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
    ...partial,
  }
}

describe('selectRowEngineSessionId (the merge key read back apart)', () => {
  test('a history row is keyed by its engine id', () => {
    expect(selectRowEngineSessionId(row({ sessionId: 'engine-1' }))).toBe('engine-1')
  })

  test('a registry row the engine has named returns that id, not the app address', () => {
    expect(
      selectRowEngineSessionId(
        row({ sessionId: 'engine-1', appSessionId: 'app-1', inRegistry: true }),
      ),
    ).toBe('engine-1')
  })

  test('a registry row with NO engine id yet returns null, not its app id', () => {
    // The merge falls back to the app address for the key
    // (`selectMergedSessionRows`), so reading `sessionId` raw here would report
    // an app id as if the engine had minted it.
    expect(
      selectRowEngineSessionId(
        row({ sessionId: 'app-1', appSessionId: 'app-1', inRegistry: true }),
      ),
    ).toBeNull()
  })

  test('it agrees with the merge for both row kinds it produces', () => {
    const merged = selectMergedSessionRows(
      [
        descriptor({ appSessionId: 'app-live', engineSessionId: 'engine-live' }),
        descriptor({ appSessionId: 'app-fresh', engineSessionId: null }),
      ],
      null,
    )
    const byApp = new Map(merged.map(r => [r.appSessionId, r]))
    expect(selectRowEngineSessionId(byApp.get('app-live')!)).toBe('engine-live')
    expect(selectRowEngineSessionId(byApp.get('app-fresh')!)).toBeNull()
  })
})

describe('resolveSessionOpenRoute (P4-29 — one open decision, no per-caller copies)', () => {
  test('a live registry row is pure UI focus', () => {
    expect(
      resolveSessionOpenRoute(
        row({ sessionId: 'a', appSessionId: 'app-a', inRegistry: true, live: true }),
      ),
    ).toEqual({ kind: 'focus', appSessionId: 'app-a' })
  })

  // The bug this function exists to kill: the ⋯ menu labels a non-live registry
  // row "Restore" (sessionActions.ts) but its handler ran a bare `selectTab`, so
  // clicking Restore only re-focused a stale, dead pane. Every OTHER open path
  // branched on `live`; this route is now the only answer any of them get.
  test('a NON-live registry row restores — it is never a bare focus', () => {
    const route = resolveSessionOpenRoute(
      row({
        sessionId: 'a',
        appSessionId: 'app-a',
        inRegistry: true,
        live: false,
        restorable: true,
        parked: false,
        status: 'exited',
      }),
    )
    expect(route).toEqual({ kind: 'restore', appSessionId: 'app-a' })
  })

  test('a non-live registry row with known-dead cwd remains visible but has no restore route', () => {
    expect(
      resolveSessionOpenRoute(
        row({
          sessionId: 'a',
          appSessionId: 'app-a',
          inRegistry: true,
          live: false,
          cwdExists: false,
        }),
      ),
    ).toEqual({ kind: 'none' })
    expect(
      resolveSessionOpenRoute(
        row({
          sessionId: 'a',
          appSessionId: 'app-a',
          inRegistry: true,
          live: true,
          cwdExists: false,
        }),
      ),
    ).toEqual({ kind: 'focus', appSessionId: 'app-a' })
  })

  test('a terminal-history row with a workspace opens by its ENGINE id', () => {
    expect(resolveSessionOpenRoute(row({ sessionId: 'engine-1' }))).toEqual({
      kind: 'history',
      engineSessionId: 'engine-1',
    })
  })

  test('a history row whose workspace no longer exists stays browse-only', () => {
    expect(
      resolveSessionOpenRoute(
        row({ sessionId: 'gone', cwd: '/w/gone', cwdExists: false }),
      ),
    ).toEqual({ kind: 'none' })
  })

  test('a history row with no recorded workspace stays browse-only', () => {
    expect(resolveSessionOpenRoute(row({ sessionId: 'a', cwd: '   ' }))).toEqual({
      kind: 'none',
    })
  })
})

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
        parked: false,
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

  test('adopts an openable registry id; a terminal-only project opens by engine id', () => {
    const recents = selectRecentWorkspaces(rows, new Map())
    const one = recents.find(r => r.cwd === '/w/one')!
    expect(one.appSessionId).toBe('a')
    expect(one.live).toBe(true)
    // P4-40 — /w/two has no registry row at all (every session in it was created
    // in the terminal). That is an openable identity now, not a dead row: it
    // carries the engine id the `openHistorySession` path takes.
    const two = recents.find(r => r.cwd === '/w/two')!
    expect(two.appSessionId).toBeNull()
    expect(two.historySessionId).toBe('ec')
  })

  test('a project whose folder is gone from disk has NO openable identity', () => {
    // The one case the launcher must still refuse (bug-sweep #1): the recorded
    // workspace no longer exists, so opening it would come back as the host's
    // typed `invalid_cwd` rejection. Same gate the sidebar row applies.
    const gone = selectMergedSessionRows(
      [],
      snapshot([entry({ sessionId: 'eg', cwd: '/w/gone', cwdExists: false })]),
    )
    const recents = selectRecentWorkspaces(gone, new Map())
    expect(recents).toHaveLength(1)
    expect(recents[0]!.appSessionId).toBeNull()
    expect(recents[0]!.historySessionId).toBeNull()
    expect(resolveRecentOpenRoute(recents[0]!)).toEqual({ kind: 'none' })
  })

  test('the newest openable terminal session wins when the newest one is unopenable', () => {
    const mixed = selectMergedSessionRows(
      [],
      snapshot([
        entry({ sessionId: 'new', cwd: '/w/two', cwdExists: false, modifiedAtMs: 9000 }),
        entry({ sessionId: 'old', cwd: '/w/two', modifiedAtMs: 8000 }),
      ]),
    )
    // Both rows share a cwd, so `cwdExists` disagreeing between them is a
    // stale-snapshot artefact; adopting the openable one keeps the project
    // reachable instead of letting row order decide.
    expect(selectRecentWorkspaces(mixed, new Map())[0]!.historySessionId).toBe('old')
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

describe('resolveRecentOpenRoute (P4-40 — the launcher opens by the SAME decision)', () => {
  function recent(over: Partial<RecentWorkspace> & { cwd: string }): RecentWorkspace {
    return {
      name: 'proj',
      appSessionId: null,
      live: false,
      historySessionId: null,
      modifiedAtMs: 0,
      trusted: null,
      sessionCount: 1,
      ...over,
    }
  }

  test('a live registry project is focused', () => {
    expect(
      resolveRecentOpenRoute(recent({ cwd: '/w/one', appSessionId: 'a', live: true })),
    ).toEqual({ kind: 'focus', appSessionId: 'a' })
  })

  test('a registry project whose process is gone is restored', () => {
    expect(
      resolveRecentOpenRoute(recent({ cwd: '/w/one', appSessionId: 'a', live: false })),
    ).toEqual({ kind: 'restore', appSessionId: 'a' })
  })

  // The defect P4-40 fixes: this project used to resolve to nothing at all, so
  // the launcher greyed it out and told the operator to go to the terminal.
  test('a project whose sessions were all created in the terminal opens by engine id', () => {
    expect(
      resolveRecentOpenRoute(recent({ cwd: '/w/two', historySessionId: 'ec' })),
    ).toEqual({ kind: 'history', engineSessionId: 'ec' })
  })

  test('a registry id wins over an engine id — an open session is never resumed twice', () => {
    expect(
      resolveRecentOpenRoute(
        recent({ cwd: '/w/one', appSessionId: 'a', live: true, historySessionId: 'ec' }),
      ),
    ).toEqual({ kind: 'focus', appSessionId: 'a' })
  })

  test('neither identity ⇒ nothing to open', () => {
    expect(resolveRecentOpenRoute(recent({ cwd: '/w/gone' }))).toEqual({ kind: 'none' })
  })
})

describe('selectRecentWorkspaces label disambiguation (CC-15)', () => {
  /**
   * Recents built through the REAL P4-6 merge — the production feed is
   * `selectRecentWorkspaces(sessionCatalogRows, welcomeTrustByCwd)`
   * (`App.tsx:894`), and `sessionCatalogRows` is `selectMergedSessionRows`
   * output. History-only entries suffice for a label claim; the trust/openable
   * pairing gets its own registry-backed case below.
   */
  function recentsFor(
    workspaces: readonly { cwd: string; modifiedAtMs: number }[],
    limit?: number,
  ) {
    const merged = selectMergedSessionRows(
      [],
      snapshot(
        workspaces.map((workspace, index) =>
          entry({
            sessionId: `e${index}`,
            cwd: workspace.cwd,
            modifiedAtMs: workspace.modifiedAtMs,
          }),
        ),
      ),
    )
    return limit == null
      ? selectRecentWorkspaces(merged, new Map())
      : selectRecentWorkspaces(merged, new Map(), limit)
  }

  test("the operator's real collision — two recents ending /app are separable", () => {
    const recents = recentsFor([
      { cwd: '/Users/pt/cat-code/app', modifiedAtMs: 5000 },
      { cwd: '/Users/pt/PTClove/app', modifiedAtMs: 4000 },
    ])
    const names = recents.map(r => r.name)
    expect(new Set(names).size).toBe(2)
    expect(names).not.toContain('app')
    const byCwd = new Map(recents.map(r => [r.cwd, r.name]))
    expect(byCwd.get('/Users/pt/cat-code/app')).toBe('cat-code/app')
    expect(byCwd.get('/Users/pt/PTClove/app')).toBe('PTClove/app')
    // Label-only change: cwd keying and newest-first order are untouched.
    expect(recents.map(r => r.cwd)).toEqual([
      '/Users/pt/cat-code/app',
      '/Users/pt/PTClove/app',
    ])
  })

  test('an uncontested recent keeps its bare basename while a collision widens', () => {
    const recents = recentsFor([
      { cwd: '/Users/pt/discordbot', modifiedAtMs: 6000 },
      { cwd: '/Users/pt/cat-code/app', modifiedAtMs: 5000 },
      { cwd: '/Users/pt/PTClove/app', modifiedAtMs: 4000 },
    ])
    const byCwd = new Map(recents.map(r => [r.cwd, r.name]))
    expect(byCwd.get('/Users/pt/discordbot')).toBe('discordbot')
    expect(byCwd.get('/Users/pt/cat-code/app')).toBe('cat-code/app')
    expect(byCwd.get('/Users/pt/PTClove/app')).toBe('PTClove/app')
  })

  test('a collision whose entries carry DIFFERENT trust is separable, and the open target rides along', () => {
    const merged = selectMergedSessionRows(
      [
        descriptor({
          appSessionId: 'live-catcode',
          engineSessionId: 'e-catcode',
          cwd: '/Users/pt/cat-code/app',
          status: 'ready',
          restorable: false,
          parked: false,
          lastAttachedAt: 5000,
        }),
      ],
      snapshot([
        entry({
          sessionId: 'e-catcode',
          cwd: '/Users/pt/cat-code/app',
          modifiedAtMs: 5000,
        }),
        entry({
          sessionId: 'e-ptclove',
          cwd: '/Users/pt/PTClove/app',
          modifiedAtMs: 4000,
        }),
      ]),
    )
    const recents = selectRecentWorkspaces(
      merged,
      new Map([
        ['/Users/pt/cat-code/app', true],
        ['/Users/pt/PTClove/app', false],
      ]),
    )
    const untrusted = recents.filter(r => r.trusted === false)
    expect(untrusted).toHaveLength(1)
    // The point of the fix: an untrusted badge must sit on a name that no other
    // visible entry answers to, or the trust decision is unattributable.
    expect(recents.filter(r => r.name === untrusted[0]!.name)).toHaveLength(1)
    expect(untrusted[0]!.name).toBe('PTClove/app')
    const trusted = recents.find(r => r.cwd === '/Users/pt/cat-code/app')!
    expect(trusted.trusted).toBe(true)
    expect(trusted.name).toBe('cat-code/app')
    // Openable adoption survives the label pass (it is the thing being clicked).
    expect(trusted.appSessionId).toBe('live-catcode')
    expect(trusted.live).toBe(true)
  })

  test('disambiguation runs AFTER the cap — a twin cut by the limit never widens a survivor', () => {
    const workspaces = [
      { cwd: '/Users/pt/discordbot', modifiedAtMs: 6000 },
      { cwd: '/Users/pt/cat-code/app', modifiedAtMs: 5000 },
      { cwd: '/Users/pt/PTClove/app', modifiedAtMs: 4000 },
    ]
    const capped = recentsFor(workspaces, 2)
    expect(capped.map(r => r.cwd)).toEqual([
      '/Users/pt/discordbot',
      '/Users/pt/cat-code/app',
    ])
    // The colliding twin is off-screen, so paying a longer label for it would be
    // noise the operator cannot explain.
    expect(capped.map(r => r.name)).toEqual(['discordbot', 'app'])
    // Raise the cap so both land on screen and the collision must be resolved.
    expect(recentsFor(workspaces, 3).map(r => r.name)).toEqual([
      'discordbot',
      'cat-code/app',
      'PTClove/app',
    ])
  })

  test('degenerate cwds stay sane — trailing slash still collides, root and empty keep their labels', () => {
    const recents = recentsFor([
      { cwd: '/Users/pt/cat-code/app/', modifiedAtMs: 6000 },
      { cwd: '/Users/pt/PTClove/app', modifiedAtMs: 5000 },
      { cwd: '/', modifiedAtMs: 4000 },
      { cwd: '', modifiedAtMs: 3000 },
    ])
    const byCwd = new Map(recents.map(r => [r.cwd, r.name]))
    // A trailing separator must not defeat the collision detection.
    expect(byCwd.get('/Users/pt/cat-code/app/')).toBe('cat-code/app')
    expect(byCwd.get('/Users/pt/PTClove/app')).toBe('PTClove/app')
    // basename('/') is '' — the pre-existing `|| cwd` fallback still applies.
    expect(byCwd.get('/')).toBe('/')
    // An unreconciled cwd (MAJOR-1) names no openable project, so it is not a
    // recent at all — see the dedicated test below.
    expect(byCwd.has('')).toBe(false)
    expect(recents).toHaveLength(3)
  })

  test('a row with no reconciled workspace is not a recent (it would render nameless)', () => {
    // The bug this pins: `name` was `basename('') || ''` = `''`, and the empty
    // cwd survived to the head of the list whenever its row was the newest. The
    // launcher then rendered a blank trigger label and a blank picker row — a
    // folder icon with nothing beside it, and nothing to open.
    const recents = recentsFor([
      { cwd: '', modifiedAtMs: 9000 },
      { cwd: '/Users/pt/cat-code', modifiedAtMs: 5000 },
    ])
    expect(recents.map(r => r.cwd)).toEqual(['/Users/pt/cat-code'])
    expect(recents.every(r => r.name.length > 0)).toBe(true)

    // Whitespace-only is the same non-workspace, and an all-orphan roster is
    // simply empty rather than a list of blanks.
    expect(recentsFor([{ cwd: '   ', modifiedAtMs: 9000 }])).toEqual([])
  })
})
