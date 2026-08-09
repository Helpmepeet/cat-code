import {
  PROTOCOL_VERSION,
  type ReadyFrame,
  type ServerFrame,
  type SessionId,
  type TranscriptCache,
} from '../../shared/protocol.js'
import type { SDKMessage } from '@cat-code/engine/sdk'
import { selectContextUsage, type ContextUsage } from './contextUsage.js'
import { REPLAY_BUFFER_TRUNCATION_REQUEST_ID } from './rawMessageLog.js'
import {
  batch,
  withBatch,
  type BatchAction,
} from './serverFrameBatch.js'
import {
  createTranscriptState,
  projectServerFrame,
  resetTranscriptSession,
  type TranscriptState,
} from './transcriptProjector.js'

export type PreviewTranscriptEntry = {
  transcript: TranscriptState
  truncationMessage: string | null
  /**
   * What the composer rail can honestly say about a session with no engine.
   *
   * A previewed session has no sidecar, so every live seam the rail normally
   * reads (`run-controls`, `diagnostics`, `permission.context`) is absent and
   * the rail renders blank. But the cached transcript is the session's own
   * traffic, so the model it ran on and the context it ended at are REAL and
   * already in hand. `null` on either means the cache genuinely does not say
   * (an empty or truncated-past-the-evidence transcript), and the rail then
   * shows nothing rather than a zero.
   */
  runFacts: PreviewRunFacts
}

export type PreviewRunFacts = {
  /** The newest assistant message's `model`, or null when none carried one. */
  model: string | null
  /** Context at the session's last `result`, or null when no result is cached. */
  contextUsage: ContextUsage | null
  /**
   * The newest `permissionMode` the transcript carries. Verified against real
   * transcripts (2026-07-27): it rides USER messages, not the `system`/`init`
   * frame the type snapshot declares it on, so it is read positionally off any
   * message that carries it rather than bound to a declared message type. The
   * value may be an engine-internal mode such as `auto` that the mode PICKER
   * cannot select, which is exactly why this is display-only.
   */
  permissionMode: string | null
  /**
   * The newest reasoning effort actually sent, off `system`/`codex_send_path`.
   * Codex/GPT sessions only; an Anthropic session carries no effort record and
   * leaves this null.
   */
  effort: string | null
}

export type PreviewTranscriptState = {
  bySession: Record<SessionId, PreviewTranscriptEntry>
}

export type PreviewTranscriptAction =
  | {
      type: 'preview-load'
      cache: TranscriptCache
      projected?: PreviewTranscriptEntry
    }
  | { type: 'preview-reset'; sessionId: SessionId }

export type LiveTranscriptAction =
  | ServerFrame
  | BatchAction<ServerFrame>
  | { type: 'preview-live-reset'; sessionId: SessionId }

const projectServerFrameBatched = withBatch(projectServerFrame)

export function createPreviewTranscriptState(): PreviewTranscriptState {
  return { bySession: {} }
}

