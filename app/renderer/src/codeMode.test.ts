import { expect, test } from 'bun:test'
import { codeModeDigest, codeModeInput, codeModeInputWasOmitted, codeModeStepDigest, parseCodeMode, type CodeModeEnvelope } from './codeMode.js'
import { summarizeFocusedWork } from './focusedTranscriptLayout.js'
import { focusedCallLine, focusedCallPhase } from './focusedCallText.js'
import type { NestedToolUseRow } from './transcriptProjector.js'
const cell = (patch: Partial<CodeModeEnvelope> = {}): CodeModeEnvelope => ({ kind: 'code-mode', cellId: 'cell', generation: 'g', description: 'Inspect project', code: '// Read files\nRead();\n// Check\nBash();', status: 'completed', output: 'ok', calls: [{ toolUseId: 'read', name: 'Read', input: { file_path: '/a' }, status: 'completed', line: 2 }, { toolUseId: 'check', name: 'Bash', input: {}, status: 'failed', error: 'test failed', line: 4 }], changedFiles: [], ...patch })
const row = (envelope: CodeModeEnvelope): NestedToolUseRow => ({ kind: 'tool-use', id: 'cell', sessionId: 's', messageId: 'm', frameId: 'f', blockIndex: 0, parentToolUseId: null, children: [], toolUseId: 'cell', toolName: 'REPL', toolFamily: 'other', status: 'success', input: {}, agentCompletion: null, result: { content: 'selected', isError: false, diff: null, codeMode: envelope } })
test('accepts host envelope without parsing output and rejects malformed shapes', () => {
  const value = cell()
  expect(parseCodeMode(value)).toBe(value)
  for (const malformed of [null, JSON.stringify(value), { ...value, status: 'green' }, { ...value, calls: [{}] }, { ...value, changedFiles: [{ path: '/a', additions: -1 }] }, { ...value, line: 0 }]) expect(parseCodeMode(malformed)).toBeNull()
})
test('Focused counts inner work and partial changes rather than one REPL', () => {
  const summary = summarizeFocusedWork([row(cell({ changedFiles: [{ path: '/b', additions: 3, deletions: 2 }], status: 'cancelled' }))])
  expect(summary.toolCalls).toBe(1)
  expect(summary.errorCount).toBeGreaterThan(0)
})
test('running receipts remain live, but yielded cells are terminal and paused', () => {
  expect(focusedCallPhase(row(cell({ status: 'running' })), false)).toBe('running')
  const paused = row(cell({ status: 'yielded' }))
  expect(focusedCallPhase(paused, false)).toBe('stopped')
  const line = focusedCallLine(paused, { signalled: false, cwd: null, tasks: null, turnRows: [paused] })
  expect(line.verb).toBe('Paused')
  expect(line.verbTone).toBeNull()
})
test('concise check digests and failed reads never invent successful file reads', () => {
  const calls = Array.from({ length: 15 }, (_, index) => ({ toolUseId: String(index), name: 'Bash', input: { command: `test -e /repo/${index}` }, status: 'completed' }))
  expect(codeModeStepDigest(calls)).toBe('15 checks')
  expect(codeModeStepDigest([{ toolUseId: 'bad', name: 'Read', input: { file_path: '/missing' }, status: 'failed' }])).toBeNull()
})

test('Glob counts require complete effective structured data, not selected prose or lookalike fields', () => {
  const call = { toolUseId: 'glob', name: 'Glob', input: {}, status: 'completed' }
  expect(codeModeStepDigest([{ ...call, result: { data: { numFiles: 6 }, dataComplete: true, isError: false, content: 'selected' } }])).toBe('6 files')
  for (const result of [{ numFiles: 6 }, { content: '{\"numFiles\":6}', isError: false }, { data: { numFiles: 6 }, dataComplete: false, isError: false }, { data: { numFiles: 6 }, dataComplete: true, isError: true }]) expect(codeModeStepDigest([{ ...call, result }])).toBeNull()
})

