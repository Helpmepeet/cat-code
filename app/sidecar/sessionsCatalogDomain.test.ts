import { describe, expect, test } from 'bun:test'
import type { LogOption } from '../../src/types/logs.js'
import type { SessionLogResult } from '../../src/utils/sessionStorage.js'
import type { SessionsCatalogSnapshotFrame } from '../shared/protocol.js'
import { scanForSecrets } from '../shared/secretGuard.js'
import {
  annotateCwdExistence,
  buildSessionsCatalogSnapshot,
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
        forked: true,
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
      forked: true,
      cwd: '/Users/me/proj',
      title: 'Fix the parser',
      messageCount: 12,
      gitBranch: 'feature/x',
      tag: 'bug',
      mode: 'normal',
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

  /**
   * The terminal-rename fix needs a title field that is NOT the B2 cascade above:
   * only a title the engine actually recorded (`custom-title` > `ai-title`, folded
   * into `LogOption.customTitle` at `src/utils/sessionStorage.ts:5262`) may outrank
   * the host registry's own title.
   */
  describe('transcriptTitle — the recorded title, never the display cascade', () => {
    test('carries the recorded title while `title` falls through the cascade', () => {
      const recorded = mapLogOptionToCatalogEntry(
        makeLog({ sessionId: 's', customTitle: 'Renamed in the terminal', firstPrompt: 'hi' }),
      )
      expect(recorded?.transcriptTitle).toBe('Renamed in the terminal')
      expect(recorded?.title).toBe('Renamed in the terminal')

      // No recorded title: `title` still labels the row from the summary / first
      // prompt / basename, but `transcriptTitle` stays null so none of those
      // fallbacks can ever overwrite an app-set title.
      const summaryOnly = mapLogOptionToCatalogEntry(
        makeLog({ sessionId: 's', summary: 'A summary', firstPrompt: 'hi' }),
      )
      expect(summaryOnly?.transcriptTitle).toBeNull()
      expect(summaryOnly?.title).toBe('A summary')

      const promptOnly = mapLogOptionToCatalogEntry(
        makeLog({ sessionId: 's', firstPrompt: 'please fix the parser' }),
      )
      expect(promptOnly?.transcriptTitle).toBeNull()
      expect(promptOnly?.title).toBe('please fix the parser')

      const basenameOnly = mapLogOptionToCatalogEntry(
        makeLog({ sessionId: 's', firstPrompt: '', projectPath: '/Users/me/my-proj' }),
      )
      expect(basenameOnly?.transcriptTitle).toBeNull()
      expect(basenameOnly?.title).toBe('my-proj')
    })

    test('a whitespace-only recorded title is null, not blank', () => {
      expect(
        mapLogOptionToCatalogEntry(makeLog({ sessionId: 's', customTitle: '   ' }))
          ?.transcriptTitle,
      ).toBeNull()
    })
  })

  describe('B3 / MAJOR-1 — cwd resolution when the transcript recorded no projectPath', () => {
    test('no projectPath and no reconciliation sibling ⇒ empty cwd, never the sanitized storage dir', () => {
      const entry = mapLogOptionToCatalogEntry(
        makeLog({
          sessionId: 's',
          projectPath: undefined,
          fullPath: '/Users/me/.cat-code/projects/-Users-me-proj/abc.jsonl',
        }),
      )
      // Was previously the ugly sanitized dir; now empty so it never fragments a
      // workspace under an undecodable header (falls into the "Unknown workspace"
      // bucket). Reconciliation to a real cwd happens in buildSessionsCatalogSnapshot.
      expect(entry?.cwd).toBe('')
    })

    test('reconciles to a sibling storage-dir cwd when a map is supplied', () => {
      const map = new Map([['/Users/me/.cat-code/projects/-Users-me-proj', '/Users/me/proj']])
      const entry = mapLogOptionToCatalogEntry(
        makeLog({
          sessionId: 's',
          projectPath: undefined,
          fullPath: '/Users/me/.cat-code/projects/-Users-me-proj/abc.jsonl',
        }),
        map,
      )
      expect(entry?.cwd).toBe('/Users/me/proj')
    })

    test('an explicit projectPath still wins over the reconciliation map', () => {
      const map = new Map([['/Users/me/.cat-code/projects/-Users-me-proj', '/Users/me/borrowed']])
      const entry = mapLogOptionToCatalogEntry(
        makeLog({
          sessionId: 's',
          projectPath: '/Users/me/real-cwd',
          fullPath: '/Users/me/.cat-code/projects/-Users-me-proj/abc.jsonl',
        }),
        map,
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

  // Every catalog row is openable: a transcript with no conversation fails to
  // resume in the engine AFTER the app minted a registry row for it, which then
  // evicts a real restorable session at MAX_REGISTRY_SESSIONS. Observed live
  // 2026-07-20 as repeated `resume-failed: no conversation found` + `reaped 1
  // over-bound terminal row(s)` on Codex telemetry-only transcripts.
  test('drops transcripts with no conversation (unresumable)', () => {
    expect(
      mapLogOptionToCatalogEntry(makeLog({ sessionId: 's-4', hasConversation: false })),
    ).toBeNull()
  })

  test('marks noninteractive SDK CLI transcripts unavailable to the desktop app', () => {
    expect(
      mapLogOptionToCatalogEntry(makeLog({ sessionId: 'sdk-run', entrypoint: 'sdk-cli' })),
    ).toMatchObject({ isInteractive: false })
  })

  // The title fallback is NOT the predicate: the engine stamps '(session)' on a
  // real session whose first prompt outgrew the read window, and that session is
  // resumable. Only the content flag may drop a row.
  test('keeps a "(session)"-titled row that HAS a conversation', () => {
    const entry = mapLogOptionToCatalogEntry(
      makeLog({ sessionId: 's-5', firstPrompt: '(session)', hasConversation: true }),
    )
    expect(entry).not.toBeNull()
    expect(entry?.title).toBe('(session)')
  })

  // An unscanned lite row carries `undefined`, which must not be read as "empty".
  test('keeps a row whose conversation flag is unknown', () => {
    expect(
      mapLogOptionToCatalogEntry(makeLog({ sessionId: 's-6', hasConversation: undefined })),
    ).not.toBeNull()
  })
})

describe('buildSessionsCatalogSnapshot', () => {
  test('builds entries from enriched logs and flags truncation', () => {
    const snapshot = buildSessionsCatalogSnapshot(
      result([makeLog({ sessionId: 'a' }), makeLog({ sessionId: 'b' })], 50),
    )
    expect(snapshot.entries.map(e => e.sessionId)).toEqual(['a', 'b'])
    expect(snapshot.truncated).toBe(true)
  })

  test('carries the injected capturedAtMs, and defaults to a real clock reading', () => {
    // The renderer compares this against the registry's `titleUpdatedAt` to decide
    // which title is the newer intent, so it must survive the build unchanged.
    expect(
      buildSessionsCatalogSnapshot(result([makeLog({ sessionId: 'a' })]), 1234).capturedAtMs,
    ).toBe(1234)
    const before = Date.now()
    const defaulted = buildSessionsCatalogSnapshot(result([makeLog({ sessionId: 'a' })]))
    expect(defaulted.capturedAtMs).toBeGreaterThanOrEqual(before)
  })

  test('not truncated when every discovered session is enriched', () => {
    const snapshot = buildSessionsCatalogSnapshot(
      result([makeLog({ sessionId: 'a' })], 1),
    )
    expect(snapshot.truncated).toBe(false)
  })

  // Rows DROPPED by the loader (sidechains, team sessions, no-conversation
  // transcripts) are not omitted history: the whole list was still scanned. A
  // count comparison would call this truncated and tell the operator older
  // sessions are missing when none are — `nextIndex` is the honest signal.
  test('filtered-out rows do NOT flag truncation when the whole list was scanned', () => {
    const snapshot = buildSessionsCatalogSnapshot({
      logs: [makeLog({ sessionId: 'a' })],
      allStatLogs: Array.from({ length: 40 }, (_, i) =>
        makeLog({ sessionId: `stat-${i}` }),
      ),
      // Enrichment reached the END of the discovered list; the other 39 rows were
      // dropped by the loader's filters, not left unscanned.
      nextIndex: 40,
    })
    expect(snapshot.entries).toHaveLength(1)
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

  test('MAJOR-1 — same-workspace sessions group under the real cwd even when some lack projectPath', () => {
    const dir = '/Users/me/.cat-code/projects/-Users-me-proj'
    const snapshot = buildSessionsCatalogSnapshot(
      result([
        // One session recorded the real cwd…
        makeLog({ sessionId: 'has-cwd', projectPath: '/Users/me/proj', fullPath: `${dir}/a.jsonl` }),
        // …its sibling in the same storage dir did not.
        makeLog({ sessionId: 'no-cwd', projectPath: undefined, fullPath: `${dir}/b.jsonl` }),
      ]),
    )
    const byId = new Map(snapshot.entries.map(e => [e.sessionId, e.cwd]))
    // The projectPath-less session borrows its sibling's real cwd — one workspace,
    // not two (and it reconciles with the registry rows that carry the real cwd).
    expect(byId.get('has-cwd')).toBe('/Users/me/proj')
    expect(byId.get('no-cwd')).toBe('/Users/me/proj')
    // groupByWorkspace keys on cwd, so a single shared cwd ⇒ exactly ONE group.
    expect(new Set(snapshot.entries.map(e => e.cwd)).size).toBe(1)
  })

  test('MAJOR-1 — a storage dir with NO projectPath sibling stays unresolved (empty cwd), not a sanitized path', () => {
    const snapshot = buildSessionsCatalogSnapshot(
      result([
        makeLog({
          sessionId: 'orphan',
          projectPath: undefined,
          fullPath: '/Users/me/.cat-code/projects/-Users-me-orphan/x.jsonl',
        }),
      ]),
    )
    expect(snapshot.entries[0]?.cwd).toBe('')
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

  // The pure builder is filesystem-free: it never stats. It defaults every entry
  // to cwdExists:true (assume-exists), so a direct use without the async annotate
  // pass NEVER hides a row — the pre-fix behavior. `annotateCwdExistence` is the
  // sole downgrade point.
  test('the pure builder defaults cwdExists true (assume-exists; annotate downgrades)', () => {
    const snapshot = buildSessionsCatalogSnapshot(
      result([makeLog({ sessionId: 'a', projectPath: '/w/one' })]),
    )
    expect(snapshot.entries[0]?.cwdExists).toBe(true)
  })
})

describe('annotateCwdExistence (bug-sweep #1 — dead-cwd downgrade)', () => {
  test('marks an existing cwd true and a gone cwd false; empty cwd stays false', async () => {
    const snapshot = buildSessionsCatalogSnapshot(
      result([
        makeLog({ sessionId: 'live', projectPath: '/w/alive' }),
        makeLog({ sessionId: 'dead', projectPath: '/tmp/gone-fixture' }),
        makeLog({ sessionId: 'orphan', projectPath: undefined, fullPath: undefined }),
      ]),
    )
    const annotated = await annotateCwdExistence(
      snapshot,
      async cwd => cwd === '/w/alive',
    )
    const byId = new Map(annotated.entries.map(e => [e.sessionId, e.cwdExists]))
    expect(byId.get('live')).toBe(true)
    expect(byId.get('dead')).toBe(false)
    // Empty cwd is never statted (there is no path); it resolves to false and the
    // renderer keeps such "Unknown workspace" rows via its own predicate.
    expect(byId.get('orphan')).toBe(false)
  })

  test('stats each DISTINCT non-empty cwd exactly once (two sessions, one workspace → one stat)', async () => {
    const dir = '/Users/me/.cat-code/projects/-Users-me-proj'
    const snapshot = buildSessionsCatalogSnapshot(
      result([
        makeLog({ sessionId: 'has-cwd', projectPath: '/w/proj', fullPath: `${dir}/a.jsonl` }),
        makeLog({ sessionId: 'no-cwd', projectPath: undefined, fullPath: `${dir}/b.jsonl` }),
      ]),
    )
    const statted: string[] = []
    const annotated = await annotateCwdExistence(snapshot, async cwd => {
      statted.push(cwd)
      return true
    })
    // Both sessions reconcile to /w/proj (MAJOR-1), so exactly ONE distinct stat.
    expect(statted).toEqual(['/w/proj'])
    expect(annotated.entries.every(e => e.cwdExists)).toBe(true)
  })

  test('does not mutate the input snapshot (returns a fresh one)', async () => {
    const snapshot = buildSessionsCatalogSnapshot(
      result([makeLog({ sessionId: 'a', projectPath: '/tmp/gone' })]),
    )
    const annotated = await annotateCwdExistence(snapshot, async () => false)
    expect(snapshot.entries[0]?.cwdExists).toBe(true) // untouched
    expect(annotated.entries[0]?.cwdExists).toBe(false) // downgraded copy
    expect(annotated).not.toBe(snapshot)
  })

  test('carries capturedAtMs + transcriptTitle through the async pass', async () => {
    // The pass rebuilds the snapshot, so a field it forgot to spread would silently
    // become "unknown age" and disable the whole title-precedence rule.
    const snapshot = buildSessionsCatalogSnapshot(
      result([makeLog({ sessionId: 'a', projectPath: '/w/x', customTitle: 'Recorded' })]),
      4321,
    )
    const annotated = await annotateCwdExistence(snapshot, async () => true)
    expect(annotated.capturedAtMs).toBe(4321)
    expect(annotated.entries[0]?.transcriptTitle).toBe('Recorded')
  })
})
