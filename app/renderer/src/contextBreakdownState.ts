/**
 * Context-breakdown domain state — the renderer half of the
 * `context-breakdown.snapshot` read seam, following `runControlsState.ts` (the
 * recipe this copies): a reducer over the read-only frame plus a read-time
 * selector, kept OUT of `transcriptProjector.ts`.
 *
 * The seam is coarse on purpose: the sidecar computes only when the popover
 * asks, not per turn or attach, because the analysis is expensive. Between those
 * requests the popover reads the last snapshot rather than an estimate.
 */

import type { ContextUsage } from './contextUsage.js'
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
  /** Same hue as `swatch`, as a raw value for the donut chart's SVG `stroke`
   * attribute (an SVG presentation attribute, not a Tailwind class, so it
   * carries no dynamic-class risk). */
  colorHex: string
  /** Same hue again as a static `text-*` class, for the donut's center readout
   * while this category is hovered. A class rather than an inline colour so the
   * center number is styled the same way every other label on the panel is. */
  textClass: string
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

/** The same hues as {@link CATEGORY_SWATCH}, as raw values for the donut
 * chart's SVG `stroke` (never derived from the class string — that would
 * mean parsing a Tailwind literal back apart, fragile for no reason when the
 * source hex is right here). */
const CATEGORY_COLOR_HEX: Record<string, string> = {
  promptBorder: '#a1a1aa',
  inactive: '#60a5fa',
  purple_FOR_SUBAGENTS_ONLY: '#f472b6',
  claude: '#c084fc',
  cyan_FOR_SUBAGENTS_ONLY: '#22d3ee',
  permission: '#5eead4',
  warning: '#fbbf24',
}

/** The same hues once more as static `text-*` classes (see `textClass`). Written
 * out rather than derived from {@link CATEGORY_SWATCH} for the same reason
 * {@link CATEGORY_COLOR_HEX} is: `bg-` → `text-` string surgery on a Tailwind
 * literal is fragile, and the source hex is right here. */
const CATEGORY_TEXT: Record<string, string> = {
  promptBorder: 'text-[light-dark(#52525b,#a1a1aa)]',
  inactive: 'text-[light-dark(#2563eb,#60a5fa)]',
  purple_FOR_SUBAGENTS_ONLY: 'text-[light-dark(#be185d,#f472b6)]',
  claude: 'text-[light-dark(#7c3aed,#c084fc)]',
  cyan_FOR_SUBAGENTS_ONLY: 'text-[light-dark(#0e7490,#22d3ee)]',
  permission: 'text-[light-dark(#0f766e,#5eead4)]',
  warning: 'text-[light-dark(#b45309,#fbbf24)]',
}

const FALLBACK_SWATCH = 'bg-white/25'
const FALLBACK_COLOR_HEX =
  'light-dark(rgba(9,9,11,0.28), rgba(255,255,255,0.25))'
const FALLBACK_TEXT = 'text-white/25'

/**
 * Categories that are RESERVED space rather than a content type. The engine reuses
 * the `inactive` colour key for both `System tools` and `Compact buffer`, so keying
 * on the colour alone painted two unrelated legend rows the same blue. Reserved
 * space gets the neutral swatch instead.
 */
const RESERVED_CATEGORY_LABELS = new Set(['Compact buffer'])

/**
 * Below this share of the reported usage, the breakdown is treated as FAILED and
 * rendered as nothing at all.
 *
 * This is a BACKSTOP, not the primary defence. The original collapse — every
 * API-counted category dropped, leaving a panel reading `Skills 2.6k` and
 * `Free 318k` under a header of `71% · 262k` — is fixed at the source: the engine
 * now falls back to a local estimate rather than returning nothing
 * (`countTokensForDisplay`, `src/utils/analyzeContext.ts`). What remains is the
 * possibility of a future counter failing in a way that empties categories again.
 *
 * The threshold is deliberately FAR below 1, because the two numbers have
 * different bases and are expected to disagree: `usedTokens` is the API's
 * fresh-input count (input + cache_creation, EXCLUDING cache reads,
 * `analyzeContext.ts` → `getFreshInputTokens`), while the categories may be local
 * estimates. An earlier 0.5 sat right where a Codex session legitimately lands,
 * so a correct breakdown flickered in and out depending on how JSON-heavy the
 * transcript was. Only a near-total collapse should suppress the panel.
 */
const MIN_ACCOUNTED_SHARE = 0.15

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
      swatch: RESERVED_CATEGORY_LABELS.has(category.label)
        ? FALLBACK_SWATCH
        : (CATEGORY_SWATCH[category.colorKey] ?? FALLBACK_SWATCH),
      colorHex: RESERVED_CATEGORY_LABELS.has(category.label)
        ? FALLBACK_COLOR_HEX
        : (CATEGORY_COLOR_HEX[category.colorKey] ?? FALLBACK_COLOR_HEX),
      textClass: RESERVED_CATEGORY_LABELS.has(category.label)
        ? FALLBACK_TEXT
        : (CATEGORY_TEXT[category.colorKey] ?? FALLBACK_TEXT),
      percentOfWindow: Math.min(
        100,
        (category.tokens / snapshot.contextWindow) * 100,
      ),
    }))
}

/**
 * The popover's own aggregate — the sum of the SAME rows the legend prints,
 * over the snapshot's OWN `contextWindow`. Never the composer's live `usage`
 * (refreshed on every message): the breakdown is a coarse, throttled snapshot
 * (attach + on popover-open, 15s floor — `sidecarServer.ts`
 * `CONTEXT_BREAKDOWN_MIN_INTERVAL_MS`), and its category tokens are local
 * estimates on top of that, so pairing it with the live number let the header
 * and the rows drift apart — a header reading "30k" over rows that summed to
 * well over that. `accounted + Free` equals the snapshot's own `contextWindow`
 * exactly, by construction (`analyzeContext.ts`: `freeTokens = contextWindow -
 * actualUsage - reservedTokens`, and the reserved-buffer row, when present, is
 * part of `actualUsage`'s complement, not `accounted`'s), so this is the one
 * total that always reconciles with what is printed below it.
 *
 * Falls back to the live `usage` when there is no trustworthy breakdown yet
 * (`rows` empty) — the aggregate-row-only state, where there is nothing to sum.
 */
