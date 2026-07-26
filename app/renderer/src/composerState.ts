/**
 * P4-0 composer state — the renderer-local, per-session models the composer
 * gained beyond its draft (P3-4 `promptDrafts`): @-mention detection, paste
 * collapse, and ↑/↓ input-history recall.
 *
 * NONE of this crosses the wire. A submitted turn still rides the EXISTING
 * `app.submit` path with a PLAIN-TEXT prompt: mentions are literal `@text`, and
 * a collapsed paste is expanded back inline (`expandPasteRefs`) before submit.
 * No new inbound frame, no new preload method, no new domain read-seam
 * (SECURITY-MINIMUM §2; P4-5 owns the first canonical read-seam — this module
 * invents none).
 *
 * Per-session records are keyed by `SessionId` exactly like `promptDrafts`, so
 * switching focus never bleeds paste/history state across sessions.
 *
 * Engine parity anchors (terminal REPL), re-verified 2026-07-08:
 *  - paste threshold `PASTE_THRESHOLD = 800` chars OR `numLines > maxLines`
 *    (`src/utils/imagePaste.ts:30`, `src/components/PromptInput/PromptInput.tsx:1236-1240`;
 *    `maxLines = min(rows-10, 2)` → 2 for any real terminal, adopted verbatim);
 *  - token format `formatPastedTextRef` (`src/history.ts:51-55`);
 *  - submit expansion `expandPastedTextRefs` (`src/history.ts:81`, called
 *    `src/utils/handlePromptSubmit.ts:216`);
 *  - ↑/↓ recall + draft preservation `useArrowKeyHistory` (`src/hooks/useArrowKeyHistory.tsx:124-207`),
 *    50-cap in the history store (`src/utils/config`).
 */

import type { ConnectionSnapshot } from './connectionState.js'
import type { MentionItem } from './MentionPicker.js'
import type { AgentConfigSnapshot, SessionId } from '../../shared/protocol.js'

// ── @-mention ──────────────────────────────────────────────────────────────

/**
 * The trailing `@token` query in a draft, or `null` when no mention is in
 * progress. Mirrors the prototype's `/(?:^|\s)@([\w/.\-]*)$/` (Chat.jsx:954):
 * an `@` at line start or after whitespace, followed by an unbroken path/word
 * token, anchored to the END of the text. A completed mention (`@agent `) ends
 * with a space, so the trailing-token match fails and the picker closes.
 *
 * NB: detection is anchored to the END of the whole draft, not caret-aware
 * (unchanged by the P4-24 multi-line composer). A mention typed mid-text with
 * the caret moved away — or an `@token` that is not the final token in a
 * multi-line draft — is not detected (flagged §0). Caret-aware detection would
 * need to read the live textarea selection here, which this pure parser avoids.
 */
export function parseMentionQuery(draft: string): string | null {
  const match = /(?:^|\s)@([\w/.\-]*)$/.exec(draft)
  return match ? match[1] : null
}

/**
 * Replace the trailing `@token` with the picked `label` plus a trailing space
 * (Chat.jsx:1031). The space both separates the mention from the next word and
 * closes the picker (the trailing-token match now fails).
 */
export function applyMention(draft: string, label: string): string {
  return draft.replace(/(^|\s)@[\w/.\-]*$/, `$1@${label} `)
}

/**
 * Real agent mention items from the per-session `agent-config.snapshot`
 * (P4-7). Only AVAILABLE definitions are offered. There is no `name` field on
 * the wire — `agentType` is the identity handle (recon: `protocol.ts:341`);
 * `whenToUse` is the muted sub-line.
 *
 * FILE mention items are intentionally absent: the engine's `@`-file index is
 * engine-side (`src/hooks/unifiedSuggestions.ts:121` merges file + agent
 * sources; files come from `src/hooks/fileSuggestions.ts` over `git ls-files`)
 * and not on the wire; surfacing it needs a read-seam this session must not
 * invent (rule 3). A free-typed `@path` still submits as plain text.
 */
export function selectAgentMentionItems(
  snapshot: AgentConfigSnapshot | null,
): MentionItem[] {
  if (!snapshot) return []
  return snapshot.definitions
    .filter(definition => definition.available)
    .map(definition => ({
      label: definition.agentType,
      sub: definition.whenToUse || undefined,
      value: definition.agentType,
    }))
}

