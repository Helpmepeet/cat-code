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
 * need to read the live field selection here, which this pure parser avoids.
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

/**
 * Global matcher for paste tokens (mirrors the engine's `parseReferences`
 * regex). Group 1 is the id, group 2 the line count when the token carries one
 * — the composer needs both to rebuild a pill from the draft alone.
 */
export const PASTE_REF_RE = /\[Pasted text #(\d+)(?: \+(\d+) lines)?\]/g

export function selectSessionPasteState(
  state: PasteState,
  sessionId: SessionId | null,
): SessionPasteState {
  if (!sessionId) return { entries: {}, nextId: 1 }
  return state[sessionId] ?? { entries: {}, nextId: 1 }
}

/** Paste entries for a session, oldest id first (the order the pills are built in). */
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
 * pill in one keystroke (`Chat.jsx:766-777`). Returns `null` when the caret is
 * not right after a token. Anchored to the caret with `$`, so only the token
 * abutting the caret matches.
 *
 * The field is a contentEditable and the pill is `contenteditable="false"`, so
 * browsers mostly delete it atomically already; this keeps the DRAFT the single
 * source of that edit rather than depending on per-browser behaviour.
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

/**
 * Cut ONE occurrence of a paste token out of a draft: the one starting at `at`,
 * which is the live position of the pill the user clicked.
 *
 * The occurrence matters because a draft can carry the same token twice (the
 * user copied the token text itself). Removing "the first match" would then
 * delete a pill the user did not click and leave the one they did. Falls back
 * to the first match when `at` no longer lines up, so a stale position removes
 * something sensible rather than nothing.
 */
export function removePasteOccurrence(
  draft: string,
  token: string,
  at: number,
): string {
  const index = draft.startsWith(token, at) ? at : draft.indexOf(token)
  if (index < 0) return draft
  return draft.slice(0, index) + draft.slice(index + token.length)
}

/**
 * The paste whose token the caret is touching (either edge counts), so parking
 * the caret on a pill opens its preview the same way hovering does
 * (`Chat.jsx:854-867`). Null when the caret is clear of every token.
 */
export function pasteIdAtCaret(value: string, caret: number): number | null {
  const pattern = new RegExp(PASTE_REF_RE.source, 'g')
  let match = pattern.exec(value)
  while (match) {
    if (caret >= match.index && caret <= match.index + match[0].length) {
      return Number(match[1])
    }
    match = pattern.exec(value)
  }
  return null
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
 * The composer's single `composerEnabled` flag used to conflate THREE different
 * reasons it could be unusable. They are separated here because none of them
 * means "stop typing":
 *
 *  - `engineInputEnabled` — attached and accepting input right now: the submit
 *    goes straight out over `app.submit`.
 *  - `connectPending` — no engine process is attached YET, and the user's own
 *    intent is what starts one: a preview pane (composer focus/pointer-down
 *    runs `engagePreviewPane` → the existing lazy-restore spawn), an in-flight
 *    spawn (`connecting` / `starting`), or an idle-PARKED session, whose spawn is
 *    asked for when the held prompt drains (`resolvePendingSubmit` → 'restore').
 *  - `turnPending` — attached, but a turn is running. The submit still goes
 *    STRAIGHT OUT over `app.submit`: the sidecar hands a mid-turn prompt to the
 *    engine's own command queue and the running turn drains it at its next tool
 *    round (`src/query.ts:1636-1645` → `getQueuedCommandAttachments`,
 *    `src/utils/attachments.ts:1056`), which is how the terminal REPL has always
 *    behaved. Nothing waits for the turn boundary; the between-turn drain
 *    (`useQueueProcessor`) is only the fallback for a turn that ends before any
 *    tool round consumed the queue.
 *
 * Typing is accepted whenever ANY of the three holds (`editable`); only a submit
 * with NO engine attached yet waits (`planSessionSubmit` → `hold`, drained by
 * `resolvePendingSubmit`). This does NOT make browsing spawn an engine: the
 * spawn still fires on focus/pointer-down/submit intent, it just stops blocking
 * that intent (the 300 ms dwell auto-spawn stays removed, cut-list §I.1 #3).
 *
 * The terminal statuses — `dead`, `failed`, `exited`, `disconnected` — are none
 * of the three: no spawn is in flight, no turn will end, and no keystroke
 * starts one, so the composer stays read-only there exactly as it was.
 */
export type ComposerGate = {
  engineInputEnabled: boolean
  connectPending: boolean
  turnPending: boolean
  /** Typing / attach are accepted: the union of the three reasons above. */
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
      input.connectionStatus === 'starting' ||
      // IDLE-PARK — a parked session is the third way to be "no engine yet, and
      // the user's own intent starts one". It differs from the two above only in
      // WHEN the spawn is asked for: a preview pane and an in-flight spawn already
      // have one coming, a parked session asks for one when the prompt is held
      // (`resolvePendingSubmit` → 'restore'). Typing must stay open either way, or
      // the reclaim the user never asked for turns into a composer they cannot use.
      input.connectionStatus === 'parked')
  // Attached (`ready`) but not accepting input: all but always a turn running,
  // which is what the copy says. The one other producer is a transient skew
  // where the connection store has reduced `ready` and the log store has not
  // yet; treating that as a queue is safe because the drain resolves from the
  // CONNECTION snapshot, so it flushes on the next pass rather than waiting.
  const turnPending =
    input.hasSession &&
    !engineInputEnabled &&
    !connectPending &&
    input.connectionStatus === 'ready'
  return {
    engineInputEnabled,
    connectPending,
    turnPending,
    editable: engineInputEnabled || connectPending || turnPending,
  }
}

/**
 * What Enter / the send arrow does.
 *  - `send`   — an engine is attached: it takes the prompt now (idle) or queues
 *               it into the running turn (`turnPending`). Both are one
 *               `app.submit`; which one it is, is the sidecar's call, not the
 *               renderer's.
 *  - `hold`   — no engine is attached YET: park the text and drain it the
 *               moment one is. Reachable only while `connectPending` (a preview
 *               pane, an in-flight spawn, or an idle-parked session).
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
  if (gate.engineInputEnabled || gate.turnPending) return { type: 'send', text }
  if (gate.connectPending && !input.alreadyParked) {
    return { type: 'hold', text }
  }
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
 *  - `send`    — attached: flush it through `app.submit`. `inputEnabled` is NOT
 *                a condition. A spawn that completes into a session already
 *                mid-turn still takes the prompt, because the sidecar queues a
 *                mid-turn submit into the engine's own queue rather than
 *                refusing it. Holding on for the turn boundary would delay the
 *                prompt past the round that should have seen it.
 *  - `wait`    — still spawning: keep holding.
 *  - `restore` — IDLE-PARK: the engine was reclaimed while the session sat idle,
 *                so nothing is coming unless we ask. The caller re-spawns through
 *                the EXISTING restore path and keeps holding; the drain then runs
 *                the `wait` → `send` course above off the resumed session's own
 *                `ready` frame. This is the arm that makes park/restore invisible:
 *                the user pressed Enter, not Restart.
 *  - `release` — terminal: this spawn will never complete. The text goes BACK
 *                into the composer (`restoreDraftWithPending`) with an error,
 *                so a failed reconnect can never eat a prompt silently.
 *
 * `restore` is deliberately an OUTCOME rather than something the submit handler
 * decides once: the drain re-runs on every connection change, so a prompt that
 * somehow ends up held on a parked session with no restore in flight asks again
 * on the next pass instead of waiting forever. The caller's own in-flight claim
 * (`claimLazyRestore`) is what keeps that idempotent.
 */
export type PendingSubmitOutcome = 'send' | 'wait' | 'restore' | 'release'

export function resolvePendingSubmit(connection: {
  status: ConnectionSnapshot['status']
  inputEnabled: boolean
}): PendingSubmitOutcome {
  switch (connection.status) {
    case 'ready':
      return 'send'
    case 'connecting':
    case 'starting':
      return 'wait'
    case 'parked':
      return 'restore'
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

/**
 * Bug fix (CC-16/stop) — Stop must not let the CC-16 drain treat its own
 * abort as a natural turn end. The abort's `turn.status(activeTurn:false)`
 * flips the connection snapshot to `{status:'ready', inputEnabled:true}` —
 * BYTE-IDENTICAL to a natural turn end, since `resolvePendingSubmit` above
 * reads only `status`/`inputEnabled` and cannot tell the two apart. Left
 * alone, the drain effect (`App.tsx`) fires the parked prompt as a fresh
 * turn the instant that frame lands.
 *
 * `stopTurn` (`App.tsx`, inside `SessionPane`) is only reachable while the
 * session is `generating` (`ready` + `inputEnabled:false`). A mid-turn submit
 * no longer parks at all — it goes out and the engine queues it — so what is
 * left here is the narrow race where a spawn-time park has not yet met the
 * drain effect that would flush it. Stop resolves that synchronously, before
 * the abort round-trip can produce the frame that would otherwise re-arm the
 * drain: the caller releases the parked prompt back to the composer (via the
 * existing `releasePendingSubmit` path) up front, so by the time
 * `turn.status(false)` arrives there is nothing left for the drain to find.
 */
export function shouldReleasePendingSubmitOnStop(
  pendingSubmit: string | null,
): boolean {
  return pendingSubmit !== null
}

/**
 * Shown when a parked prompt is released — the text is visibly back, not gone.
 * Cause-free on purpose: a park is released both by a spawn that never
 * connected and by a session that dies while a queued prompt waits out its
 * turn, and the user's next move is the same either way.
 */
export const PENDING_SUBMIT_RELEASED_MESSAGE =
  'Your message was not sent, so it is back in the composer.'

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

// ── Per-session transport error ──────────────────────────────────────────────

/**
 * Bug fix — a submit/verb/permission-response failure (or a released parked
 * prompt) used to set ONE app-wide error string handed to every `SessionPane`
 * alike, so a background session's failure painted red text under whichever
 * session the user was actually looking at. Keyed per session exactly like
 * `PendingSubmitState`, so each pane only ever shows its OWN outcome.
 */
export type TransportErrorState = Record<SessionId, string>

export function createTransportErrorState(): TransportErrorState {
  return {}
}

export function selectTransportError(
  state: TransportErrorState,
  sessionId: SessionId | null,
): string | null {
  if (!sessionId) return null
  return state[sessionId] ?? null
}

export function reduceTransportErrorSet(
  state: TransportErrorState,
  sessionId: SessionId,
  message: string,
): TransportErrorState {
  return { ...state, [sessionId]: message }
}

export function reduceTransportErrorCleared(
  state: TransportErrorState,
  sessionId: SessionId,
): TransportErrorState {
  if (!(sessionId in state)) return state
  const next = { ...state }
  delete next[sessionId]
  return next
}
