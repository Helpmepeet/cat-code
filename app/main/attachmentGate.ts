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
import type { ServerFrame, SessionId } from '../shared/protocol.js'

export class AttachmentGate {
  private readonly buffer: FrameReplayBuffer
  private attached = false

  constructor(buffer: FrameReplayBuffer = new FrameReplayBuffer()) {
    this.buffer = buffer
  }

  /**
   * A frame arrived from the supervisor. Always buffered; returned for live
   * delivery only if a renderer is currently attached (else it waits for replay).
   */
  onFrame(sessionId: SessionId, frame: ServerFrame): ServerFrame[] {
    this.buffer.record(sessionId, frame)
    return this.attached ? [frame] : []
  }

  /**
   * The renderer announced readiness. Replays the buffered snapshot once per
   * document load; a repeat signal on the same load returns nothing.
   */
  onRendererReady(): ServerFrame[] {
    if (this.attached) return []
    this.attached = true
    return this.buffer.snapshot()
  }

  /** A new document is loading (reload or new window): re-arm for a fresh replay. */
  onNavigationStart(): void {
    this.attached = false
  }

  /** The session was torn down (macOS window-all-closed): drop everything. */
  reset(): void {
    this.attached = false
    this.buffer.clear()
  }

  /** Test/introspection: is a renderer currently attached (live-forwarding on)? */
  get isAttached(): boolean {
    return this.attached
  }
}
