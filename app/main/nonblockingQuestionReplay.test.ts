import { expect, test } from 'bun:test'
import { FrameReplayBuffer } from './replayBuffer.js'
import { PROTOCOL_VERSION, type ServerFrame } from '../shared/protocol.js'

const question = { toolUseId: 'ask', questionIndex: 0, sourceMessageUuid: 'source', question: 'Which storage?', options: [], multiSelect: false }
const snapshot = (pending = true): ServerFrame => ({ kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', event: { type: 'question.snapshot', snapshot: { pending: pending ? [question] : [], resolved: pending ? [] : [{ ...question, state: 'dismissed' }] } } })

test('pending and resolved question snapshots survive transcript ring eviction and replace one another', () => {
  const buffer = new FrameReplayBuffer(1, 2048)
  buffer.record('a', snapshot())
  for (let i = 0; i < 10; i++) buffer.record('a', { kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', event: { type: 'message', message: { type: 'assistant', uuid: `a-${i}`, session_id: 'a', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } } as never } })
  expect(buffer.snapshotSession('a').filter(frame => frame.kind === 'event' && frame.event.type === 'question.snapshot')).toEqual([snapshot()])
  buffer.record('a', snapshot(false))
  buffer.record('a', { kind: 'question.result', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', requestId: 'closed', accepted: true })
  expect(buffer.snapshotSession('a').filter(frame => frame.kind === 'event' && frame.event.type === 'question.snapshot')).toEqual([snapshot(false)])
  expect(buffer.snapshotSession('a').some(frame => frame.kind === 'question.result')).toBe(false)
})

test('reload applies the current question state after transcript resets; replacement engines clear the old snapshot', () => {
  const buffer = new FrameReplayBuffer()
  buffer.record('a', snapshot())
  buffer.record('a', { kind: 'transcript.reset', protocolVersion: PROTOCOL_VERSION, sessionId: 'a' })
  buffer.record('a', snapshot(false))
  expect(buffer.snapshotSession('a').at(-1)).toEqual(snapshot(false))
  buffer.record('a', { kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', engineSessionId: 'replacement', payload: { type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false, abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [] } })
  expect(buffer.snapshotSession('a').some(frame => frame.kind === 'event' && frame.event.type === 'question.snapshot')).toBe(false)
})
