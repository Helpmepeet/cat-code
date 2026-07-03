import type { SDKMessage } from '@cat-code/engine/sdk'
import type { ServerFrame, SessionId } from '../../shared/protocol.js'
import { isAppReadyFrame } from './connectionState.js'

export type RawMessageLogState = {
  sessionId: SessionId | null
  inputEnabled: boolean
  messages: SDKMessage[]
  error: string | null
}

export function createRawMessageLogState(): RawMessageLogState {
  return {
    sessionId: null,
    inputEnabled: false,
    messages: [],
    error: null,
  }
}

export function reduceServerFrame(
  state: RawMessageLogState,
  frame: ServerFrame,
): RawMessageLogState {
  if (isAppReadyFrame(frame)) {
    return {
      ...state,
      sessionId: frame.sessionId,
      inputEnabled: frame.payload.inputEnabled,
      error: null,
    }
  }

  if (frame.kind === 'error') {
    return {
      ...state,
      error: frame.message,
    }
  }

  if (frame.kind === 'event' && frame.event.type === 'message') {
    return {
      ...state,
      messages: [...state.messages, frame.event.message],
    }
  }

  return state
}
