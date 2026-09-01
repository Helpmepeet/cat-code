/**
 * Per-session server-frame replay buffer (review finding F2).
 *
 * Server frames arrive from the supervisor the moment a sidecar attaches — the
 * one-shot `ready` handshake and (in P1-0) the probe `tool_use` — which is
 * BEFORE the renderer has mounted and registered its `subscribe`, and there is
 * nothing to receive them at all after a renderer reload. A fire-and-forget
 * `webContents.send` therefore loses those frames permanently, so the renderer
 * hangs at `connecting…`, never learns its `sessionId`, and never sees the probe.
 *
 * This buffer decouples "a frame was produced" from "a renderer is attached":
 * main records every frame here, and when the renderer announces readiness it
 * replays the buffer. It is Electron-free and pure so the attachment lifecycle
 * (the hop the P1-0 tests otherwise cannot exercise) is unit-testable without an
 * Electron process.
 *
 * Retention has four tiers, one per frame kind (`FRAME_RETENTION` below):
 *
 *  - `head` — the single `ready` frame per session, a permanent head outside
 *    the replay budget (a late renderer must recover its session id).
 *  - `sticky` — the once-per-attach state snapshots the sidecar sends in one
 *    burst right after `ready` and before history replay
 *    (`app/sidecar/sidecarServer.ts` `addConnection`). Nothing re-sends them on
 *    a renderer reload — main never re-runs connect() — so an evicted one is
 *    gone until the session is respawned, and the renderer reattaches with no
 *    settings, no model/effort chip, and no permission mode. They therefore get
 *    one slot each, outside the replay budget, replaced (never appended) by a
 *    later snapshot of the same kind, and replayed in the order they first
 *    arrived, which is the order the sidecar deliberately sends them in.
 *  - `ring` — transcript `event` traffic, transcript reset barriers,
 *    request-scoped replies, and lifecycle. Bounded by BOTH count and serialized UTF-8 JSON
 *    bytes; oldest evicted until both limits hold, and a frame larger than the
 *    whole byte budget is not retained. One `event` frame is exempt from
 *    retention entirely — a `recovered` one, see `record` (B2).
 *  - `preview` — generated-image bytes, keyed by tool-use id and bounded by
 *    their own byte budget. A preview can be larger than the transcript ring;
 *    keeping it outside that ring prevents one image from erasing the result
 *    event it must correlate with after a renderer reload.
 *
 * Sticky storage is bounded by construction: one slot per `sticky` kind in the
 * table, so it can never grow into a second unbounded store. Any
 * eviction/omission inserts one synthetic error boundary between the sticky
 * frames and the retained ring, so consumers cannot mistake a lossy replay
 * for complete history.
 */

import {
  PROTOCOL_VERSION,
  REPLAY_BUFFER_TRUNCATION_REQUEST_ID,
  type ServerFrame,
  type SessionId,
} from '../shared/protocol.js'
import { MAX_OUTBOUND_FRAME_BYTES } from '../shared/limits.js'

/**
 * Default cap on retained `ring` frames per session (`head`/`sticky` are
 * outside it).
 *
 * Sized from MEASURED sessions, 2026-07-27. The previous 512 dated from the
 * P1-0 walking skeleton, when a whole session was a handshake plus one probe
 * tool call; it was never re-measured against real traffic. Six real sessions
 * in this repo's own transcript store held 223–1,413 finished messages
 * (assistant/user/system) for 1.3–4.2 MB on the wire, and each message is
 * several frames once streamed partials are counted — so 512 ran out at
 * roughly a QUARTER of one working session, which is what the operator hit.
 *
 * The count is therefore raised until the BYTE budget below is what actually
 * binds: memory is the thing worth bounding, and a frame tally sitting far
 * beneath the byte ceiling only ever truncates early without saving anything.
 *
 * The bound this costs is the ELECTRON MAIN process, not an engine process: the
 * engines are N separate processes, while `FrameReplayBuffer.sessions` is one
 * Map in main. The transcript-ring ceiling is therefore `MAX_LIVE_SESSIONS`
 * (32, `app/shared/hostApi.ts`) × `DEFAULT_MAX_BUFFERED_BYTES` (8 MiB) = 256 MiB
 * of serialized JSON held as parsed objects, all in main. Generated images use
 * the separately bounded 32 MiB preview tier below, for a combined worst-case
 * ceiling of 1.25 GiB across 32 simultaneously image-heavy live sessions.
 * Steady state is far below either ceiling because idle-park frees a parked
 * session's buffer.
 */
