/**
 * Context-breakdown domain state — the renderer half of the
 * `context-breakdown.snapshot` read seam, following `runControlsState.ts` (the
 * recipe this copies): a reducer over the read-only frame plus a read-time
 * selector, kept OUT of `transcriptProjector.ts`.
 *
 * The seam is live but coarse: the sidecar re-broadcasts once per turn boundary,
 * because that is the only moment per-category occupancy can move. Between turns
 * the popover reads the last snapshot rather than an estimate.
 */

import type {
  ContextBreakdownSnapshot,
  ServerFrame,
  SessionId,
} from '../../shared/protocol.js'

export type ContextBreakdownState = {
  /** Latest snapshot per session; null once reset by a lifecycle frame. */
  sessions: Record<SessionId, ContextBreakdownSnapshot | null>
}

export type ContextBreakdownAction = { type: 'frame'; frame: ServerFrame }

export function createContextBreakdownState(): ContextBreakdownState {
  return { sessions: {} }
}

export function reduceContextBreakdownState(
  state: ContextBreakdownState,
  action: ContextBreakdownAction,
): ContextBreakdownState {
  const { frame } = action

  if (frame.kind === 'context-breakdown.snapshot') {
    return {
      ...state,
      sessions: { ...state.sessions, [frame.sessionId]: frame.breakdown },
    }
  }

  // A process/transport reset drops the stale snapshot; a fresh one arrives on
  // re-attach. Untracked sessions are left alone (mirrors runControlsState).
  if (frame.kind === 'lifecycle') {
    if (!(frame.sessionId in state.sessions)) return state
    return {
      ...state,
      sessions: { ...state.sessions, [frame.sessionId]: null },
    }
  }

  return state
}

/** The latest breakdown for a session (null before the first frame). */
export function selectContextBreakdown(
  state: ContextBreakdownState,
  sessionId: SessionId | null,
): ContextBreakdownSnapshot | null {
  const snapshot = sessionId ? state.sessions[sessionId] : undefined
  return snapshot ?? null
}

/**
 * One legend row, ready to paint: the engine's label and token count plus the
 * static Tailwind classes for its swatch and bar segment.
 *
 * Tailwind v4 dynamic-class trap: the engine ships a terminal theme key
 * (`promptBorder`, `cyan_FOR_SUBAGENTS_ONLY`, …) which has no meaning in the
 * DOM, so it is mapped to LITERAL class strings here. Interpolating
 * `bg-[${hex}]` would silently emit nothing.
 */
export type ContextBreakdownRow = {
  label: string
  tokens: number
  /** Static `bg-*` class for the swatch + its stacked-bar segment. */
  swatch: string
  /** Share of the window, 0–100, for the segment's width. */
  percentOfWindow: number
}

/**
 * Engine theme key → the prototype's legend hue (`Surfaces.jsx:517-531` paints
 * one colour per category). Unknown keys fall back to a neutral swatch rather
 * than dropping the row: a category the engine adds later must still be visible
 * and still counted, just uncoloured.
 */
const CATEGORY_SWATCH: Record<string, string> = {
  promptBorder: 'bg-tone-info',
  inactive: 'bg-white/25',
  cyan_FOR_SUBAGENTS_ONLY: 'bg-tone-good',
  permission: 'bg-accent-soft',
  claude: 'bg-accent',
  warning: 'bg-tone-warn',
  purple_FOR_SUBAGENTS_ONLY: 'bg-tone-danger',
}

const FALLBACK_SWATCH = 'bg-white/25'

/**
 * Legend rows for a snapshot, in the engine's own order.
 *
 * Deferred categories are DROPPED, not dimmed: they do not occupy the window
 * (`analyzeContext.ts:1075-1092`), so a bar segment or a legend row for them
 * would claim space the session does not actually use.
 */
export function selectBreakdownRows(
  snapshot: ContextBreakdownSnapshot | null,
): ContextBreakdownRow[] {
  if (!snapshot || snapshot.contextWindow <= 0) return []
  return snapshot.categories
    .filter(category => !category.deferred && category.tokens > 0)
    .map(category => ({
      label: category.label,
      tokens: category.tokens,
      swatch: CATEGORY_SWATCH[category.colorKey] ?? FALLBACK_SWATCH,
      percentOfWindow: Math.min(
        100,
        (category.tokens / snapshot.contextWindow) * 100,
      ),
    }))
}

/** Unoccupied window (`Free`, `Surfaces.jsx:532-535`), never negative. */
export function selectFreeTokens(
  snapshot: ContextBreakdownSnapshot | null,
): number | null {
  if (!snapshot) return null
  return Math.max(0, snapshot.contextWindow - snapshot.usedTokens)
}
