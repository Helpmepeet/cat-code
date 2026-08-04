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
 * Engine theme key → the prototype's legend hue, matched CATEGORY BY CATEGORY
 * against its fixture (`data.js:3316-3322`), which is the one place the
 * prototype states a colour per context category:
 *
 *   System prompt #a1a1aa · Tool definitions #60a5fa · Messages #f472b6 ·
 *   Memory #c084fc · MCP tools #22d3ee · Agents #5eead4 · Skills #fbbf24
 *
 * These are CATEGORY IDENTITY colours, not status or brand tones, which is why
 * they are fixed hexes rather than `--tone-*` / `--accent` tokens: they must not
 * repaint when the operator switches accent, and three of them (purple, cyan,
 * teal) have no token at all. Static arbitrary classes are the sanctioned form
 * here — only INTERPOLATED ones silently no-op under Tailwind v4.
 *
 * Reading a status token instead is what made `Messages` render alarm-red on
 * first draft, for a category that is simply the conversation.
 *
 * Unknown keys fall back to a neutral swatch rather than dropping the row: a
 * category the engine adds later must still be visible and still counted.
 */
const CATEGORY_SWATCH: Record<string, string> = {
  promptBorder: 'bg-[#a1a1aa]', // System prompt
  inactive: 'bg-[#60a5fa]', // System tools (the prototype's "Tool definitions")
  purple_FOR_SUBAGENTS_ONLY: 'bg-[#f472b6]', // Messages
  claude: 'bg-[#c084fc]', // Memory files
  cyan_FOR_SUBAGENTS_ONLY: 'bg-[#22d3ee]', // MCP tools
  permission: 'bg-[#5eead4]', // Custom agents
  warning: 'bg-[#fbbf24]', // Skills
}

const FALLBACK_SWATCH = 'bg-white/25'

/**
 * Below this share of the reported usage, the breakdown is treated as FAILED and
 * rendered as nothing at all.
 *
 * The engine drops any category whose token count came back empty, so when its
 * counters are unavailable the analysis does not error — it returns a technically
 * valid snapshot that accounts for almost none of the context. That shipped as a
 * panel reading `Skills 2.6k` and `Free 318k` under a header of `71% · 262k`,
 * three mutually contradictory numbers. Showing nothing is the honest degrade.
 *
 * Deliberately loose: an estimate legitimately disagrees with the API-derived
 * header by a wide margin, and a partial breakdown is still useful. This catches
 * collapse, not imprecision.
 */
const MIN_ACCOUNTED_SHARE = 0.5

/**
 * Whether the analysis accounted for enough of the reported usage to be worth
 * showing. `usedTokens` is the engine's own headline for the same analysis, so
 * the comparison is internal to the snapshot.
 */
export function isBreakdownTrustworthy(
  snapshot: ContextBreakdownSnapshot | null,
): boolean {
  if (!snapshot || snapshot.contextWindow <= 0) return false
  const accounted = snapshot.categories
    .filter(category => !category.deferred)
    .reduce((sum, category) => sum + category.tokens, 0)
  if (accounted <= 0) return false
  if (snapshot.usedTokens <= 0) return true
  return accounted >= snapshot.usedTokens * MIN_ACCOUNTED_SHARE
}

/**
 * Legend rows for a snapshot, in the engine's own order. Empty when the analysis
 * collapsed ({@link isBreakdownTrustworthy}).
 *
 * Deferred categories are DROPPED, not dimmed: they do not occupy the window
 * (`analyzeContext.ts:1075-1092`), so a bar segment or a legend row for them
 * would claim space the session does not actually use.
 */
export function selectBreakdownRows(
  snapshot: ContextBreakdownSnapshot | null,
): ContextBreakdownRow[] {
  if (!snapshot || !isBreakdownTrustworthy(snapshot)) return []
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

/**
 * Unoccupied window (`Free`, `Surfaces.jsx:532-535`).
 *
 * The engine's own remainder, passed through — NOT `contextWindow - usedTokens`,
 * which is a different number: `usedTokens` is the API's fresh-input count when
 * one exists, while the bar segments are the category estimates. Subtracting
 * would print a `Free` that fails to reconcile with the bar directly above it.
 */
export function selectFreeTokens(
  snapshot: ContextBreakdownSnapshot | null,
): number | null {
  if (!snapshot || snapshot.freeTokens == null) return null
  // A collapsed analysis reports a `Free` that contradicts the header; suppress
  // it with the rows it belongs to.
  if (!isBreakdownTrustworthy(snapshot)) return null
  return Math.max(0, snapshot.freeTokens)
}