export const DEFAULT_MAX_BUFFERED_FRAMES = 8_000
/** Default UTF-8 JSON byte budget for retained `ring` frames, per session. */
export const DEFAULT_MAX_BUFFERED_BYTES = 8 * 1024 * 1024
/**
 * Generated-image previews use a separate per-session budget. Matching the
 * outbound frame cap guarantees that any preview delivered live can occupy the
 * bounded replay slot without consuming the transcript ring.
 */
export const DEFAULT_MAX_BUFFERED_PREVIEW_BYTES = MAX_OUTBOUND_FRAME_BYTES
/** Max retained generated-image preview frames per live session. */
export const DEFAULT_MAX_BUFFERED_PREVIEWS = 32

const PREVIEW_REPLAY_TRUNCATION_REQUEST_ID =
  'catcode.preview-replay-truncated'

type FrameRetention = 'head' | 'sticky' | 'ring' | 'preview'

/**
 * Retention tier per frame kind. Exhaustive by construction — a
 * `Record<ServerFrame['kind'], …>` makes tsc fail when the protocol union
 * grows, so a NEW once-per-attach snapshot has to be classified here instead of
 * silently landing in the evictable ring (the defect this table fixes).
 *
 * `sticky` lists exactly the once-per-attach state frames, in the send order of
 * `SidecarServer.addConnection`. A few of them also re-broadcast on change
 * (settings / run-controls / accounts / goal / memory / tasks / agent-mode /
 * workspace-trust / remoteSettings / permission.context / queued-prompts); a
 * re-broadcast replaces the slot's value and keeps its original position,
 * because these are point-in-time state a reader applies wholesale, not
 * transcript rows whose position carries meaning.
 *
 * `ring` covers transcript traffic (`event` and `transcript.reset`), request-scoped replies
 * (`*.result`, `pong`, `error`, `oauth.login.progress`), `lifecycle`, and the
 * two kinds this buffer never sees: `session-title` (main consumes it and
 * relays it to the durable registry, `main.ts:674`) and `sessions.snapshot`
 * (catalog decision #4 — a main-supervised worker owns the catalog, the sidecar
 * no longer emits it on attach).
 */
