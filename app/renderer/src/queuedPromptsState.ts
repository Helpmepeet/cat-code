/**
 * Messages waiting for the running response — the renderer half of the
 * `queued-prompts.snapshot` read seam (D1a). A reducer over the read-only frame
 * plus a read-time selector, in the shape `slashCatalogState.ts` established.
 *
 * Deliberately OUTSIDE `transcriptProjector.ts`: a message that has not reached
 * the model is not transcript history, and a transcript row is never rewritten
 * after the fact. These rows live above the composer and disappear when the
 * message is delivered, at which point the engine's own user event puts it in
 * the transcript.
 *
 * The sidecar publishes the WHOLE list on every change, so each snapshot
 * replaces the previous one; an empty list is the signal that nothing is
 * waiting.
 */

import type {
  QueuedPromptItem,
  RecalledPrompt,
  ServerFrame,
  SessionId,
} from '../../shared/protocol.js'
import type { ImageAttachment } from './composerState.js'

export type QueuedPromptsState = {
  sessions: Record<SessionId, readonly QueuedPromptItem[]>
}

export type QueuedPromptsAction =
  | { type: 'frame'; frame: ServerFrame }
  /**
   * The session left the roster. A `lifecycle` frame empties the list but keeps
   * the key, which is right while the row still exists; a removed session has
   * no row to publish into, so its entry is dropped outright.
   */
  | { type: 'session-removed'; sessionId: SessionId }

const EMPTY: readonly QueuedPromptItem[] = []

export function createQueuedPromptsState(): QueuedPromptsState {
  return { sessions: {} }
}

export function reduceQueuedPromptsState(
  state: QueuedPromptsState,
  action: QueuedPromptsAction,
): QueuedPromptsState {
  if (action.type === 'session-removed') {
    if (!(action.sessionId in state.sessions)) return state
    const { [action.sessionId]: _removed, ...rest } = state.sessions
    return { ...state, sessions: rest }
  }

  const { frame } = action

  if (frame.kind === 'queued-prompts.snapshot') {
    return {
      ...state,
      sessions: { ...state.sessions, [frame.sessionId]: frame.prompts },
    }
  }

  // The engine that held the queue is gone, so what it was holding is gone with
  // it; a fresh one publishes its own list. Untracked sessions are left alone
  // (mirrors slashCatalogState / runControlsState).
  if (frame.kind === 'lifecycle') {
    if (!(frame.sessionId in state.sessions)) return state
    return {
      ...state,
      sessions: { ...state.sessions, [frame.sessionId]: EMPTY },
    }
  }

  return state
}

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

/** What this session has waiting, oldest first (empty before any snapshot). */
export function selectQueuedPrompts(
  state: QueuedPromptsState,
  sessionId: SessionId | null,
): readonly QueuedPromptItem[] {
  const prompts = sessionId ? state.sessions[sessionId] : undefined
  return prompts ?? EMPTY
}
