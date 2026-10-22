import { expect, test } from 'bun:test'
import type { SDKMessage } from '@cat-code/engine/session-events'
import { PROTOCOL_VERSION, type ServerFrame } from '../../shared/protocol.js'
import { encodeInlineCommandResult, type InlineCommandRun } from '../../shared/inlineCommand.js'
import { createTranscriptState, projectServerFrame, selectTranscriptRows } from './transcriptProjector.js'

const uuid = '00000000-0000-4000-8000-000000000001'
const ready: ServerFrame = { kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId: 'app', engineSessionId: 'engine', payload: { type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false, abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [] } }
const frame = (message: SDKMessage): ServerFrame => ({ kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'app', event: { type: 'message', message } })
const run: InlineCommandRun = { runId: 'run', source: { engineSessionId: 'engine', messageUuid: uuid, contentBlockIndex: 1, fenceOrdinal: 0 }, command: 'echo hi', cwd: '/tmp', status: 'success', output: 'hi', exitCode: 0 }
const initial = () => projectServerFrame(createTranscriptState(), ready)

test('full assistant origins use canonical frame UUID and local text index, not API id or projected cumulative block index', () => {
  let state = initial()
  const assistant = (id: typeof uuid, content: unknown[]): SDKMessage => ({ type: 'assistant', uuid: id, session_id: 'engine', parent_tool_use_id: null, message: { id: 'same-api-message', role: 'assistant', content } } as SDKMessage)
  state = projectServerFrame(state, frame(assistant('00000000-0000-4000-8000-000000000001', [{ type: 'text', text: 'earlier' }])))
  state = projectServerFrame(state, frame(assistant('00000000-0000-4000-8000-000000000002' as typeof uuid, [{ type: 'thinking', thinking: 'reason', signature: '' }, { type: 'text', text: '```sh\necho hi\n```' }])))
  const row = selectTranscriptRows(state, 'app').find(row => row.kind === 'assistant-text' && row.content.includes('echo hi'))
  expect(row?.kind === 'assistant-text' && row.inlineCommandOrigin).toEqual({ messageUuid: '00000000-0000-4000-8000-000000000002', contentBlockIndex: 1 })
})

test('only synthetic meta user result messages associate output, and replay is idempotent', () => {
  const message: SDKMessage = { type: 'user', uuid, session_id: 'engine', parent_tool_use_id: null, isSynthetic: true, message: { role: 'user', content: encodeInlineCommandResult(run) } }
  const state = projectServerFrame(initial(), frame(message))
  expect(selectTranscriptRows(state, 'app', true)).toHaveLength(0)
  expect(state.sessions.app!.inlineCommandResults).toEqual([run])
  expect(projectServerFrame(state, frame(message))).toBe(state)
  const ordinary = projectServerFrame(initial(), frame({ ...message, isSynthetic: false }))
  expect(ordinary.sessions.app!.inlineCommandResults).toBeUndefined()
  expect(selectTranscriptRows(ordinary, 'app')).toHaveLength(1)
})

test('a replacement snapshot interrupts uncertain active outcomes without reconstructing or executing them', () => {
  const snapshot = (generation: string, runs: InlineCommandRun[]): ServerFrame => ({ kind: 'inline-command.snapshot', protocolVersion: PROTOCOL_VERSION, sessionId: 'app', generation, runs })
  let state = projectServerFrame(initial(), snapshot('old', [{ ...run, status: 'running', exitCode: null }]))
  state = projectServerFrame(state, snapshot('new', []))
  expect(state.sessions.app!.inlineCommands).toEqual({ generation: 'new', runs: [] })
  expect(state.sessions.app!.inlineCommandResults?.[0]).toMatchObject({ runId: 'run', status: 'interrupted', output: 'hi' })
  const reattached = projectServerFrame(state, ready)
  expect(reattached.sessions.app!.inlineCommandResults).toEqual(state.sessions.app!.inlineCommandResults)
})

test('request outcomes survive ready reattachment without a run preview', () => {
  const requests = [{ requestId: 'lost', source: run.source, status: 'rejected' as const, error: 'Source unavailable.' }]
  const state = projectServerFrame(initial(), {
    kind: 'inline-command.snapshot', protocolVersion: PROTOCOL_VERSION, sessionId: 'app', generation: 'live', runs: [], requests,
  })
  expect(projectServerFrame(state, ready).sessions.app!.inlineCommands).toEqual({ generation: 'live', runs: [], requests })
})
