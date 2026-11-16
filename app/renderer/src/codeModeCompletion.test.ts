import { expect, test } from 'bun:test'
import { PROTOCOL_VERSION, type ServerFrame } from '../../shared/protocol.js'
import { createTranscriptState, projectServerFrames, selectNestedTranscriptRows } from './transcriptProjector.js'

const sessionId = 'background-completion'
const base = { kind: 'code-mode', cellId: 'cell', generation: 'gen', taskId: 'task', description: 'Background', code: 'output(1)', calls: [], changedFiles: [] }
const event = (message: Record<string, unknown>): ServerFrame => ({ kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId, event: { type: 'message', message: { session_id: 'engine', parent_tool_use_id: null, ...message } } } as unknown as ServerFrame)
const ready = { kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId, engineSessionId: 'engine', payload: { type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false, abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [] } } as unknown as ServerFrame
const outer = event({ type: 'assistant', uuid: 'outer', message: { id: 'outer', role: 'assistant', content: [{ type: 'tool_use', id: 'cell', name: 'REPL', input: { code: base.code, description: base.description } }] } })
const running = event({ type: 'user', uuid: 'running', tool_use_result: { ...base, status: 'running', output: 'Accepted' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'cell', content: 'Accepted' }] } })
const terminal = (overrides: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) => event({ type: 'user', uuid: 'terminal', isSynthetic: true, origin: { kind: 'task-notification', toolUseId: 'cell' }, tool_use_result: { ...base, status: 'completed', output: 'Final selected output', ...overrides }, message: { role: 'user', content: 'SYSTEM NOTIFICATION (NOT USER INPUT)' }, ...meta })
const projection = (frames: ServerFrame[]) => {
  const state = projectServerFrames(createTranscriptState(), [ready, ...frames])
  return { state, row: selectNestedTranscriptRows(state, sessionId).find(row => row.kind === 'tool-use' && row.toolUseId === 'cell') }
}

test('authenticated background completion settles the original Script in live and reversed replay order', () => {
  for (const frames of [[outer, running, terminal()], [terminal(), outer, running]]) {
    const { row } = projection(frames)
    expect(row?.kind).toBe('tool-use')
    if (row?.kind !== 'tool-use') throw new Error('missing Script')
    expect(row.status).toBe('success')
    expect(row.result?.codeMode?.status).toBe('completed')
    expect(row.result?.codeMode?.output).toBe('Final selected output')
  }
})

test('an early terminal receipt remains hidden until the matching running receipt arrives', () => {
  const { row } = projection([terminal(), outer])
  if (row?.kind !== 'tool-use') throw new Error('missing Script')
  expect(row.status).toBe('pending')
  expect(row.result).toBeNull()
})

test('mismatched or untrusted background receipts cannot settle the original Script', () => {
  for (const frame of [terminal({ generation: 'other' }), terminal({ taskId: 'other' }), terminal({ taskId: undefined }), terminal({ cellId: 'other' }), terminal({ status: 'running' }), terminal({}, { isSynthetic: false }), terminal({}, { origin: { kind: 'human' } }), terminal({}, { origin: { kind: 'task-notification', toolUseId: 'other' } })]) {
    const { row } = projection([outer, running, frame])
    if (row?.kind !== 'tool-use') throw new Error('missing Script')
    expect(row.result?.codeMode?.status).toBe('running')
  }
})

test('terminal outcomes retain their distinct host status', () => {
  for (const [status, expected] of [['failed', 'error'], ['blocked', 'error'], ['cancelled', 'cancelled'], ['yielded', 'success']] as const) {
    const { row } = projection([outer, running, terminal({ status })])
    if (row?.kind !== 'tool-use') throw new Error('missing Script')
    expect(row.status).toBe(expected)
    expect(row.result?.codeMode?.status).toBe(status)
  }
})

test('an early receipt cannot supply a result for a different tool or mismatched running receipt', () => {
  const bash = event({ type: 'assistant', uuid: 'bash', message: { id: 'bash', role: 'assistant', content: [{ type: 'tool_use', id: 'cell', name: 'Bash', input: { command: 'date' } }] } })
  const different = event({ type: 'user', uuid: 'different', tool_use_result: { ...base, generation: 'new', status: 'running', output: 'New run' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'cell', content: 'New run' }] } })
  for (const frames of [[terminal(), bash], [terminal(), outer, different]]) {
    const { row } = projection(frames)
    if (row?.kind !== 'tool-use') throw new Error('missing tool')
    expect(row.status).toBe('pending')
    expect(row.result?.codeMode?.status).not.toBe('completed')
  }
})

test('a mismatched early completion cannot displace the later matching completion', () => {
  const wrong = terminal({ generation: 'other', taskId: 'other' }, { uuid: 'wrong' })
  const { row } = projection([wrong, terminal(), outer, running])
  if (row?.kind !== 'tool-use') throw new Error('missing Script')
  expect(row.result?.codeMode?.status).toBe('completed')
  expect(row.result?.codeMode?.output).toBe('Final selected output')
})

test('an unrelated tool keeps its own result even if an audit-shaped receipt shares its ID', () => {
  const bash = event({ type: 'assistant', uuid: 'bash', message: { id: 'bash', role: 'assistant', content: [{ type: 'tool_use', id: 'cell', name: 'Bash', input: { command: 'date' } }] } })
  const ordinary = event({ type: 'user', uuid: 'ordinary', tool_use_result: { ...base, status: 'running', output: 'Fake receipt' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'cell', content: 'Actual Bash result' }] } })
  const { row } = projection([terminal(), bash, ordinary])
  if (row?.kind !== 'tool-use') throw new Error('missing Bash')
  expect(row.result?.content).toBe('Actual Bash result')
  expect(row.result?.codeMode).toBeUndefined()
})
