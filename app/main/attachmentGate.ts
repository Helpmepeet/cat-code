/**
 * Renderer attachment state machine (review finding F2).
 *
 * Owns the decision behind main's renderer bridge: WHICH frames to deliver to the
 * renderer's `webContents` in response to each event, so nothing is lost before
 * the renderer attaches and nothing is delivered twice. Electron-free and pure so
 * the lifecycle — including the reload and React-StrictMode double-signal paths
 * that a live Electron test would otherwise be the only way to exercise — is
 * unit-testable. `main.ts` is a thin adapter: it calls a method and `send`s the
 * returned frames.
 *
 * The contract per document load:
 *   - frames produced BEFORE the renderer announces readiness are buffered;
 *   - the FIRST `rendererReady` of a load replays the buffer once (ready head +
 *     recent frames);
 *   - after that, frames are forwarded live as they arrive;
 *   - a REPEAT `rendererReady` on the same load delivers NOTHING (StrictMode
 *     mounts the effect twice, so the renderer signals twice — replaying again
 *     would duplicate the ready/probe and any frame delivered in between);
 *   - `onNavigationStart` (a reload or a fresh window) re-arms, so the next
 *     `rendererReady` replays again for the new document.
 */

import { FrameReplayBuffer } from './replayBuffer.js'
import {
  HISTORY_REPLAY_TRUNCATION_REQUEST_ID,
  type ServerFrame,
  type SessionId,
} from '../shared/protocol.js'
import {
  MAX_HISTORY_REPLAY_BYTES,
  MAX_HISTORY_REPLAY_FRAMES,
} from '../shared/limits.js'

export const LAZY_REPLAY_FLUSH_MS = 50

type ReplayCoalescingEntry = {
  mode: 'lazy-restore' | 'rewind'
  frames: ServerFrame[]
  replayFrames: number
  replayBytes: number
  sawReplay: boolean
}

type ReplayCoalescingLimits = {
  maxFrames: number
  maxBytes: number
}

export class AttachmentGate {
  private readonly buffer: FrameReplayBuffer
  private readonly replayLimits: ReplayCoalescingLimits
  private readonly replayCoalescing = new Map<
    SessionId,
    ReplayCoalescingEntry
  >()
  private attached = false

  constructor(
    buffer: FrameReplayBuffer = new FrameReplayBuffer(),
    replayLimits: ReplayCoalescingLimits = {
      maxFrames: MAX_HISTORY_REPLAY_FRAMES,
      maxBytes: MAX_HISTORY_REPLAY_BYTES,
    },
  ) {
    this.buffer = buffer
    this.replayLimits = replayLimits
  }

  /**
   * A frame arrived from the supervisor. Always buffered; returned for live
   * delivery only if a renderer is currently attached (else it waits for replay).
   */
  onFrame(sessionId: SessionId, frame: ServerFrame): ServerFrame[] {
    this.buffer.record(sessionId, frame)
    if (!this.attached) return []

    const entry = this.replayCoalescing.get(sessionId)
    if (!entry) {
      if (frame.kind !== 'transcript.reset') return [frame]
      this.replayCoalescing.set(sessionId, {
        mode: 'rewind',
        frames: [frame],
        replayFrames: 0,
        replayBytes: 0,
        sawReplay: false,
      })
      return []
    }

    const replay = frame.kind === 'event' && frame.replay === true
    const historyTruncation =
      frame.kind === 'error' &&
      frame.requestId === HISTORY_REPLAY_TRUNCATION_REQUEST_ID
    if (replay) {
      const frameBytes =
        entry.mode === 'rewind'
          ? serializedBareServerFrameUtf8Bytes(frame)
          : serializedUtf8Bytes(frame)
      if (frameBytes > this.replayLimits.maxBytes) {
        this.replayCoalescing.delete(sessionId)
        return [...entry.frames, frame]
      }
      if (
        entry.replayFrames >= this.replayLimits.maxFrames ||
        entry.replayBytes + frameBytes > this.replayLimits.maxBytes
      ) {
        if (entry.mode === 'rewind') {
          this.replayCoalescing.delete(sessionId)
          return [...entry.frames, frame]
        }
        const flushed = entry.frames
        this.replayCoalescing.set(sessionId, {
          mode: entry.mode,
          frames: [frame],
          replayFrames: 1,
          replayBytes: frameBytes,
          sawReplay: true,
        })
        return flushed
      }
      entry.replayFrames += 1
      entry.replayBytes += frameBytes
      entry.sawReplay = true
    }

    entry.frames.push(frame)
    if (entry.mode === 'rewind') {
      if (
        isSuccessfulEditFromMessageResult(frame) ||
        (frame.kind === 'error' && !historyTruncation) ||
        frame.kind === 'lifecycle'
      ) {
        this.replayCoalescing.delete(sessionId)
        return entry.frames
      }
      return []
    }
    if (
      (entry.sawReplay && !replay) ||
      (frame.kind === 'error' && !historyTruncation) ||
      frame.kind === 'lifecycle'
    ) {
      this.replayCoalescing.delete(sessionId)
      return entry.frames
    }
    return []
  }

