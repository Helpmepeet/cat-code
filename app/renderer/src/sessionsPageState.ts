/**
 * P4-29 — the Sessions-page ACTION state (`SessionsPage.jsx`): multi-select,
 * inline rename, the tag popover, and the row overflow/context menu anchor.
 *
 * House idiom (`agentConfigState.ts`): `create…` / `reduce…` / `select…`, with a
 * pure reducer and read-time selectors. Nothing here stores a catalog row — the
 * rows arrive from `selectMergedSessionRows` and are never mutated; everything
 * derived (which rows are selected, what tag a row shows, where a popover goes)
 * is computed at read time from ids + the live row list.
 *
 * Two things this module deliberately does NOT do:
 *
 *  - **No tag store.** The prototype keeps a `tagOverrides` map and calls that a
 *    tag model. The real tag is an engine write (`session.tag` → `saveTag`), read
 *    back off the sessions catalog. The only local state is `confirmedTags`: a tag
 *    the sidecar ALREADY acknowledged `ok`, held so the row does not visibly
 *    revert for the up-to-one catalog refresh interval it takes the write to be
 *    re-enumerated. It is seeded only from a real result and dropped the moment
 *    the catalog agrees, so it can never invent a tag that was not written.
 *  - **No renderer-side title store.** Rename commits through the existing
 *    `session.rename` verb; the live relabel rides `session-title` → the registry.
 */

import type { SessionId } from '../../shared/protocol.js'
import type { MergedSessionRow } from './sessionsCatalogState.js'

/** A viewport point, in CSS pixels, that an overlay is anchored to. */
export type SessionsPageAnchor = { top: number; left: number }

/**
 * The open tag popover. `target` is a row's catalog `sessionId`, or `'bulk'` for
 * the selection form. `rect` carries the trigger's measured edges so placement
 * can flip above/below exactly as the prototype does.
 */
export type TagPopoverTarget = { kind: 'row'; sessionId: string } | { kind: 'bulk' }

export type TagPopoverState = {
  target: TagPopoverTarget
  /** Trigger geometry: `top` = its bottom edge, `bottom` = its top edge. */
  rect: { top: number; bottom: number; left: number }
}

export type SessionsPageState = {
  /** Catalog `sessionId`s the user has ticked. */
  selected: readonly string[]
  /** The row being renamed inline, or null. */
  renaming: { sessionId: string; value: string } | null
  tagPopover: TagPopoverState | null
  /** Tags the sidecar confirmed, pending the next catalog refresh. */
  confirmedTags: Readonly<Record<string, string | null>>
}

export type SessionsPageAction =
  | { type: 'toggle-selected'; sessionId: string }
  | { type: 'select-all'; sessionIds: readonly string[] }
  | { type: 'clear-selection' }
  | { type: 'start-rename'; sessionId: string; initial: string }
  | { type: 'edit-rename'; value: string }
  | { type: 'end-rename' }
  | { type: 'open-tag-popover'; target: TagPopoverTarget; rect: TagPopoverState['rect'] }
  | { type: 'close-tag-popover' }
  | { type: 'tag-confirmed'; sessionIds: readonly string[]; tag: string | null }
  | {
      type: 'catalog-settled'
      rows: readonly MergedSessionRow[]
      /** The prior catalog snapshot, used only to migrate a fresh row's id after ready. */
      previousRows: readonly MergedSessionRow[]
    }

