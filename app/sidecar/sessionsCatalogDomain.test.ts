import { describe, expect, test } from 'bun:test'
import type { LogOption } from '../../src/types/logs.js'
import type { SessionLogResult } from '../../src/utils/sessionStorage.js'
import type {
  SessionsCatalogSnapshot,
  SessionsCatalogSnapshotFrame,
} from '../shared/protocol.js'
import { scanForSecrets } from '../shared/secretGuard.js'
import {
  buildSessionsCatalogSnapshot,
  createSidecarSessionsCatalogDomain,
  mapLogOptionToCatalogEntry,
} from './sessionsCatalogDomain.js'

function makeLog(partial: Partial<LogOption>): LogOption {
  return {
    date: '2026-07-10',
    messages: [],
    value: 0,
    created: new Date('2026-07-01T00:00:00Z'),
    modified: new Date('2026-07-10T00:00:00Z'),
    firstPrompt: 'first prompt',
    messageCount: 0,
    isSidechain: false,
    ...partial,
  }
}

function result(logs: LogOption[], allStatCount = logs.length): SessionLogResult {
  return {
    logs,
    allStatLogs: Array.from({ length: allStatCount }, (_, i) => makeLog({ sessionId: `stat-${i}` })),
    nextIndex: logs.length,
  }
}

describe('mapLogOptionToCatalogEntry', () => {
  test('maps the real LogOption metadata fields onto a catalog entry', () => {
    const entry = mapLogOptionToCatalogEntry(
      makeLog({
        sessionId: 's-1',
        projectPath: '/Users/me/proj',
        customTitle: 'Fix the parser',
        modified: new Date('2026-07-09T12:00:00Z'),
        created: new Date('2026-07-08T09:00:00Z'),
        messageCount: 12,
        gitBranch: 'feature/x',
        tag: 'bug',
        mode: 'agent',
        agentSetting: 'reviewer',
        prNumber: 42,
        prRepository: 'me/proj',
      }),
    )
    expect(entry).not.toBeNull()
    expect(entry).toMatchObject({
      sessionId: 's-1',
      cwd: '/Users/me/proj',
      title: 'Fix the parser',
      messageCount: 12,
      gitBranch: 'feature/x',
      tag: 'bug',
      mode: 'agent',
      agentSetting: 'reviewer',
      prNumber: 42,
      prRepository: 'me/proj',
    })
    expect(entry?.modifiedAtMs).toBe(new Date('2026-07-09T12:00:00Z').getTime())
    expect(entry?.createdAtMs).toBe(new Date('2026-07-08T09:00:00Z').getTime())
  })

  test('renders truth: missing chip metadata → null, not fabricated', () => {
    const entry = mapLogOptionToCatalogEntry(makeLog({ sessionId: 's-2', customTitle: '   ' }))
    // Chips are still render-truth: absent → null (no fabricated branch/tag/mode/PR).
    expect(entry?.gitBranch).toBeNull()
    expect(entry?.tag).toBeNull()
    expect(entry?.mode).toBeNull()
    expect(entry?.prNumber).toBeNull()
  })

  describe('B2 — title fallback (never an unlabeled row)', () => {
    test('customTitle > summary > firstPrompt > cwd basename', () => {
      // customTitle wins.
      expect(
        mapLogOptionToCatalogEntry(
          makeLog({ sessionId: 's', customTitle: 'Real title', summary: 'sum', firstPrompt: 'hi' }),
        )?.title,
      ).toBe('Real title')
      // summary next.
      expect(
        mapLogOptionToCatalogEntry(
          makeLog({ sessionId: 's', customTitle: '  ', summary: 'A summary', firstPrompt: 'hi' }),
        )?.title,
      ).toBe('A summary')
      // firstPrompt next — this is what labels the operator's real history.
      expect(
        mapLogOptionToCatalogEntry(
          makeLog({ sessionId: 's', customTitle: undefined, summary: undefined, firstPrompt: 'list-skills' }),
        )?.title,
      ).toBe('list-skills')
      // cwd basename last resort when even firstPrompt is empty.
      expect(
        mapLogOptionToCatalogEntry(
          makeLog({ sessionId: 's', firstPrompt: '', projectPath: '/Users/me/my-proj' }),
        )?.title,
      ).toBe('my-proj')
    })

    test('the enrich placeholder firstPrompt still yields a non-empty label', () => {
      // enrichLog stamps firstPrompt:"(session)" when it can extract nothing.
      expect(
        mapLogOptionToCatalogEntry(makeLog({ sessionId: 's', firstPrompt: '(session)' }))?.title,
      ).toBe('(session)')
    })

    test('title is null only when nothing at all is available (renderer supplies the final fallback)', () => {
      const entry = mapLogOptionToCatalogEntry(
        makeLog({ sessionId: 's', firstPrompt: '', projectPath: undefined, fullPath: undefined }),
      )
      expect(entry?.title).toBeNull()
      expect(entry?.cwd).toBe('')
    })
  })

  describe('B3 — cwd fallback when the transcript recorded no projectPath', () => {
    test('falls back to the transcript project directory so rows still group', () => {
      const entry = mapLogOptionToCatalogEntry(
        makeLog({
          sessionId: 's',
          projectPath: undefined,
          fullPath: '/Users/me/.cat-code/projects/-Users-me-proj/abc.jsonl',
        }),
      )
      // Non-empty + stable grouping key (the transcript's own project dir).
      expect(entry?.cwd).toBe('/Users/me/.cat-code/projects/-Users-me-proj')
    })

    test('an explicit projectPath still wins over the fullPath fallback', () => {
      const entry = mapLogOptionToCatalogEntry(
        makeLog({
          sessionId: 's',
          projectPath: '/Users/me/real-cwd',
          fullPath: '/Users/me/.cat-code/projects/-Users-me-proj/abc.jsonl',
        }),
      )
      expect(entry?.cwd).toBe('/Users/me/real-cwd')
    })
  })

  test('drops sidechain logs and logs without a sessionId', () => {
    expect(mapLogOptionToCatalogEntry(makeLog({ sessionId: undefined }))).toBeNull()
    expect(
      mapLogOptionToCatalogEntry(makeLog({ sessionId: 's-3', isSidechain: true })),
    ).toBeNull()
  })
})

