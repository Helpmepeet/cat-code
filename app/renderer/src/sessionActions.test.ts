import { describe, expect, test } from 'bun:test'
import type { MergedSessionRow } from './sessionsCatalogState.js'
import {
  estimateSessionActionsMenuHeight,
  placeSessionActionsMenu,
  resolveSessionActions,
  selectSessionsPageActions,
  SESSION_ACTION_SECTIONS,
  type SessionActionItem,
  type SessionActionKind,
} from './sessionActions.js'

function row(overrides: Partial<MergedSessionRow> = {}): MergedSessionRow {
  return {
    sessionId: 'engine-1',
    appSessionId: 'app-1',
    cwd: '/w/project',
    cwdExists: true,
    title: 'Refactor auth',
    displayLabel: 'Refactor auth',
    live: true,
    restorable: false,
    parked: false,
    status: 'ready',
    inRegistry: true,
    modifiedAtMs: 1,
    createdAtMs: 0,
    lastMessageSentAt: null,
    transcriptActivityAtMs: null,
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
      // P4-30 — walks flyout CHILDREN too, so a submenu row can never smuggle in
      // a dead affordance with no reason.
      for (const item of resolveSessionActions(row(), ctx).flatMap(i => [
        i,
        ...(i.flyout ?? []),
      ])) {
        if (item.enabled) expect(item.reason).toBeUndefined()
        else expect(typeof item.reason).toBe('string')
      }
    }
  })

  test('P4-30: Copy is a non-dispatching flyout host over the two copy variants', () => {
    const copy = byKind(resolveSessionActions(row(), { isActiveOpen: true })).get('copy')!
    expect(copy.label).toBe('Copy')
    const children = copy.flyout ?? []
    expect(children.map(c => c.kind)).toEqual(['copy-md', 'copy-text'])

    // Markdown stays the owner-flagged §0 defer (no engine markdown renderer):
    // rendered, disabled, with an honest reason — never a Potemkin button.
    const markdown = children.find(c => c.kind === 'copy-md')!
    expect(markdown.enabled).toBe(false)
    expect(markdown.reason).toContain('not available yet')

    // The plain-text child is the real, already-wired copy action.
    expect(children.find(c => c.kind === 'copy-text')!.enabled).toBe(true)
  })

  test('P4-30: a flyout host that is itself disabled carries the group reason', () => {
    const copy = byKind(resolveSessionActions(row(), { isActiveOpen: false })).get('copy')!
    expect(copy.enabled).toBe(false)
    expect(copy.reason).toContain('Open this session first')
    expect(copy.flyout?.every(child => !child.enabled)).toBe(true)
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
    expect(historyOnly.reason).toContain('came from terminal history')
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

  test('Copy-session-ids is NOT active-open gated: it reads the row, not the transcript', () => {
    // The point of the row. It replaced a composer debug line that could only
    // speak for the attached tab, and the ids you usually want belong to a
    // session that is closed or came from the terminal.
    for (const isActiveOpen of [true, false]) {
      const item = byKind(resolveSessionActions(row(), { isActiveOpen })).get(
        'copy-ids',
      )!
      expect(item.label).toBe('Copy session ids')
      expect(item.section).toBe('transfer')
      expect(item.enabled).toBe(true)
      expect(item.reason).toBeUndefined()
    }

    // A history row has no app id and a closed row has no live engine; both
    // still have an id to copy.
    const history = byKind(
      resolveSessionActions(
        row({
          sessionId: 'engine-9',
          appSessionId: null,
          inRegistry: false,
          live: false,
          status: 'history',
        }),
        { isActiveOpen: false },
      ),
    )
    expect(history.get('copy-ids')!.enabled).toBe(true)

    // A registry row the engine has not named yet (merge key === app id) keeps
    // it too: the app id alone is worth copying, and `none` is the honest value
    // for the other half.
    const unnamed = byKind(
      resolveSessionActions(row({ sessionId: 'app-1', appSessionId: 'app-1' }), {
        isActiveOpen: false,
      }),
    )
    expect(unnamed.get('copy-ids')!.enabled).toBe(true)
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

  test('Rename / Export / Branch are disabled when the host row is live but its sidecar disconnected', () => {
    const items = byKind(
      resolveSessionActions(row({ live: true, status: 'disconnected' }), {
        isActiveOpen: true,
        hasEngine: false,
      }),
    )
    for (const kind of ['rename', 'export', 'branch'] as const) {
      expect(items.get(kind)!.enabled).toBe(false)
      expect(items.get(kind)!.reason).toContain('live engine')
    }
  })

  test('Rewind stays deferred (disabled) — no engine conversation-rewind verb', () => {
    const items = byKind(resolveSessionActions(row(), { isActiveOpen: true }))
    expect(items.get('rewind')!.enabled).toBe(false)
    expect(items.get('rewind')!.reason).toContain('not available in the desktop app yet')
  })

  test('P4-36: the hidden-row reveal appears ONLY when the tier exists', () => {
    // No hidden tier ⇒ no row at all (not a disabled one): the prototype's
    // `messages.some(m => m.meta)` guard, Chat.jsx:1200.
    const none = resolveSessionActions(row(), { isActiveOpen: true }).map(i => i.kind)
    expect(none).not.toContain('reveal-hidden' as SessionActionKind)
    expect(none).not.toContain('hide-hidden' as SessionActionKind)

    // Hidden tier, not revealed ⇒ the "show" variant, enabled, no reason.
    const show = byKind(
      resolveSessionActions(row(), { isActiveOpen: true, hasHiddenRows: true }),
    )
    expect(show.get('reveal-hidden')!.label).toBe('Show hidden messages')
    expect(show.get('reveal-hidden')!.enabled).toBe(true)
    expect(show.get('reveal-hidden')!.reason).toBeUndefined()
    expect(show.get('reveal-hidden')!.section).toBe('history')
    expect(show.has('hide-hidden')).toBe(false)

    // Revealed ⇒ the "hide" variant replaces it (one row, never both).
    const hide = byKind(
      resolveSessionActions(row(), {
        isActiveOpen: true,
        hasHiddenRows: true,
        hiddenRevealed: true,
      }),
    )
    expect(hide.get('hide-hidden')!.label).toBe('Hide hidden messages')
    expect(hide.has('reveal-hidden')).toBe(false)
  })

  test('P4-36: the reveal is active-open gated (it changes the attached pane)', () => {
    const kinds = resolveSessionActions(row(), {
      isActiveOpen: false,
      hasHiddenRows: true,
    }).map(i => i.kind)
    expect(kinds).not.toContain('reveal-hidden' as SessionActionKind)
    expect(kinds).not.toContain('hide-hidden' as SessionActionKind)
  })

  test('every item belongs to a known section', () => {
    for (const item of resolveSessionActions(row(), { isActiveOpen: true })) {
      expect(SESSION_ACTION_SECTIONS).toContain(item.section)
    }
  })
})

describe('P4-39 — placeSessionActionsMenu', () => {
  const viewport = { width: 1280, height: 800 }
  const HEIGHT = 264

  test('a trigger near the top opens BELOW it, one gap down', () => {
    const placed = placeSessionActionsMenu(
      { top: 40, bottom: 58, left: 800 },
      viewport,
      HEIGHT,
    )
    expect(placed).toEqual({ placeAbove: false, top: 62, left: 800 })
  })

  test('a trigger near the bottom FLIPS above it, anchored by `bottom`', () => {
    // The defect this session exists for: 718 + 264 overflows an 800px window,
    // and the raw anchor put the lower rows out of reach with no scroll.
    const placed = placeSessionActionsMenu(
      { top: 700, bottom: 718, left: 800 },
      viewport,
      HEIGHT,
    )
    expect(placed).toEqual({ placeAbove: true, bottom: 104, left: 800 })
  })

  test('exactly-fits stays below; one pixel less flips', () => {
    // spaceBelow = 800 - 532 - 4 = 264 = the panel: it fits, so no flip.
    expect(
      placeSessionActionsMenu({ top: 514, bottom: 532, left: 0 }, viewport, HEIGHT)
        .placeAbove,
    ).toBe(false)
    expect(
      placeSessionActionsMenu({ top: 515, bottom: 533, left: 0 }, viewport, HEIGHT)
        .placeAbove,
    ).toBe(true)
  })

  test('a viewport narrower than the panel clamps to the left margin', () => {
    const placed = placeSessionActionsMenu(
      { top: 40, bottom: 58, left: 150 },
      { width: 200, height: 800 },
      HEIGHT,
    )
    expect(placed.left).toBe(8)
  })

  test('the right-click path (a zero-height pointer) is clamped and flipped too', () => {
    // Before P4-39 these coordinates were applied raw at the sidebar and the
    // Sessions page: no clamp of any kind, in either axis.
    const nearBottomRight = placeSessionActionsMenu(
      { top: 790, bottom: 790, left: 1270 },
      viewport,
      HEIGHT,
    )
    expect(nearBottomRight).toEqual({ placeAbove: true, bottom: 14, left: 1040 })
    const nearTop = placeSessionActionsMenu(
      { top: 120, bottom: 120, left: 60 },
      viewport,
      HEIGHT,
    )
    expect(nearTop).toEqual({ placeAbove: false, top: 124, left: 60 })
  })

  test('a panel taller than the whole viewport picks the roomier side, not always above', () => {
    const placed = placeSessionActionsMenu(
      { top: 10, bottom: 28, left: 0 },
      viewport,
      900,
    )
    expect(placed.placeAbove).toBe(false)
  })
})

describe('P4-39 — estimateSessionActionsMenuHeight', () => {
  test('the real menu lands in the range the audit measured by eye (~300px)', () => {
    const height = estimateSessionActionsMenuHeight(
      resolveSessionActions(row(), { isActiveOpen: true }),
    )
    expect(height).toBeGreaterThan(240)
    expect(height).toBeLessThan(320)
  })

  test('it tracks the rows actually rendered, so a short menu does not flip early', () => {
    const [first] = resolveSessionActions(row(), { isActiveOpen: true })
    // One unlabelled section, one row: panel chrome + one row, no divider.
    expect(estimateSessionActionsMenuHeight([first!])).toBe(44)
    expect(
      estimateSessionActionsMenuHeight(
        resolveSessionActions(row(), { isActiveOpen: true }),
      ),
    ).toBeGreaterThan(estimateSessionActionsMenuHeight([first!]))
  })
})

describe('selectSessionsPageActions (P4-35 — the Sessions-page entry point)', () => {
  test('hides ONLY metadata, as the prototype does', () => {
    const all = resolveSessionActions(row(), { isActiveOpen: true })
    const page = selectSessionsPageActions(all)
    expect(page.map(item => item.kind)).not.toContain('metadata')
    expect(page).toHaveLength(all.length - 1)
    // Order is otherwise untouched, so this page's menu reads like the others.
    expect(page.map(item => item.kind)).toEqual(
      all.map(item => item.kind).filter(kind => kind !== 'metadata'),
    )
  })

  test('Branch and Export SURVIVE the filter for a live row', () => {
    // The two rows P4-29 deferred: the Sessions page reaches P4-30's dialogs by
    // reaching the shared menu's branch/export verbs, with no second menu and no
    // second dialog layer. If this filter ever swallowed them the page would
    // silently lose both dialogs again.
    const page = byKind(selectSessionsPageActions(resolveSessionActions(row(), { isActiveOpen: true })))
    expect(page.get('branch')!.enabled).toBe(true)
    expect(page.get('export')!.enabled).toBe(true)
  })

  test('a closed row still offers both, disabled with the actionable reason', () => {
    const page = byKind(
      selectSessionsPageActions(
        resolveSessionActions(row({ live: false, status: 'exited', restorable: true }), {
          isActiveOpen: false,
        }),
      ),
    )
    for (const kind of ['branch', 'export'] as const) {
      expect(page.get(kind)!.enabled).toBe(false)
      expect(page.get(kind)!.reason).toContain('Open or restore this session first.')
    }
  })

  test('an empty menu filters to an empty menu, never a throw', () => {
    expect(selectSessionsPageActions([])).toEqual([])
  })
})
