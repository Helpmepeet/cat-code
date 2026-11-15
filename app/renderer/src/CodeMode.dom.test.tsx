import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, memo, Profiler } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { TranscriptRowsView } from './TranscriptView.js'
import { ToolInspector } from './ToolInspector.js'
import { ToolsExpandedContext } from './toolsExpanded.js'
import { ToolOutputContext } from './toolOutputPanel.js'
import { selectCodeModeLine } from './codeModeSelection.js'
import type { NestedToolUseRow } from './transcriptProjector.js'
import type { CodeModeEnvelope } from './codeMode.js'
import { PermissionQueue } from './PermissionQueue.js'
import { CodeModeCard } from './CodeModeCard.js'
let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await act(async () => { await harness.nextFrame() }); await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })
function row(id = 'cell', patch: Partial<CodeModeEnvelope> = {}): NestedToolUseRow {
  const cell: CodeModeEnvelope = { kind: 'code-mode', cellId: id, generation: 'g', description: 'Inspect project', code: '// Read files\nRead();\n// Verify\nBash();', status: 'completed', output: 'result text', calls: [{ toolUseId: 'r', name: 'Read', input: { file_path: '/a' }, status: 'completed', line: 2 }, { toolUseId: 'b', name: 'Bash', input: {}, status: 'failed', error: '15 tests failed', line: 4 }], changedFiles: [{ path: '/a', additions: 3 }], ...patch }
  return { kind: 'tool-use', id, sessionId: 's', frameId: id, messageId: id, blockIndex: 0, parentToolUseId: null, toolUseId: id, toolName: 'REPL', toolFamily: 'other', input: { code: cell.code, description: cell.description }, status: 'success', result: { content: 'not the audit output', isError: false, diff: null, codeMode: cell }, agentCompletion: null, children: [] }
}
const transcript = (rows: NestedToolUseRow[]) => <ToolsExpandedContext.Provider value={{ expanded: true, setExpanded: () => {} }}><TranscriptRowsView rows={rows} cwd="/repo" /></ToolsExpandedContext.Provider>
async function click(element: Element) { await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) }) }
test('real transcript renders Script steps, caught errors, partial files and exact audit Output', async () => {
  const tree = await harness.mount(transcript([row('caught')]))
  expect(tree.container.textContent).toContain('SCRIPT')
  expect(tree.container.textContent).toContain('Read files')
  expect(tree.container.textContent).toContain('15 tests failed')
  expect(tree.container.textContent).toContain('result text')
  expect(tree.container.textContent).not.toContain('not the audit output')
  expect(tree.container.querySelectorAll('.code-mode-output button')).toHaveLength(0)
  expect(tree.container.querySelector('.code-mode-file')?.textContent).toContain('/a +3')
})
test('Script line link and source gutter share selection without selecting other cells', async () => {
  const first = row('linked-a'), second = row('linked-b')
  let opened = ''
  const tree = await harness.mount(<ToolOutputContext.Provider value={value => { opened = value.toolUseId }}>{transcript([first, second])}<ToolInspector row={first} /></ToolOutputContext.Provider>)
  const link = tree.container.querySelector('.code-mode-line')!
  await click(link)
  expect(opened).toBe(first.toolUseId)
  expect(tree.container.querySelector('.code-mode-step.is-selected')).not.toBeNull()
  const gutter = tree.container.querySelector('button[aria-label="Select line 4, executed"]')!
  expect(gutter).not.toBeNull()
  await click(gutter)
  expect(tree.container.querySelector('.code-mode-step.is-selected')?.textContent).toContain('Verify')
  expect(tree.container.querySelectorAll('.code-mode')[1]!.querySelector('.is-selected')).toBeNull()
  const output = tree.container.querySelectorAll('[role="tab"]')[1]!
  await click(output)
  expect(output.getAttribute('aria-selected')).toBe('true')
  expect(tree.container.querySelector('.code-mode-panel')?.textContent).toContain('result text')
})
test('large outputs and call sets mount bounded children and source lines', async () => {
  const value = row('large', { output: 'line\n'.repeat(100000), code: 'Read();\n'.repeat(10000), calls: Array.from({ length: 10000 }, (_, index) => ({ toolUseId: String(index), name: 'Read', input: {}, status: 'completed', line: index + 1 })) })
  const tree = await harness.mount(<>{transcript([value])}<ToolInspector row={value} /></>)
  const mountedSteps = tree.container.querySelectorAll('.code-mode-step').length
  const mountedLines = tree.container.querySelectorAll('.code-mode-panel button[aria-label^="Select line"]').length
  expect(mountedSteps).toBeGreaterThan(0)
  expect(mountedSteps).toBeLessThan(200)
  expect(mountedLines).toBeGreaterThan(0)
  expect(mountedLines).toBeLessThan(300)
  expect(tree.container.querySelector('.code-mode-output pre')!.textContent!.length).toBeLessThanOrEqual(1600)
  console.info(`Code Mode bounds: 10000 calls mount ${mountedSteps} steps and ${mountedLines} source lines; 500000-character output preview mounts 1600 characters`)
})
test('running receipt, cancellation and syntax errors remain distinct', async () => {
  const tree = await harness.mount(transcript([row('receipt', { status: 'running', calls: [], changedFiles: [] }), row('cancelled', { status: 'cancelled', error: 'Stopped after edit' }), row('syntax', { status: 'failed', calls: [], error: 'SyntaxError: unexpected token' })]))
  expect(tree.container.querySelector('.code-mode-status-running')?.textContent).toBe('running')
  expect(tree.container.querySelector('.code-mode-status-cancelled')?.textContent).toBe('cancelled')
  expect(tree.container.textContent).toContain('Stopped after edit')
  expect(tree.container.textContent).toContain('SyntaxError: unexpected token')
})
test('source selection notifies only its cell and adds no idle timer work', async () => {
  let renders = 0
  const tree = await harness.mount(<>{transcript([row('identity-a')])}<Profiler id="unrelated" onRender={() => { renders++ }}>{transcript([row('identity-b')])}</Profiler></>)
  const before = renders
  await act(async () => { selectCodeModeLine('s', 'identity-a', 2) })
  await act(async () => { await harness.nextFrame() })
  expect(renders).toBe(before)
  expect(tree.container.querySelectorAll('.code-mode-step.is-selected')).toHaveLength(1)
})

