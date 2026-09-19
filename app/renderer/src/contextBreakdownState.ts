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

import type {
  ContextBreakdownSnapshot,
  ServerFrame,
  SessionId,
} from '../../shared/protocol.js'

export type ContextBreakdownState = {
  /** Latest snapshot per session; null once reset or invalidated. */
  sessions: Record<SessionId, ContextBreakdownSnapshot | null>
  /** Tracked control state per session to detect actual changes */
  controls: Record<
    SessionId,
    {
      currentModel?: string | null
      selectedModel?: string | null
      contextWindow?: number | null
      permissionMode?: string | null
    }
  >
}

export type ContextBreakdownAction = { type: 'frame'; frame: ServerFrame }

export function createContextBreakdownState(): ContextBreakdownState {
  return { sessions: {}, controls: {} }
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

  if (frame.kind === 'transcript.reset') {
    if (!(frame.sessionId in state.sessions)) return state
    return {
      ...state,
      sessions: { ...state.sessions, [frame.sessionId]: null },
    }
  }

  if (
    frame.kind === 'session-action.result' &&
    frame.verb === 'editFromMessage' &&
    frame.ok
  ) {
    if (!(frame.sessionId in state.sessions)) return state
    return {
      ...state,
      sessions: { ...state.sessions, [frame.sessionId]: null },
    }
  }

  if (frame.kind === 'event') {
    if (frame.event.type === 'turn.status') {
      if (!(frame.sessionId in state.sessions)) return state
      return {
        ...state,
        sessions: { ...state.sessions, [frame.sessionId]: null },
      }
    }
    if (
      frame.event.type === 'message' &&
      frame.event.message.type === 'system' &&
      frame.event.message.subtype === 'compact_boundary' &&
      frame.event.message.parent_tool_use_id == null
    ) {
      if (!(frame.sessionId in state.sessions)) return state
      return {
        ...state,
        sessions: { ...state.sessions, [frame.sessionId]: null },
      }
    }
    return state
  }

  if (frame.kind === 'run-controls.snapshot') {
    const prev = state.controls[frame.sessionId]
    const nextCurrent = frame.runControls.model.current
    const nextSelected = frame.runControls.model.selected
    const nextWindow = frame.runControls.model.contextWindow

    if (prev !== undefined) {
      const changed =
        prev.currentModel !== nextCurrent ||
        prev.selectedModel !== nextSelected ||
        prev.contextWindow !== nextWindow
      if (changed) {
        return {
          ...state,
          sessions: { ...state.sessions, [frame.sessionId]: null },
          controls: {
            ...state.controls,
            [frame.sessionId]: {
              ...prev,
              currentModel: nextCurrent,
              selectedModel: nextSelected,
              contextWindow: nextWindow,
            },
          },
        }
      }
      return state
    }

    return {
      ...state,
      controls: {
        ...state.controls,
        [frame.sessionId]: {
          currentModel: nextCurrent,
          selectedModel: nextSelected,
          contextWindow: nextWindow,
        },
      },
    }
  }

  if (frame.kind === 'permission.context') {
    const prev = state.controls[frame.sessionId]
    const nextMode = frame.context.mode

    if (
      prev !== undefined &&
      prev.permissionMode !== undefined &&
      prev.permissionMode !== nextMode
    ) {
      return {
        ...state,
        sessions: { ...state.sessions, [frame.sessionId]: null },
        controls: {
          ...state.controls,
          [frame.sessionId]: {
            ...prev,
            permissionMode: nextMode,
          },
        },
      }
    }

    return {
      ...state,
      controls: {
        ...state.controls,
        [frame.sessionId]: {
          ...prev,
          permissionMode: nextMode,
        },
      },
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
/**
 * One legend row, ready to paint: the engine's label and token count plus the
 * static Tailwind class for its swatch.
 *
 * Tailwind v4 dynamic-class trap: the engine ships a terminal theme key
 * (`promptBorder`, `cyan_FOR_SUBAGENTS_ONLY`, …) which has no meaning in the
 * DOM, so it is mapped to LITERAL class strings here. Interpolating
 * `bg-[${hex}]` would silently emit nothing.
 */
export type ContextBreakdownRow = {
  label: string
  tokens: number
  /** Static `bg-*` class for the category swatch. */
  swatch: string
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
  promptBorder: 'bg-[light-dark(#52525b,#a1a1aa)]', // System prompt
  inactive: 'bg-[light-dark(#2563eb,#60a5fa)]', // System tools (the prototype's "Tool definitions")
  purple_FOR_SUBAGENTS_ONLY: 'bg-[light-dark(#bb3e84,#f472b6)]', // Messages
  claude: 'bg-[light-dark(#7c3aed,#c084fc)]', // Memory files
  cyan_FOR_SUBAGENTS_ONLY: 'bg-[light-dark(#0e7490,#22d3ee)]', // MCP tools
  permission: 'bg-[light-dark(#0f766e,#5eead4)]', // Custom agents
  warning: 'bg-[light-dark(#a35f00,#fbbf24)]', // Skills
}

const FALLBACK_SWATCH = 'bg-white/25'

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
 * different bases and are expected to disagree: `usedTokens` is reported
 * usage, while the categories may be local estimates. An earlier 0.5 sat right
 * where a Codex session legitimately lands, so a correct breakdown flickered in
 * and out depending on how JSON-heavy the transcript was. Only a near-total
 * collapse should suppress the panel.
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
    }))
}
