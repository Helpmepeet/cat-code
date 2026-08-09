import { describe, expect, test } from 'bun:test'
import type { MergedSessionRow } from './sessionsCatalogState.js'
import {
  createSessionsPageState,
  placeTagPopover,
  reduceSessionsPageState,
  resolveTagCommit,
  selectAllVisibleSelected,
  selectCanCreateTag,
  selectKnownTags,
  selectMatchingTags,
  selectRowTag,
  selectWritableRows,
  selectWritableSelection,
  TAG_POPOVER_GAP,
  TAG_POPOVER_VIEWPORT_MARGIN,
  TAG_POPOVER_WIDTH,
  type SessionsPageAction,
  type SessionsPageState,
} from './sessionsPageState.js'

function row(
  partial: Partial<MergedSessionRow> & { sessionId: string },
): MergedSessionRow {
  return {
    appSessionId: null,
    cwd: '/w/proj',
    cwdExists: true,
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
    gitBranch: null,
    tag: null,
    mode: null,
    agentSetting: null,
    prNumber: null,
    prRepository: null,
    ...partial,
  }
}

function apply(
  actions: SessionsPageAction[],
  initial: SessionsPageState = createSessionsPageState(),
): SessionsPageState {
  return actions.reduce(reduceSessionsPageState, initial)
}

describe('selection', () => {
  test('toggling adds then removes an id, and clear empties it', () => {
    const selected = apply([
      { type: 'toggle-selected', sessionId: 'a' },
      { type: 'toggle-selected', sessionId: 'b' },
    ])
    expect(selected.selected).toEqual(['a', 'b'])

    const one = reduceSessionsPageState(selected, {
      type: 'toggle-selected',
      sessionId: 'a',
    })
    expect(one.selected).toEqual(['b'])
    expect(
      reduceSessionsPageState(one, { type: 'clear-selection' }).selected,
    ).toEqual([])
  })

  test('select-all is a toggle: it selects the visible rows, then deselects them', () => {
    const all = apply([{ type: 'select-all', sessionIds: ['a', 'b', 'c'] }])
    expect(all.selected).toEqual(['a', 'b', 'c'])
    expect(selectAllVisibleSelected(all, ['a', 'b', 'c'])).toBe(true)

    const none = reduceSessionsPageState(all, {
      type: 'select-all',
      sessionIds: ['a', 'b', 'c'],
    })
    expect(none.selected).toEqual([])
    expect(selectAllVisibleSelected(none, ['a', 'b', 'c'])).toBe(false)
  })

  test('a partial selection is not "all selected", so the button still offers select-all', () => {
    const partial = apply([{ type: 'toggle-selected', sessionId: 'a' }])
    expect(selectAllVisibleSelected(partial, ['a', 'b'])).toBe(false)
  })

  test('only LIVE selected rows are writable — a closed row cannot receive a verb', () => {
    const rows = [
      row({ sessionId: 'live', appSessionId: 'app-live', live: true, inRegistry: true }),
      row({ sessionId: 'closed', appSessionId: 'app-closed', inRegistry: true }),
      row({ sessionId: 'history' }),
    ]
    const state = apply([
      { type: 'toggle-selected', sessionId: 'live' },
      { type: 'toggle-selected', sessionId: 'closed' },
      { type: 'toggle-selected', sessionId: 'history' },
    ])
    expect(selectWritableRows(rows).map(row => row.appSessionId)).toEqual(['app-live'])
    expect(selectWritableSelection(state, rows)).toEqual(['app-live'])
  })
})

describe('rename', () => {
  test('start / edit / end round-trips the draft without touching any row', () => {
    const editing = apply([
      { type: 'start-rename', sessionId: 'a', initial: 'Old name' },
      { type: 'edit-rename', value: 'New name' },
    ])
    expect(editing.renaming).toEqual({ sessionId: 'a', value: 'New name' })
    expect(reduceSessionsPageState(editing, { type: 'end-rename' }).renaming).toBeNull()
  })

  test('editing with no rename in flight is ignored', () => {
    const state = createSessionsPageState()
    expect(reduceSessionsPageState(state, { type: 'edit-rename', value: 'x' })).toBe(
      state,
    )
  })
})

