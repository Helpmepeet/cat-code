/**
 * F2 — restored history RENDERS (decisions/RESTORE-HISTORY.md): replayed
 * `replay: true` event frames project into normal transcript rows through the
 * unchanged projector, and the additive flag is invisible to every renderer
 * reducer (rows identical with and without it — the "renderer may ignore it"
 * half of the contract).
 *
 * Samples come from the P2-0 mint-anchored fixture — the same shapes
 * `toSDKMessages` emits for restored user/assistant messages (the e2e probe in
 * spawnConfig.probe.test.ts proves the real mapper output crossing the wire).
 */

import { expect, test } from 'bun:test'
import type { SDKMessage } from '@cat-code/engine/session-events'
import type { ServerFrame } from '../../shared/protocol.js'
import {
  createRawMessageLogState,
  reduceServerFrame,
  selectRawMessageLog,
} from './rawMessageLog.js'
import { SDK_MESSAGE_FIXTURE } from './sdkMessageFixtures.js'
import {
  createTranscriptState,
  projectServerFrame,
  selectTranscriptRows,
} from './transcriptProjector.js'

const SESSION = 'restored-session'

function ready(): ServerFrame {
  return {
    kind: 'ready',
    protocolVersion: 2,
    sessionId: SESSION,
    engineSessionId: 'engine-restored',
    payload: {
      type: 'app.ready',
      protocolVersion: 1,
      inputEnabled: true,
      activeTurn: false,
      abort: { status: 'idle' },
      goalSnapshot: null,
      pendingPermissionRequests: [],
    },
  }
}

function frame(message: SDKMessage, replay: boolean): ServerFrame {
  return {
    kind: 'event',
    protocolVersion: 2,
    sessionId: SESSION,
    ...(replay ? { replay: true as const } : {}),
    event: { type: 'message', message },
  }
}

function fixtureMessages(): { user: SDKMessage; assistant: SDKMessage } {
  const user = SDK_MESSAGE_FIXTURE.user.find(
    sample => sample.name === 'user: plain prompt (string content)',
  )
  const assistant = SDK_MESSAGE_FIXTURE.assistant.find(
    sample => sample.name === 'assistant: text block (streamed per-block frame)',
  )
  if (!user || !assistant) throw new Error('required fixture samples missing')
  return { user: user.message, assistant: assistant.message }
}

test('replayed history frames project into normal transcript rows', () => {
  const { user, assistant } = fixtureMessages()

  let state = createTranscriptState()
  for (const f of [ready(), frame(user, true), frame(assistant, true)]) {
    state = projectServerFrame(state, f)
  }

  const rows = selectTranscriptRows(state, SESSION)
  expect(rows.length).toBe(2)
  expect(rows.map(r => r.kind)).toEqual(['user-text', 'assistant-text'])
  expect(rows.every(r => r.sessionId === SESSION)).toBe(true)
})

test('a replayed compact boundary stays between its archival prefix and compacted tail', () => {
  const { user, assistant } = fixtureMessages()
  const boundary: SDKMessage = {
    type: 'system',
    subtype: 'compact_boundary',
    session_id: 'engine-restored',
    uuid: 'compact-boundary-fixture',
    compact_metadata: {
      trigger: 'manual',
      pre_tokens: 316_672,
    },
  }

  let state = createTranscriptState()
  for (const f of [
    ready(),
    frame(user, true),
    frame(boundary, true),
    frame(assistant, true),
  ]) {
    state = projectServerFrame(state, f)
  }

  const rows = selectTranscriptRows(state, SESSION)
  expect(rows.map(row => row.kind)).toEqual([
    'user-text',
    'compact-boundary',
    'assistant-text',
  ])
})

test('the replay flag is invisible to the projector and the raw log (additive field, rows identical)', () => {
  const { user, assistant } = fixtureMessages()

  let flagged = createTranscriptState()
  let unflagged = createTranscriptState()
  for (const [withFlag, target] of [
    [true, (f: ServerFrame) => (flagged = projectServerFrame(flagged, f))],
    [false, (f: ServerFrame) => (unflagged = projectServerFrame(unflagged, f))],
  ] as const) {
    for (const f of [ready(), frame(user, withFlag), frame(assistant, withFlag)]) {
      target(f)
    }
  }
  expect(JSON.stringify(selectTranscriptRows(flagged, SESSION))).toBe(
    JSON.stringify(selectTranscriptRows(unflagged, SESSION)),
  )

  // Raw log accepts replayed frames like any event frame (ready opens the
  // session, exactly as it does on a real attach — history follows ready).
  let raw = createRawMessageLogState()
  for (const f of [ready(), frame(user, true), frame(assistant, true)]) {
    raw = reduceServerFrame(raw, f)
  }
  expect(selectRawMessageLog(raw, SESSION).messages.length).toBe(2)
})