test('ordinary and MCP lookalikes cannot change Focused identity, lifecycle or inner tallies', () => {
  for (const toolName of ['Bash', 'mcp__foreign__audit']) {
    const ordinary = { ...row(cell({ status: 'running' })), toolName }
    expect(focusedCallPhase(ordinary, false)).toBe('done')
    expect(focusedCallLine(ordinary, { signalled: false, cwd: null, tasks: null, turnRows: [ordinary] }).markClass).not.toBe('code-mode-identity')
    expect(summarizeFocusedWork([ordinary]).toolCalls).toBe(1)
    expect(summarizeFocusedWork([ordinary]).readPaths).toEqual([])
  }
})

test('denied and cancelled reads are not performed work or duplicate outer failures', () => {
  for (const status of ['blocked', 'cancelled', 'failed'] as const) {
    const value = cell({ status, calls: [{ toolUseId: 'denied', name: 'Read', input: { file_path: '/denied' }, status, error: 'Not read' }] })
    const outer = { ...row(value), status: status === 'cancelled' ? 'cancelled' as const : 'error' as const }
    const summary = summarizeFocusedWork([outer])
    expect(summary.readPaths).toEqual([])
    expect(summary.toolCalls).toBe(0)
    expect(summary.blockedCount).toBe(status === 'blocked' ? 1 : 0)
    expect(summary.stoppedCount).toBe(status === 'cancelled' ? 1 : 0)
    expect(summary.errorCount).toBe(status === 'failed' ? 1 : 0)
    expect(codeModeStepDigest(value.calls)).toBeNull()
    expect(codeModeDigest(value)).not.toContain('file read')
  }
})

test('partial Bash check batches count only completed outcomes and retain separate failure counts', () => {
  const calls = ['completed', 'blocked', 'cancelled', 'failed', 'running'].map((status, index) => ({
    toolUseId: String(index), name: 'Bash', input: { command: `test -e /file-${index}` }, status,
    ...(['blocked', 'cancelled', 'failed'].includes(status) ? { error: status } : {}),
  }))
  const value = cell({ status: 'blocked', calls })
  const summary = summarizeFocusedWork([{ ...row(value), status: 'error' }])
  expect(summary.toolCalls).toBe(1)
  expect(summary.commands).toBe(1)
  expect(summary.errorCount).toBe(1)
  expect(summary.blockedCount).toBe(1)
  expect(summary.stoppedCount).toBe(1)
  expect(codeModeStepDigest(calls)).toBe('1 check')
  expect(codeModeDigest(value)).toBe('1 check · 1 error · 1 blocked · 1 stopped')
})

test('live Script summaries count only finished work and never denied Grep searches', () => {
  const value = cell({ status: 'running', calls: [
    { toolUseId: 'done', name: 'Read', input: { file_path: '/done' }, status: 'completed' },
    { toolUseId: 'pending', name: 'Read', input: { file_path: '/pending' }, status: 'running' },
    { toolUseId: 'grep', name: 'Grep', input: { pattern: 'denied' }, status: 'blocked' },
  ] })
  const summary = summarizeFocusedWork([{ ...row(value), status: 'pending' }])
  expect(summary.toolCalls).toBe(1)
  expect(summary.readPaths).toEqual(['/done'])
  expect(summary.searchedPatterns).toEqual([])
  expect(summary.blockedCount).toBe(1)
})

test('only validated host-call inputOmission metadata controls omission, never argument data', () => {
  const input = { omitted: true, reason: 'Final executable input display limit', bytes: 1, file_path: '/actual-target', inputOmission: { bytes: 90000 } }
  const guest = { toolUseId: 'guest-call', name: 'mcp__fixture__save', status: 'completed', input }
  expect(codeModeInputWasOmitted(guest)).toBe(false)
  expect(codeModeInput(guest)).toBe(input)
  const plain = cell({ calls: [guest] })
  expect(parseCodeMode(plain)).toBe(plain)
  const host = { ...guest, input: {}, inputOmission: { bytes: 90000 } }
  expect(codeModeInputWasOmitted(host)).toBe(true)
  const envelope = cell({ calls: [host] })
  expect(parseCodeMode(envelope)).toBe(envelope)
  for (const inputOmission of [null, {}, { bytes: -1 }, { bytes: 1.5 }, { bytes: '90000' }, { bytes: 90000, extra: true }]) {
    expect(parseCodeMode(cell({ calls: [{ ...guest, inputOmission } as unknown as typeof host] }))).toBeNull()
  }
})
