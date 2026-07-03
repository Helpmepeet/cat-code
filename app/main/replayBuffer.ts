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
 * Retention: the single `ready` frame per session is kept as a permanent head
 * outside the replay budget (a late renderer must recover its session id).
 * Non-ready frames are bounded by BOTH count and their serialized UTF-8 JSON
 * bytes. Oldest frames are evicted until both limits hold. A frame larger than
 * the whole byte budget is not retained. Any eviction/omission inserts one
 * synthetic error boundary between `ready` and retained frames, so consumers
 * cannot mistake a lossy replay for complete history.
 */

import {
  PROTOCOL_VERSION,
  type ServerFrame,
  type SessionId,
} from '../shared/protocol.js'

/** Default cap on retained non-ready frames per session. */
export const DEFAULT_MAX_BUFFERED_FRAMES = 512
/** Default UTF-8 JSON byte budget for retained non-ready frames, per session. */
export const DEFAULT_MAX_BUFFERED_BYTES = 8 * 1024 * 1024

const REPLAY_TRUNCATION_REQUEST_ID = 'catcode.replay-truncated'
const REPLAY_TRUNCATION_MESSAGE =
  'Earlier session events were omitted because the renderer replay buffer reached its retention limit.'

type SessionEntry = {
  ready: ServerFrame | null
  recent: ServerFrame[]
  recentBytes: number
  truncated: boolean
}

export class FrameReplayBuffer {
  private readonly sessions = new Map<SessionId, SessionEntry>()

  constructor(
    private readonly maxRecent: number = DEFAULT_MAX_BUFFERED_FRAMES,
    private readonly maxRecentBytes: number = DEFAULT_MAX_BUFFERED_BYTES,
  ) {}

  /** Record one frame. The `ready` frame replaces the head; others ring-buffer. */
  record(sessionId: SessionId, frame: ServerFrame): void {
    let entry = this.sessions.get(sessionId)
    if (!entry) {
      entry = { ready: null, recent: [], recentBytes: 0, truncated: false }
      this.sessions.set(sessionId, entry)
    }
    if (frame.kind === 'ready') {
      entry.ready = frame
      return
    }
    const frameBytes = serializedUtf8Bytes(frame)
    if (frameBytes > this.maxRecentBytes) {
      entry.recent = []
      entry.recentBytes = 0
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
   */
  snapshot(): ServerFrame[] {
    const frames: ServerFrame[] = []
    for (const [sessionId, entry] of this.sessions) {
      if (entry.ready) frames.push(entry.ready)
      if (entry.truncated) frames.push(replayTruncationFrame(sessionId))
      frames.push(...entry.recent)
    }
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
    frame.requestId === REPLAY_TRUNCATION_REQUEST_ID
  )
}

function replayTruncationFrame(sessionId: SessionId): ServerFrame {
  return {
    kind: 'error',
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    requestId: REPLAY_TRUNCATION_REQUEST_ID,
    code: 'internal_error',
    message: REPLAY_TRUNCATION_MESSAGE,
    retryable: false,
  }
}

function serializedUtf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}
