import { expect, test } from 'bun:test'
import { PROTOCOL_VERSION, type ServerFrame } from '../../shared/protocol.js'
import { createTranscriptState, projectServerFrame, selectTranscriptRows } from './transcriptProjector.js'
import type { AutoModeReview } from '../../../src/app-runtime/autoModeReviewContract.js'

const sessionId = 'review-projection'
const ready: ServerFrame = { kind: 'ready', sessionId, protocolVersion: PROTOCOL_VERSION, engineSessionId: 'engine-review', payload: { type: 'app.ready', protocolVersion: 1, activeTurn: false, inputEnabled: true, abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [] } }
const message: ServerFrame = { kind: 'event', sessionId, protocolVersion: PROTOCOL_VERSION, event: { type: 'message', message: { type: 'assistant', session_id: 'engine-review', uuid: '00000000-0000-4000-8000-000000000001', parent_tool_use_id: null, message: { id: 'assistant-review', type: 'message', role: 'assistant', model: 'test', content: [{ type: 'tool_use', id: 'call', name: 'Bash', input: { command: 'echo checked' } }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } } } }
const reviewing: AutoModeReview = { type: 'tool.review', toolUseId: 'call', attemptId: 'attempt', startedAt: 1000, outcome: 'reviewing' }
const decided: AutoModeReview = { ...reviewing, completedAt: 13000, outcome: 'allowed', reason: 'Full allowed reason survives.' }
const event = (review: AutoModeReview): ServerFrame => ({ kind: 'event', sessionId, protocolVersion: PROTOCOL_VERSION, event: review })

test('review evidence joins read-time, survives new turns and same-engine reload, and ignores stale recovered starts', () => {
  let state = projectServerFrame(createTranscriptState(), ready)
  state = projectServerFrame(state, message)
  state = projectServerFrame(state, { kind: 'event', sessionId, protocolVersion: PROTOCOL_VERSION, event: { type: 'tool.activity', toolUseId: 'call', phase: 'reviewing', startedAt: 1000 } })
  const stored = state.sessions[sessionId]!.rows[0]!
  expect(selectTranscriptRows(state, sessionId)[0]).not.toHaveProperty('autoModeReview')
  state = projectServerFrame(state, event(reviewing))
  expect(selectTranscriptRows(state, sessionId)[0]).toHaveProperty('autoModeReview.outcome', 'reviewing')
  state = projectServerFrame(state, event(decided))
  const joined = selectTranscriptRows(state, sessionId)[0]!
  expect(joined).toHaveProperty('autoModeReview.reason', decided.reason)
  expect(state.sessions[sessionId]!.rows[0]).toBe(stored)
  expect(stored).not.toHaveProperty('autoModeReview')
  expect(selectTranscriptRows(state, sessionId)[0]).toBe(joined)
  state = projectServerFrame(state, { kind: 'event', sessionId, protocolVersion: PROTOCOL_VERSION, event: { type: 'turn.status', activeTurn: true } })
  expect(selectTranscriptRows(state, sessionId)[0]).toHaveProperty('autoModeReview.reason', decided.reason)
  state = projectServerFrame(state, ready)
  state = projectServerFrame(state, message)
  state = projectServerFrame(state, event(reviewing))
  expect(selectTranscriptRows(state, sessionId)[0]).toHaveProperty('autoModeReview', decided)
})

test('replaying into an empty renderer restores the mark independent of message order and rejects foreign sessions', () => {
  let state = projectServerFrame(createTranscriptState(), ready)
  state = projectServerFrame(state, event(decided))
  state = projectServerFrame(state, message)
  expect(selectTranscriptRows(state, sessionId)[0]).toHaveProperty('autoModeReview', decided)
  state = projectServerFrame(state, { ...ready, engineSessionId: 'another-engine' })
  state = projectServerFrame(state, message)
  expect(selectTranscriptRows(state, sessionId)[0]).not.toHaveProperty('autoModeReview')
})
