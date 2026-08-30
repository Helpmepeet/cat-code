/**
 * Session-action write domain (P4-6b). Like `runControlsDomain`
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
 *   - Message-targeted Edit / Branch → the same live AppSessionController that
 *     owns turns, which delegates to QueryEngine's raw-message resolver.
 *   - Tag (P4-29) → `saveTag` (`src/utils/sessionStorage.ts:3257`), the SAME
 *     per-session tag write `/tag` uses (`src/commands/tag/tag.tsx:118` set,
 *     `:141` remove-with-empty-string), normalized with the SAME
 *     `recursivelySanitizeUnicode(tag).trim()` `/tag` applies
 *     (`src/commands/tag/tag.tsx:82`, `src/utils/sanitization.ts`) before the
 *     write, so a renderer-supplied tag can't carry the hidden/bidi
 *     characters that gate is meant to strip. It appends a `{type:'tag'}`
 *     entry to this session's transcript, which is where the sessions
 *     catalog reads `tag` back from — one write, one reader, no
 *     renderer-side tag store.
 *
 * The executor is behind a seam (like `runControlsDomain`): the real one wires the
 * engine functions; tests inject a fake so the domain round-trip is proven without
 * touching real transcripts on disk. All ops read the current engine session id
 * from `getSessionId()` — the SAME source the engine writes use — so the
 * op always targets THIS sidecar's own session (N-process, LOCKED).
 *
 * Failure posture: display = degrade gracefully. Every op is try/catch-wrapped to
 * an `{ ok:false, message }` result (never a throw that crashes the connection);
 * an empty/whitespace rename title fails closed BEFORE the engine write.
 */

import type { UUID } from 'crypto'
import type { AppSessionController } from '../../src/app-runtime/AppSessionController.js'
import { getSessionId } from '../../src/bootstrap/state.js'
import { createFork } from '../../src/commands/branch/branch.js'
import type { ConversationForkResult } from '../../src/commands/branch/branch.js'
import type { Tools } from '../../src/Tool.js'
import type { Message, UserMessage } from '../../src/types/message.js'
import { loadConversationForResume } from '../../src/utils/conversationRecovery.js'
import { renderMessagesToPlainText } from '../../src/utils/exportRenderer.js'
import { recursivelySanitizeUnicode } from '../../src/utils/sanitization.js'
import {
  getTranscriptPath,
  saveCustomTitle,
  saveTag,
} from '../../src/utils/sessionStorage.js'
import type { SessionActionResultFrame } from '../shared/protocol.js'

/** The redacted outcome of a session-action write (no transport, no secret). */
export type SessionActionResult = {
  ok: boolean
  /** Redacted, human-readable outcome — NEVER carries token material. */
  message: string
  /** The engine-rendered plain-text transcript — present iff a successful export. */
  exportText?: string
  /** The new fork's engine session id, present iff a successful targeted branch. */
  branchEngineSessionId?: string
  /** The engine-derived title, present with a successful targeted branch. */
  branchTitle?: string
  /** The selected engine-resolved user prompt for a targeted edit/branch. */
  selectedPrompt?: SessionActionResultFrame['selectedPrompt']
  /** Internal-only retained model seed used to rebuild display history after edit. */
  retainedMessages?: Message[]
}

/**
 * The engine session-action ops, behind a seam (P4-6b). The real implementation
 * wires the engine's OWN rename/export/fork logic; tests inject a fake so a
 * headless round-trip proves the wiring without writing real transcripts.
 */
export type SessionActionsExecutor = {
  /** Persist a user custom title for THIS session (`saveCustomTitle`). */
  rename(title: string): Promise<void>
  /**
   * Render THIS session's transcript to plain text (`renderMessagesToPlainText`),
   * or null when no conversation could be loaded at all. Null and `''` are
   * different answers: null is "nothing was there to read", `''` is a
   * conversation that read fine and rendered to nothing.
   */
  export(): Promise<string | null>
  /** Fork the whole conversation at HEAD; return the new session id + title. */
  branch(): Promise<{ engineSessionId: string; title: string; forkPath: string }>
  /** Rewind before an engine-resolved user message. */
  selectUserMessage(userMessageId: string): UserMessage
  editFromMessage(
    userMessageId: string,
  ): Promise<{ prompt: UserMessage; retainedMessages: Message[] }>
  /** Fork before an engine-resolved user message. */
  branchFromMessage(
    userMessageId: string,
  ): Promise<{ engineSessionId: string; title: string; prompt: UserMessage }>
  /** Set (or, with an empty string, clear) THIS session's tag (`saveTag`). */
  tag(tag: string): Promise<void>
}

