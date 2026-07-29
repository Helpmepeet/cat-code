/**
 * Session-action write domain (P4-6b) — the WRITE half of the Sessions `⋯`
 * menu's three MUTATING verbs (Rename / Export / Branch). Like `runControlsDomain`
 * (the recipe this copies), each op dispatches to the engine's OWN machinery over
 * an injectable executor seam — never a re-implementation (mistakes #1/#10):
 *
 *   - Rename → `saveCustomTitle` (`src/utils/sessionStorage.ts:3009`), the SAME
 *     custom-title write `/rename` (`src/commands/rename/rename.ts:53-57`) uses.
 *   - Export → `renderMessagesToPlainText` (`src/utils/exportRenderer.tsx:91`), the
 *     SAME plain-text renderer `/export` (`src/commands/export/export.tsx:49-55`)
 *     uses, over the transcript re-read from disk via `loadConversationForResume`
 *     (`src/utils/conversationRecovery.ts:469`, the loader the sidecar's resume
 *     uses) and the session's REAL `tools` (`getTools`, not `[]` — the P1-3 defect).
 *   - Branch → `createFork` (`src/commands/branch/branch.ts:61`), the SAME fork
 *     primitive `/branch` uses; it writes a real fork transcript on disk and
 *     returns the new engine session id. The forked session is NOT auto-opened
 *     (§0-deferred: a fork has no registry row and the sidecar has no host
 *     control-plane channel — see protocol.ts SESSION_ACTION_VERB_TYPES).
 *   - Tag (P4-29) → `saveTag` (`src/utils/sessionStorage.ts:3257`), the SAME
 *     per-session tag write `/tag` uses (`src/commands/tag/tag.tsx:118` set,
 *     `:141` remove-with-empty-string). It appends a `{type:'tag'}` entry to this
 *     session's transcript, which is where the sessions catalog reads `tag` back
 *     from — one write, one reader, no renderer-side tag store.
 *
 * The executor is behind a seam (like `runControlsDomain`): the real one wires the
 * engine functions; tests inject a fake so the domain round-trip is proven without
 * touching real transcripts on disk. All ops read the current engine session id
 * from `getSessionId()` — the SAME source the engine + `createFork` use — so the
 * op always targets THIS sidecar's own session (N-process, LOCKED).
 *
 * Failure posture: display = degrade gracefully. Every op is try/catch-wrapped to
 * an `{ ok:false, message }` result (never a throw that crashes the connection);
 * an empty/whitespace rename title fails closed BEFORE the engine write.
 */

import type { UUID } from 'crypto'
import { getSessionId } from '../../src/bootstrap/state.js'
import { createFork, deriveFirstPrompt } from '../../src/commands/branch/branch.js'
import type { Tools } from '../../src/Tool.js'
import type { SerializedMessage } from '../../src/types/logs.js'
import { loadConversationForResume } from '../../src/utils/conversationRecovery.js'
import { renderMessagesToPlainText } from '../../src/utils/exportRenderer.js'
import {
  getTranscriptPath,
  saveCustomTitle,
  saveTag,
} from '../../src/utils/sessionStorage.js'

/** The redacted outcome of a session-action write (no transport, no secret). */
export type SessionActionResult = {
  ok: boolean
  /** Redacted, human-readable outcome — NEVER carries token material. */
  message: string
  /** The engine-rendered plain-text transcript — present iff a successful export. */
  exportText?: string
  /** The new fork's engine session id — present iff a successful branch. */
  branchEngineSessionId?: string
}

/**
 * The engine session-action ops, behind a seam (P4-6b). The real implementation
 * wires the engine's OWN rename/export/fork logic; tests inject a fake so a
 * headless round-trip proves the wiring without writing real transcripts.
 */
export type SessionActionsExecutor = {
  /** Persist a user custom title for THIS session (`saveCustomTitle`). */
  rename(title: string): Promise<void>
  /** Render THIS session's transcript to plain text (`renderMessagesToPlainText`). */
  export(): Promise<string>
  /** Fork the whole conversation at HEAD; return the new session id + title. */
  branch(): Promise<{ engineSessionId: string; title: string; forkPath: string }>
  /** Set (or, with an empty string, clear) THIS session's tag (`saveTag`). */
  tag(tag: string): Promise<void>
}