describe('buildSessionsCatalogSnapshot', () => {
  test('builds entries from enriched logs and flags truncation', () => {
    const snapshot = buildSessionsCatalogSnapshot(
      result([makeLog({ sessionId: 'a' }), makeLog({ sessionId: 'b' })], 50),
    )
    expect(snapshot.entries.map(e => e.sessionId)).toEqual(['a', 'b'])
    expect(snapshot.truncated).toBe(true)
    expect(snapshot.notes.length).toBeGreaterThan(0)
  })

  test('not truncated when every discovered session is enriched', () => {
    const snapshot = buildSessionsCatalogSnapshot(
      result([makeLog({ sessionId: 'a' })], 1),
    )
    expect(snapshot.truncated).toBe(false)
  })

  test('B1 — carries far more than the old 50-row cap (older work sessions appear)', () => {
    // The pre-#16 default hid history behind the newest 50; the builder itself
    // never capped — the loader enrich budget did. Prove the builder emits every
    // enriched row it is given so raising that budget surfaces real history.
    const many = Array.from({ length: 120 }, (_, i) =>
      makeLog({ sessionId: `s-${i}`, firstPrompt: `prompt ${i}` }),
    )
    const snapshot = buildSessionsCatalogSnapshot(result(many, 600))
    expect(snapshot.entries).toHaveLength(120)
    // Every emitted row is labeled (B2) — no unlabeled rows.
    expect(snapshot.entries.every(e => e.title != null && e.title.length > 0)).toBe(true)
  })

  test('the built frame is secretGuard-clean (display metadata only)', () => {
    const snapshot = buildSessionsCatalogSnapshot(
      result([
        makeLog({ sessionId: 'a', customTitle: 'Refactor auth', tag: 'wip', gitBranch: 'main' }),
        makeLog({ sessionId: 'b', customTitle: 'Session two', prRepository: 'me/proj', prNumber: 7 }),
      ]),
    )
    const frame: SessionsCatalogSnapshotFrame = {
      kind: 'sessions.snapshot',
      protocolVersion: 1,
      sessionId: 's1',
      catalog: snapshot,
    }
    expect(scanForSecrets(frame).ok).toBe(true)
  })
})

describe('B4 — createSidecarSessionsCatalogDomain refresh / de-stale', () => {
  function snap(ids: string[]): SessionsCatalogSnapshot {
    return {
      entries: ids.map(id => ({
        sessionId: id,
        cwd: '/w/proj',
        title: id,
        modifiedAtMs: 1,
        createdAtMs: 1,
        messageCount: 0,
        gitBranch: null,
        tag: null,
        mode: null,
        agentSetting: null,
        prNumber: null,
        prRepository: null,
      })),
      truncated: false,
      notes: [],
    }
  }

  test('refresh re-enumerates so a session created after spawn appears', async () => {
    const states = [snap(['a']), snap(['a', 'b'])]
    let call = 0
    const domain = await createSidecarSessionsCatalogDomain(async () => states[Math.min(call++, states.length - 1)]!)
    // Spawn snapshot = first enumeration.
    expect(domain.getSnapshot()?.entries.map(e => e.sessionId)).toEqual(['a'])
    // A new session ('b') landed; refresh surfaces it.
    const refreshed = await domain.refresh()
    expect(refreshed?.entries.map(e => e.sessionId)).toEqual(['a', 'b'])
    expect(domain.getSnapshot()?.entries.map(e => e.sessionId)).toEqual(['a', 'b'])
  })

  test('a transient re-read failure keeps the last good snapshot (degrade, not blank)', async () => {
    const results: Array<SessionsCatalogSnapshot | null> = [snap(['a']), null]
    let call = 0
    const domain = await createSidecarSessionsCatalogDomain(async () => results[Math.min(call++, results.length - 1)]!)
    expect(domain.getSnapshot()?.entries.map(e => e.sessionId)).toEqual(['a'])
    await domain.refresh() // enumeration returned null
    expect(domain.getSnapshot()?.entries.map(e => e.sessionId)).toEqual(['a'])
  })
})
