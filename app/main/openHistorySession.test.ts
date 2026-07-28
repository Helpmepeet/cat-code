import { describe, expect, test } from 'bun:test'

import { resolveOpenHistorySession } from './openHistorySession.js'
import type { SessionDescriptor } from '../shared/hostApi.js'
import type {
  SessionCatalogEntry,
  SessionsCatalogSnapshot,
} from '../shared/protocol.js'

// A real transcript session id shape (UUID v4) — engine ids are `randomUUID()`.
const ENGINE_ID = '2a2af184-cde0-47e6-b1c4-82f2fa2c59e1'
const OTHER_ID = '8ad429a8-65bd-4eef-897c-821c0610ed84'

function entry(over: Partial<SessionCatalogEntry> = {}): SessionCatalogEntry {
  return {
    sessionId: ENGINE_ID,
    cwd: '/Users/pt/project',
    cwdExists: true,
    title: 'A terminal session',
    transcriptTitle: null,
    modifiedAtMs: 1000,
    createdAtMs: 500,
    messageCount: 3,
    gitBranch: null,
    tag: null,
    mode: null,
    agentSetting: null,
    prNumber: null,
    prRepository: null,
    ...over,
  }
}

function catalog(entries: SessionCatalogEntry[]): SessionsCatalogSnapshot {
  return { entries, truncated: false, notes: [], capturedAtMs: 1000 }
}

function descriptor(over: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    appSessionId: '11111111-1111-4111-8111-111111111111',
    engineSessionId: ENGINE_ID,
    cwd: '/Users/pt/project',
    title: null,
    titleUpdatedAt: null,
    status: 'ready',
    restorable: false,
    createdAt: 1,
    lastAttachedAt: 2,
    lastMessageSentAt: null,
    ...over,
  }
}

describe('resolveOpenHistorySession (open-from-history boundary)', () => {
  test('rejects a non-string id (fail closed, no lookup)', () => {
    const result = resolveOpenHistorySession(42, [], catalog([entry()]))
    expect(result.kind).toBe('reject')
    if (result.kind === 'reject') expect(result.error.code).toBe('session_not_found')
  })

  test('rejects a malformed / non-UUID id', () => {
    for (const bad of [
      '',
      'not-a-uuid',
      '../../etc/passwd',
      `${ENGINE_ID} ` /* trailing space */,
      `${ENGINE_ID}\n${OTHER_ID}`,
    ]) {
      const result = resolveOpenHistorySession(bad, [], catalog([entry()]))
      expect(result.kind).toBe('reject')
      if (result.kind === 'reject') {
        expect(result.error.code).toBe('session_not_found')
      }
    }
  })

  test('rejects an id absent from the cache (unknown → typed failure)', () => {
    const result = resolveOpenHistorySession(OTHER_ID, [], catalog([entry()]))
    expect(result.kind).toBe('reject')
    if (result.kind === 'reject') {
      expect(result.error.code).toBe('session_not_found')
      expect(result.error.message).toContain('terminal')
    }
  })

  test('rejects an id whose cached cwd is empty (MAJOR-1 → invalid_cwd)', () => {
    for (const emptyCwd of ['', '   ']) {
      const result = resolveOpenHistorySession(
        ENGINE_ID,
        [],
        catalog([entry({ cwd: emptyCwd })]),
      )
      expect(result.kind).toBe('reject')
      if (result.kind === 'reject') {
        expect(result.error.code).toBe('invalid_cwd')
        expect(result.error.message).toContain('terminal')
      }
    }
  })

  // These messages are rendered verbatim by the renderer, but they are composed
  // in main, outside `userVisibleText.test.ts`'s `app/renderer/src` scan root.
  test('reject messages carry no em dash (user-visible text rule)', () => {
    const messages = [
      resolveOpenHistorySession(OTHER_ID, [], catalog([entry()])),
      resolveOpenHistorySession(ENGINE_ID, [], catalog([entry({ cwd: '' })])),
    ].map(result => (result.kind === 'reject' ? result.error.message : ''))
    expect(messages).toHaveLength(2)
    for (const message of messages) {
      expect(message.length).toBeGreaterThan(0)
      expect(message).not.toContain('—')
    }
  })

  test('rejects everything when the catalog is null (no cache at all)', () => {
    const result = resolveOpenHistorySession(ENGINE_ID, [], null)
    expect(result.kind).toBe('reject')
    if (result.kind === 'reject') expect(result.error.code).toBe('session_not_found')
  })

  test('SUCCESS: resolves cwd + title from the cache, never from the request', () => {
    const result = resolveOpenHistorySession(
      ENGINE_ID,
      [],
      catalog([entry({ cwd: '/Users/pt/real-workspace', title: 'Fix the parser' })]),
    )
    expect(result.kind).toBe('spawn')
    if (result.kind === 'spawn') {
      // cwd + title came from the engine-written cache entry, not the renderer.
      expect(result.cwd).toBe('/Users/pt/real-workspace')
      expect(result.resumeEngineSessionId).toBe(ENGINE_ID)
      // The persisted title rides along so the resumed tab/sidebar match the
      // clicked history row instead of the cwd basename (bug-sweep #2, 2026-07-21).
      expect(result.title).toBe('Fix the parser')
    }
  })

  test('SUCCESS: a title-less transcript carries no title (tab keeps the cwd fallback)', () => {
    const result = resolveOpenHistorySession(
      ENGINE_ID,
      [],
      catalog([entry({ cwd: '/Users/pt/real-workspace', title: null })]),
    )
    expect(result.kind).toBe('spawn')
    if (result.kind === 'spawn') {
      expect(result.title).toBeUndefined()
    }
  })

  test('dedup: an id already bound to a live app row returns that row (no spawn)', () => {
    const live = descriptor({ engineSessionId: ENGINE_ID, status: 'ready' })
    const result = resolveOpenHistorySession(ENGINE_ID, [live], catalog([entry()]))
    expect(result.kind).toBe('existing')
    if (result.kind === 'existing') {
      expect(result.descriptor.appSessionId).toBe(live.appSessionId)
    }
  })

  test('dedup: an id bound to a restorable app row returns it (switch/restore, not re-spawn)', () => {
    const restorable = descriptor({
      engineSessionId: ENGINE_ID,
      status: 'exited',
      restorable: true,
    })
    const result = resolveOpenHistorySession(
      ENGINE_ID,
      [restorable],
      catalog([entry()]),
    )
    expect(result.kind).toBe('existing')
  })

  test('dedup does not fire on a different engine id in the roster', () => {
    const otherRow = descriptor({ engineSessionId: OTHER_ID })
    const result = resolveOpenHistorySession(
      ENGINE_ID,
      [otherRow],
      catalog([entry()]),
    )
    expect(result.kind).toBe('spawn')
  })
})
