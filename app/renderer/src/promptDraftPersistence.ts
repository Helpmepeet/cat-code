/**
 * Unsent composer text, persisted per session so it survives a renderer reload.
 *
 * `promptDrafts` (`App.tsx`, reducer in `appModel.ts`) is plain component state,
 * so every reload emptied every composer. That is not a rare event here: the
 * app's OWN crash recovery reloads the document (`app/main/main.ts`
 * `render-process-gone`), so the healing path destroyed the one piece of state
 * in the window that the engine has never seen and cannot replay. Quitting with
 * a half-written prompt lost it the same way.
 *
 * Renderer-local persistence through the shared codec (`viewPreference.ts`):
 * versioned JSON under a `catcode.`-prefixed key, read and written through an
 * injectable storage, best-effort. A draft is text the user typed and has not
 * sent; it has no engine meaning until they do, so it stays on this side of the
 * wire — no protocol frame, no registry field, no preload channel
 * (SECURITY-MINIMUM §2).
 *
 * Keyed by `SessionId` exactly like the in-memory state, so a restored draft
 * lands back in the composer it was typed in and nowhere else. Entries for
 * sessions that no longer exist are harmless: `selectPromptDraft` only ever
 * looks up the session being rendered, and the caps below bound the file.
 */

import type { PromptDraftState } from './appModel.js'
import type { SessionId } from '../../shared/protocol.js'
import {
  expandPasteRefs,
  restoreDraftWithPending,
  type HistoryNav,
  type PasteState,
  type PendingSubmitState,
} from './composerState.js'
import {
  readViewPreference,
  writeViewPreference,
  type ViewPreferenceStorage,
} from './viewPreference.js'

export const PROMPT_DRAFTS_STORAGE_KEY = 'catcode.promptDrafts.v1'

/**
 * Persistence bounds. Drafts are kept for sessions that are not currently open
 * (a draft must survive a relaunch that has not respawned that session yet), so
 * without a cap the entry set would grow for the life of the install.
 *
 * The per-draft cap is the one that matters: a pasted transcript can be
 * megabytes, and `localStorage` is a single shared quota for the whole renderer.
 * An oversized replacement retains its last-good copy and reports unsaved text
 * to the renderer. Text is never truncated to fit.
 */
export const MAX_PERSISTED_PROMPT_DRAFTS = 32
export const MAX_PERSISTED_PROMPT_DRAFT_CHARS = 20_000

/**
 * Storage-boundary normalization: string values only, blanks dropped (an empty
 * draft is the absence of one — `reducePromptDrafts` deletes the key), oversized
 * ones dropped, and at most `MAX_PERSISTED_PROMPT_DRAFTS` entries.
 *
 * Insertion order is the caller's, and the cap keeps the FIRST entries. Object
 * key order in `PromptDraftState` follows first-write order, so this keeps the
 * longest-lived drafts and drops the newest overflow. Either end loses
 * something; this end at least never evicts a draft the user has been carrying
 * across sessions in favour of one they abandoned a moment ago.
 */
function normalizePromptDrafts(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {}
  }
  const out: Record<string, string> = {}
  let kept = 0
  for (const [sessionId, draft] of Object.entries(value)) {
    if (kept >= MAX_PERSISTED_PROMPT_DRAFTS) break
    if (typeof draft !== 'string') continue
    if (draft.length === 0) continue
    if (draft.length > MAX_PERSISTED_PROMPT_DRAFT_CHARS) continue
    if (sessionId.length === 0) continue
    out[sessionId] = draft
    kept += 1
  }
  return out
}

/**
 * Unreadable storage (a private window, a thumbnail capture, a corrupt value)
 * degrades to "no saved drafts", never to a failed mount. A version-1 record
 * whose `drafts` is not an object normalizes to the empty set rather than to
 * null, so a damaged half is dropped without discarding the record.
 */
export function readPromptDraftsFromStorage(
  storage: ViewPreferenceStorage | null,
): PromptDraftState | null {
  return readViewPreference(
    storage,
    PROMPT_DRAFTS_STORAGE_KEY,
    'drafts',
    value => normalizePromptDrafts(value) as PromptDraftState,
  )
}

export function writePromptDraftsToStorage(
  storage: ViewPreferenceStorage | null,
  drafts: PromptDraftState,
  pastes: PasteState = {},
  recovery: {
    pendingSubmits?: PendingSubmitState
    historyNavigation?: Partial<Record<SessionId, HistoryNav>>
  } = {},
): Record<string, { status: 'saved' | 'stale' | 'unsaved'; text: string }> {
  // Paste pills depend on volatile entries. Persist their text so restoring a
  // draft after a reload never leaves a pill whose contents no longer exist.
  const expanded: Record<string, string> = {}
  const sessionIds = new Set([
    ...Object.keys(drafts),
    ...Object.keys(recovery.pendingSubmits ?? {}),
    ...Object.keys(recovery.historyNavigation ?? {}),
  ])
  for (const key of sessionIds) {
    const sessionId = key as SessionId
    const navigation = recovery.historyNavigation?.[sessionId]
    const draft = navigation && navigation.index !== null
      ? navigation.savedDraft
      : drafts[sessionId] ?? ''
    // A held submit has never reached an engine. Recovery deliberately restores
    // text for review, rather than recreating a queue that could send on reload.
    expanded[key] = restoreDraftWithPending(
      expandPasteRefs(draft, pastes[sessionId]?.entries ?? {}),
      recovery.pendingSubmits?.[sessionId]?.text ?? '',
    )
  }
  // Keep each last-good value until its replacement fits. Capacity must never
  // evict another nonempty draft merely because a new draft was added.
  const previous = readPromptDraftsFromStorage(storage) ?? {}
  const next: Record<string, string> = Object.fromEntries(
    Object.entries(previous).filter(([key]) => key in expanded),
  )
  for (const [key, text] of Object.entries(expanded)) {
    if (!text) {
      delete next[key]
    } else if (text.length <= MAX_PERSISTED_PROMPT_DRAFT_CHARS &&
      (key in next || Object.keys(next).length < MAX_PERSISTED_PROMPT_DRAFTS)) {
      next[key] = text
    }
  }
  const written = writeViewPreference(
    storage,
    PROMPT_DRAFTS_STORAGE_KEY,
    'drafts',
    next,
  )
  const protectedDrafts = written ? next : previous
  return Object.fromEntries(Object.entries(expanded).filter(([, text]) => text.length > 0).map(([key, text]) => [
    key,
    { status: protectedDrafts[key] === text ? 'saved' : protectedDrafts[key] ? 'stale' : 'unsaved', text },
  ]))
}
