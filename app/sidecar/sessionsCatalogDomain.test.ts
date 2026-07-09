import { describe, expect, test } from 'bun:test'
import type { LogOption } from '../../src/types/logs.js'
import type { SessionLogResult } from '../../src/utils/sessionStorage.js'
import type { SessionsCatalogSnapshotFrame } from '../shared/protocol.js'
import { scanForSecrets } from '../shared/secretGuard.js'
import {
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

  test('renders truth: empty/undefined metadata → null, not fabricated', () => {
    const entry = mapLogOptionToCatalogEntry(makeLog({ sessionId: 's-2', customTitle: '   ' }))
    expect(entry?.title).toBeNull()
    expect(entry?.gitBranch).toBeNull()
    expect(entry?.tag).toBeNull()
    expect(entry?.mode).toBeNull()
    expect(entry?.prNumber).toBeNull()
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