export function createRealSessionActionsExecutor(deps: {
  tools: Tools
}): SessionActionsExecutor {
  return {
    async rename(title) {
      // Mirror `/rename` (rename.ts:53-57): the custom-title write, keyed by the
      // current engine session id + its transcript path. `custom-title` is the
      // user-authored entry readers prefer over an AI title (a rename always wins).
      await saveCustomTitle(
        getSessionId() as UUID,
        title,
        getTranscriptPath(),
        'user',
      )
    },
    async export() {
      // Re-read THIS session's persisted transcript → Message[] (the loader the
      // sidecar resume uses), then render with the engine's OWN plain-text renderer
      // and the session's REAL tools. Text-only: the engine has no md/json path.
      const loaded = await loadConversationForResume(getSessionId(), undefined)
      const messages = loaded?.messages ?? []
      return renderMessagesToPlainText(messages, deps.tools)
    },
    async branch() {
      // The engine's OWN fork primitive: writes a real fork transcript on disk +
      // returns its new engine session id. Then save the "(Branch)" custom title
      // so the fork is identifiable, mirroring `/branch`'s call() (branch.ts:250-252).
      const fork = await createFork()
      const firstUser = fork.serializedMessages.find(
        (m): m is Extract<SerializedMessage, { type: 'user' }> =>
          m.type === 'user',
      )
      const title = `${deriveFirstPrompt(firstUser)} (Branch)`
      await saveCustomTitle(fork.sessionId, title, fork.forkPath, 'user')
      return { engineSessionId: fork.sessionId, title, forkPath: fork.forkPath }
    },
    async tag(tag) {
      // Mirror `/tag` (tag.tsx:118 set / :141 remove): one `saveTag` call keyed by
      // the current engine session id + its transcript path. An empty string is the
      // engine's own REMOVE form, so set and clear share one code path here too.
      await saveTag(getSessionId() as UUID, tag, getTranscriptPath())
    },
  }
}

export type SidecarSessionActionsDomain = {
  /** Rename this session; report the redacted outcome. */
  rename(title: string): Promise<SessionActionResult>
  /** Export this session's transcript to plain text on the result. */
  export(): Promise<SessionActionResult>
  /** Fork the conversation at HEAD; report the new engine session id. */
  branch(): Promise<SessionActionResult>
  /** Set or clear this session's tag; report the redacted outcome. */
  tag(tag: string): Promise<SessionActionResult>
}

export function createSidecarSessionActionsDomain(
  options: {
    executor?: SessionActionsExecutor
    tools?: Tools
  } = {},
): SidecarSessionActionsDomain {
  const executor =
    options.executor ??
    createRealSessionActionsExecutor({ tools: options.tools ?? [] })

  return {
    async rename(title) {
      const trimmed = title.trim()
      if (trimmed.length === 0) {
        return { ok: false, message: 'Title cannot be empty.' }
      }
      try {
        await executor.rename(trimmed)
        return { ok: true, message: `Renamed to ${trimmed}.` }
      } catch (error) {
        return {
          ok: false,
          message: `Could not rename: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }
      }
    },
    async export() {
      try {
        const exportText = await executor.export()
        return {
          ok: true,
          message: 'Transcript exported.',
          exportText,
        }
      } catch (error) {
        return {
          ok: false,
          message: `Could not export: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }
      }
    },
    async branch() {
      try {
        const { engineSessionId, title } = await executor.branch()
        return {
          ok: true,
          message: `Branched to ${title}.`,
          branchEngineSessionId: engineSessionId,
        }
      } catch (error) {
        return {
          ok: false,
          message: `Could not branch: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }
      }
    },
    async tag(tag) {
      // Trim here so `#  spaces  ` can never become a tag the filter tabs cannot
      // match; an all-whitespace value is the REMOVE form, not a failure.
      const trimmed = tag.trim()
      try {
        await executor.tag(trimmed)
        return {
          ok: true,
          message: trimmed.length === 0 ? 'Tag removed.' : `Tagged #${trimmed}.`,
        }
      } catch (error) {
        return {
          ok: false,
          message: `Could not tag: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }
      }
    },
  }
}
