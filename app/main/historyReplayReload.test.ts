/**
 * F2 — the RELOAD half of the restored-history contract
 * (decisions/RESTORE-HISTORY.md): a renderer reload right after a restore must
 * replay the SAME history from main's per-session buffer. That holds because
 * the sidecar's replay caps are strictly BELOW the buffer's budgets (with
 * headroom for ready/C3/early live frames) — asserted here so the two constants
 * can never drift apart silently — and proven functionally by pushing an
 * at-cap history through the REAL AttachmentGate + FrameReplayBuffer.
 */

import { expect, test } from 'bun:test'
import {
  MAX_HISTORY_REPLAY_BYTES,
  MAX_HISTORY_REPLAY_FRAMES,
} from '../shared/limits.js'
import type { ServerFrame } from '../shared/protocol.js'
import { AttachmentGate } from './attachmentGate.js'
import {
  DEFAULT_MAX_BUFFERED_BYTES,
  DEFAULT_MAX_BUFFERED_FRAMES,
  FrameReplayBuffer,
  isReplayTruncationFrame,
} from './replayBuffer.js'

const SESSION = 'restored-session'

function readyFrame(): ServerFrame {
  return {
    kind: 'ready',
    protocolVersion: 2,
    sessionId: SESSION,
    engineSessionId: 'engine-restored',
    payload: { type: 'app.ready' } as never,
  }
}

function replayEventFrame(i: number): ServerFrame {
  return {
    kind: 'event',
    protocolVersion: 2,
    sessionId: SESSION,
    replay: true,
    event: {
      type: 'message',
      message: {
        type: 'user',
        message: { role: 'user', content: `restored ${i}` },
        session_id: 'engine-restored',
        parent_tool_use_id: null,
        uuid: `u-${i}`,
      } as never,
    },
  }
}

test('ALIGNMENT INVARIANT: history replay caps sit strictly below the replay-buffer budgets', () => {
  // Strict (<) on purpose: the buffer must also hold the ready head, C3
  // snapshots, and early live frames without evicting history.
  expect(MAX_HISTORY_REPLAY_FRAMES).toBeLessThan(DEFAULT_MAX_BUFFERED_FRAMES)
  expect(MAX_HISTORY_REPLAY_BYTES).toBeLessThan(DEFAULT_MAX_BUFFERED_BYTES)
})

test('an AT-CAP history survives a renderer reload intact through the real gate + buffer', () => {
  const gate = new AttachmentGate(new FrameReplayBuffer())

  // Frames arrive from the sidecar before any renderer attached (the restore
  // scenario: spawn + attach precede window load).
  gate.onFrame(SESSION, readyFrame())
  for (let i = 0; i < MAX_HISTORY_REPLAY_FRAMES; i++) {
    gate.onFrame(SESSION, replayEventFrame(i))
  }

  // First attach: ready head + the FULL history, no truncation boundary.
  const first = gate.onRendererReady()
  expect(first.length).toBe(1 + MAX_HISTORY_REPLAY_FRAMES)
  expect(first[0]!.kind).toBe('ready')
  expect(first.some(isReplayTruncationFrame)).toBe(false)

  // RELOAD: a fresh document re-arms the gate; the replay must be the SAME.
  gate.onNavigationStart()
  const second = gate.onRendererReady()
  expect(second.length).toBe(first.length)
  expect(second.some(isReplayTruncationFrame)).toBe(false)
  expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  // Spot-check both ends of the history survived (nothing evicted).
  expect(JSON.stringify(second)).toContain('"restored 0"')
  expect(JSON.stringify(second)).toContain(
    `"restored ${MAX_HISTORY_REPLAY_FRAMES - 1}"`,
  )
})
