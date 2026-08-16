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

export type QueuedPromptsAction = { type: 'frame'; frame: ServerFrame }

const EMPTY: readonly QueuedPromptItem[] = []

export function createQueuedPromptsState(): QueuedPromptsState {
  return { sessions: {} }
}

export function reduceQueuedPromptsState(
  state: QueuedPromptsState,
  action: QueuedPromptsAction,
): QueuedPromptsState {
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
 * Images are collected across all recalled messages in the same order. The
 * composer holds one at a time (`reduceImageAttachmentAdded`), and
 * `reduceSessionImagesReplaced` is what decides which survives; ids are assigned
 * here so the fold has no dependency on what is currently attached.
 */
export function foldRecalledPrompts(prompts: readonly RecalledPrompt[]): {
  text: string
  images: ImageAttachment[]
} {
  const texts: string[] = []
  const images: ImageAttachment[] = []
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
      images.push({
        id: images.length + 1,
        mediaType: block.source.media_type,
        data: block.source.data,
        // The sent message carries no filename; only the picker ever had one.
        name: 'image',
      })
    }
  }
  return { text: texts.join('\n'), images }
}

/** What this session has waiting, oldest first (empty before any snapshot). */
export function selectQueuedPrompts(
  state: QueuedPromptsState,
  sessionId: SessionId | null,
): readonly QueuedPromptItem[] {
  const prompts = sessionId ? state.sessions[sessionId] : undefined
  return prompts ?? EMPTY
}
