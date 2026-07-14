import {
  PROTOCOL_VERSION,
  type ReadyFrame,
  type ServerFrame,
  type SessionId,
  type TranscriptCache,
} from '../../shared/protocol.js'
import {
  batch,
  withBatch,
  type BatchAction,
} from './serverFrameBatch.js'
import {
  createTranscriptState,
  projectServerFrame,
  type TranscriptState,
} from './transcriptProjector.js'

export type PreviewTranscriptEntry = {
  transcript: TranscriptState
  truncationMessage: string | null
}

export type PreviewTranscriptState = {
  bySession: Record<SessionId, PreviewTranscriptEntry>
}

export type PreviewTranscriptAction =
  | { type: 'preview-load'; cache: TranscriptCache }
  | { type: 'preview-reset'; sessionId: SessionId }

export type LiveTranscriptAction =
  | ServerFrame
  | BatchAction<ServerFrame>
  | { type: 'preview-live-reset'; sessionId: SessionId }

const projectServerFrameBatched = withBatch(projectServerFrame)
export const PREVIEW_DWELL_MS = 300

export function createPreviewTranscriptState(): PreviewTranscriptState {
  return { bySession: {} }
}

export function reduceLiveTranscriptState(
  state: TranscriptState,
  action: LiveTranscriptAction,
): TranscriptState {
  if ('type' in action && action.type === 'preview-live-reset') {
    if (!state.sessions[action.sessionId]) return state
    const sessions = { ...state.sessions }
    delete sessions[action.sessionId]
    return { sessions }
  }
  return projectServerFrameBatched(state, action)
}

export function reducePreviewTranscriptState(
  state: PreviewTranscriptState,
  action: PreviewTranscriptAction,
): PreviewTranscriptState {
  if (action.type === 'preview-reset') {
    if (!state.bySession[action.sessionId]) return state
    const bySession = { ...state.bySession }
    delete bySession[action.sessionId]
    return { bySession }
  }

  const sessionId = action.cache.header.appSessionId
  const cacheFrames = action.cache.frames.filter(
    frame => frame.sessionId === sessionId,
  )
  let transcript = projectServerFrame(
    createTranscriptState(),
    previewReadyFrame(action.cache),
  )
  transcript = projectServerFrameBatched(transcript, batch(cacheFrames))
  const truncationMessage =
    cacheFrames.find(frame => frame.kind === 'error')?.message ?? null

  return {
    bySession: {
      ...state.bySession,
      [sessionId]: { transcript, truncationMessage },
    },
  }
}

export function selectPreviewTranscript(
  state: PreviewTranscriptState,
  sessionId: SessionId,
): TranscriptState | null {
  return state.bySession[sessionId]?.transcript ?? null
}

export function selectPreviewTruncationMessage(
  state: PreviewTranscriptState,
  sessionId: SessionId,
): string | null {
  return state.bySession[sessionId]?.truncationMessage ?? null
}

export function hasPreviewTranscript(
  state: PreviewTranscriptState,
  sessionId: SessionId,
): boolean {
  return state.bySession[sessionId] !== undefined
}

/**
 * The real swap observations available without widening the protocol. Main
 * coalesces a lazy restore's bootstrap frames, so a batch containing replayed
 * history is the history swap, while ready+input-enabled is the zero-history
 * swap. There is no replay-complete frame in the current sidecar stream.
 */
export function selectPreviewSwapSessions(
  frames: readonly ServerFrame[],
  previewing: ReadonlySet<SessionId>,
): SessionId[] {
  const swap = new Set<SessionId>()
  for (const frame of frames) {
    if (!previewing.has(frame.sessionId)) continue
    if (
      (frame.kind === 'event' && frame.replay === true) ||
      (frame.kind === 'ready' && frame.payload.inputEnabled)
    ) {
      swap.add(frame.sessionId)
    }
  }
  return [...swap]
}

/** First engagement wins across composer focus, pointer-down, and pane dwell. */
export function claimLazyRestore(
  claimed: Set<SessionId>,
  sessionId: SessionId,
): boolean {
  if (claimed.has(sessionId)) return false
  claimed.add(sessionId)
  return true
}

export function previewClosePlan(
  live: boolean,
  restoreClaimed: boolean,
): { cancelRestore: boolean; closeLive: boolean } {
  return {
    cancelRestore: restoreClaimed,
    closeLive: live,
  }
}

function previewReadyFrame(cache: TranscriptCache): ReadyFrame {
  return {
    kind: 'ready',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: cache.header.appSessionId,
    engineSessionId:
      cache.header.engineSessionId ?? `preview:${cache.header.appSessionId}`,
    payload: {
      type: 'app.ready',
      protocolVersion: PROTOCOL_VERSION,
      inputEnabled: false,
      activeTurn: false,
      abort: { status: 'idle' },
      goalSnapshot: null,
      pendingPermissionRequests: [],
    },
  }
}
