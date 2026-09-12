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
import type {
  AgentConfigSnapshot,
  RecalledPrompt,
  ServerFrame,
  SessionId,
  SubmitPrompt,
} from '../../shared/protocol.js'
import {
  ACCEPTED_IMAGE_TYPES,
  type AcceptedImageType,
} from './imageAttachment.js'
import {
  reducePromptDrafts,
  selectPromptDraft,
  type PromptDraftState,
} from './appModel.js'

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

export type ImageAttachment = {
  id: number
  mediaType: AcceptedImageType
  data: string
  name: string
}
export type ImageAttachmentState = Record<SessionId, ImageAttachment[]>

export function createImageAttachmentState(): ImageAttachmentState {
  return {}
}

/**
 * A native-picker file selection is an opaque main-issued token, not a path.
 * Main resolves it into the engine's normal `@` attachment syntax immediately
 * before forwarding the submit, so the renderer cannot name filesystem targets.
 */
export type FileAttachment = {
  name: string
  token: string
}

export type FileAttachmentState = Partial<Record<SessionId, FileAttachment>>

export function createFileAttachmentState(): FileAttachmentState {
  return {}
}

export function selectFileAttachment(
  state: FileAttachmentState,
  sessionId: SessionId | null,
): FileAttachment | null {
  return sessionId ? (state[sessionId] ?? null) : null
}

export function reduceFileAttachmentSelected(
  state: FileAttachmentState,
  sessionId: SessionId,
  attachment: FileAttachment,
): FileAttachmentState {
  return { ...state, [sessionId]: attachment }
}

export function reduceFileAttachmentRemoved(
  state: FileAttachmentState,
  sessionId: SessionId,
): FileAttachmentState {
  if (!(sessionId in state)) return state
  const next = { ...state }
  delete next[sessionId]
  return next
}

export function reduceSessionFileAttachmentRestored(
  state: FileAttachmentState,
  sessionId: SessionId,
  attachment: FileAttachment | null | undefined,
): FileAttachmentState {
  return attachment ? reduceFileAttachmentSelected(state, sessionId, attachment) : state
}

export function selectImageAttachments(
  state: ImageAttachmentState,
  sessionId: SessionId | null,
): ImageAttachment[] {
  return sessionId ? (state[sessionId] ?? []) : []
}

export function reduceImageAttachmentAdded(
  state: ImageAttachmentState,
  sessionId: SessionId,
  attachment: Omit<ImageAttachment, 'id'>,
): ImageAttachmentState {
  const current = selectImageAttachments(state, sessionId)
  const id = (current.at(-1)?.id ?? 0) + 1
  return { ...state, [sessionId]: [{ ...attachment, id }] }
}

export function reduceImageAttachmentRemoved(
  state: ImageAttachmentState,
  sessionId: SessionId,
  id: number,
): ImageAttachmentState {
  const current = state[sessionId]
  if (!current?.some(attachment => attachment.id === id)) return state
  const remaining = current.filter(attachment => attachment.id !== id)
  if (remaining.length > 0) return { ...state, [sessionId]: remaining }
  const next = { ...state }
  delete next[sessionId]
  return next
}

export function reduceSessionImagesReplaced(
  state: ImageAttachmentState,
  sessionId: SessionId,
  attachments: readonly ImageAttachment[],
): ImageAttachmentState {
  if (attachments.length === 0) {
    if (!(sessionId in state)) return state
    const next = { ...state }
    delete next[sessionId]
    return next
  }
  return { ...state, [sessionId]: [...attachments] }
}

/**
 * Guarded sibling of `reduceSessionImagesReplaced`, shared by every path that
 * hands a submit's attachments back to the composer (a released pending
 * submit, a refused submit, a recalled prompt): an EMPTY `images` list means
 * that submit never carried any, not "clear whatever is attached now".
 * `reduceSessionImagesReplaced` alone deletes the session's entry on an empty
 * array, which would erase an attachment the user added to the CURRENT draft
 * while the submit was parked, in flight, or queued.
 */
export function reduceSessionImagesRestored(
  state: ImageAttachmentState,
  sessionId: SessionId,
  images: readonly ImageAttachment[],
): ImageAttachmentState {
  return images.length > 0
    ? reduceSessionImagesReplaced(state, sessionId, images)
    : state
}

