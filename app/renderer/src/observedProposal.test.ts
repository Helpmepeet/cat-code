import { expect, test } from 'bun:test'
import type { SDKMessage } from '@cat-code/engine/sdk'
import { selectObservedProposal } from './observedProposal.js'
import { createTranscriptState, projectServerFrame, selectTranscriptRows } from './transcriptProjector.js'
import { PROTOCOL_VERSION } from '../../shared/protocol.js'

const a = { type: 'assistant', uuid: 'proposal-a', session_id: 'engine', parent_tool_use_id: null,
  message: { id: 'api-a', role: 'assistant', model: 'claude', content: [{ type: 'text', text: 'Do A?' }] } } as SDKMessage
function rows(messages: SDKMessage[] = [a]) {
  const state = projectServerFrame(createTranscriptState(), {
    kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId: 'session', engineSessionId: 'engine',
    payload: { type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false,
      abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [] },
  })
  return selectTranscriptRows(messages.reduce((current, message) => projectServerFrame(current, {
    kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'session',
    event: { type: 'message', message },
  }), state), 'session')
}
test('selects completed displayed prose and keeps the submitted snapshot', () => {
  const observed = selectObservedProposal([a], rows())
  expect(observed).toEqual({ messageUuid: 'proposal-a', text: 'Do A?' })
  const b = { ...a, uuid: 'proposal-b' } as SDKMessage
  expect(selectObservedProposal([a, b], rows())).toBeNull()
  expect(observed?.messageUuid).toBe('proposal-a')
})
test('partial, hidden, duplicate and post-user context fail closed', () => {
  expect(selectObservedProposal([a], rows().map(row => row.kind === 'assistant-text' ? { ...row, isStreaming: true } : row))).toBeNull()
  expect(selectObservedProposal([a], [])).toBeNull()
  expect(selectObservedProposal([a, a], rows())).toBeNull()
  expect(selectObservedProposal([a, { type: 'user', message: { content: 'Sure' } } as SDKMessage], rows())).toBeNull()
  expect(selectObservedProposal([a, { type: 'stream_event', event: { type: 'message_start' } } as SDKMessage], rows())).toBeNull()
  expect(selectObservedProposal([a], rows().map(row => row.kind === 'assistant-text' ? { ...row, phase: 'commentary' } : row))).toBeNull()
})

test('normal trailing stream-completion events do not hide the completed proposal', () => {
  // The API stream yields the finalized assistant block before its stop event.
  const messages = [
    a,
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop', index: 0 } },
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } },
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } },
  ] as SDKMessage[]
  expect(selectObservedProposal(messages, rows(messages))).toEqual({ messageUuid: 'proposal-a', text: 'Do A?' })
})

test('unknown or malformed SDK records cannot supply proposal text', () => {
  for (const message of [
    { ...a, uuid: undefined },
    { ...a, message: { content: [{ type: 'text', text: { injected: true } }] } },
    { type: 'user' },
    { type: 'stream_event', event: null },
  ] as SDKMessage[]) {
    expect(selectObservedProposal([message], rows())).toBeNull()
  }
})