const FRAME_RETENTION: Record<ServerFrame['kind'], FrameRetention> = {
  ready: 'head',

  'permission.context': 'sticky',
  'settings.snapshot': 'sticky',
  'agent-config.snapshot': 'sticky',
  'thread-goal.snapshot': 'sticky',
  'memory.snapshot': 'sticky',
  'tasks.snapshot': 'sticky',
  'agent-mode.snapshot': 'sticky',
  'lease.snapshot': 'sticky',
  'run-controls.snapshot': 'sticky',
  'context-breakdown.snapshot': 'sticky',
  'accounts.snapshot': 'sticky',
  'workspace-trust.snapshot': 'sticky',
  'diagnostics.snapshot': 'sticky',
  'extensions.snapshot': 'sticky',
  'remoteSettings.snapshot': 'sticky',
  'slash-catalog.snapshot': 'sticky',
  'stats.usage.snapshot': 'sticky',
  // Sticky, not ring: this is the list of messages waiting for the running
  // response, applied wholesale and replaced by the next one. A reload during a
  // long turn would otherwise lose the rows for messages the user has already
  // sent, putting them back in the state D1a exists to fix — invisible.
  //
  // What makes that classification correct rather than merely safe is that the
  // slot's value is always replaced by a LATER list for the same session — but
  // the sidecar does NOT republish on every change: a change with no connection
  // open is deliberately not published at all, so its own list can move on while
  // this slot still holds the last one it sent. The corrective is at attach,
  // where the sidecar re-sends its current list (including the EMPTY one) if the
  // last list it published was not empty. On a fresh session with nothing ever
  // waiting there is no frame and no slot, which is also correct.
  'queued-prompts.snapshot': 'sticky',
  // Ring, with the same request-scoped reasoning as the `*.result` frames below:
  // it answers ONE submit, addressed to a correlation id the renderer minted, so
  // a reader that did not mint it has nothing to do with it. A replayed one is
  // inert for the same reason (a reload starts with no retained submits).
  'submit.result': 'ring',

  event: 'ring',
  'transcript.reset': 'ring',
  'generated-image-preview': 'preview',
  pong: 'ring',
  error: 'ring',
  lifecycle: 'ring',
  'session-title': 'ring',
  'sessions.snapshot': 'ring',
  'agent-mode.set.result': 'ring',
  'task-control.result': 'ring',
  'run-control.result': 'ring',
  'session-action.result': 'ring',
  'account.result': 'ring',
  'oauth.login.progress': 'ring',
  'workspace.trust.result': 'ring',
  'remoteSettings.result': 'ring',
  'settings.result': 'ring',
  // Ring, with the same request-scoped reasoning as its `*.result` siblings, and
  // deliberately NOT sticky: it is the answer to one recall the user asked for,
  // not state a fresh reader should be brought up to date on. Pinning it would
  // hand the recalled text back to every later attach, long after the user
  // resent or discarded it. The renderer additionally ignores a replayed result
  // it did not mint the requestId for, so an evicting ring is the only thing
  // this classification has to get right.
  'prompt-recall.result': 'ring',
  // Ring for the same reason: this answers one send-now request, while the queue
  // state it acted on is already represented by the sticky queued snapshot.
  'prompt-force.result': 'ring',
  // Ring, same request-scoped reasoning: it closes ONE load-earlier the user
  // asked for, addressed to a requestId that reader minted. The messages it
  // completes ride `event` frames and are retained as transcript traffic like
  // every other event; pinning the completion itself would replay a finished
  // answer to every later attach.
  'history.loadEarlier.result': 'ring',
}

/** The once-per-attach kinds that survive ring eviction, for tests + callers. */
export const STICKY_FRAME_KINDS: readonly ServerFrame['kind'][] = (
  Object.keys(FRAME_RETENTION) as ServerFrame['kind'][]
).filter(kind => FRAME_RETENTION[kind] === 'sticky')

type SessionEntry = {
  ready: ServerFrame | null
  /**
   * One slot per `sticky` kind. Keyed by kind so a later snapshot REPLACES the
   * earlier one; a `Map` because re-setting an existing key keeps its original
   * insertion position, which is what preserves the sidecar's deliberate
   * attach-burst order across a replay.
   */
  sticky: Map<ServerFrame['kind'], ServerFrame>
  recent: ServerFrame[]
  recentBytes: number
  previews: Map<
    string,
    { frame: Extract<ServerFrame, { kind: 'generated-image-preview' }>; bytes: number }
  >
  previewBytes: number
  truncated: boolean
  previewTruncated: boolean
}

export class FrameReplayBuffer {
  private readonly sessions = new Map<SessionId, SessionEntry>()

  constructor(
    private readonly maxRecent: number = DEFAULT_MAX_BUFFERED_FRAMES,
    private readonly maxRecentBytes: number = DEFAULT_MAX_BUFFERED_BYTES,
    private readonly maxPreviewBytes: number = DEFAULT_MAX_BUFFERED_PREVIEW_BYTES,
    private readonly maxPreviews: number = DEFAULT_MAX_BUFFERED_PREVIEWS,
  ) {}