describe('tags', () => {
  test('a row renders the catalog tag until a confirmed write replaces it', () => {
    const tagged = row({ sessionId: 'a', tag: 'infra' })
    const base = createSessionsPageState()
    expect(selectRowTag(base, tagged)).toBe('infra')

    const confirmed = apply([
      { type: 'tag-confirmed', sessionIds: ['a'], tag: 'ui' },
    ])
    expect(selectRowTag(confirmed, tagged)).toBe('ui')
  })

  test('a confirmed REMOVAL renders as no tag, not as the stale catalog value', () => {
    const confirmed = apply([{ type: 'tag-confirmed', sessionIds: ['a'], tag: null }])
    expect(selectRowTag(confirmed, row({ sessionId: 'a', tag: 'infra' }))).toBeNull()
  })

  test('the echo is dropped once the catalog agrees, so rows become the only source', () => {
    const confirmed = apply([{ type: 'tag-confirmed', sessionIds: ['a'], tag: 'ui' }])
    const settled = reduceSessionsPageState(confirmed, {
      type: 'catalog-settled',
      rows: [row({ sessionId: 'a', tag: 'ui' })],
      previousRows: [row({ sessionId: 'a', tag: 'infra' })],
    })
    expect(settled.confirmedTags).toEqual({})
  })

  test('the echo SURVIVES a catalog that has not caught up yet', () => {
    const confirmed = apply([{ type: 'tag-confirmed', sessionIds: ['a'], tag: 'ui' }])
    const settled = reduceSessionsPageState(confirmed, {
      type: 'catalog-settled',
      rows: [row({ sessionId: 'a', tag: 'infra' })],
      previousRows: [row({ sessionId: 'a', tag: 'infra' })],
    })
    expect(selectRowTag(settled, row({ sessionId: 'a', tag: 'infra' }))).toBe('ui')
  })

  test('catalog-settled forgets a selection whose row disappeared', () => {
    const state = apply([
      { type: 'toggle-selected', sessionId: 'a' },
      { type: 'toggle-selected', sessionId: 'gone' },
    ])
    const settled = reduceSessionsPageState(state, {
      type: 'catalog-settled',
      rows: [row({ sessionId: 'a' })],
      previousRows: [row({ sessionId: 'a' })],
    })
    expect(settled.selected).toEqual(['a'])
  })

  test('catalog-settled migrates page state when ready replaces a fresh row app id with its engine id', () => {
    const provisional = row({
      sessionId: 'app-1',
      appSessionId: 'app-1',
      live: true,
      inRegistry: true,
      status: 'spawning',
      tag: 'infra',
    })
    const ready = row({
      ...provisional,
      sessionId: 'engine-1',
      status: 'ready',
    })
    const state = apply([
      { type: 'toggle-selected', sessionId: 'app-1' },
      { type: 'start-rename', sessionId: 'app-1', initial: 'Old title' },
      { type: 'edit-rename', value: 'Draft title' },
      { type: 'tag-confirmed', sessionIds: ['app-1'], tag: 'ui' },
      {
        type: 'open-tag-popover',
        target: { kind: 'row', sessionId: 'app-1' },
        rect: { top: 20, bottom: 10, left: 5 },
      },
    ])

    const settled = reduceSessionsPageState(state, {
      type: 'catalog-settled',
      rows: [ready],
      previousRows: [provisional],
    })

    expect(settled.selected).toEqual(['engine-1'])
    expect(settled.renaming).toEqual({ sessionId: 'engine-1', value: 'Draft title' })
    expect(selectRowTag(settled, ready)).toBe('ui')
    expect(settled.tagPopover?.target).toEqual({ kind: 'row', sessionId: 'engine-1' })
  })

  // A bulk tag settles one result per row, so several confirmations arrive in a
  // single pass. Each must land: the earlier shape kept only the last, leaving
  // the other rows blank until the next catalog refresh.
  test('several confirmations in one pass ALL apply, including different tags', () => {
    const state = apply([
      { type: 'tag-confirmed', sessionIds: ['a'], tag: 'ui' },
      { type: 'tag-confirmed', sessionIds: ['b'], tag: 'ui' },
      { type: 'tag-confirmed', sessionIds: ['c'], tag: 'infra' },
    ])
    expect(selectRowTag(state, row({ sessionId: 'a' }))).toBe('ui')
    expect(selectRowTag(state, row({ sessionId: 'b' }))).toBe('ui')
    expect(selectRowTag(state, row({ sessionId: 'c' }))).toBe('infra')
  })

  test('known tags include confirmed writes the catalog has not published yet', () => {
    const rows = [row({ sessionId: 'a', tag: 'infra' }), row({ sessionId: 'b' })]
    const confirmed = apply([{ type: 'tag-confirmed', sessionIds: ['b'], tag: 'ui' }])
    expect(selectKnownTags(confirmed, rows)).toEqual(['infra', 'ui'])
  })
})

describe('tag popover behaviour', () => {
  const known = ['infra', 'ui', 'uikit']

  test('filtering matches on substring, case-insensitively', () => {
    expect(selectMatchingTags('UI', known)).toEqual(['ui', 'uikit'])
    expect(selectMatchingTags('', known)).toEqual(known)
    expect(selectMatchingTags('zzz', known)).toEqual([])
  })

  test('"Create #tag" appears only for a novel, non-empty query', () => {
    expect(selectCanCreateTag('ui', known)).toBe(false)
    expect(selectCanCreateTag('UI', known)).toBe(false)
    expect(selectCanCreateTag('release', known)).toBe(true)
    expect(selectCanCreateTag('   ', known)).toBe(false)
  })

  test('Enter prefers an exact match, else creates, and does nothing when empty', () => {
    expect(resolveTagCommit('UI', known)).toBe('ui')
    expect(resolveTagCommit(' release ', known)).toBe('release')
    expect(resolveTagCommit('  ', known)).toBeNull()
  })
})

describe('tag popover placement', () => {
  const viewport = { width: 1000, height: 800 }

  test('a trigger in the TOP half opens downward from its bottom edge', () => {
    const placed = placeTagPopover({ top: 300, bottom: 280, left: 120 }, viewport)
    expect(placed).toEqual({
      placeAbove: false,
      top: 300 + TAG_POPOVER_GAP,
      left: 120,
    })
  })

  test('a trigger past the fold FLIPS above, measured from the viewport bottom', () => {
    const placed = placeTagPopover({ top: 720, bottom: 700, left: 120 }, viewport)
    expect(placed).toEqual({
      placeAbove: true,
      bottom: viewport.height - 700 + TAG_POPOVER_GAP,
      left: 120,
    })
  })

  test('a trigger near the right edge is clamped so the panel stays on screen', () => {
    const placed = placeTagPopover({ top: 100, bottom: 80, left: 980 }, viewport)
    expect(placed.left).toBe(
      viewport.width - TAG_POPOVER_WIDTH - TAG_POPOVER_VIEWPORT_MARGIN,
    )
    expect(placed.left + TAG_POPOVER_WIDTH).toBeLessThanOrEqual(viewport.width)
  })

  test('a trigger off the left edge is clamped to the viewport margin', () => {
    expect(placeTagPopover({ top: 100, bottom: 80, left: -40 }, viewport).left).toBe(
      TAG_POPOVER_VIEWPORT_MARGIN,
    )
  })
})