export function reduceLiveTranscriptState(
  state: TranscriptState,
  action: LiveTranscriptAction,
): TranscriptState {
  if ('type' in action && action.type === 'preview-live-reset') {
    // Empty, never forget: the batch carrying this handover may not carry the
    // `ready` frame that would rebuild the session, and the projector discards
    // events for an unknown session. See `resetTranscriptSession`.
    return resetTranscriptSession(state, action.sessionId)
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
  const entry = action.projected ?? projectPreviewTranscriptCache(action.cache)

  return {
    bySession: {
      ...state.bySession,
      [sessionId]: entry,
    },
  }
}

/** Project one cache before admission so startup preload budgets projected RAM. */
export function projectPreviewTranscriptCache(
  cache: TranscriptCache,
): PreviewTranscriptEntry {
  const sessionId = cache.header.appSessionId
  const cacheFrames = cache.frames.filter(frame => frame.sessionId === sessionId)
  let transcript = projectServerFrame(
    createTranscriptState(),
    previewReadyFrame(cache),
  )
  transcript = projectServerFrameBatched(transcript, batch(cacheFrames))
  // The replay buffer's retention notice is not a boundary message: retention is
  // working as designed and there is nothing for the user to act on, which is
  // why the live pane drops it too (`rawMessageLog.ts`). `transcriptCache.ts:129`
  // keeps the frame deliberately, so it has to be excluded here rather than
  // upstream. The history-replay sibling IS a real boundary and still shows.
  let truncationMessage: string | null = null
  for (const frame of cacheFrames) {
    if (frame.kind !== 'error') continue
    if (frame.requestId === REPLAY_BUFFER_TRUNCATION_REQUEST_ID) continue
    truncationMessage = frame.message
    break
  }
  return {
    transcript,
    truncationMessage,
    runFacts: selectPreviewRunFacts(cache),
  }
}

/**
 * Read the run facts back out of a cached session's own frames.
 *
 * Runtime-narrowed with no casts, projector-style: a cache is JSON that was on
 * disk, so nothing about its shape is guaranteed. `selectContextUsage` is the
 * SAME function the live composer donut uses, so a previewed session's context
 * is computed exactly as a live one's is, never approximated.
 */
export function selectPreviewRunFacts(cache: TranscriptCache): PreviewRunFacts {
  const sessionId = cache.header.appSessionId
  const frames = cache.frames.filter(frame => frame.sessionId === sessionId)
  // The HEADER wins when present, WHOLESALE — it is one coherent snapshot, and
  // merging a frame-derived value into it would rebuild the incoherence the
  // snapshot exists to remove. Both writers read the raw transcript, which still
  // carries the mode/effort/usage the engine's message conversion drops, and the
  // frames below cannot recover effort at all.
  //
  // Because this trusts it wholesale, a header is written ONLY when it is
  // complete on every field the scan below could otherwise supply
  // (`transcriptCache.ts` `resolveCacheRunFacts`). A cache whose session ran
  // before the engine recorded run facts still arrives headerless, and its
  // frames DO hold a live `result`, so the scan is the fallback rather than
  // dead code.
  const header = cache.header.runFacts
  if (header) {
    return {
      model: header.model,
      permissionMode: header.permissionMode,
      effort: header.effort,
      contextUsage:
        header.usedTokens === null
          ? null
          : {
              usedTokens: header.usedTokens,
              contextWindow: header.contextWindow ?? DEFAULT_PREVIEW_WINDOW,
              percentUsed: percentOf(
                header.usedTokens,
                header.contextWindow ?? DEFAULT_PREVIEW_WINDOW,
              ),
            },
    }
  }
  return selectRunFactsFromFrames(frames)
}

/** Matches `contextUsage.ts`'s default when no turn reported a real window. */
const DEFAULT_PREVIEW_WINDOW = 200_000

function percentOf(used: number, window: number): number {
  if (window <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((used / window) * 100)))
}

function selectRunFactsFromFrames(
  frames: readonly ServerFrame[],
): PreviewRunFacts {
  const messages: SDKMessage[] = []
  for (const frame of frames) {
    if (frame.kind !== 'event') continue
    const event: unknown = frame.event
    if (!isRecord(event) || event.type !== 'message') continue
    const message: unknown = event.message
    if (!isRecord(message) || typeof message.type !== 'string') continue
    messages.push(message as SDKMessage)
  }

  // One backwards pass: each fact is the NEWEST the transcript records, since a
  // session can switch model, mode, or effort part-way through and what it ran
  // on last is what the rail should say. Stop as soon as all three are known.
  let model: string | null = null
  let permissionMode: string | null = null
  let effort: string | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message) continue
    model ??= readAssistantModel(message)
    permissionMode ??= readStringField(message, 'permissionMode')
    effort ??= readSendPathEffort(message)
    if (model && permissionMode && effort) break
  }

  // No cached `result` means no usage was ever reported, and a 0% donut would
  // claim the session used nothing. `hasResult` distinguishes that from a real
  // zero so the caller can render nothing instead.
  const hasResult = messages.some(message => message.type === 'result')
  return {
    model,
    contextUsage: hasResult ? selectContextUsage(messages, model) : null,
    permissionMode,
    effort,
  }
}

function readAssistantModel(message: SDKMessage): string | null {
  if (message.type !== 'assistant') return null
  const inner: unknown = message.message
  if (!isRecord(inner)) return null
  return typeof inner.model === 'string' && inner.model ? inner.model : null
}

/** The effort a request was actually sent with (`system`/`codex_send_path`). */
function readSendPathEffort(message: SDKMessage): string | null {
  if (message.type !== 'system') return null
  // Read `subtype` positionally: `codex_send_path` is real in transcripts but
  // absent from the snapshot's declared subtype union, so comparing against the
  // typed field is a compile error AND would narrow to never at runtime.
  if (readStringField(message, 'subtype') !== 'codex_send_path') return null
  return readStringField(message, 'effort')
}