  /**
   * Record one frame. The `ready` head and each once-per-attach snapshot kind
   * replace their own slot; everything else ring-buffers.
   */
  record(sessionId: SessionId, frame: ServerFrame): void {
    let entry = this.sessions.get(sessionId)
    if (!entry) {
      entry = {
        ready: null,
        sticky: new Map(),
        recent: [],
        recentBytes: 0,
        previews: new Map(),
        previewBytes: 0,
        truncated: false,
        previewTruncated: false,
      }
      this.sessions.set(sessionId, entry)
    }
    const retention = FRAME_RETENTION[frame.kind]
    if (frame.kind === 'transcript.reset') {
      entry.recent = []
      entry.recentBytes = 0
      entry.truncated = false
      entry.previews.clear()
      entry.previewBytes = 0
      entry.previewTruncated = false
    }
    if (retention === 'head') {
      entry.ready = frame
      return
    }
    if (retention === 'sticky') {
      entry.sticky.set(frame.kind, frame)
      return
    }
    if (retention === 'preview') {
      if (frame.kind !== 'generated-image-preview') return
      const frameBytes = serializedUtf8Bytes(frame)
      const existing = entry.previews.get(frame.toolUseId)
      if (existing) {
        entry.previewBytes -= existing.bytes
        entry.previews.delete(frame.toolUseId)
      }
      if (frameBytes > this.maxPreviewBytes) {
        entry.previewTruncated = true
        return
      }
      entry.previews.set(frame.toolUseId, { frame, bytes: frameBytes })
      entry.previewBytes += frameBytes
      while (
        entry.previews.size > this.maxPreviews ||
        entry.previewBytes > this.maxPreviewBytes
      ) {
        const oldest = entry.previews.entries().next().value
        if (!oldest) break
        const [toolUseId, retained] = oldest
        entry.previews.delete(toolUseId)
        entry.previewBytes -= retained.bytes
        entry.previewTruncated = true
      }
      return
    }
    // B2 (decisions/HISTORY-LOAD-EARLIER.md). Recovered history is NOT retained.
    //
    // It cannot be discriminated in `FRAME_RETENTION` above: that table is keyed
    // by frame KIND, and a recovered frame and a restore replay are both
    // `event`. So the decision lives here, where the ring decides to retain, and
    // the table's exhaustiveness tripwire is left alone.
    //
    // The ring evicts oldest-BY-ARRIVAL, and recovered frames are the oldest
    // messages arriving LAST. Retaining them would evict live frames from the
    // middle of the session while keeping ancient ones, so a renderer reload
    // would replay a transcript with a hole in it — strictly worse than the
    // contiguous tail the boundary row promises. Recovered history is
    // re-fetchable from disk on demand, so dropping it costs one more click and
    // keeps every retained tail contiguous.
    //
    // Deliberately NOT marking `entry.truncated`: nothing was evicted and the
    // retained tail is exactly as complete as it was a moment ago. The boundary
    // row the renderer draws from the sidecar's own signal still says what is
    // true, that there is more above what this pane holds.
    if (frame.kind === 'event' && frame.recovered === true) return

    const frameBytes = serializedUtf8Bytes(frame)
    if (frameBytes > this.maxRecentBytes) {
      // Drop ONLY the oversized frame. `MAX_OUTBOUND_FRAME_BYTES` (32 MiB) is
      // deliberately four times this ring's default budget so a base64 image or
      // a large tool result still reaches the renderer, which makes this branch
      // reachable in a healthy session — clearing the ring here would erase an
      // entire session's replayable transcript (and, via `persistTranscriptCache`,
      // its at-rest preview) because one frame was big.
      entry.truncated = true
      return
    }

    entry.recent.push(frame)
    entry.recentBytes += frameBytes
    while (
      entry.recent.length > this.maxRecent ||
      entry.recentBytes > this.maxRecentBytes
    ) {
      const evicted = entry.recent.shift()
      if (!evicted) break
      entry.recentBytes -= serializedUtf8Bytes(evicted)
      entry.truncated = true
    }
  }

  /**
   * Everything a freshly-attached (or reloaded) renderer must receive to catch
   * up, in delivery order: each session's `ready` head first, then its buffered
   * frames. P1-0 has one session; the shape is already N-session ready.
   * Concatenates `snapshotSession` so the two can never drift apart.
   */
  snapshot(): ServerFrame[] {
    const frames: ServerFrame[] = []
    for (const sessionId of this.sessions.keys()) {
      frames.push(...this.snapshotSession(sessionId))
    }
    return frames
  }