export function createSessionsPageState(): SessionsPageState {
  return {
    selected: [],
    renaming: null,
    tagPopover: null,
    confirmedTags: {},
  }
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function tagRecordsEqual(
  left: Readonly<Record<string, string | null>>,
  right: Readonly<Record<string, string | null>>,
): boolean {
  const leftEntries = Object.entries(left)
  return (
    leftEntries.length === Object.keys(right).length &&
    leftEntries.every(([key, value]) => right[key] === value)
  )
}

export function reduceSessionsPageState(
  state: SessionsPageState,
  action: SessionsPageAction,
): SessionsPageState {
  switch (action.type) {
    case 'toggle-selected': {
      const has = state.selected.includes(action.sessionId)
      return {
        ...state,
        selected: has
          ? state.selected.filter(id => id !== action.sessionId)
          : [...state.selected, action.sessionId],
      }
    }
    case 'select-all': {
      // The prototype's one button is a toggle: all-visible-selected flips to none.
      const allSelected =
        action.sessionIds.length > 0 &&
        action.sessionIds.every(id => state.selected.includes(id))
      return { ...state, selected: allSelected ? [] : [...action.sessionIds] }
    }
    case 'clear-selection':
      return { ...state, selected: [] }
    case 'start-rename':
      return {
        ...state,
        renaming: { sessionId: action.sessionId, value: action.initial },
      }
    case 'edit-rename':
      if (!state.renaming) return state
      return { ...state, renaming: { ...state.renaming, value: action.value } }
    case 'end-rename':
      return { ...state, renaming: null }
    case 'open-tag-popover':
      return { ...state, tagPopover: { target: action.target, rect: action.rect } }
    case 'close-tag-popover':
      return { ...state, tagPopover: null }
    case 'tag-confirmed': {
      const confirmedTags = { ...state.confirmedTags }
      for (const sessionId of action.sessionIds) confirmedTags[sessionId] = action.tag
      return { ...state, confirmedTags }
    }
    case 'catalog-settled': {
      // Drop each echo the catalog has caught up with, so the rows become the only
      // source again. Also drop selections/rename/popover targets whose row is gone.
      const byId = new Map(action.rows.map(row => [row.sessionId, row]))
      // A newly-created app session initially has no engine id, so its catalog key
      // is its app id. `ready` fills the engine id and flips the catalog key. The
      // page state is keyed by that catalog id, so migrate every ephemeral key
      // through the stable app id before pruning the old key as absent.
      const currentByAppId = new Map(
        action.rows.flatMap(row => (row.appSessionId ? [[row.appSessionId, row] as const] : [])),
      )
      const replacementById = new Map<string, string>()
      for (const previous of action.previousRows) {
        if (!previous.appSessionId) continue
        const current = currentByAppId.get(previous.appSessionId)
        if (current && current.sessionId !== previous.sessionId) {
          replacementById.set(previous.sessionId, current.sessionId)
        }
      }
      const migrateId = (sessionId: string) => replacementById.get(sessionId) ?? sessionId
      const migratedTags = Object.fromEntries(
        Object.entries(state.confirmedTags)
          .map(([sessionId, tag]) => [migrateId(sessionId), tag] as const)
          .filter(([sessionId]) => byId.has(sessionId)),
      ) as Readonly<Record<string, string | null>>
      const settled = Object.entries(migratedTags).filter(
        ([sessionId, tag]) => {
          const row = byId.get(sessionId)
          return row === undefined || (row.tag ?? null) === tag
        },
      )
      const nextConfirmedTags: Readonly<Record<string, string | null>> =
        settled.length === 0
          ? migratedTags
          : Object.fromEntries(
              Object.entries(migratedTags).filter(
                ([sessionId]) => !settled.some(([id]) => id === sessionId),
              ),
            )
      const confirmedTags = tagRecordsEqual(state.confirmedTags, nextConfirmedTags)
        ? state.confirmedTags
        : nextConfirmedTags
      const nextSelected = [...new Set(state.selected.map(migrateId).filter(id => byId.has(id)))]
      const selected = stringArraysEqual(state.selected, nextSelected) ? state.selected : nextSelected
      const nextRenaming =
        state.renaming && byId.has(migrateId(state.renaming.sessionId))
          ? { ...state.renaming, sessionId: migrateId(state.renaming.sessionId) }
          : null
      const renaming =
        nextRenaming &&
        state.renaming &&
        nextRenaming.sessionId === state.renaming.sessionId &&
        nextRenaming.value === state.renaming.value
          ? state.renaming
          : nextRenaming
      const tagPopover =
        state.tagPopover &&
        (state.tagPopover.target.kind === 'bulk' ||
          byId.has(migrateId(state.tagPopover.target.sessionId)))
          ? state.tagPopover.target.kind === 'bulk'
            ? state.tagPopover
            : migrateId(state.tagPopover.target.sessionId) === state.tagPopover.target.sessionId
              ? state.tagPopover
            : {
                ...state.tagPopover,
                target: {
                  ...state.tagPopover.target,
                  sessionId: migrateId(state.tagPopover.target.sessionId),
                },
              }
          : null
      if (
        confirmedTags === state.confirmedTags &&
        selected.length === state.selected.length &&
        renaming === state.renaming &&
        tagPopover === state.tagPopover
      ) {
        return state
      }
      return { ...state, confirmedTags, selected, renaming, tagPopover }
    }
    default:
      return state
  }
}

/* ------------------------------------------------------------------------- *
 * Read-time selectors
 * ------------------------------------------------------------------------- */

/** The tag to RENDER for a row: a confirmed write, else the catalog's own value. */
export function selectRowTag(
  state: SessionsPageState,
  row: Pick<MergedSessionRow, 'sessionId' | 'tag'>,
): string | null {
  if (Object.prototype.hasOwnProperty.call(state.confirmedTags, row.sessionId)) {
    return state.confirmedTags[row.sessionId] ?? null
  }
  return row.tag
}

export function selectIsSelected(state: SessionsPageState, sessionId: string): boolean {
  return state.selected.includes(sessionId)
}

/** True when every currently-visible row is ticked (drives the toggle's label). */
export function selectAllVisibleSelected(
  state: SessionsPageState,
  visibleIds: readonly string[],
): boolean {
  return visibleIds.length > 0 && visibleIds.every(id => state.selected.includes(id))
}

/**
 * The rows a bulk write can actually target. Rename / Export / Tag all
 * run inside a session's OWN live engine (`sessionActions.ts`), so a selection
 * that includes closed sessions writes only to the live part of it. Returning the
 * ids lets the bar say what will happen instead of silently doing less.
 *
 * `row.live` alone is the host row's view, not the transport's: a row can stay
 * `live` after its supervisor record has gone `disconnected`
 * (`sessionsCatalogState.ts` `live`), which sending into just returns an
 * undeliverable result. `hasEngine` is the frame-plane check
 * (`connectionHasEngine`, `connectionState.ts`) that the ⋯ menu already applies
 * to these same verbs (`resolveSessionActions`, `sessionActions.ts`). Omitted
 * only by static/test callers that deliberately exercise the row-only contract.
 */
export function isWritableSessionRow(
  row: MergedSessionRow,
  hasEngine?: (appSessionId: SessionId) => boolean,
): row is MergedSessionRow & { appSessionId: SessionId } {
  return (
    row.live &&
    row.appSessionId != null &&
    (hasEngine === undefined || hasEngine(row.appSessionId))
  )
}

/** The live catalog rows that can receive a session-action verb. */
export function selectWritableRows(
  rows: readonly MergedSessionRow[],
  hasEngine?: (appSessionId: SessionId) => boolean,
): Array<MergedSessionRow & { appSessionId: SessionId }> {
  return rows.filter(row => isWritableSessionRow(row, hasEngine))
}

export function selectWritableSelection(
  state: SessionsPageState,
  rows: readonly MergedSessionRow[],
  hasEngine?: (appSessionId: SessionId) => boolean,
): SessionId[] {
  const writable: SessionId[] = []
  for (const row of rows) {
    if (!state.selected.includes(row.sessionId)) continue
    if (isWritableSessionRow(row, hasEngine)) writable.push(row.appSessionId)
  }
  return writable
}

/** The distinct tags to offer in the popover: the catalog's, plus confirmed ones. */
export function selectKnownTags(
  state: SessionsPageState,
  rows: readonly MergedSessionRow[],
): string[] {
  const tags = new Set<string>()
  for (const row of rows) {
    const tag = selectRowTag(state, row)
    if (tag && tag.trim().length > 0) tags.add(tag)
  }
  return [...tags].sort((a, b) => a.localeCompare(b))
}

/* ------------------------------------------------------------------------- *
 * Pure geometry — the two pieces of the prototype a row summary cannot convey
 * ------------------------------------------------------------------------- */

/** Popover box width, matching the prototype panel (`SessionsPage.jsx:391`). */
export const TAG_POPOVER_WIDTH = 216
/** Gap between the trigger edge and the panel (`SessionsPage.jsx:386-387`). */
export const TAG_POPOVER_GAP = 6
/** Minimum distance from the viewport's left edge (`SessionsPage.jsx:384`). */
export const TAG_POPOVER_VIEWPORT_MARGIN = 12

export type TagPopoverPlacement =
  | { placeAbove: true; bottom: number; left: number }
  | { placeAbove: false; top: number; left: number }

/**
 * Place the tag popover exactly as the prototype does (`SessionsPage.jsx:383-387`):
 * flip ABOVE the trigger once its top edge is past the vertical midpoint (so a row
 * near the fold opens upward instead of off-screen), and clamp the left edge into
 * the viewport. Pure, so the placement is testable without a DOM.
 */
export function placeTagPopover(
  rect: TagPopoverState['rect'],
  viewport: { width: number; height: number },
): TagPopoverPlacement {
  const left = Math.max(
    TAG_POPOVER_VIEWPORT_MARGIN,
    Math.min(rect.left, viewport.width - TAG_POPOVER_WIDTH - TAG_POPOVER_VIEWPORT_MARGIN),
  )
  if (rect.bottom > viewport.height / 2) {
    return {
      placeAbove: true,
      bottom: viewport.height - rect.bottom + TAG_POPOVER_GAP,
      left,
    }
  }
  return { placeAbove: false, top: rect.top + TAG_POPOVER_GAP, left }
}

/**
 * What Enter resolves to in the tag filter/create input
 * (`SessionsPage.jsx:397`): an exact match wins, then create-if-novel, then the
 * first remaining match; an empty query does nothing.
 */
export function resolveTagCommit(
  query: string,
  knownTags: readonly string[],
): string | null {
  const normalized = query.trim().toLowerCase()
  if (normalized.length === 0) return null
  const exact = knownTags.find(tag => tag.toLowerCase() === normalized)
  if (exact) return exact
  return normalized
}

/** The tags matching the popover's filter query (substring, case-insensitive). */
export function selectMatchingTags(
  query: string,
  knownTags: readonly string[],
): string[] {
  const normalized = query.trim().toLowerCase()
  return knownTags.filter(tag => tag.toLowerCase().includes(normalized))
}

/** True when the query names a tag that does not exist yet ("Create #tag"). */
export function selectCanCreateTag(
  query: string,
  knownTags: readonly string[],
): boolean {
  const normalized = query.trim().toLowerCase()
  if (normalized.length === 0) return false
  return !knownTags.some(tag => tag.toLowerCase() === normalized)
}