/**
 * Read a top-level string off a message whose declared type does not admit it.
 * The cache is JSON that was on disk and the snapshot types are known to lag
 * what the engine actually writes, so this narrows rather than casts.
 */
function readStringField(message: SDKMessage, field: string): string | null {
  if (!isRecord(message)) return null
  const value: unknown = message[field]
  return typeof value === 'string' && value ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function selectPreviewTranscript(
  state: PreviewTranscriptState,
  sessionId: SessionId,
): TranscriptState | null {
  return state.bySession[sessionId]?.transcript ?? null
}

export function selectPreviewRunFactsFor(
  state: PreviewTranscriptState,
  sessionId: SessionId | null,
): PreviewRunFacts | null {
  return sessionId ? (state.bySession[sessionId]?.runFacts ?? null) : null
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

/** The actual click-path decision: a store hit opens without invoking fallback. */
export function openPreloadedPreview(
  state: PreviewTranscriptState,
  sessionId: SessionId,
  open: () => void,
): boolean {
  if (!hasPreviewTranscript(state, sessionId)) return false
  open()
  return true
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

/**
 * The handover is once per session, claimed synchronously by the caller.
 *
 * A restore does NOT always arrive in one batch: main coalesces the bootstrap
 * window for `LAZY_REPLAY_FLUSH_MS` only (`app/main/attachmentGate.ts`), so a
 * large history flushes as `ready` + a first slice, then bare replay batches.
 * Those later batches carry a `replay: true` frame for a session still listed
 * as previewing, so `selectPreviewSwapSessions` names it again — and a second
 * `preview-live-reset` deletes the live session state that only the `ready`
 * frame creates. `projectServerFrame` drops an `event` frame for a session with
 * no state, so every remaining history frame was discarded and the pane fell
 * back to the empty-session Welcome with the cache already gone.
 */
export function claimPreviewSwaps(
  claimed: Set<SessionId>,
  sessionIds: readonly SessionId[],
): SessionId[] {
  return sessionIds.filter(sessionId => {
    if (claimed.has(sessionId)) return false
    claimed.add(sessionId)
    return true
  })
}

/** The three ordered effects one delivered batch can have on the handover. */
export type PreviewHandoverPorts = {
  /** Empty the live rows of a session handing over (`preview-live-reset`). */
  resetLiveSession: (sessionId: SessionId) => void
  /** Project the batch into every store — always runs, swap or not. */
  applyFrames: () => void
  /** Drop the now-superseded cache (`preview-reset`). */
  resetPreview: (sessionId: SessionId) => void
}

/**
 * Apply one delivered batch's preview→live handover, in the order that matters.
 *
 * This lives here rather than inline in App's `subscribe` callback because the
 * ORDER is the load-bearing part, and a callback that only works by React
 * batching happenstance cannot be tested (the renderer suite renders to static
 * markup, so no subscription ever runs). Clearing the live rows must precede
 * the batch: both go to the SAME reducer, so reversing them wipes the batch.
 * Dropping the cache targets a different reducer and is order-free — it is kept
 * last because that is the sequence the pane reads as, not because an
 * intermediate state would render (all three land in one React commit).
 *
 * The reset is scoped to sessions whose `ready` frame is in THIS batch. Its job
 * is to drop rows a previous connection left behind, and `ready` is the only
 * frame that marks a new connection starting. A handover firing on a later
 * batch of the same replay must not empty what earlier batches of that same
 * replay already projected — that would be silent partial history loss, the
 * exact failure this module exists to prevent.
 *
 * Returns the sessions that handed over, for the caller's own bookkeeping.
 */
export function applyPreviewHandover(
  frames: readonly ServerFrame[],
  previewing: ReadonlySet<SessionId>,
  claimed: Set<SessionId>,
  ports: PreviewHandoverPorts,
): SessionId[] {
  const swapped = claimPreviewSwaps(
    claimed,
    selectPreviewSwapSessions(frames, previewing),
  )
  const connectionStarts = new Set<SessionId>()
  for (const frame of frames) {
    if (frame.kind === 'ready') connectionStarts.add(frame.sessionId)
  }
  for (const sessionId of swapped) {
    if (connectionStarts.has(sessionId)) ports.resetLiveSession(sessionId)
  }
  ports.applyFrames()
  for (const sessionId of swapped) ports.resetPreview(sessionId)
  return swapped
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