  /**
   * One session's frames in delivery order: its `ready` head, then its sticky
   * once-per-attach snapshots in first-arrival order, then the truncation marker
   * if lossy, then its buffered recent frames and generated-image previews —
   * the single-session slice of `snapshot()`. Preview-after-result ordering is
   * intentional; the renderer projector supports either arrival order. Empty
   * when the session was never buffered.
   * Used by the transcript-cache persist path (IS-A); the permanent `ready` head
   * is INCLUDED here (like `snapshot()`) and dropped by the cache's `distill`
   * allowlist, so the ready-drop decision lives in exactly one place — the same
   * allowlist drops every sticky snapshot, so none of them reach a cached
   * transcript.
   */
  snapshotSession(sessionId: SessionId): ServerFrame[] {
    const entry = this.sessions.get(sessionId)
    if (!entry) return []
    const frames: ServerFrame[] = []
    if (entry.ready) frames.push(entry.ready)
    frames.push(...entry.sticky.values())
    if (entry.truncated) {
      frames.push(
        replayTruncationFrame(sessionId, retainedMessageCount(entry.recent)),
      )
    }
    frames.push(...entry.recent)
    if (entry.previewTruncated) {
      frames.push(previewReplayTruncationFrame(sessionId))
    }
    frames.push(...Array.from(entry.previews.values(), retained => retained.frame))
    return frames
  }

  /** Forget a session's buffer (e.g. its sidecar was torn down). */
  clearSession(sessionId: SessionId): void {
    this.sessions.delete(sessionId)
  }

  /** Forget every session's buffer (e.g. the desktop host was torn down). */
  clear(): void {
    this.sessions.clear()
  }
}

export function isReplayTruncationFrame(
  frame: ServerFrame | undefined,
): boolean {
  return (
    frame?.kind === 'error' &&
    frame.requestId === REPLAY_BUFFER_TRUNCATION_REQUEST_ID
  )
}

export function isPreviewReplayTruncationFrame(
  frame: ServerFrame | undefined,
): boolean {
  return (
    frame?.kind === 'error' &&
    frame.requestId === PREVIEW_REPLAY_TRUNCATION_REQUEST_ID
  )
}

/**
 * How many MESSAGES survived in the ring, which is not how many frames did.
 *
 * The ring budget is spent by everything that rides it: lifecycle, pongs,
 * request-scoped results, and — on a streaming provider — one `stream_event`
 * frame per delta alongside the finished assistant message. Reporting
 * `recent.length` as a message count therefore overstated it, on a chatty
 * session by several times (2026-08-19 review, finding 3). The retained count
 * varies per session because the BYTE budget is what actually binds
 * (`docs/reports/2026-08-19-transcript-retention-cap-measurement.md` §3), so it
 * is counted here at the moment of the cut and never derived from a constant.
 *
 * A `stream_event` is a partial of a message this ring also holds in full, so
 * counting it would double-count that message rather than measure history.
 */
function retainedMessageCount(frames: readonly ServerFrame[]): number {
  let retained = 0
  for (const frame of frames) {
    if (frame.kind !== 'event') continue
    if (frame.event.type !== 'message') continue
    if (frame.event.message.type === 'stream_event') continue
    retained += 1
  }
  return retained
}

function replayTruncationFrame(
  sessionId: SessionId,
  retained: number,
): ServerFrame {
  return {
    kind: 'error',
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    requestId: REPLAY_BUFFER_TRUNCATION_REQUEST_ID,
    code: 'internal_error',
    message: `Only the ${retained} most recent messages are shown.`,
    retryable: false,
  }
}

function previewReplayTruncationFrame(sessionId: SessionId): ServerFrame {
  return {
    kind: 'error',
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    requestId: PREVIEW_REPLAY_TRUNCATION_REQUEST_ID,
    code: 'internal_error',
    message: 'Some earlier generated image previews are no longer available.',
    retryable: false,
  }
}

function serializedUtf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}