test('permission badge is correlated to host child identity, never tool input', async () => {
  const parent = row('permission-source')
  const child = { ...row('r'), result: null, status: 'pending' as const, codeMode: { cellId: parent.toolUseId, generation: 'g', line: 2 } }
  parent.children = [child]
  const request = { requestId: 'approval', request: { subtype: 'can_use_tool' as const, tool_name: 'Bash', tool_use_id: 'r', input: { command: 'date' } } }
  const tree = await harness.mount(<PermissionQueue items={[{ request, dismissed: false, submitted: false }]} transcriptRows={[parent]} onAllow={() => {}} onDeny={() => {}} onRestore={() => {}} />)
  expect(tree.container.querySelector('.code-mode-permission-badge')?.textContent).toBe('from script · line 2')
  await tree.render(<PermissionQueue items={[{ request: { ...request, request: { ...request.request, tool_use_id: 'unrelated', input: { command: 'date', codeMode: child.codeMode } } }, dismissed: false, submitted: false }]} transcriptRows={[parent]} onAllow={() => {}} onDeny={() => {}} onRestore={() => {}} />)
  expect(tree.container.querySelector('.code-mode-permission-badge')).toBeNull()
})

test('streaming input, live children and waiting permissions retain the Script object', async () => {
  const value = { ...row('streaming'), input: {}, status: 'pending' as const, result: null }
  const tree = await harness.mount(transcript([value]))
  const element = tree.container.querySelector('.code-mode')
  expect(element).not.toBeNull()
  const streaming = { ...value, input: { description: 'Read files', code: '// Read files\nRead(' } }
  await tree.render(transcript([streaming]))
  expect(tree.container.querySelector('.code-mode')).toBe(element)
  expect(tree.container.textContent).toContain('Waiting for output')
  await tree.render(<CodeModeCard row={streaming} waitingForApproval renderChild={() => null} />)
  expect(tree.container.textContent).toContain('Waiting for approval')
})

test('inline Output expands to bounded searchable full output without a second Open control', async () => {
  const value = row('inline', { output: 'result\n'.repeat(50000) })
  const tree = await harness.mount(transcript([value]))
  const summary = tree.container.querySelector('.code-mode-output summary')!
  await click(summary)
  expect(tree.container.querySelector('.code-mode-inline-output input[data-output-search]')).not.toBeNull()
  const mounted = tree.container.querySelectorAll('.code-mode-inline-output .tool-output-row').length
  expect(mounted).toBeGreaterThan(0)
  expect(mounted).toBeLessThan(300)
  expect([...tree.container.querySelectorAll('.code-mode-output button')].some(button => button.textContent?.includes('Open'))).toBe(false)
})

test('streaming Script input causes zero commits in an unchanged sibling cell', async () => {
  const historical = row('historical')
  const pending = { ...row('stream-source'), result: null, status: 'pending' as const }
  const renderChild = () => null
  let historicalCommits = 0
  // Match TranscriptRowView's row-level memo boundary rather than counting
  // Profiler reconciliation caused by the test root itself.
  const HistoricalCell = memo(function HistoricalCell({ value }: { value: NestedToolUseRow }) {
    return <Profiler id="historical-cell" onRender={() => { historicalCommits++ }}><CodeModeCard row={value} renderChild={renderChild} /></Profiler>
  })
  const view = (code: string) => <>
    <HistoricalCell value={historical} />
    <CodeModeCard row={{ ...pending, input: { description: 'Read files', code } }} renderChild={renderChild} />
  </>
  const tree = await harness.mount(view(''))
  const before = historicalCommits
  for (const code of ['// Read', '// Read files\n', '// Read files\nRead(', '// Read files\nRead();']) await tree.render(view(code))
  await act(async () => { await harness.nextFrame() })
  expect(historicalCommits - before).toBe(0)
})

