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
 * Renderer-local persistence, the `sidebarWorkspaceOrder.ts` idiom verbatim:
 * versioned JSON under a `catcode.`-prefixed key, read and written through an
 * injectable `Pick<Storage, …>`, best-effort. A draft is text the user typed and
 * has not sent; it has no engine meaning until they do, so it stays on this side
 * of the wire — no protocol frame, no registry field, no preload channel
 * (SECURITY-MINIMUM §2).
 *
 * Keyed by `SessionId` exactly like the in-memory state, so a restored draft
 * lands back in the composer it was typed in and nowhere else. Entries for
 * sessions that no longer exist are harmless: `selectPromptDraft` only ever
 * looks up the session being rendered, and the caps below bound the file.
 */

import type { PromptDraftState } from './appModel.js'

export const PROMPT_DRAFTS_STORAGE_KEY = 'catcode.promptDrafts.v1'

/**
 * Persistence bounds. Drafts are kept for sessions that are not currently open
 * (a draft must survive a relaunch that has not respawned that session yet), so
 * without a cap the entry set would grow for the life of the install.
 *
 * The per-draft cap is the one that matters: a pasted transcript can be
 * megabytes, and `localStorage` is a single shared quota for the whole renderer.
 * An oversized draft is DROPPED rather than truncated: handing back a silently
 * cut-off prompt is worse than handing back nothing, because the user cannot see
 * what went missing.
 */
export const MAX_PERSISTED_PROMPT_DRAFTS = 32
export const MAX_PERSISTED_PROMPT_DRAFT_CHARS = 20_000

type PromptDraftStorage = Pick<Storage, 'getItem' | 'setItem'>

type PersistedPromptDrafts = {
  version: 1
  drafts: Record<string, string>
}

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

export function readPromptDraftsFromStorage(
  storage: PromptDraftStorage | null,
): PromptDraftState | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(PROMPT_DRAFTS_STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<PersistedPromptDrafts>
    if (value.version !== 1) return null
    return normalizePromptDrafts(value.drafts) as PromptDraftState
  } catch {
    // Unreadable storage (a private window, a thumbnail capture, a corrupt
    // value) degrades to "no saved drafts", never to a failed mount.
    return null
  }
}

export function writePromptDraftsToStorage(
  storage: PromptDraftStorage | null,
  drafts: PromptDraftState,
): void {
  if (!storage) return
  try {
    const value: PersistedPromptDrafts = {
      version: 1,
      drafts: normalizePromptDrafts(drafts),
    }
    storage.setItem(PROMPT_DRAFTS_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // View persistence is best-effort; a storage failure (quota, a locked-down
    // window) must never affect live session state
    // (`sidebarWorkspaceOrder.ts`).
  }
}

/**
 * How long the write waits after the last keystroke. Typing rewrites the draft
 * on every character, and `localStorage.setItem` is synchronous on the renderer
 * thread, so an unthrottled write would serialize the whole draft set per
 * keystroke. Long enough to coalesce a burst of typing, short enough that the
 * pause before a user quits or a crash lands has almost always elapsed.
 */
export const PROMPT_DRAFT_WRITE_DEBOUNCE_MS = 500