export function selectPanelUsage(
  usage: ContextUsage,
  breakdown: ContextBreakdownSnapshot | null,
): ContextUsage {
  const rows = selectBreakdownRows(breakdown)
  if (rows.length === 0 || !breakdown) return usage
  const accounted = rows.reduce((sum, row) => sum + row.tokens, 0)
  const contextWindow = breakdown.contextWindow
  const percentUsed = Math.min(
    100,
    Math.max(0, Math.round((accounted / contextWindow) * 100)),
  )
  return { usedTokens: accounted, contextWindow, percentUsed }
}

/* ---------------------------------------------------------------------------
 * The donut's hover view
 *
 * Ring geometry AND hover emphasis live here, not in the component, for one
 * reason: the renderer suite has no DOM (`SettingsEditors.test.tsx:3` — adding
 * happy-dom needs sign-off), so anything left inside the JSX is untestable. The
 * component keeps only the two `onMouseEnter`/`onMouseLeave` wires and paints
 * what this returns.
 *
 * The ring and the legend are ONE hover target set: both call the same setter
 * with the same index, and both read their appearance from this one view, so
 * hovering a legend row emphasises its arc and vice versa without either side
 * knowing about the other.
 * ------------------------------------------------------------------------- */

const DONUT_RADIUS = 30
const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS
/** Segments are notched apart rather than butted: each arc gives up GAP units of
 * its own length and starts a half-gap later, so the notch sits centred between
 * neighbours and the ring's total sweep still reads as the used fraction. */
const SEGMENT_GAP = 3
/** Thin enough that the notches stay legible at 76px, and that the center
 * readout has room. Hover thickens the one arc under the pointer. */
const SEGMENT_STROKE = 6
const SEGMENT_STROKE_HOVER = 9
/** Unhovered arcs and their legend rows recede rather than vanish. */
const DIMMED_OPACITY = 0.3

export type DonutSegment = {
  label: string
  tokens: number
  colorHex: string
  /** Dash length in circumference units, already shortened by the gap. */
  dash: number
  /** Negative offset that walks each arc to its slot, plus the half-gap. */
  offset: number
  strokeWidth: number
  opacity: number
}

export type DonutLegendRow = ContextBreakdownRow & {
  /** Row fill while this row is the hover target. */
  rowClass: string
  labelClass: string
  valueClass: string
}

export type DonutView = {
  circumference: number
  segments: DonutSegment[]
  legend: DonutLegendRow[]
  /** The hovered category's hue as a static `text-*` class, null at rest. */
  centerClass: string | null
  /**
   * The hovered category's share of the ACCOUNTED total (`Σ rows[].tokens`,
   * the same denominator {@link selectPanelUsage} sums the header from), 0-100.
   * Null at rest, where the caller prints the panel's own overall percent
   * instead — the arcs still size by share of the full window
   * ({@link ContextBreakdownRow.percentOfWindow}), so a category can read
   * "23% of what's used" in the center while its arc still occupies a sliver
   * of the ring; those are different questions and both are correct.
   */
  centerPercent: number | null
}

/**
 * The ring + legend as they should paint for a given hover target.
 *
 * `hoveredIndex` is null when nothing is hovered; an out-of-range index is
 * treated as null rather than throwing, because it can legitimately go stale for
 * one render when a fresh snapshot arrives with fewer categories than the one
 * the pointer entered.
 */
export function selectDonutView(
  rows: readonly ContextBreakdownRow[],
  hoveredIndex: number | null,
): DonutView {
  const hovered =
    hoveredIndex != null && hoveredIndex >= 0 && hoveredIndex < rows.length
      ? hoveredIndex
      : null
  const accountedTotal = rows.reduce((sum, row) => sum + row.tokens, 0)

  let drawn = 0
  const segments = rows.map((row, index) => {
    const arcLength = (row.percentOfWindow / 100) * DONUT_CIRCUMFERENCE
    const segment: DonutSegment = {
      label: row.label,
      tokens: row.tokens,
      colorHex: row.colorHex,
      dash: Math.max(0, arcLength - SEGMENT_GAP),
      offset: -(drawn + SEGMENT_GAP / 2),
      strokeWidth: hovered === index ? SEGMENT_STROKE_HOVER : SEGMENT_STROKE,
      opacity: hovered === null || hovered === index ? 1 : DIMMED_OPACITY,
    }
    drawn += arcLength
    return segment
  })

  const legend = rows.map((row, index) => ({
    ...row,
    rowClass: hovered === index ? 'bg-white/5' : 'bg-transparent',
    labelClass:
      hovered === null
        ? 'text-text-muted'
        : hovered === index
          ? 'text-text-primary'
          : 'text-text-ghost',
    valueClass:
      hovered === null
        ? 'text-text-subtle'
        : hovered === index
          ? 'text-text-primary'
          : 'text-text-ghost',
  }))

  const hoveredRow = hovered === null ? null : (rows[hovered] ?? null)
  return {
    circumference: DONUT_CIRCUMFERENCE,
    segments,
    legend,
    centerClass: hoveredRow ? hoveredRow.textClass : null,
    centerPercent:
      hoveredRow && accountedTotal > 0
        ? (hoveredRow.tokens / accountedTotal) * 100
        : null,
  }
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