test('pending scripts open automatically, clean completion closes, and explicit choices win', async () => {
  const pending = { ...row('automatic', { status: 'running' }), status: 'pending' as const }
  const complete = row('automatic', { calls: [] })
  const view = (value: NestedToolUseRow) => <ToolOutputContext.Provider value={() => {}}><TranscriptRowsView rows={[value]} /></ToolOutputContext.Provider>
  const tree = await harness.mount(view(pending))
  const header = () => tree.container.querySelector('.code-mode-disclosure')!
  expect(header().getAttribute('aria-expanded')).toBe('true')
  expect(tree.container.querySelector('.code-mode-source')?.textContent).toBe('Open')
  await tree.render(view(complete))
  expect(header().getAttribute('aria-expanded')).toBe('false')
  await click(header())
  await tree.render(view(pending))
  await tree.render(view(complete))
  expect(header().getAttribute('aria-expanded')).toBe('true')
  await click(header())
  await tree.render(view(pending))
  expect(header().getAttribute('aria-expanded')).toBe('false')
})

test('collapsed partial receipts keep paths visible and large lists bounded for all stopped outcomes', async () => {
  for (const status of ['failed', 'cancelled', 'blocked', 'yielded'] as const) {
    const value = row(`partial-${status}`, { status, changedFiles: Array.from({ length: 10000 }, (_, index) => ({ path: `/changed/file-${index}`, additions: 2 })) })
    const tree = await harness.mount(<TranscriptRowsView rows={[value]} />)
    const header = tree.container.querySelector('.code-mode-disclosure')!
    if (header.getAttribute('aria-expanded') === 'true') await click(header)
    expect(tree.container.querySelector('.code-mode-body')).toBeNull()
    const receipt = tree.container.querySelector('.code-mode-partial')!
    expect(receipt.textContent).toContain('Changed before it stopped')
    expect(receipt.textContent).toContain('/changed/file-0 +2')
    expect(receipt.querySelectorAll('.code-mode-file')).toHaveLength(3)
    expect(receipt.textContent).toContain('Show all 10000 changed files')
    if (status === 'yielded') expect(tree.container.querySelector('.code-mode-status-yielded')?.textContent).toBe('Paused')
    await tree.unmount()
  }
})

test('ordinary and MCP audit-shaped results cannot impersonate Script transcript or inspector', async () => {
  for (const toolName of ['Bash', 'mcp__foreign__audit']) {
    const ordinary = { ...row(`lookalike-${toolName}`), toolName }
    const tree = await harness.mount(<>{transcript([ordinary])}<ToolInspector row={ordinary} /></>)
    expect(tree.container.querySelector('.code-mode')).toBeNull()
    expect(tree.container.querySelector('.code-mode-panel')).toBeNull()
    expect(tree.container.querySelector('[aria-label="Script views"]')).toBeNull()
    await tree.unmount()
  }
})

test('identical cell IDs in forked sessions have isolated selection and retained per-session state', async () => {
  const first = { ...row('fork-shared-selection'), sessionId: 'fork-selection-a' }
  const second = { ...row('fork-shared-selection'), sessionId: 'fork-selection-b' }
  let secondCommits = 0
  const tree = await harness.mount(<>
    <div data-selection-pane="a">{transcript([first])}<ToolInspector row={first} /></div>
    <Profiler id="fork-b" onRender={() => { secondCommits++ }}><div data-selection-pane="b">{transcript([second])}<ToolInspector row={second} /></div></Profiler>
  </>)
  const before = secondCommits
  await act(async () => { selectCodeModeLine(first.sessionId, first.toolUseId, 2) })
  expect(secondCommits).toBe(before)
  const paneA = tree.container.querySelector('[data-selection-pane="a"]')!
  const paneB = tree.container.querySelector('[data-selection-pane="b"]')!
  expect(paneA.querySelector('.code-mode-step.is-selected')?.textContent).toContain('Read files')
  expect(paneB.querySelector('.code-mode-step.is-selected')).toBeNull()
  await act(async () => { selectCodeModeLine(second.sessionId, second.toolUseId, 4) })
  expect(paneA.querySelector('.code-mode-step.is-selected')?.textContent).toContain('Read files')
  expect(paneB.querySelector('.code-mode-step.is-selected')?.textContent).toContain('Verify')
  await tree.unmount()
  const restored = await harness.mount(<>{transcript([first])}<ToolInspector row={first} /></>)
  expect(restored.container.querySelector('.code-mode-step.is-selected')?.textContent).toContain('Read files')
  expect(restored.container.querySelector('button[aria-label="Select line 2, executed"]')?.getAttribute('aria-pressed')).toBe('true')
})