export function buildSubmitPrompt(
  text: string,
  attachments: readonly ImageAttachment[],
): SubmitPrompt {
  if (attachments.length === 0) return text
  return [
    ...attachments.map(attachment => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: attachment.mediaType,
        data: attachment.data,
      },
    })),
    ...(text.length > 0 ? [{ type: 'text' as const, text }] : []),
  ]
}

export type RestoredSelectedPrompt = {
  text: string
  images: ImageAttachment[]
}

/**
 * Narrow the engine-selected prompt before it enters renderer composer state.
 * The wire intentionally carries `unknown[]`: only plain text and accepted
 * base64 image blocks are restored. Unknown and malformed blocks are ignored,
 * matching the tolerant read path used for recalled prompts.
 */
export function restoreSelectedPrompt(
  selectedPrompt: unknown,
): RestoredSelectedPrompt | null {
  if (!isRecord(selectedPrompt)) return null
  const content = selectedPrompt.content
  if (typeof content === 'string') return { text: content, images: [] }
  if (!Array.isArray(content)) return null

  const texts: string[] = []
  const imageBlocks: Array<{ mediaType: AcceptedImageType; data: string }> = []
  for (const block of content) {
    if (!isRecord(block) || typeof block.type !== 'string') continue
    if (block.type === 'text') {
      if (typeof block.text !== 'string') continue
      texts.push(block.text)
      continue
    }
    if (block.type === 'image') {
      if (!isRecord(block.source) || block.source.type !== 'base64') continue
      if (
        typeof block.source.media_type !== 'string' ||
        !isAcceptedImageType(block.source.media_type) ||
        typeof block.source.data !== 'string' ||
        !isBase64(block.source.data)
      ) {
        continue
      }
      imageBlocks.push({
        mediaType: block.source.media_type,
        data: block.source.data,
      })
    }
  }

  return {
    text: texts.join('\n'),
    images: imageBlocks.map((image, index) => ({
      id: index + 1,
      mediaType: image.mediaType,
      data: image.data,
      name: 'image',
    })),
  }
}

function isAcceptedImageType(value: string): value is AcceptedImageType {
  return ACCEPTED_IMAGE_TYPES.some(type => type === value)
}

