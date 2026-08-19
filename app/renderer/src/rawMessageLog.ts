import type { SDKMessage } from '@cat-code/engine/sdk'
import {
  HISTORY_REPLAY_TRUNCATION_REQUEST_ID,
  REPLAY_BUFFER_TRUNCATION_REQUEST_ID,
  type ServerFrame,
  type SessionId,
} from '../../shared/protocol.js'
import { isAppReadyFrame } from './connectionState.js'

/**
 * Sized so the BYTE budget below is what binds, the same correction
 * `DEFAULT_MAX_BUFFERED_FRAMES` took (app/main/replayBuffer.ts) and
 * `MAX_HISTORY_REPLAY_FRAMES` took after it. 512 was the third copy of the
 * P1-0 walking-skeleton number and truncated real sessions at roughly a
 * quarter of their length while the byte budget sat nearly empty. Raising the
 * count does NOT raise this store's memory ceiling: 8 MiB already bounded it,
 * and the count only ever cut retention short of that.
 */
export const DEFAULT_MAX_RAW_MESSAGES = 8_000
/**
 * Per-session raw-message retention budget, measured as serialized UTF-8 JSON.
 * Oldest messages are evicted until both this and the count cap hold; an
 * individually oversized message is therefore observed live but not retained.
 */
export const DEFAULT_MAX_RAW_MESSAGE_BYTES = 8 * 1024 * 1024

export type RawMessageSessionLog = {
  inputEnabled: boolean
  messages: SDKMessage[]
  retainedBytes: number
  truncated: boolean
  error: string | null
  /** Parallel to messages; avoids re-serializing surviving messages on eviction. */
  messageBytes: number[]
}

export type RawMessageLogState = {
  sessions: Record<SessionId, RawMessageSessionLog>
}

export type RawMessageLogLimits = {
  maxMessages: number
  maxBytes: number
}

export type RawMessageLogAction =
  | ServerFrame
  | { type: 'session-removed'; sessionId: SessionId }

const EMPTY_SESSION_LOG: RawMessageSessionLog = {
  inputEnabled: false,
  messages: [],
  retainedBytes: 0,
  truncated: false,
  error: null,
  messageBytes: [],
}

export function createRawMessageLogState(): RawMessageLogState {
  return { sessions: {} }
}

export function selectRawMessageLog(
  state: RawMessageLogState,
  sessionId: SessionId | null,
): RawMessageSessionLog {
  return sessionId
    ? (state.sessions[sessionId] ?? EMPTY_SESSION_LOG)
    : EMPTY_SESSION_LOG
}

export function reduceServerFrame(
  state: RawMessageLogState,
  action: RawMessageLogAction,
): RawMessageLogState {
  if ('type' in action) {
    if (action.type === 'session-removed') {
      if (!state.sessions[action.sessionId]) return state
      const sessions = { ...state.sessions }
      delete sessions[action.sessionId]
      return { ...state, sessions }
    }
    return state
  }
  return reduceServerFrameWithLimits(state, action, {
    maxMessages: DEFAULT_MAX_RAW_MESSAGES,
    maxBytes: DEFAULT_MAX_RAW_MESSAGE_BYTES,
  })
}

export function reduceServerFrameWithLimits(
  state: RawMessageLogState,
  frame: ServerFrame,
  limits: RawMessageLogLimits,
): RawMessageLogState {
  if (isAppReadyFrame(frame)) {
    const previous = state.sessions[frame.sessionId] ?? EMPTY_SESSION_LOG
    return {
      ...state,
      sessions: {
        ...state.sessions,
        [frame.sessionId]: {
          ...previous,
          inputEnabled: frame.payload.inputEnabled,
          error: null,
        },
      },
    }
  }

  if (frame.kind === 'error') {
    // Both retention notices ride `kind:'error'` to reuse the channel, but
    // neither is an error: retention is working as designed. Nothing ever
    // clears `error`, so routing them here pinned an undismissable red line
    // above the composer for the rest of the session. They are dropped at THIS
    // display only — the frames are still minted, still kept by the transcript
    // cache (`app/main/transcriptCache.ts`), and the transcript itself now
    // draws the boundary as a quiet seam at the top of the pane
    // (`transcriptProjector.ts` `HistoryBoundaryRow`), which is where an
    // incomplete history belongs.
    if (
      frame.requestId === REPLAY_BUFFER_TRUNCATION_REQUEST_ID ||
      frame.requestId === HISTORY_REPLAY_TRUNCATION_REQUEST_ID
    ) {
      return state
    }
    const session = state.sessions[frame.sessionId] ?? EMPTY_SESSION_LOG
    return updateSession(state, frame.sessionId, {
      ...session,
      error: frame.message,
    })
  }

  const session = state.sessions[frame.sessionId]
  if (!session) return state

  // Turn boundary — the same live signal `connectionState` reads, kept in step
  // here because the composer gate reads BOTH copies of `inputEnabled` and a
  // disagreement between them would leave the composer half-enabled mid-turn.
  if (frame.kind === 'event' && frame.event.type === 'turn.status') {
    const inputEnabled = !frame.event.activeTurn
    if (session.inputEnabled === inputEnabled) return state
    return updateSession(state, frame.sessionId, { ...session, inputEnabled })
  }

  if (frame.kind !== 'event' || frame.event.type !== 'message') return state

  // An in-run restore reuses the appSessionId and this store is never torn
  // down, so the resumed sidecar's replayed history (`replay:true`, same uuids
  // — F1/F2 same-source) would append the whole history again behind the
  // retained pre-crash rows (SF-1, P3-5 review). Skip a replayed message whose
  // uuid is already retained — the transcript projector dedupes the same way
  // (its seenFrameIds). Live (non-replay) frames are never deduped: this is
  // the raw debug view and must show what actually arrived.
  if (frame.replay === true) {
    const uuid = messageUuid(frame.event.message)
    if (uuid !== null && session.messages.some(m => messageUuid(m) === uuid)) {
      return state
    }
    // An evicted uuid is NOT held, so it passes the check above and re-appends
    // behind newer rows. That inversion is real but strictly transient: the
    // replay arrives oldest-first, so the last messages processed are the true
    // newest ones, and the window converges on the correct chronological tail by
    // the end of the burst. Deliberately NOT guarded — see the convergence test,
    // which pins the property that a mid-burst reader is the only thing that
    // could observe the inversion.
  }

  const messageBytes = serializedUtf8Bytes(frame.event.message)
  let messages = [...session.messages, frame.event.message]
  let sizes = [...session.messageBytes, messageBytes]
  let retainedBytes = session.retainedBytes + messageBytes
  let truncated = session.truncated

  while (
    messages.length > limits.maxMessages ||
    retainedBytes > limits.maxBytes
  ) {
    messages = messages.slice(1)
    const removedBytes = sizes[0] ?? 0
    sizes = sizes.slice(1)
    retainedBytes -= removedBytes
    truncated = true
  }

  return updateSession(state, frame.sessionId, {
    ...session,
    messages,
    messageBytes: sizes,
    retainedBytes,
    truncated,
  })
}

function updateSession(
  state: RawMessageLogState,
  sessionId: SessionId,
  session: RawMessageSessionLog,
): RawMessageLogState {
  return {
    ...state,
    sessions: { ...state.sessions, [sessionId]: session },
  }
}

function serializedUtf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

/** The message's engine uuid, or null when absent/empty (then never deduped). */
function messageUuid(message: SDKMessage): string | null {
  const uuid = (message as { uuid?: unknown }).uuid
  return typeof uuid === 'string' && uuid.length > 0 ? uuid : null
}
