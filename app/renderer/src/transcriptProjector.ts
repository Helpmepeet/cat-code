/**
 * Transcript projector — anti-corruption boundary LAYER 2 (PROGRAM-PLAN §5).
 *
 * THE projector entry point. This module is the single place that derives
 * renderable transcript rows from the raw `AppSessionEvent` stream (whose
 * `message` member carries the engine's `SDKMessage`, raw-forwarded over IPC —
 * TRANSPORT-DECISION §4). Later domains (W3/W4) read `TranscriptState` through
 * their OWN selectors (§5 layer 3); they must not extend this module.
 *
 * P1-3 slice: assistant `text` and `tool_use` content blocks only. The
 * `SDKMessage` union is ~19 members / ~25 runtime variants (TRANSPORT-DECISION
 * §6), so `projectMessage` is a switch where every new variant is an added
 * case, not a restructure; Phase 2 owes an exhaustive fixture over the union.
 * Assistant content is typed `unknown[]` at the seam
 * (sdk-types.snapshot.d.ts:108), so block discriminants are read by runtime
 * narrowing — never casts.
 */

import type { AppSessionEvent, SDKMessage } from '@cat-code/engine/session-events'

export type AssistantTextRow = {
  kind: 'assistant-text'
  role: 'assistant'
  /** Markdown source of one assistant `text` content block. */
  content: string
}

export type ToolUseRow = {
  kind: 'tool-use'
  toolUseId: string | null
  toolName: string
  input: Record<string, unknown>
}

export type TranscriptRow = AssistantTextRow | ToolUseRow

export type TranscriptState = {
  /**
   * Append-only in P1-3. Phase 2 adds tool_use↔tool_result correlation and
   * derived tool status, which will update rows in place keyed by toolUseId.
   */
  rows: TranscriptRow[]
}

export function createTranscriptState(): TranscriptState {
  return { rows: [] }
}

/** Reducer over the raw event stream: `(state, AppSessionEvent) → state`. */
export function projectSessionEvent(
  state: TranscriptState,
  event: AppSessionEvent,
): TranscriptState {
  switch (event.type) {
    case 'message': {
      const rows = projectMessage(event.message)
      if (rows.length === 0) return state
      return { ...state, rows: [...state.rows, ...rows] }
    }

    // Permission/goal/abort events become their own row kinds in later
    // phases (P1-4 starts permissions); no transcript projection yet.
    case 'goal.snapshot':
    case 'permission.requested':
    case 'permission.resolved':
    case 'abort.status':
      return state
  }
}

function projectMessage(message: SDKMessage): TranscriptRow[] {
  switch (message.type) {
    case 'assistant':
      return message.message.content.flatMap(block => {
        const row = projectAssistantContentBlock(block)
        return row === null ? [] : [row]
      })

    // Deliberate no-ops in the P1-3 slice. These four arrive on every live
    // turn today (P1-2 observed system/stream_event/assistant/result);
    // stream_event will carry incremental text once streaming rows land.
    case 'system':
    case 'stream_event':
    case 'result':
    case 'user':
      return []

    // Long tail of the union (assistant_error, status, tool_progress,
    // auth_status, …): extend with explicit cases above as slices land.
    default:
      return []
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function projectAssistantContentBlock(block: unknown): TranscriptRow | null {
  if (!isRecord(block)) return null

  if (block.type === 'text' && typeof block.text === 'string') {
    return { kind: 'assistant-text', role: 'assistant', content: block.text }
  }

  if (block.type === 'tool_use' && typeof block.name === 'string') {
    return {
      kind: 'tool-use',
      toolUseId: typeof block.id === 'string' ? block.id : null,
      toolName: block.name,
      input: isRecord(block.input) ? block.input : {},
    }
  }

  // thinking / image / tool_result / … — later slices.
  return null
}
