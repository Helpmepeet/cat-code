import { expect, test } from 'bun:test'
import { codeModeDigest, codeModeStepDigest, codeModeSteps, parseCodeMode, type CodeModeEnvelope } from './codeMode.js'
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
test('comment-derived steps keep failures and cache identity', () => {
  const value = cell()
  const steps = codeModeSteps(value)
  expect(steps.map(step => step.label)).toEqual(['Read files', 'Check'])
  expect(steps[1]!.calls[0]!.error).toBe('test failed')
  expect(codeModeSteps(value)).toBe(steps)
  expect(codeModeDigest(value)).toBe('1 file read · 1 error')
})
test('no comments falls back to source lines then individual calls', () => {
  const value = cell({ code: 'Read();\nBash();', calls: [{ toolUseId: 'a', name: 'Read', input: {}, status: 'completed', line: 1 }, { toolUseId: 'b', name: 'Bash', input: {}, status: 'running' }] })
  expect(codeModeSteps(value).map(step => step.label)).toEqual(['Read();', 'Bash'])
})
test('parse errors and not-run cells create no fictional steps', () => {
  expect(codeModeSteps(cell({ calls: [], status: 'failed', error: 'SyntaxError' }))).toEqual([])
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
test('large cells keep stable groups without scanning source for each call', () => {
  const value = cell({ code: Array.from({ length: 10000 }, (_, index) => `// step ${index}\nRead();`).join('\n'), calls: Array.from({ length: 10000 }, (_, index) => ({ toolUseId: String(index), name: 'Read', input: {}, status: 'completed', line: index * 2 + 2 })) })
  const start = performance.now()
  const steps = codeModeSteps(value)
  expect(steps).toHaveLength(10000)
  expect(codeModeSteps(value)).toBe(steps)
  expect(performance.now() - start).toBeLessThan(1000)
})

test('strings and nested comments cannot invent top-level step labels', () => {
  const value = cell({ code: 'const text = `\n// Not a step\n`;\nRead();', calls: [{ toolUseId: 'a', name: 'Read', input: {}, status: 'completed', line: 4 }] })
  expect(codeModeSteps(value)[0]!.label).toBe('Read();')
})
test('retained helper calls without current source mapping do not get misleading line links', () => {
  for (const line of [undefined, 999]) {
    const value = cell({ calls: [{ toolUseId: 'a', name: 'Read', input: {}, status: 'completed', ...(line ? { line } : {}) }] })
    expect(codeModeSteps(value)[0]!.line).toBeUndefined()
    expect(codeModeSteps(value)[0]!.label).toBe('Read')
  }
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