export function createRealSessionActionsExecutor(deps: {
  tools: Tools
  controller: AppSessionController
}): SessionActionsExecutor {
  const finalizeFork = async (
    fork: ConversationForkResult,
  ): Promise<{ engineSessionId: string; title: string; forkPath: string }> => {
    if (!fork.title) throw new Error('Fork title was not published')
    return {
      engineSessionId: fork.sessionId,
      title: fork.title,
      forkPath: fork.forkPath,
    }
  }

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
      // `loadConversationForResume` answers null when it resolved neither a log
      // nor messages (`src/utils/conversationRecovery.ts` `if (!log && !messages)`).
      // Coercing that to `[]` rendered a blank export as a success; forward the
      // null so the domain can fail closed instead.
      const loaded = await loadConversationForResume(getSessionId(), undefined)
      if (!loaded) return null
      return renderMessagesToPlainText(loaded.messages, deps.tools)
    },
    async branch() {
      return finalizeFork(await createFork())
    },
    async editFromMessage(userMessageId) {
      return deps.controller.rewindBeforeUserMessage(userMessageId)
    },
    selectUserMessage(userMessageId) {
      return deps.controller.selectUserMessage(userMessageId)
    },
    async branchFromMessage(userMessageId) {
      const source = await loadConversationForResume(getSessionId(), undefined)
      const sourceTitle = source?.customTitle?.trim() || undefined
      const fork = await deps.controller.forkBeforeUserMessage(
        userMessageId,
        sourceTitle,
      )
      if (!fork.sourcePrompt) {
        throw new Error('Selected source prompt is unavailable')
      }
      // The fork glyph is the persistent qualifier in the desktop. A text suffix
      // is the first part a capped tab title truncates, so targeted forks keep the
      // conversation title itself unchanged.
      const finalized = await finalizeFork(fork)
      return { ...finalized, prompt: fork.sourcePrompt }
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
  /** Rewind before a selected user message and return its raw prompt. */
  selectUserMessage(userMessageId: string): SessionActionResult
  editFromMessage(userMessageId: string): Promise<SessionActionResult>
  /** Fork before a selected user message and return its raw prompt. */
  branchFromMessage(userMessageId: string): Promise<SessionActionResult>
  /** Set or clear this session's tag; report the redacted outcome. */
  tag(tag: string): Promise<SessionActionResult>
}

export function createSidecarSessionActionsDomain(
  options: {
    executor?: SessionActionsExecutor
    tools?: Tools
    controller?: AppSessionController
  } = {},
): SidecarSessionActionsDomain {
  const executor = options.executor ?? (() => {
    if (!options.controller) {
      throw new Error('Session actions require the live session controller')
    }
    return createRealSessionActionsExecutor({
      tools: options.tools ?? [],
      controller: options.controller,
    })
  })()

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
        if (exportText === null) {
          return { ok: false, message: 'This session has nothing saved to export.' }
        }
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
          branchTitle: title,
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
    async editFromMessage(userMessageId) {
      try {
        const { prompt, retainedMessages } =
          await executor.editFromMessage(userMessageId)
        return {
          ok: true,
          message: 'Conversation rewound.',
          selectedPrompt: selectedPrompt(prompt),
          retainedMessages,
        }
      } catch (error) {
        return {
          ok: false,
          message: `Could not edit from message: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }
      }
    },
    selectUserMessage(userMessageId) {
      try {
        return {
          ok: true,
          message: 'Message selected.',
          selectedPrompt: selectedPrompt(executor.selectUserMessage(userMessageId)),
        }
      } catch (error) {
        return {
          ok: false,
          message: `Could not select message: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }
      }
    },
    async branchFromMessage(userMessageId) {
      try {
        const { engineSessionId, title, prompt } =
          await executor.branchFromMessage(userMessageId)
        return {
          ok: true,
          message: `Branched to ${title}.`,
          branchEngineSessionId: engineSessionId,
          branchTitle: title,
          selectedPrompt: selectedPrompt(prompt),
        }
      } catch (error) {
        return {
          ok: false,
          message: `Could not branch from message: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }
      }
    },
    async tag(tag) {
      // Mirror `/tag`'s own normalization (tag.tsx:82) byte-for-byte before
      // this ever reaches `saveTag`: `recursivelySanitizeUnicode` strips the
      // hidden-character ranges (bidi overrides, zero-width, private-use —
      // sanitization.ts) a renderer-supplied tag has no other gate against,
      // THEN trim so `#  spaces  ` can never become a tag the filter tabs
      // cannot match. An all-whitespace (or now-empty-after-sanitizing) value
      // is the REMOVE form, not a failure.
      const trimmed = recursivelySanitizeUnicode(tag).trim()
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

function selectedPrompt(prompt: UserMessage): NonNullable<
  SessionActionResult['selectedPrompt']
> {
  const content =
    typeof prompt.message.content === 'string'
      ? prompt.message.content
      : prompt.message.content.flatMap<unknown>(block => {
          if (block.type === 'text' && typeof block.text === 'string') {
            return [{ type: 'text', text: block.text }]
          }
          if (
            block.type === 'image' &&
            block.source.type === 'base64' &&
            ACCEPTED_PROMPT_IMAGE_TYPES.has(block.source.media_type) &&
            typeof block.source.data === 'string'
          ) {
            return [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: block.source.media_type,
                  data: block.source.data,
                },
              },
            ]
          }
          return []
        })
  return {
    content,
  }
}

const ACCEPTED_PROMPT_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
])
