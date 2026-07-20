import { describe, expect, test } from 'bun:test'
import type { MergedSessionRow } from './sessionsCatalogState.js'
import {
  resolveSessionActions,
  SESSION_ACTION_SECTIONS,
  type SessionActionItem,
  type SessionActionKind,
} from './sessionActions.js'

function row(overrides: Partial<MergedSessionRow> = {}): MergedSessionRow {
  return {
    sessionId: 'engine-1',
    appSessionId: 'app-1',
    cwd: '/w/project',
    title: 'Refactor auth',
    displayLabel: 'Refactor auth',
    live: true,
    restorable: false,
    status: 'ready',
    inRegistry: true,
    modifiedAtMs: 1,
    createdAtMs: 0,
    lastMessageSentAt: null,
    messageCount: 4,
    gitBranch: null,
    tag: null,
    mode: 'normal',
    agentSetting: null,
    prNumber: null,
    prRepository: null,
    ...overrides,
  }
}

function byKind(items: SessionActionItem[]): Map<SessionActionKind, SessionActionItem> {
  return new Map(items.map(item => [item.kind, item]))
}

describe('resolveSessionActions', () => {
  test('never returns a cut verb (tag/archive/delete)', () => {
    const kinds = resolveSessionActions(row(), { isActiveOpen: true }).map(i => i.kind)
    expect(kinds).not.toContain('tag' as SessionActionKind)
    expect(kinds).not.toContain('archive' as SessionActionKind)
    expect(kinds).not.toContain('delete' as SessionActionKind)
  })

  test('every disabled item carries a source-cited reason; every enabled one does not', () => {
    for (const ctx of [{ isActiveOpen: true }, { isActiveOpen: false }]) {
      for (const item of resolveSessionActions(row(), ctx)) {
        if (item.enabled) expect(item.reason).toBeUndefined()
        else expect(typeof item.reason).toBe('string')
      }
    }
  })

  test('Open is enabled for a registry-backed row, disabled+reason for history-only', () => {
    const openable = byKind(resolveSessionActions(row({ appSessionId: 'app-1' }), { isActiveOpen: false })).get('open')!
    expect(openable.enabled).toBe(true)
    expect(openable.label).toBe('Open')

    const historyOnly = byKind(
      resolveSessionActions(
        row({ appSessionId: null, inRegistry: false, live: false, status: 'history' }),
        { isActiveOpen: false },
      ),
    ).get('open')!
    expect(historyOnly.enabled).toBe(false)
    expect(historyOnly.reason).toContain('host-API gap')
  })

  test('Open reads "Restore" for a restorable (not-live) registry row', () => {
    const item = byKind(
      resolveSessionActions(row({ live: false, restorable: true, status: 'exited' }), { isActiveOpen: false }),
    ).get('open')!
    expect(item.enabled).toBe(true)
    expect(item.label).toBe('Restore')
  })

  test('Copy + Inspect-metadata are live ONLY for the active-open session', () => {
    const active = byKind(resolveSessionActions(row(), { isActiveOpen: true }))
    expect(active.get('copy')!.enabled).toBe(true)
    expect(active.get('metadata')!.enabled).toBe(true)

    const inactive = byKind(resolveSessionActions(row(), { isActiveOpen: false }))
    expect(inactive.get('copy')!.enabled).toBe(false)
    expect(inactive.get('copy')!.reason).toContain('Open this session first')
    expect(inactive.get('metadata')!.enabled).toBe(false)
  })

  test('Rename / Export / Branch are ENABLED for a LIVE row (P4-6b wired verbs)', () => {
    const items = byKind(resolveSessionActions(row({ live: true }), { isActiveOpen: true }))
    expect(items.get('rename')!.enabled).toBe(true)
    expect(items.get('rename')!.reason).toBeUndefined()
    expect(items.get('export')!.enabled).toBe(true)
    expect(items.get('export')!.reason).toBeUndefined()
    expect(items.get('branch')!.enabled).toBe(true)
    expect(items.get('branch')!.label).toBe('Branch from HEAD…')
    expect(items.get('branch')!.reason).toBeUndefined()
  })

  test('Rename / Export / Branch are DISABLED with a reason for a NON-live row', () => {
    const items = byKind(
      resolveSessionActions(
        row({ live: false, restorable: true, status: 'exited' }),
        { isActiveOpen: false },
      ),
    )
    for (const kind of ['rename', 'export', 'branch'] as const) {
      expect(items.get(kind)!.enabled).toBe(false)
      expect(items.get(kind)!.reason).toContain('live engine')
    }
  })

  test('Rewind stays deferred (disabled) — no engine conversation-rewind verb', () => {
    const items = byKind(resolveSessionActions(row(), { isActiveOpen: true }))
    expect(items.get('rewind')!.enabled).toBe(false)
    expect(items.get('rewind')!.reason).toContain('REPL.tsx:4034')
  })

  test('every item belongs to a known section', () => {
    for (const item of resolveSessionActions(row(), { isActiveOpen: true })) {
      expect(SESSION_ACTION_SECTIONS).toContain(item.section)
    }
  })
})
