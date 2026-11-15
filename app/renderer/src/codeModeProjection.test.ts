import { expect, test } from 'bun:test'
import { PROTOCOL_VERSION, type ServerFrame } from '../../shared/protocol.js'
import { createTranscriptState, projectCodeModeCall, projectServerFrames, selectNestedTranscriptRows, selectTranscriptRows, type NestedToolUseRow } from './transcriptProjector.js'
import { findToolOutputRow } from './toolOutputRow.js'
const envelope = (cellId: string, status = 'completed') => ({ kind: 'code-mode', cellId, generation: 'g', description: 'Read project', code: '// Read\nRead()', status, output: 'selected', calls: [{ toolUseId: 'inner', name: 'Read', input: { file_path: '/a' }, status: 'completed', line: 2 }], changedFiles: [] })
const initial = () => projectServerFrames(createTranscriptState(), [{ kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId: 's', engineSessionId: 'engine-s', payload: { type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false, abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [] } } as unknown as ServerFrame])
const frame = (message: Record<string, unknown>, replay = false): ServerFrame => ({ kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 's', ...(replay ? { replay: true } : {}), event: { type: 'message', message: { session_id: 'engine-s', ...message } } } as unknown as ServerFrame)
const use = (id: string, name = 'REPL', parent: string | null = null, metadata?: Record<string, unknown>) => frame({ type: 'assistant', uuid: `frame-${id}`, parent_tool_use_id: parent, ...(metadata ? { isVirtual: true, code_mode: metadata } : {}), message: { id: `message-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input: { code: '// Read\nRead()', description: 'Read project' } }] } })
const result = (id: string, status = 'completed', replay = false) => frame({ type: 'user', uuid: `result-${id}-${status}`, parent_tool_use_id: null, tool_use_result: envelope(id, status), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'selected' }] } }, replay)
test('live and restored SDK code_mode children nest under their cell, including inside Agent', () => {
  for (const replay of [false, true]) {
    const frames = [use('agent', 'Agent'), use('cell', 'REPL', 'agent'), use('inner', 'Read', 'agent', { cellId: 'cell', generation: 'g', line: 2 }), result('cell')].map(value => ({ ...value, ...(replay ? { replay: true as const } : {}) }))
    const state = projectServerFrames(initial(), frames)
    const rows = selectNestedTranscriptRows(state, 's')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.children[0]!.children[0]!.id).toContain('inner')
    const cell = rows[0]!.children[0]!
    expect(cell.kind).toBe('tool-use')
    if (cell.kind === 'tool-use') expect(cell.result?.codeMode?.output).toBe('selected')
    expect('codeMode' in cell.children[0]! && cell.children[0]!.codeMode?.line).toBe(2)
    expect('parentToolUseId' in cell.children[0]! && cell.children[0]!.parentToolUseId).toBe('agent')
  }
})
test('receipt stays pending until host-owned completion and unaffected cells retain identity', () => {
  let state = projectServerFrames(initial(), [use('older'), result('older'), use('cell'), result('cell', 'running')])
  const before = selectTranscriptRows(state, 's')
  expect(before[1]!.kind === 'tool-use' && before[1]!.status).toBe('pending')
  state = projectServerFrames(state, [result('cell', 'completed')])
  const after = selectTranscriptRows(state, 's')
  expect(after[0]).toBe(before[0])
  expect(after[1]!.kind === 'tool-use' && after[1]!.status).toBe('success')
})
test('mismatched cell audit cannot replace ordinary output', () => {
  const state = projectServerFrames(initial(), [use('cell'), frame({ type: 'user', uuid: 'mismatch', tool_use_result: envelope('foreign'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'cell', content: 'plain fallback' }] } })])
  const row = selectTranscriptRows(state, 's')[0]!
  expect(row.kind === 'tool-use' && row.result?.codeMode).toBeUndefined()
  expect(row.kind === 'tool-use' && row.result?.content).toBe('plain fallback')
})

test('restored audit child outputs remain reachable through the real output-pane resolver', () => {
  const state = projectServerFrames(initial(), [use('cell'), result('cell')])
  const parent = selectNestedTranscriptRows(state, 's')[0] as NestedToolUseRow
  const call = parent.result!.codeMode!.calls[0]!
  const audited = projectCodeModeCall(parent, call)
  expect(findToolOutputRow([parent], audited.id)).toBe(audited)
  const actual = { ...audited, id: 'real-child-frame', parentToolUseId: null }
  expect(findToolOutputRow([{ ...parent, children: [actual] }], audited.id)).toBe(actual)
})

test('only actual REPL tools may interpret audits or own Code Mode display children', () => {
  for (const toolName of ['Bash', 'mcp__foreign__audit']) {
    const state = projectServerFrames(initial(), [use('foreign', toolName), result('foreign', 'running'), use('inner', 'Read', null, { cellId: 'foreign', generation: 'g', line: 2 })])
    const rows = selectNestedTranscriptRows(state, 's')
    expect(rows).toHaveLength(2)
    const ordinary = rows[0] as NestedToolUseRow
    expect(ordinary.status).toBe('success')
    expect(ordinary.result?.codeMode).toBeUndefined()
    expect(ordinary.children).toEqual([])
    expect(selectNestedTranscriptRows(state, 's')[0]).toBe(ordinary)
  }
})

test('yield is terminal rather than pending while genuine running receipts remain pending', () => {
  for (const status of ['running', 'yielded']) {
    const state = projectServerFrames(initial(), [use('cell'), result('cell', status)])
    const projected = selectNestedTranscriptRows(state, 's')[0] as NestedToolUseRow
    expect(projected.status).toBe(status === 'running' ? 'pending' : 'success')
  }
})