  /**
   * Begin one lazy restore's bootstrap batch. Ready and snapshot frames precede
   * history replay in the real sidecar attach order, so they wait with the replay
   * instead of exposing a live-ready empty pane before history lands.
   */
  startReplayCoalescing(sessionId: SessionId): void {
    if (this.replayCoalescing.has(sessionId)) return
    this.replayCoalescing.set(sessionId, {
      mode: 'lazy-restore',
      frames: [],
      replayFrames: 0,
      replayBytes: 0,
      sawReplay: false,
    })
  }

  /** Flush the bootstrap/replay batch when main's short window expires. */
  flushReplayCoalescing(sessionId: SessionId): ServerFrame[] {
    const entry = this.replayCoalescing.get(sessionId)
    if (!entry) return []
    this.replayCoalescing.delete(sessionId)
    return entry.frames
  }

  /** Cancel lazy mode after a typed restore failure without losing buffered frames. */
  cancelReplayCoalescing(sessionId: SessionId): ServerFrame[] {
    return this.flushReplayCoalescing(sessionId)
  }

  hasPendingReplayCoalescing(sessionId: SessionId): boolean {
    return (this.replayCoalescing.get(sessionId)?.frames.length ?? 0) > 0
  }

  isReplayCoalescing(sessionId: SessionId): boolean {
    return this.replayCoalescing.has(sessionId)
  }

  /** Whether main should arm its bounded lazy-restore flush timer. */
  isLazyReplayCoalescing(sessionId: SessionId): boolean {
    return this.replayCoalescing.get(sessionId)?.mode === 'lazy-restore'
  }

  /**
   * The renderer announced readiness. Replays the buffered snapshot once per
   * document load; a repeat signal on the same load returns nothing.
   */
  onRendererReady(): ServerFrame[] {
    if (this.attached) return []
    this.attached = true
    this.replayCoalescing.clear()
    return this.buffer.snapshot()
  }

  /** A new document is loading (reload or new window): re-arm for a fresh replay. */
  onNavigationStart(): void {
    this.attached = false
    this.replayCoalescing.clear()
  }

  /**
   * One session's buffered frames (IS-A transcript-cache persist path). Main
   * snapshots BEFORE evicting so a dead session's transcript can be distilled to
   * an at-rest cache. Thin pass-through to the buffer, mirroring `clearSession`.
   */
  snapshotSession(sessionId: SessionId): ServerFrame[] {
    return this.buffer.snapshotSession(sessionId)
  }

  /** Drop stale replay for one restarting session without detaching the renderer. */
  clearSession(sessionId: SessionId): void {
    this.replayCoalescing.delete(sessionId)
    this.buffer.clearSession(sessionId)
  }

  /** The session was torn down (macOS window-all-closed): drop everything. */
  reset(): void {
    this.attached = false
    this.replayCoalescing.clear()
    this.buffer.clear()
  }

  /** Test/introspection: is a renderer currently attached (live-forwarding on)? */
  get isAttached(): boolean {
    return this.attached
  }
}

function serializedUtf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

// Sidecar applies history caps before its socket envelope adds `deliveryTrace`.
// Matching that bare payload keeps a sidecar-valid rewind within the same caps.
function serializedBareServerFrameUtf8Bytes(frame: ServerFrame): number {
  const { deliveryTrace: _deliveryTrace, ...bareFrame } = frame
  return serializedUtf8Bytes(bareFrame)
}

function isSuccessfulEditFromMessageResult(frame: ServerFrame): boolean {
  return (
    frame.kind === 'session-action.result' &&
    frame.verb === 'editFromMessage' &&
    frame.ok
  )
}
