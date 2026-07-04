import type { SDKMessage } from '@cat-code/engine/sdk'
import type { ServerFrame, SessionId } from '../../shared/protocol.js'
import { isAppReadyFrame } from './connectionState.js'

export const DEFAULT_MAX_RAW_MESSAGES = 512
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
  frame: ServerFrame,
): RawMessageLogState {
  return reduceServerFrameWithLimits(state, frame, {
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
    const session = state.sessions[frame.sessionId] ?? EMPTY_SESSION_LOG
    return updateSession(state, frame.sessionId, {
      ...session,
      error: frame.message,
    })
  }

  const session = state.sessions[frame.sessionId]
  if (!session) return state

  if (frame.kind !== 'event' || frame.event.type !== 'message') return state

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