// ── Paste collapse ───────────────────────────────────────────────────────────

export const PASTE_THRESHOLD = 800
/** `maxLines = min(rows-10, 2)` collapses to 2 for any real terminal; a paste
 * with MORE than this many newlines collapses. */
export const PASTE_MAX_LINES = 2

export type PasteEntry = { id: number; content: string; numLines: number }
export type SessionPasteState = {
  entries: Record<number, PasteEntry>
  /** Monotonic within a session so a removed-then-re-pasted block gets a fresh
   * `#N`, matching the engine's per-session `pasteId` counter. */
  nextId: number
}
export type PasteState = Record<SessionId, SessionPasteState>

export function createPasteState(): PasteState {
  return {}
}

/** Count line breaks the way the engine does (`\r\n | \r | \n`, `src/history.ts:44-59`). */
export function countNewlines(text: string): number {
  return (text.match(/\r\n|\r|\n/g) ?? []).length
}

/** Collapse when a paste is long OR spans more than `PASTE_MAX_LINES` newlines. */
export function shouldCollapsePaste(text: string): boolean {
  return text.length > PASTE_THRESHOLD || countNewlines(text) > PASTE_MAX_LINES
}

/** `[Pasted text #N]` / `[Pasted text #N +M lines]` (`formatPastedTextRef`, `src/history.ts:51-55`). */
export function formatPasteRef(id: number, numLines: number): string {
  return numLines > 0
    ? `[Pasted text #${id} +${numLines} lines]`
    : `[Pasted text #${id}]`
}

