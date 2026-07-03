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
 * Retention: the single `ready` frame per session is kept as a permanent head (a
 * late or reloaded renderer must always be able to re-derive its session state
 * and id), plus a bounded ring of the most recent non-ready frames so a long
 * streaming turn cannot grow the buffer without bound.
 */

import type { ServerFrame, SessionId } from '../shared/protocol.js'

/** Default cap on retained non-ready frames per session. */
export const DEFAULT_MAX_BUFFERED_FRAMES = 512

type SessionEntry = {
  ready: ServerFrame | null
  recent: ServerFrame[]
}

export class FrameReplayBuffer {
  private readonly sessions = new Map<SessionId, SessionEntry>()

  constructor(private readonly maxRecent: number = DEFAULT_MAX_BUFFERED_FRAMES) {}

  /** Record one frame. The `ready` frame replaces the head; others ring-buffer. */
  record(sessionId: SessionId, frame: ServerFrame): void {
    let entry = this.sessions.get(sessionId)
    if (!entry) {
      entry = { ready: null, recent: [] }
      this.sessions.set(sessionId, entry)
    }
    if (frame.kind === 'ready') {
      entry.ready = frame
      return
    }
    entry.recent.push(frame)
    if (entry.recent.length > this.maxRecent) {
      entry.recent.shift()
    }
  }

  /**
   * Everything a freshly-attached (or reloaded) renderer must receive to catch
   * up, in delivery order: each session's `ready` head first, then its buffered
   * frames. P1-0 has one session; the shape is already N-session ready.
   */
  snapshot(): ServerFrame[] {
    const frames: ServerFrame[] = []
    for (const entry of this.sessions.values()) {
      if (entry.ready) frames.push(entry.ready)
      frames.push(...entry.recent)
    }
    return frames
  }

  /** Forget a session's buffer (e.g. its sidecar was torn down). */
  clear(): void {
    this.sessions.clear()
  }
}