function isBase64(value: string): boolean {
  return (
    value.length > 0 &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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

/**
 * Terminal parity — `↑` takes back everything waiting BEFORE it walks prompt
 * history. `handleHistoryUp` in `src/components/PromptInput/PromptInput.tsx`
 * checks for an editable queued command first and pops all of them, ahead of
 * history and with no loading guard, so `↑` is the terminal's mid-turn
 * take-back. Escape is NOT: with a turn running it cancels and leaves the queue
 * alone, popping only when nothing is running (`src/hooks/useCancelRequest.ts`
 * `handleCancel`, priority 1). The desktop keeps that split, so Escape on the
 * composer stays the interrupt.
 *
 * CC-67 rejected an `↑` binding, on two grounds. The first, that `↑` moves the
 * caret in a multi-line composer, is answered by `caretAtHistoryEdge`, which
 * the caller applies BEFORE this: an arrow inside a draft never reaches here.
 * The second, that `↑` is already the history key, is real and accepted rather
 * than argued away — while messages wait, `↑` reaches the queue instead of
 * history, exactly as the terminal behaves. That shadowing lasts only as long
 * as something is waiting, and the button stays for anyone who does not know
 * the key. Operator call, 2026-08-18.
 *
 * `canRecall` is the caller's own handler being wired, not a permission: recall
 * is one verb that takes back everything of this page's, so there is nothing
 * here to target or forge.
 */
export function shouldRecallWaitingMessages(
  direction: 'up' | 'down',
  queuedCount: number,
  canRecall: boolean,
): boolean {
  return direction === 'up' && queuedCount > 0 && canRecall
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
 * The editable composer's prompt, addressed to the session by its own name
 * (PEER-SESSIONS §6). One function rather than a ternary at the call site so the
 * unnamed fallback is the ORIGINAL string byte for byte, and a test can hold it
 * to that: a row with no name is every row that predates the field, so the
 * fallback is the common case for existing installs, not an edge.
 *
 * The doc's example copy ("Message Bear", replacing "Message Cat Code") does not
 * describe this app: `Message Cat Code` exists only in a test fixture. The shape
 * below is the real one it replaces, with the name in place of the product.
 */
export function composerPromptPlaceholder(name: string | null): string {
  const trimmed = name?.trim() ?? ''
  return trimmed.length > 0
    ? `Ask ${trimmed} anything or describe a task…`
    : 'Ask Cat Code anything or describe a task…'
}

/**
 * The same placeholder, split so the NAME can carry the peer colour (operator,
 * 2026-09-05).
 *
 * Tinting this session's own name is deliberate and is what the colour means:
 * it marks the PEER NAMESPACE, not "somebody else". Your session has a peer
 * name as much as any other does, and this is the one place that name is
 * addressed to you, so the colour says "this is the name peers reach you by".
 *
 * Null when there is no name to tint. The unnamed fallback stays the ORIGINAL
 * string byte for byte and untinted, because "Cat Code" is the product, not a
 * peer name; `composerPromptPlaceholder` remains the single owner of both
 * strings, so the two can never drift apart.
 */
export type ComposerPlaceholderParts = {
  lead: string
  name: string
  tail: string
}

export function composerPlaceholderParts(
  name: string | null,
): ComposerPlaceholderParts | null {
  const trimmed = name?.trim() ?? ''
  if (trimmed.length === 0) return null
  const whole = composerPromptPlaceholder(trimmed)
  const at = whole.indexOf(trimmed)
  // Defensive: if the name is somehow not in the string the wording owns, the
  // caller renders the plain string rather than a mis-split one.
  if (at < 0) return null
  return {
    lead: whole.slice(0, at),
    name: trimmed,
    tail: whole.slice(at + trimmed.length),
  }
}

/**
 * Whether a submit the user did not type can be sent right now: the donut's
 * Compact row, which puts `/compact` on the wire without going through the draft.
 *
 * The two arms the send arrow already treats as sendable. `connectPending` is
 * deliberately NOT one of them: it would have to park the text, and there is one
 * parked slot per session, so a button press would either swallow the prompt the
 * user parked or bounce off the one-message-queued toast.
 *
 * Its own function, rather than the expression inline at the call site, because
 * `editable` sits right next to it in the same JSX and reads like the obvious
 * simplification — and `editable` INCLUDES `connectPending`, which includes
 * `preview`. That substitution re-opens CC-28 (a verb sent to a session the
 * supervisor does not have answers `session_not_found`, which the connection
 * reducer maps to `dead`) on the one face that renders without an engine.
 */
export function canSendUntypedSubmit(gate: ComposerGate): boolean {
  return gate.engineInputEnabled || gate.turnPending
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
  | { type: 'hold'; text: string; showQueuedRow: boolean }
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
  hasImages?: boolean
  preview: boolean
  connectionStatus: ConnectionSnapshot['status']
  connectionInputEnabled: boolean
  logInputEnabled: boolean
  alreadyParked: boolean
}): ComposerSubmitAction {
  const text = expandPasteRefs(input.draft, input.pasteEntries).trim()
  if (text.length === 0 && input.hasImages !== true) return { type: 'ignore' }
  const gate = selectComposerGate({
    hasSession: true,
    preview: input.preview,
    connectionStatus: input.connectionStatus,
    connectionInputEnabled: input.connectionInputEnabled,
    logInputEnabled: input.logInputEnabled,
  })
  if (gate.engineInputEnabled || gate.turnPending) return { type: 'send', text }
  if (gate.connectPending && !input.alreadyParked) {
    return {
      type: 'hold',
      text,
      showQueuedRow: input.connectionStatus !== 'parked',
    }
  }
  return { type: 'ignore' }
}

/**
 * One parked prompt per session — the text submitted while the engine was still
 * spawning, already paste-expanded (`expandPasteRefs`) so the drain hands the
 * sidecar exactly what a live submit would have. Renderer-local: it rides the
 * EXISTING `app.submit` when it flushes, so no frame kind, preload method or
 * inbound vocabulary is added (SECURITY-MINIMUM §2). `showQueuedRow` preserves
 * whether this wait began as a real cold spawn. A parked-session restore keeps
 * holding the text through its later `connecting` state without announcing the
 * restore machinery as a queue.
 */
export type PendingSubmit = {
  text: string
  images?: ImageAttachment[]
  file?: FileAttachment | null
  showQueuedRow: boolean
}
export type PendingSubmitState = Record<SessionId, PendingSubmit>

export function createPendingSubmitState(): PendingSubmitState {
  return {}
}

export function selectPendingSubmit(
  state: PendingSubmitState,
  sessionId: SessionId | null,
): PendingSubmit | null {
  if (!sessionId) return null
  return state[sessionId] ?? null
}

export function reducePendingSubmitHeld(
  state: PendingSubmitState,
  sessionId: SessionId,
  pending: PendingSubmit,
): PendingSubmitState {
  if (pending.text.length === 0 && (pending.images?.length ?? 0) === 0) return state
  return { ...state, [sessionId]: pending }
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
  pendingSubmit: PendingSubmit | null,
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
 *
 * An image-only submit carries no text (`reducePendingSubmitHeld` parks it on
 * the strength of its attachments alone), so the empty case is real and must
 * return the draft untouched — otherwise the restore prepends a blank line to
 * text the user is still typing.
 */
export function restoreDraftWithPending(
  draft: string,
  pending: string,
): string {
  if (pending.length === 0) return draft
  return draft.length === 0 ? pending : `${pending}\n${draft}`
}

// ── The submit the sidecar can still refuse (D5) ─────────────────────────────

/**
 * What a `send` submit optimistically cleared out of the composer, kept until
 * its answer arrives. Text alone is not enough: `↑` history stores strings, so a
 * refused image-bearing submit used to lose its attachments with no recovery path
 * at all.
 *
 * `submitId` is the renderer-minted correlation id that went out with the submit
 * (`SubmitOptions.submitId`) and comes back on its answer.
 */
export type RetainedSubmit = {
  submitId: string
  text: string
  images: ImageAttachment[]
  file?: FileAttachment | null
  settlement?: 'refused'
  restored?: true
}

/**
 * KEYED BY `submitId`, not positional. Several submits can be outstanding at
 * once (press Enter twice inside one round trip), and the shape has been both
 * wrong ways: one slot per session lost the second message outright, and a
 * positional FIFO retired whichever entry happened to be at the head when
 * something that looked like an answer arrived. Both failed for the same reason,
 * which was that the renderer could not tell WHICH submit an answer belonged to.
 *
 * Now it can (`selectSubmitAnswer`), so the identity is the key and position
 * carries no meaning at all. A map is what that asks for; the per-session value
 * is an insertion-ordered array because it is also how the cap evicts (oldest
 * out, `RETAINED_SUBMIT_CAP`) and because a plain array keeps this module's
 * immutable-value style. Entries are never more than a handful, so the by-id
 * scan costs nothing.
 *
 * Order-independence is not a nicety here: an answer can come from the sidecar
 * OR from Electron main (a submit that was never forwarded), and those two are
 * not ordered against each other.
 */
export type RetainedSubmitState = Record<SessionId, readonly RetainedSubmit[]>

/**
 * How many unanswered submits one session keeps. Each entry holds a full base64
 * image, so this is a memory bound, and it is the ONLY bound: nothing infers an
 * answer any more, so a submit whose answer never arrives (its connection went
 * away mid-flight) is evicted by a later submit rather than by a passing frame.
 * A handful is already generous — outstanding submits are the ones sent inside a
 * single round trip.
 */
export const RETAINED_SUBMIT_CAP = 8

export function createRetainedSubmitState(): RetainedSubmitState {
  return {}
}

/** The submit this answer belongs to, or null when this page is not holding it. */
export function selectRetainedSubmit(
  state: RetainedSubmitState,
  sessionId: SessionId | null,
  submitId: string,
): RetainedSubmit | null {
  if (!sessionId) return null
  return state[sessionId]?.find(entry => entry.submitId === submitId) ?? null
}

/** Oldest out past the cap: a copy nothing will ever answer must not pin an image. */
export function reduceRetainedSubmitHeld(
  state: RetainedSubmitState,
  sessionId: SessionId,
  retained: RetainedSubmit,
): RetainedSubmitState {
  const held = [...(state[sessionId] ?? []), retained]
  return {
    ...state,
    [sessionId]:
      held.length > RETAINED_SUBMIT_CAP ? held.slice(-RETAINED_SUBMIT_CAP) : held,
  }
}

/** Retire exactly the submit that was answered; everything else keeps waiting. */
export function reduceRetainedSubmitSettled(
  state: RetainedSubmitState,
  sessionId: SessionId,
  submitId: string,
): RetainedSubmitState {
  const queue = state[sessionId]
  if (queue === undefined) return state
  const rest = queue.filter(entry => entry.submitId !== submitId)
  if (rest.length === queue.length) return state
  if (rest.length === 0) return reduceRetainedSubmitCleared(state, sessionId)
  return { ...state, [sessionId]: rest }
}

/**
 * Drop the whole queue: the session is closing or has left the roster, so
 * nothing is coming to resolve the copies, and each holds a full base64 image.
 */
export function reduceRetainedSubmitCleared(
  state: RetainedSubmitState,
  sessionId: SessionId,
): RetainedSubmitState {
  if (!(sessionId in state)) return state
  const next = { ...state }
  delete next[sessionId]
  return next
}

/**
 * The answer to one submit, or null for a frame that is not one.
 *
 * There is nothing to infer here any more, and that is the point. This used to
 * READ acceptance and refusal out of unrelated frames, because there was no id
 * to correlate on: main minted the transport request id inside its own IPC
 * handler and `submit()` returned void. Every signal it leaned on had producers
 * that have nothing to do with a submit:
 *
 *  - a user `event` message is also every tool result (they ride user SDKMessages);
 *  - `queued-prompts.snapshot` is republished on ANY queue change, including a
 *    subagent's;
 *  - both `turn.status` brackets fire for turns nobody submitted;
 *  - an `error` can be a refusal of something else entirely — the park refusal
 *    carries the RECALL's request id, and read positionally it retired a submit.
 *
 * With `SubmitOptions.submitId` on the way out and `submit.result` on the way
 * back, a frame either is this submit's answer or it is not, and only the answer
 * settles it (`reduceSubmitAnswers`).
 */
export type SubmitAnswer = { submitId: string; accepted: boolean }

export function selectSubmitAnswer(frame: ServerFrame): SubmitAnswer | null {
  if (frame.kind !== 'submit.result') return null
  return { submitId: frame.submitId, accepted: frame.accepted }
}

/**
 * Resolve a whole arrival batch against the retained copies: the state after it,
 * plus messages that can go back into a composer in original submit order.
 *
 * Batch-shaped rather than frame-shaped so the pairing is testable against a
 * REALISTIC stream. The defects this replaces were invisible to a test that
 * called the reducer directly: they only appeared once ordinary traffic (a tool
 * result, a staged snapshot, a turn bracket) flowed past the retained copies
 * ahead of the frame that actually answered one.
 *
 * Every newly known refusal is released immediately. Refused entries stay in
 * the ordered queue (marked `restored`) until the other outstanding answers
 * arrive, allowing a later batch to emit the complete refused sequence in
 * submission order. App replaces its previously inserted prefix with that
 * sequence instead of prepending it again. An answer for an id this page is not
 * holding is a no-op, which makes a replayed `submit.result` inert after a
 * reload.
 */
export function reduceSubmitAnswers(
  state: RetainedSubmitState,
  frames: readonly ServerFrame[],
): {
  state: RetainedSubmitState
  restored: readonly { sessionId: SessionId; retained: RetainedSubmit }[]
} {
  let next = state
  const restored: { sessionId: SessionId; retained: RetainedSubmit }[] = []
  const touchedSessions = new Set<SessionId>()
  for (const frame of frames) {
    const answer = selectSubmitAnswer(frame)
    if (answer === null) continue
    const retained = selectRetainedSubmit(next, frame.sessionId, answer.submitId)
    if (retained === null) continue
    if (retained.settlement !== undefined) continue
    touchedSessions.add(frame.sessionId)
    if (answer.accepted) {
      next = reduceRetainedSubmitSettled(next, frame.sessionId, answer.submitId)
      continue
    }
    next = {
      ...next,
      [frame.sessionId]: (next[frame.sessionId] ?? []).map(entry =>
        entry.submitId === answer.submitId
          ? { ...entry, settlement: 'refused' as const }
          : entry,
      ),
    }
  }
  for (const sessionId of touchedSessions) {
    const entries = next[sessionId] ?? []
    if (!entries.some(entry => entry.settlement === 'refused' && !entry.restored)) {
      continue
    }
    for (const entry of entries) {
      if (entry.settlement !== 'refused') continue
      const { settlement: _, restored: __, ...retained } = entry
      restored.push({ sessionId, retained })
    }
    const marked = entries.map(entry =>
      entry.settlement === 'refused' ? { ...entry, restored: true as const } : entry,
    )
    next = marked.every(entry => entry.settlement === 'refused')
      ? reduceRetainedSubmitCleared(next, sessionId)
      : { ...next, [sessionId]: marked }
  }
  return { state: next, restored }
}

/** Replace App's exact prior refusal prefix while preserving later live edits. */
export type RefusedDraftRestoreState = {
  prefix: string
  representedIds: readonly string[]
  submitIds: readonly string[]
}

export function restoreDraftWithRefusedSnapshot(
  draft: string,
  previous: RefusedDraftRestoreState | null,
  refused: readonly RetainedSubmit[],
): { draft: string; state: RefusedDraftRestoreState; retained: readonly RetainedSubmit[] } {
  let liveDraft = draft
  const previousIntact = previous !== null && (
    draft === previous.prefix || draft.startsWith(`${previous.prefix}\n`)
  )
  if (previousIntact) {
    liveDraft = draft === previous.prefix
      ? ''
      : draft.slice(previous.prefix.length + 1)
  }
  const previousIds = new Set(previous?.submitIds ?? [])
  const newlyRefused = refused.filter(entry => !previousIds.has(entry.submitId))
  const representedIds = new Set(
    previousIntact ? previous?.representedIds : [],
  )
  for (const entry of newlyRefused) representedIds.add(entry.submitId)
  const represented = refused.filter(entry => representedIds.has(entry.submitId))
  const prefix = represented.map(entry => entry.text).filter(Boolean).join('\n')
  return {
    draft: restoreDraftWithPending(liveDraft, prefix),
    state: {
      prefix,
      representedIds: represented.map(entry => entry.submitId),
      submitIds: [...previousIds, ...newlyRefused.map(entry => entry.submitId)],
    },
    retained: newlyRefused,
  }
}

export function applyRefusedSubmitRestoration(
  drafts: PromptDraftState,
  recovery: ReadonlyMap<SessionId, RefusedDraftRestoreState>,
  sessionId: SessionId,
  refused: readonly RetainedSubmit[],
): {
  drafts: PromptDraftState
  recovery: Map<SessionId, RefusedDraftRestoreState>
  images: readonly ImageAttachment[] | null
  file: FileAttachment | null
} {
  const restored = restoreDraftWithRefusedSnapshot(
    selectPromptDraft(drafts, sessionId),
    recovery.get(sessionId) ?? null,
    refused,
  )
  const nextRecovery = new Map(recovery)
  nextRecovery.set(sessionId, restored.state)
  const newlyRefusedIds = new Set(restored.retained.map(entry => entry.submitId))
  const imageWinner = [...refused].reverse().find(entry => entry.images.length > 0)
  const fileWinner = [...refused].reverse().find(entry => entry.file != null)
  return {
    drafts: reducePromptDrafts(drafts, sessionId, restored.draft),
    recovery: nextRecovery,
    images: imageWinner && newlyRefusedIds.has(imageWinner.submitId)
      ? imageWinner.images
      : null,
    file: fileWinner && newlyRefusedIds.has(fileWinner.submitId)
      ? (fileWinner.file ?? null)
      : null,
  }
}

// ── The messages a recall takes back (D1b) ───────────────────────────────────

/**
 * D1b — fold the messages a recall took back into one composer draft.
 *
 * The terminal's `↑` pops EVERY editable queued command into the input at once,
 * joined by newlines, with pasted images restored
 * (`src/utils/messageQueueManager.ts` `popAllEditable`). This is that join. It
 * is a pure function so the outcome is testable without driving the composer,
 * which the SSR-only renderer harness cannot do.
 *
 * Text joins across every recalled message; images do NOT. The composer holds
 * exactly one image at a time (`reduceImageAttachmentAdded` replaces the whole
 * array with a single element) and the submit schema caps base64 as a TOTAL
 * across the prompt, so restoring one image per recalled message would build a
 * draft the sidecar then refuses, which the refusal path restores again: the
 * user cannot send and cannot easily clear. The most recent image wins, which
 * is what attaching them one after another would have produced anyway.
 */
export function foldRecalledPrompts(prompts: readonly RecalledPrompt[]): {
  text: string
  images: ImageAttachment[]
} {
  const texts: string[] = []
  let lastImage: ImageAttachment | null = null
  for (const { prompt } of prompts) {
    if (typeof prompt === 'string') {
      if (prompt.length > 0) texts.push(prompt)
      continue
    }
    for (const block of prompt) {
      if (block.type === 'text') {
        if (block.text.length > 0) texts.push(block.text)
        continue
      }
      if (block.type === 'image') {
        lastImage = {
          id: 1,
          mediaType: block.source.media_type,
          data: block.source.data,
          // The sent message carries no filename; only the picker ever had one.
          name: 'image',
        }
        continue
      }
      // Closed union tripwire: a third block kind must be handled here rather
      // than falling through into an image with undefined source fields, which
      // renders as `data:undefined;base64,undefined`.
      const exhaustive: never = block
      void exhaustive
    }
  }
  return { text: texts.join('\n'), images: lastImage ? [lastImage] : [] }
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