/** Global matcher for paste tokens (mirrors the engine's `parseReferences` regex). */
export const PASTE_REF_RE = /\[Pasted text #(\d+)(?: \+\d+ lines)?\]/g

export function selectSessionPasteState(
  state: PasteState,
  sessionId: SessionId | null,
): SessionPasteState {
  if (!sessionId) return { entries: {}, nextId: 1 }
  return state[sessionId] ?? { entries: {}, nextId: 1 }
}

/** Paste entries for a session, oldest id first (render order for the chip strip). */
export function selectSessionPasteList(
  state: PasteState,
  sessionId: SessionId | null,
): PasteEntry[] {
  const session = selectSessionPasteState(state, sessionId)
  return Object.values(session.entries).sort((a, b) => a.id - b.id)
}

/**
 * Store a collapsed paste and return the new state plus the token to splice
 * into the draft. The caller inserts the token at the caret.
 */
export function reducePasteAdded(
  state: PasteState,
  sessionId: SessionId,
  content: string,
): { state: PasteState; token: string } {
  const session = selectSessionPasteState(state, sessionId)
  const id = session.nextId
  const numLines = countNewlines(content)
  const entry: PasteEntry = { id, content, numLines }
  const next: PasteState = {
    ...state,
    [sessionId]: {
      entries: { ...session.entries, [id]: entry },
      nextId: id + 1,
    },
  }
  return { state: next, token: formatPasteRef(id, numLines) }
}

export function reducePasteRemoved(
  state: PasteState,
  sessionId: SessionId,
  id: number,
): PasteState {
  const session = state[sessionId]
  if (!session || !(id in session.entries)) return state
  const entries = { ...session.entries }
  delete entries[id]
  return { ...state, [sessionId]: { ...session, entries } }
}

/**
 * Drop any paste whose token the user deleted from the draft (Chat.jsx:933-941)
 * so a removed pill never survives as dead state. `nextId` is preserved.
 */
export function reducePastesPruned(
  state: PasteState,
  sessionId: SessionId,
  draft: string,
): PasteState {
  const session = state[sessionId]
  if (!session) return state
  const kept: Record<number, PasteEntry> = {}
  let changed = false
  for (const [key, entry] of Object.entries(session.entries)) {
    if (draft.includes(formatPasteRef(entry.id, entry.numLines))) {
      kept[Number(key)] = entry
    } else {
      changed = true
    }
  }
  if (!changed) return state
  return { ...state, [sessionId]: { ...session, entries: kept } }
}

export function reduceSessionPastesCleared(
  state: PasteState,
  sessionId: SessionId,
): PasteState {
  if (!(sessionId in state)) return state
  const next = { ...state }
  delete next[sessionId]
  return next
}

/**
 * Why a draft write happened, so paste-pruning fires only on a GENUINE edit.
 *  - `edit`: the user typed / picked a mention/command — a token they removed is
 *    a real removal, so prune (`reducePastesPruned`).
 *  - `history-nav`: an ↑/↓ recall transiently swapped the draft to an OLD
 *    prompt with no paste token. That is NOT a deletion — pruning here would
 *    destroy a live, uncommitted paste that ↓ is about to restore (the draft
 *    text returns via `savedDraft`, but the paste ENTRY would already be gone,
 *    so `expandPasteRefs` on submit would emit the literal `[Pasted text #N]`
 *    placeholder instead of the body). Nav writes therefore never prune.
 */
export type DraftWriteReason = 'edit' | 'history-nav'

export function reducePasteStateForDraftWrite(
  state: PasteState,
  sessionId: SessionId,
  draft: string,
  reason: DraftWriteReason,
): PasteState {
  if (reason === 'history-nav') return state
  return reducePastesPruned(state, sessionId, draft)
}

/**
 * Expand every paste token back to its full content for submission
 * (`expandPastedTextRefs`, `src/history.ts:81`). Unknown ids are left as-is.
 */
export function expandPasteRefs(
  draft: string,
  entries: Record<number, PasteEntry>,
): string {
  return draft.replace(PASTE_REF_RE, (match, id: string) => {
    const entry = entries[Number(id)]
    return entry ? entry.content : match
  })
}

/**
 * P4-24: with a collapsed selection sitting immediately AFTER a paste token,
 * return the `[start, end)` range of that token so Backspace deletes the WHOLE
 * pill in one keystroke — the atomic-pill delete the prototype's contentEditable
 * gets for free (`Chat.jsx:766-777`). Returns `null` when the caret is not right
 * after a token. Anchored to the caret with `$`, so only the token abutting the
 * caret matches. The multi-line composer is a plain `<textarea>`, so the token is
 * literal text; this makes its deletion feel atomic without contentEditable.
 */
export function pasteTokenBeforeCaret(
  value: string,
  caret: number,
): { start: number; end: number } | null {
  const before = value.slice(0, caret)
  const match = /\[Pasted text #\d+(?: \+\d+ lines)?\]$/.exec(before)
  if (!match) return null
  return { start: caret - match[0].length, end: caret }
}

// ── Input history (↑/↓ recall) ───────────────────────────────────────────────

export const HISTORY_CAP = 50

export type HistoryState = Record<SessionId, string[]>
/** Ephemeral per-editor cursor: which entry is shown, and the live draft saved
 * when recall began (restored on ↓ past the newest entry). */
export type HistoryNav = { index: number | null; savedDraft: string }

export function createHistoryState(): HistoryState {
  return {}
}

export const EMPTY_HISTORY_NAV: HistoryNav = { index: null, savedDraft: '' }

export function selectHistory(
  state: HistoryState,
  sessionId: SessionId | null,
): string[] {
  if (!sessionId) return []
  return state[sessionId] ?? []
}

/**
 * Append a submitted prompt (Chat.jsx:633-636): skipped when it repeats the
 * newest entry, capped at the newest `HISTORY_CAP`.
 */
export function reduceHistoryPushed(
  state: HistoryState,
  sessionId: SessionId,
  text: string,
): HistoryState {
  const existing = state[sessionId] ?? []
  if (existing[existing.length - 1] === text) return state
  const appended = [...existing, text]
  const capped =
    appended.length > HISTORY_CAP ? appended.slice(-HISTORY_CAP) : appended
  return { ...state, [sessionId]: capped }
}

/**
 * ↑/↓ recall with draft preservation (Chat.jsx:744-763). Returns the next
 * cursor and the value to write into the composer, or `null` for a no-op
 * (nothing to recall, or already at an edge). `liveDraft` is the current
 * unsent text, saved the first time recall leaves the draft.
 */
export function navigateHistory(
  history: readonly string[],
  nav: HistoryNav,
  direction: 'up' | 'down',
  liveDraft: string,
): { nav: HistoryNav; value: string } | null {
  if (history.length === 0) return null
  const current = nav.index == null ? history.length : nav.index
  if (direction === 'up') {
    const nextIndex = current - 1
    if (nextIndex < 0) return null // already at the oldest entry
    const savedDraft = nav.index == null ? liveDraft : nav.savedDraft
    return { nav: { index: nextIndex, savedDraft }, value: history[nextIndex] }
  }
  if (nav.index == null) return null // editing the draft, nothing newer to show
  const nextIndex = current + 1
  if (nextIndex >= history.length) {
    // Past the newest entry — restore the preserved draft.
    return { nav: EMPTY_HISTORY_NAV, value: nav.savedDraft }
  }
  return {
    nav: { index: nextIndex, savedDraft: nav.savedDraft },
    value: history[nextIndex],
  }
}

/**
 * P4-24: with a multi-line composer, ↑/↓ must move the caret between lines and
 * only recall history at the vertical EDGE of the draft — ArrowUp recalls when
 * no newline precedes the caret (caret on the first visual line), ArrowDown when
 * no newline follows it (caret on the last line). Otherwise the arrow is a plain
 * caret move. Parity: `Chat.jsx:745-747`, from `src/hooks/useTextInput.ts:269-315`.
 * On the old single-line `<input>` there were never newlines, so this always
 * returned `true` — preserving the P4-0 recall behavior exactly.
 */
export function caretAtHistoryEdge(
  value: string,
  caret: number,
  direction: 'up' | 'down',
): boolean {
  return direction === 'up'
    ? !value.slice(0, caret).includes('\n')
    : !value.slice(caret).includes('\n')
}

// ── Connect-then-type gating + the parked submit (CC-16) ─────────────────────

/**
 * The composer's single `composerEnabled` flag used to conflate TWO different
 * reasons it could be unusable. They are separated here because only one of
 * them is the user's to resolve:
 *
 *  - `engineInputEnabled` — the ENGINE says input is closed: a ready session
 *    mid-turn (`inputEnabled: false`), or a log that has not enabled input.
 *    Real engine-authored state; nothing in this module relaxes it.
 *  - `connectPending` — no engine process is attached YET, and the user's own
 *    intent is what starts one: a preview pane (composer focus/pointer-down
 *    runs `engagePreviewPane` → the existing lazy-restore spawn) or an
 *    in-flight spawn (`connecting` / `starting`).
 *
 * Typing is accepted whenever EITHER holds (`editable`); only the SUBMIT waits
 * for the engine (`planComposerSubmit` → `hold`, drained by
 * `resolvePendingSubmit`). This does NOT make browsing spawn an engine: the
 * spawn still fires on focus/pointer-down/submit intent, it just stops blocking
 * that intent (the 300 ms dwell auto-spawn stays removed, cut-list §I.1 #3).
 *
 * The terminal statuses — `dead`, `failed`, `exited`, `disconnected` — are
 * neither: no spawn is in flight and no keystroke starts one, so the composer
 * stays read-only there exactly as it was.
 */
export type ComposerGate = {
  engineInputEnabled: boolean
  connectPending: boolean
  /** Typing / attach are accepted: the union of the two reasons above. */
  editable: boolean
}

export type ComposerGateInput = {
  hasSession: boolean
  preview: boolean
  connectionStatus: ConnectionSnapshot['status']
  connectionInputEnabled: boolean
  logInputEnabled: boolean
}

export function selectComposerGate(input: ComposerGateInput): ComposerGate {
  const engineInputEnabled =
    input.hasSession &&
    !input.preview &&
    input.logInputEnabled &&
    input.connectionStatus === 'ready' &&
    input.connectionInputEnabled
  const connectPending =
    input.hasSession &&
    !engineInputEnabled &&
    (input.preview ||
      input.connectionStatus === 'connecting' ||
      input.connectionStatus === 'starting')
  return {
    engineInputEnabled,
    connectPending,
    editable: engineInputEnabled || connectPending,
  }
}

/**
 * What Enter / the send arrow does.
 *  - `send`   — the engine is attached and accepting input (today's path).
 *  - `hold`   — still spawning: park the text and drain it on ready. Reachable
 *               ONLY while `connectPending`; a mid-turn composer is not
 *               editable, so nothing is ever parked for an engine-disabled turn.
 *  - `ignore` — nothing to send, or the composer is not accepting submissions.
 *               The caller leaves the draft alone, so an ignored submit is
 *               visible as "my text is still there", never a swallowed prompt.
 */
export type ComposerSubmitAction =
  | { type: 'ignore' }
  | { type: 'hold'; text: string }
  | { type: 'send'; text: string }

/**
 * The whole submit decision for one session, in one pure call: expand the
 * collapsed pastes the way the engine would (`expandPasteRefs`), then route by
 * the two gates above. App's `submitSession` is the side-effecting half
 * (bridge + setState) wrapped around exactly this.
 */
export function planSessionSubmit(input: {
  draft: string
  pasteEntries: Record<number, PasteEntry>
  preview: boolean
  connectionStatus: ConnectionSnapshot['status']
  connectionInputEnabled: boolean
  logInputEnabled: boolean
  alreadyParked: boolean
}): ComposerSubmitAction {
  const text = expandPasteRefs(input.draft, input.pasteEntries).trim()
  if (text.length === 0) return { type: 'ignore' }
  const gate = selectComposerGate({
    hasSession: true,
    preview: input.preview,
    connectionStatus: input.connectionStatus,
    connectionInputEnabled: input.connectionInputEnabled,
    logInputEnabled: input.logInputEnabled,
  })
  if (gate.engineInputEnabled) return { type: 'send', text }
  if (gate.connectPending && !input.alreadyParked) return { type: 'hold', text }
  return { type: 'ignore' }
}

/**
 * One parked prompt per session — the text submitted while the engine was still
 * spawning, already paste-expanded (`expandPasteRefs`) so the drain hands the
 * sidecar exactly what a live submit would have. Renderer-local: it rides the
 * EXISTING `app.submit` when it flushes, so no frame kind, preload method or
 * inbound vocabulary is added (SECURITY-MINIMUM §2).
 */
export type PendingSubmitState = Record<SessionId, string>

export function createPendingSubmitState(): PendingSubmitState {
  return {}
}

export function selectPendingSubmit(
  state: PendingSubmitState,
  sessionId: SessionId | null,
): string | null {
  if (!sessionId) return null
  return state[sessionId] ?? null
}

export function reducePendingSubmitHeld(
  state: PendingSubmitState,
  sessionId: SessionId,
  text: string,
): PendingSubmitState {
  if (text.length === 0) return state
  return { ...state, [sessionId]: text }
}

export function reducePendingSubmitCleared(
  state: PendingSubmitState,
  sessionId: SessionId,
): PendingSubmitState {
  if (!(sessionId in state)) return state
  const next = { ...state }
  delete next[sessionId]
  return next
}

/**
 * What to do with a parked prompt on the session's current connection snapshot.
 *  - `send`    — attached and accepting input: flush it through `app.submit`.
 *  - `wait`    — still spawning, or ready but mid-turn: keep holding.
 *  - `release` — terminal: this spawn will never complete. The text goes BACK
 *                into the composer (`restoreDraftWithPending`) with an error,
 *                so a failed reconnect can never eat a prompt silently.
 */
export type PendingSubmitOutcome = 'send' | 'wait' | 'release'

export function resolvePendingSubmit(connection: {
  status: ConnectionSnapshot['status']
  inputEnabled: boolean
}): PendingSubmitOutcome {
  switch (connection.status) {
    case 'ready':
      return connection.inputEnabled ? 'send' : 'wait'
    case 'connecting':
    case 'starting':
      return 'wait'
    case 'dead':
    case 'disconnected':
    case 'failed':
    case 'exited':
      return 'release'
    default: {
      const exhaustive: never = connection.status
      return exhaustive
    }
  }
}

/** Shown when a parked prompt is released — the text is visibly back, not gone. */
export const PENDING_SUBMIT_RELEASED_MESSAGE =
  'The session did not connect, so your message was not sent — it is back in the composer.'

/**
 * Give a released prompt back to the composer without clobbering whatever the
 * user typed while it was parked: the parked text goes FIRST (it was submitted
 * first) and the live draft keeps its own line.
 */
export function restoreDraftWithPending(
  draft: string,
  pending: string,
): string {
  return draft.length === 0 ? pending : `${pending}\n${draft}`
}
