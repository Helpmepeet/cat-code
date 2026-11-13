/**
 * F2 — the RELOAD half of the restored-history contract
 * (decisions/RESTORE-HISTORY.md): a renderer reload right after a restore must
 * replay the SAME history from main's per-session buffer. That holds because
 * the sidecar's replay caps are strictly BELOW the buffer's budgets (with
 * headroom for ready/C3/early live frames) — asserted here so the two constants
 * can never drift apart silently — and proven functionally by pushing an
 * at-cap history through the REAL AttachmentGate + FrameReplayBuffer.
 */

import { PROTOCOL_VERSION } from '../shared/protocol.js'
import { expect, test } from 'bun:test'
import {
  MAX_HISTORY_REPLAY_BYTES,
  MAX_HISTORY_REPLAY_FRAMES,
} from '../shared/limits.js'
import type { ServerFrame } from '../shared/protocol.js'
import { AttachmentGate } from './attachmentGate.js'
import { createTranscriptState, projectServerFrames } from '../renderer/src/transcriptProjector.js'
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
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SESSION,
    engineSessionId: 'engine-restored',
    payload: { type: 'app.ready' } as never,
  }
}

function replayEventFrame(i: number): ServerFrame {
  return {
    kind: 'event',
    protocolVersion: PROTOCOL_VERSION,
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

test('reloading before an old recovery finishes never delivers its prefix or completion into the new view', () => {
  const gate = new AttachmentGate()
  gate.onFrame(SESSION, readyFrame())
  gate.onFrame(SESSION, replayEventFrame(2))
  let state = projectServerFrames(createTranscriptState(), gate.onRendererReady('old-document'))
  const recover = (index: number, recoveryViewId: string): ServerFrame => ({
    ...replayEventFrame(index), recovered: true, recoveryViewId,
  }) as ServerFrame
  const result = (complete: boolean, recoveryViewId: string): ServerFrame => ({
    kind: 'history.loadEarlier.result', protocolVersion: PROTOCOL_VERSION, sessionId: SESSION,
    requestId: 'recovery', ok: true, added: 1, complete, message: '', recoveryViewId,
  }) as ServerFrame
  state = projectServerFrames(state, gate.onFrame(SESSION, recover(1, 'old-document')))
  state = projectServerFrames(state, gate.onFrame(SESSION, result(false, 'old-document')))
  expect(state.sessions[SESSION]!.rows.map(row => 'content' in row ? row.content : null))
    .toEqual(['restored 1', 'restored 2'])

  gate.onNavigationStart()
  state = projectServerFrames(createTranscriptState(), gate.onRendererReady('new-document'))
  const staleAvailability = {
    kind: 'history.availability', protocolVersion: PROTOCOL_VERSION, sessionId: SESSION,
    recovered: true, recoveryViewId: 'old-document', unavailableParentToolUseIds: ['stale-worker'],
  } as ServerFrame
  for (const frame of [recover(0, 'old-document'), staleAvailability, result(true, 'old-document')]) {
    const delivered = gate.onFrame(SESSION, frame)
    expect(delivered).toEqual([])
    state = projectServerFrames(state, delivered)
  }
  expect(state.sessions[SESSION]!.rows.map(row => 'content' in row ? row.content : null))
    .toEqual(['restored 2'])
  expect(state.sessions[SESSION]!.historyTruncated).toBe(true)
  expect(state.sessions[SESSION]!.unavailableParentToolUseIds.size).toBe(0)

  for (const frame of [recover(0, 'new-document'), recover(1, 'new-document'), result(true, 'new-document')]) {
    state = projectServerFrames(state, gate.onFrame(SESSION, frame))
  }
  expect(state.sessions[SESSION]!.rows.map(row => 'content' in row ? row.content : null))
    .toEqual(['restored 0', 'restored 1', 'restored 2'])
  expect(state.sessions[SESSION]!.historyTruncated).toBe(false)
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
