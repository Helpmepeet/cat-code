import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, memo, Profiler } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { TranscriptRowsView } from './TranscriptView.js'
import { ToolInspector } from './ToolInspector.js'
import { ToolsExpandedContext } from './toolsExpanded.js'
import { ToolOutputContext } from './toolOutputPanel.js'
import { revealCodeModeLine, selectCodeModeLine } from './codeModeSelection.js'
import type { NestedToolUseRow } from './transcriptProjector.js'
import type { CodeModeEnvelope } from './codeMode.js'
import { PermissionQueue } from './PermissionQueue.js'
import { CodeModeCard } from './CodeModeCard.js'
import { codeModeBackgroundFixture } from './codeModeBackgroundFixture.js'
import { codeModeLiveView } from './codeModeLiveView.js'
import { TranscriptModeContext } from './transcriptMode.js'
import { createToolCardExpansionStore } from './toolCardExpansion.js'
import { findToolOutputRow } from './toolOutputRow.js'
import { SubagentWorkspace } from './SubagentWorkspace.js'
import { ToolCardStyleContext } from './toolCardStyle.js'
import { FilePaneContext } from './filePaneContext.js'
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
async function openSource(scope: ParentNode) {
  const head = scope.querySelector('.code-mode-fold-head.code-mode-script')!
  if (head.getAttribute('aria-expanded') === 'false') await click(head)
}
test('the Script transcript card follows the Lines and Cards preference', async () => {
  const value = row('card-style')
  const view = (style: 'lines' | 'cards') => <ToolCardStyleContext.Provider value={{ style, setStyle: () => {} }}>
    {transcript([value])}
  </ToolCardStyleContext.Provider>
  const tree = await harness.mount(view('lines'))
  expect(tree.container.querySelector('.code-mode')?.getAttribute('data-card-style')).toBe('lines')
  await tree.render(view('cards'))
  expect(tree.container.querySelector('.code-mode')?.getAttribute('data-card-style')).toBe('cards')
})
test('Script cells show call rows rather than code and keep Output closed until opened', async () => {
  const value = row('shape-b', { code: 'await Read();\nawait Bash();', calls: [
    { toolUseId: 'r', name: 'Read', input: { file_path: '/a' }, status: 'completed', line: 1 },
    { toolUseId: 'b', name: 'Bash', input: { command: 'echo ok' }, status: 'completed', line: 2 },
  ], changedFiles: [], output: 'selected output' })
  const tree = await harness.mount(transcript([value]))
  expect(tree.container.textContent).not.toContain('await Read()')
  expect(tree.container.textContent).not.toContain('selected output')
  expect(tree.container.textContent).toContain('/a')
  expect(tree.container.textContent).toContain('echo ok')
  await click(tree.container.querySelector('.code-mode-output-toggle')!)
  expect(tree.container.textContent).toContain('selected output')
})
test('same-line reads form an expandable group without absorbing the next line', async () => {
  const value = row('line-group', { code: 'readMany();\nreadOne();', calls: [
    { toolUseId: 'r1', name: 'Read', input: { file_path: '/first' }, status: 'completed', line: 1 },
    { toolUseId: 'r2', name: 'Read', input: { file_path: '/second' }, status: 'completed', line: 1 },
    { toolUseId: 'r3', name: 'Read', input: { file_path: '/third' }, status: 'completed', line: 2 },
  ], changedFiles: [] })
  const tree = await harness.mount(transcript([value]))
  const group = tree.container.querySelector<HTMLButtonElement>('.code-mode-group-header button')!
  expect(group.textContent).toContain('2 files')
  expect(group.getAttribute('aria-expanded')).toBe('false')
  expect(tree.container.textContent).toContain('/third')
  expect(tree.container.textContent).not.toContain('/first')
  await click(group)
  expect(tree.container.querySelector('.code-mode-group-body [data-file-actions]')?.getAttribute('title')).toBe('/first')
  expect(tree.container.querySelector('.code-mode-group-body')?.textContent).toContain('first')
  expect(tree.container.querySelector('.code-mode-group-body')?.textContent).toContain('second')
  await click(group)
  expect(tree.container.textContent).not.toContain('/first')
})

test('adjacent edits group by file, sum real diff counts, and keep unlisted file changes', async () => {
  const path = '/repo/long/folder/target.ts'
  const value = row('edit-run', { code: 'edit();\nedit();\nedit();', calls: [1, 2, 3].map((line) => ({
    toolUseId: `edit-${line}`, name: 'Edit', status: 'completed', line, input: { file_path: path, old_string: 'old source' },
  })), changedFiles: [{ path, additions: 3, deletions: 1 }, { path: '/repo/extra.ts' }] })
  value.children = [1, 2, 3].map(line => ({
    ...row(`edit-${line}`), parentToolUseId: value.toolUseId, toolName: 'Edit', toolFamily: 'edit',
    input: { file_path: path },
    result: { content: 'Edited', isError: false, diff: line === 3 ? null : {
      filePath: path, hunks: [{ oldStart: line * 6, oldLines: 2, newStart: line * 6, newLines: 3,
        lines: line === 1 ? [' keep', '-old first', '+first', '+another'] : [' keep', '+second'] }],
    } },
  }))
  const opened: string[] = []
  const tree = await harness.mount(<FilePaneContext.Provider value={async (_id, path) => {
    opened.push(path)
    return { ok: true }
  }}>{transcript([value])}</FilePaneContext.Provider>)
  const group = tree.container.querySelector('.code-mode-group-header')!
  expect(group.textContent).toContain('long/folder/target.ts')
  expect(group.textContent).not.toContain('/repo/')
  expect(group.textContent).toContain('3 edits')
  expect(group.textContent).toContain('+3−1')
  expect(tree.container.querySelector('.code-mode-changes summary')?.textContent).toBe('1 file changed')
  await click(group.querySelector('button')!)
  const edits = [...tree.container.querySelectorAll('.code-mode-group-body .code-mode-member')]
  expect(edits.map(edit => edit.querySelector('.code-mode-member-target')?.textContent)).toEqual(['line 7', 'line 13', 'old source'])
  await click(tree.container.querySelector('.code-mode-open-file')!)
  expect(opened).toEqual([path])
  const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  await act(async () => { group.querySelector('[data-file-actions]')!.dispatchEvent(contextMenu) })
  expect(contextMenu.defaultPrevented).toBe(true)
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('Copy')
  await click(edits[0]!)
  expect(tree.container.querySelector('.code-mode-member-body')?.textContent).toContain('old first')
  expect(tree.container.querySelector('.code-mode-member-body')?.textContent).toContain('another')
  expect(tree.container.querySelector('.code-mode-step.is-selected')).toBeNull()
})

test('same-line MCP rows show a readable tool name and identify the calls inside', async () => {
  const value = row('mcp-run', { calls: ['one', 'two'].map(query => ({
    toolUseId: query, name: 'mcp__tracker__find_issue', input: { query }, status: 'completed', line: 1,
  })), changedFiles: [] })
  const tree = await harness.mount(transcript([value]))
  const group = tree.container.querySelector('.code-mode-group-header button')!
  expect(group.textContent).toContain('tracker · find issue')
  expect(group.textContent).toContain('2 calls')
  await click(group)
  expect([...tree.container.querySelectorAll('.code-mode-group-body .code-mode-member-target')].map(el => el.textContent)).toEqual(['one', 'two'])
})

test('a Script with one Bash call shows its result and removes only a repeated Output', async () => {
  const calls: CodeModeEnvelope['calls'] = [{
    toolUseId: 'bash', name: 'Bash', status: 'completed', line: 1,
    input: { command: 'printf finished' }, result: { content: 'finished', isError: false },
  }]
  const first = row('one-bash-echo', { calls, output: 'finished', changedFiles: [] })
  const second = row('one-bash-transform', { calls, output: 'completion confirmed', changedFiles: [] })
  const tree = await harness.mount(transcript([first, second]))
  const [echo, transformed] = [...tree.container.querySelectorAll('.code-mode')]
  expect(echo!.querySelector('.code-mode-member-body')?.textContent).toContain('finished')
  expect(echo!.querySelector('.code-mode-output-toggle')).toBeNull()
  await click(transformed!.querySelector('.code-mode-output-toggle')!)
  expect(transformed!.querySelector('.code-mode-output')?.textContent).toContain('completion confirmed')
})

test('Script output retains guest text and receipt-only notices in restored rows', async () => {
  const selected = 'first line\n\n[Code Mode] completed; cell other; generation g.\n1 child calls completed; 0 failed, blocked, or cancelled.'
  const completion = '0 child calls completed; 0 failed, blocked, or cancelled.'
  const receipts = [
    { id: 'foreground', output: `${selected}\n\n[Code Mode] completed; cell foreground; generation g.\n${completion}`, keep: selected },
    { id: 'background', taskId: 'task', output: `approved text\n\n[Code Mode] completed; cell background; generation g.\n${completion}`, keep: 'approved text' },
    { id: 'withheld', taskId: 'task', output: `Selected output was withheld by a UserPromptSubmit hook.\n\n[Code Mode] completed; cell withheld; generation g.\n${completion}`, keep: 'Selected output was withheld by a UserPromptSubmit hook.' },
    { id: 'truncated', output: `retained text\n\n[Code Mode] completed; cell truncated; generation g.\nSelected output was truncated at the cell delivery limit.\n${completion}`, keep: 'retained text\n\nSelected output was truncated at the cell delivery limit.' },
    { id: 'permission', output: `[Code Mode] completed; cell permission; generation g.\n${completion}\nBash: approval was withdrawn`, keep: 'Bash: approval was withdrawn' },
    { id: 'wrong-generation', output: `[Code Mode] completed; cell wrong-generation; generation old.\n${completion}` },
    { id: 'cancel-before-start', output: '[Code Mode] Cancelled before interpreter evaluation started. No child tools ran.' },
    { id: 'unowned', taskId: 'task', output: '[Code Mode] Prior background execution is no longer owned. Effects may have occurred.' },
  ]
  for (const receipt of receipts) {
    const tree = await harness.mount(transcript([row(receipt.id, { calls: [], changedFiles: [], taskId: receipt.taskId, output: receipt.output })]))
    await click(tree.container.querySelector('.code-mode-output-toggle')!)
    const lines = [...tree.container.querySelectorAll('.code-mode-output .code-mode-script-row')]
    expect(lines.map(line => line.lastElementChild?.textContent).join('\n')).toBe(receipt.keep ?? receipt.output)
    await tree.unmount()
  }
})

test('a Script failure appears on its failed call only when that call carries the same reason', async () => {
  const value = (id: string, error?: string) => row(id, {
    status: 'failed', calls: [{ toolUseId: id + '-bash', name: 'Bash', input: { command: 'check' }, status: 'failed', error }],
    error: 'Host request failed', output: `[Code Mode] failed; cell ${id}; generation g.\n0 child calls completed; 1 failed, blocked, or cancelled.\nHost request failed\nNon-successful calls: Bash (failed). Earlier effects were not rolled back.`,
    changedFiles: [],
  })
  const tree = await harness.mount(transcript([value('same-error', 'Host request failed'), value('missing-error')]))
  const [same, missing] = [...tree.container.querySelectorAll('.code-mode')]
  expect(same!.textContent?.match(/Host request failed/g)).toHaveLength(1)
  expect(same!.querySelector('.code-mode-member-body')?.textContent).toContain('Host request failed')
  expect(missing!.querySelector('.code-mode-body > .code-mode-error')?.textContent).toBe('Host request failed')
})
test('calls outside the current script have no misleading line link', async () => {
  const value = row('old-helper', { code: 'Read();', calls: [
    { toolUseId: 'old', name: 'Read', input: { file_path: '/old' }, status: 'completed', line: 9 },
  ], changedFiles: [] })
  const tree = await harness.mount(<ToolOutputContext.Provider value={() => {}}>{transcript([value])}</ToolOutputContext.Provider>)
  expect(tree.container.textContent).toContain('/old')
  expect(tree.container.querySelector('.code-mode-line')).toBeNull()
})
test('live grouped calls show progress and only the line link selects source', async () => {
  const value = row('group-progress', { code: 'readMany();', status: 'running', calls: [
    { toolUseId: 'p1', name: 'Read', input: { file_path: '/first' }, status: 'completed', line: 1 },
    { toolUseId: 'p2', name: 'Read', input: { file_path: '/second' }, status: 'running', line: 1 },
  ], changedFiles: [] })
  const tree = await harness.mount(transcript([value]))
  const group = tree.container.querySelector<HTMLButtonElement>('.code-mode-group-header button')!
  expect(group.textContent).toContain('1 of 2')
  expect(group.parentElement?.querySelector('[aria-label="Running"]')).not.toBeNull()
  expect(group.textContent).not.toContain('Running')
  await click(group)
  expect(tree.container.querySelector('.code-mode-step.is-selected')).toBeNull()
  expect(tree.container.querySelector('.code-mode-script-body')).toBeNull()
  await click(group.parentElement!.querySelector('[aria-label="Show line 1 in the source"]')!)
  expect(tree.container.querySelector('button[aria-label="Select line 1, executed"]')?.getAttribute('aria-pressed')).toBe('true')
})

test('real transcript renders Script calls, caught errors, partial files and exact audit Output', async () => {
  const tree = await harness.mount(transcript([row('caught')]))
  expect(tree.container.textContent).toContain('SCRIPT')
  expect(tree.container.textContent).toContain('/a')
  expect(tree.container.textContent).toContain('15 tests failed')
  await click(tree.container.querySelector('.code-mode-output-toggle')!)
  expect(tree.container.textContent).toContain('result text')
  expect(tree.container.textContent).not.toContain('not the audit output')
  expect([...tree.container.querySelectorAll('.code-mode-output button')].some(button => button.textContent === 'Open')).toBe(false)
  expect(tree.container.querySelector('.code-mode-file')?.textContent).toContain('/a +3')
})
test('Script line link opens the inline source and shares selection without selecting other cells', async () => {
  const first = row('linked-a'), second = row('linked-b')
  const tree = await harness.mount(transcript([first, second]))
  const [cardA, cardB] = [...tree.container.querySelectorAll('.code-mode')]
  expect(cardA!.querySelector('.code-mode-script-body')).toBeNull()
  await click(cardA!.querySelector('.code-mode-line')!)
  expect(cardA!.querySelector('.code-mode-fold-head.code-mode-script')?.getAttribute('aria-expanded')).toBe('true')
  expect(cardA!.querySelector('.code-mode-script-row.is-active')?.textContent).toContain('Read();')
  expect(cardA!.querySelector('.code-mode-step.is-selected')).not.toBeNull()
  const gutter = cardA!.querySelector('button[aria-label="Select line 4, executed"]')!
  expect(gutter.classList.contains('is-failed')).toBe(true)
  await click(gutter)
  expect(cardA!.querySelector('.code-mode-step.is-selected')?.textContent).toContain('Bash')
  expect(cardB!.querySelector('.is-selected')).toBeNull()
  expect(cardB!.querySelector('.code-mode-script-body')).toBeNull()
  expect(tree.container.querySelector('.code-mode-source')).toBeNull()
})

test('a failure attributed to a line names it and marks it in the source', async () => {
  const value = row('failed-line', { status: 'failed', code: 'const r = Read();\nr.content.map(x => x);', calls: [], changedFiles: [], error: 'not a function', line: 2 })
  const tree = await harness.mount(transcript([value]))
  expect(tree.container.querySelector('.code-mode-body > .code-mode-error')?.textContent).toBe('Line 2: not a function')
  await openSource(tree.container)
  expect(tree.container.querySelector('button[aria-label="Select line 2"]')?.classList.contains('is-failed')).toBe(true)
  expect(tree.container.querySelector('button[aria-label="Select line 1"]')?.classList.contains('is-failed')).toBe(false)
})

test('large outputs and call sets mount bounded children and source lines', async () => {
  const value = row('large', { output: 'line\n'.repeat(100000), code: 'Read();\n'.repeat(10000), calls: Array.from({ length: 10000 }, (_, index) => ({ toolUseId: String(index), name: 'Read', input: {}, status: 'completed', line: index + 1 })) })
  const tree = await harness.mount(transcript([value]))
  expect(tree.container.querySelector('.code-mode-script-body')).toBeNull()
  await openSource(tree.container)
  const mountedSteps = tree.container.querySelectorAll('.code-mode-step').length
  const mountedLines = tree.container.querySelectorAll('.code-mode-script-body button[aria-label^="Select line"]').length
  expect(mountedSteps).toBeGreaterThan(0)
  expect(mountedSteps).toBeLessThan(200)
  expect(mountedLines).toBeGreaterThan(0)
  expect(mountedLines).toBeLessThan(300)
  expect(tree.container.querySelector('.code-mode-inline-output')).toBeNull()
  console.info(`Code Mode bounds: 10000 calls mount ${mountedSteps} rows and ${mountedLines} source lines; collapsed output mounts no body`)
})

test('running receipt, cancellation and syntax errors remain distinct', async () => {
  const tree = await harness.mount(transcript([row('receipt', { status: 'running', calls: [], changedFiles: [] }), row('cancelled', { status: 'cancelled', error: 'Stopped after edit' }), row('syntax', { status: 'failed', calls: [], error: 'SyntaxError: unexpected token' })]))
  expect(tree.container.querySelector('.code-mode-header .code-mode-dot-running')?.getAttribute('aria-label')).toBe('Running')
  expect(tree.container.querySelector('.code-mode-header .code-mode-dot-cancelled')?.getAttribute('aria-label')).toBe('Stopped')
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
  const summary = tree.container.querySelector('.code-mode-output-toggle')!
  await click(summary)
  expect(tree.container.querySelector('.code-mode-inline-output input[data-output-search]')).not.toBeNull()
  expect(tree.container.querySelector('.code-mode-inline-output [aria-label="Copy output"]')).not.toBeNull()
  expect([...tree.container.querySelectorAll('.code-mode-inline-output button')].some(button => button.textContent === 'Wrap')).toBe(true)
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
  expect(tree.container.querySelector('.code-mode-fold-head.code-mode-script')?.getAttribute('aria-expanded')).toBe('false')
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
    expect(tree.container.querySelector('.code-mode-script')).toBeNull()
    await tree.unmount()
  }
})

test('identical cell IDs in forked sessions have isolated selection and retained per-session state', async () => {
  const first = { ...row('fork-shared-selection'), sessionId: 'fork-selection-a' }
  const second = { ...row('fork-shared-selection'), sessionId: 'fork-selection-b' }
  let secondCommits = 0
  const tree = await harness.mount(<>
    <div data-selection-pane="a">{transcript([first])}</div>
    <Profiler id="fork-b" onRender={() => { secondCommits++ }}><div data-selection-pane="b">{transcript([second])}</div></Profiler>
  </>)
  const before = secondCommits
  await act(async () => { selectCodeModeLine(first.sessionId, first.toolUseId, 2) })
  expect(secondCommits).toBe(before)
  const paneA = tree.container.querySelector('[data-selection-pane="a"]')!
  const paneB = tree.container.querySelector('[data-selection-pane="b"]')!
  expect(paneA.querySelector('.code-mode-step.is-selected')?.textContent).toContain('/a')
  expect(paneB.querySelector('.code-mode-step.is-selected')).toBeNull()
  await act(async () => { selectCodeModeLine(second.sessionId, second.toolUseId, 4) })
  expect(paneA.querySelector('.code-mode-step.is-selected')?.textContent).toContain('/a')
  expect(paneB.querySelector('.code-mode-step.is-selected')?.textContent).toContain('Bash')
  await tree.unmount()
  const restored = await harness.mount(transcript([first]))
  expect(restored.container.querySelector('.code-mode-step.is-selected')?.textContent).toContain('/a')
  await openSource(restored.container)
  expect(restored.container.querySelector('button[aria-label="Select line 2, executed"]')?.getAttribute('aria-pressed')).toBe('true')
})

test('background child frames advance production Script, source gutter and Focused counts before final receipt', async () => {
  const fixture = codeModeBackgroundFixture('background-dom')
  const view = () => <>
    <div data-background-full>{transcript([fixture.row()])}</div>
    <div data-background-focused><TranscriptModeContext.Provider value={{ mode: 'focused', setMode() {} }}>
      <TranscriptRowsView rows={fixture.rows()} turnLive={fixture.row().status === 'pending'} />
    </TranscriptModeContext.Provider></div>
  </>
  const tree = await harness.mount(view())
  const full = () => tree.container.querySelector('[data-background-full]')!
  const focusedCount = () => tree.container.querySelector('[data-background-focused] .focused-fold-detail > span:last-child')?.textContent ?? ''
  expect(full().querySelectorAll('.code-mode-step')).toHaveLength(0)
  await openSource(full())
  fixture.start('live-read', 'Read', 2)
  await tree.render(view())
  expect(full().querySelectorAll('.code-mode-step')).toHaveLength(1)
  expect(full().querySelector('.code-mode-single [aria-label="Running"]')).not.toBeNull()
  expect(tree.container.querySelector<HTMLButtonElement>('button[aria-label="Select line 2, executed"]')?.title).toContain('running')
  expect(focusedCount()).not.toContain('read 1')
  fixture.finish('live-read')
  await tree.render(view())
  expect(full().querySelector('.code-mode-single [aria-label="Running"]')).toBeNull()
  expect(focusedCount()).toContain('read 1')
  expect(fixture.row().result!.codeMode!.calls).toEqual([])
  expect(full().querySelector('.code-mode-member')?.textContent).not.toContain('Invented')
  expect(codeModeLiveView(fixture.row())!.calls.map(call => call.name)).toEqual(['Read'])
  await click(full().querySelector('.code-mode-output-toggle')!)
  expect(full().querySelector('.code-mode-output')?.textContent).toContain('Background started')
  fixture.start('live-check', 'Bash', 4)
  fixture.finish('live-check')
  await tree.render(view())
  expect(full().querySelectorAll('.code-mode-step')).toHaveLength(2)
  expect(full().querySelectorAll('.code-mode-linked-call')).toHaveLength(2)
  expect(tree.container.querySelector('button[aria-label="Select line 4, executed"]')).not.toBeNull()
  expect(focusedCount()).toContain('ran 1')
  const observed = codeModeLiveView(fixture.row())!.calls
  fixture.receipt('running', [{ ...observed[0]!, status: 'running' }])
  await tree.render(view())
  expect(full().querySelectorAll('.code-mode-linked-call')).toHaveLength(2)
  // Final host ledger is authoritative even if older child frames remain.
  fixture.receipt('completed', [observed[0]!])
  await tree.render(view())
  expect(full().querySelectorAll('.code-mode-step')).toHaveLength(1)
  expect(full().querySelectorAll('.code-mode-linked-call')).toHaveLength(1)
  expect(tree.container.querySelector('button[aria-label="Select line 4, executed"]')).toBeNull()
  expect(focusedCount()).toContain('read 1')
  expect(focusedCount()).not.toContain('ran 1')
  expect(full().querySelector('.code-mode-output')?.textContent).toContain('Final selected output')
})

test('opened named Focused Scripts are headerless and visible without changing Full expansion choices', async () => {
  for (const status of ['running', 'completed'] as const) {
    const fixture = codeModeBackgroundFixture(`named-${status}`)
    fixture.start('read', 'Read', 2)
    fixture.finish('read')
    fixture.receipt(status, codeModeLiveView(fixture.row())!.calls)
    const store = createToolCardExpansionStore()
    const view = (mode: 'full' | 'focused') => <TranscriptModeContext.Provider value={{ mode, setMode() {} }}><TranscriptRowsView rows={fixture.rows()} turnLive={status === 'running'} toolCardExpansionStore={store} /></TranscriptModeContext.Provider>
    const tree = await harness.mount(view('full'))
    const fullHeader = tree.container.querySelector('.code-mode-disclosure')!
    if (fullHeader.getAttribute('aria-expanded') === 'false') await click(fullHeader)
    await click(tree.container.querySelector('.code-mode-disclosure')!)
    expect(tree.container.querySelector('.code-mode-body')).toBeNull()
    await tree.render(view('focused'))
    const turn = tree.container.querySelector('.focused-fold-head')!
    if (turn.getAttribute('aria-expanded') === 'false') await click(turn)
    const step = tree.container.querySelector('.focused-step-head')!
    expect(step.textContent).toContain('Inspect in background')
    if (step.getAttribute('aria-expanded') === 'false') await click(step)
    const body = tree.container.querySelector('.focused-step-body')!
    expect(Boolean(body.querySelector('.code-mode-header'))).toBe(false)
    expect(body.querySelector('.code-mode-body')).not.toBeNull()
    expect(body.querySelector('.code-mode-source')).toBeNull()
    await click(body.querySelector('.code-mode-line')!)
    expect(body.querySelector('.code-mode-script-row.is-active')).not.toBeNull()
    await tree.render(view('full'))
    expect(tree.container.querySelector('.code-mode-disclosure')?.getAttribute('aria-expanded')).toBe('false')
    expect(tree.container.querySelector('.code-mode-body')).toBeNull()
    await tree.unmount()
  }
})

test('zero-call parse failures keep a visible Focused body and reachable Script source', async () => {
  const value = { ...row('named-parse', { status: 'failed', calls: [], code: 'const = ;', error: 'SyntaxError: unexpected token' }), status: 'error' as const }
  const user = { id: 'parse-user', sessionId: value.sessionId, frameId: 'parse-user', messageId: 'parse-user', blockIndex: 0, parentToolUseId: null, children: [], kind: 'user-text' as const, role: 'user' as const, content: 'Inspect', isReplay: false }
  const tree = await harness.mount(<TranscriptModeContext.Provider value={{ mode: 'focused', setMode() {} }}><TranscriptRowsView rows={[user, value]} /></TranscriptModeContext.Provider>)
  const turn = tree.container.querySelector('.focused-fold-head')!
  if (turn.getAttribute('aria-expanded') === 'false') await click(turn)
  const step = tree.container.querySelector('.focused-step-head')
  expect(step).not.toBeNull()
  if (step!.getAttribute('aria-expanded') === 'false') await click(step!)
  const body = tree.container.querySelector('.focused-step-body')!
  expect(Boolean(body.querySelector('.code-mode-header'))).toBe(false)
  expect(body.textContent).toContain('SyntaxError: unexpected token')
  await openSource(body)
  expect(body.querySelector('.code-mode-script-body')?.textContent).toContain('const = ;')
})

test('Script child cards and their inspectors show host-final commands and paths, not submitted history', async () => {
  for (const name of ['Bash', 'Read']) {
    const fixture = codeModeBackgroundFixture(`final-action-${name}`)
    fixture.start('action', name, 2)
    fixture.finish('action', 'Actual child output', name === 'Read')
    const before = fixture.row()
    const submitted = before.children[0] as NestedToolUseRow
    const observed = codeModeLiveView(before)!.calls[0]!
    const input = name === 'Bash' ? { command: 'printf hook-final-command' } : { file_path: '/repo/hook-final.txt' }
    fixture.receipt(name === 'Bash' ? 'completed' : 'blocked', [{ ...observed, input, status: name === 'Bash' ? 'completed' : 'blocked' }])
    const parent = fixture.row()
    const inspector = findToolOutputRow(fixture.rows(), submitted.id)!
    const tree = await harness.mount(<>{transcript([parent])}<ToolInspector row={inspector} /></>)
    const target = name === 'Bash' ? 'hook-final-command' : 'hook-final.txt'
    const childCard = tree.container.querySelector('.code-mode-linked-call')!
    expect(childCard.textContent).toContain(target)
    expect(childCard.textContent).toContain('Actual child output')
    expect(childCard.textContent).not.toContain('test -e /repo/a')
    expect(tree.container.querySelector('.tool-output-target')?.textContent).toContain(target)
    expect(parent.children[0]).toBe(submitted)
    expect(submitted.input).toEqual(name === 'Bash' ? { command: 'test -e /repo/a' } : { file_path: '/repo/a' })
    expect(inspector.result).toBe(submitted.result)
    expect(inspector.id).toBe(submitted.id)
    await tree.unmount()
  }
})

test('omitted final inputs are explicit in Script child and inspector without original-action fallback', async () => {
  const fixture = codeModeBackgroundFixture('omitted-action-dom')
  fixture.start('omitted', 'Bash', 2)
  fixture.finish('omitted', 'Actual child output')
  const submitted = fixture.row().children[0] as NestedToolUseRow
  const observed = codeModeLiveView(fixture.row())!.calls[0]!
  fixture.receipt('completed', [{ ...observed, input: { omitted: true, reason: 'Final executable input display limit', bytes: 70000 }, inputOmission: { bytes: 70000 } }])
  const inspector = findToolOutputRow(fixture.rows(), submitted.id)!
  const tree = await harness.mount(<>{transcript([fixture.row()])}<ToolInspector row={inspector} /></>)
  expect(tree.container.querySelector('.code-mode-linked-call .code-mode-input-note')?.textContent).toBe('Final input is too large to display')
  expect(tree.container.querySelector('aside .code-mode-input-note')?.textContent).toBe('Final input is too large to display')
  expect(tree.container.textContent).not.toContain('test -e /repo/a')
  expect(submitted.input.command).toBe('test -e /repo/a')
})

function sourceWorkspace(value: NestedToolUseRow) {
  return <ToolsExpandedContext.Provider value={{ expanded: true, setExpanded() {} }}>
    <SubagentWorkspace dock={{ active: [], finished: [], chipFaces: [], nextUpdateAt: null }} collapsed={false}
      onCollapsedChange={() => {}} onClearFinished={() => {}} onDetailsVisibleChange={() => {}}
      onFallback={() => {}} onOpenWorkers={() => {}} rows={[value]} cwd={null}>
      <main className="session-pane"><TranscriptRowsView rows={[value]} /></main>
    </SubagentWorkspace>
  </ToolsExpandedContext.Provider>
}

test('real workspace Line links reveal source again, including the same previously selected line', async () => {
  const value = row('workspace-line-reveal', { code: '// Read files\nRead();\n// Verify\nBash();\n' + 'void 0;\n'.repeat(400) })
  const tree = await harness.mount(sourceWorkspace(value))
  const line = () => tree.container.querySelector('.code-mode-line')!
  await click(line())
  expect(tree.container.querySelector('.code-mode-panel, [aria-label="Script inspector"]')).toBeNull()
  const scroller = tree.container.querySelector<HTMLElement>('.code-mode-script-body')!
  expect(tree.container.querySelector('button[aria-label="Select line 2, executed"]')?.getAttribute('aria-pressed')).toBe('true')
  await act(async () => { scroller.scrollTop = 5000; scroller.dispatchEvent(new Event('scroll')); await harness.nextFrame() })
  expect(scroller.scrollTop).toBe(5000)
  await click(line())
  expect(tree.container.querySelector('.code-mode-script-body') === scroller).toBe(true)
  expect(scroller.scrollTop).toBeLessThan(5000)
  expect(tree.container.querySelector('.code-mode-script-row.is-active')?.textContent).toContain('Read();')
  await click(tree.container.querySelector('.code-mode-fold-head.code-mode-script')!)
  expect(tree.container.querySelector('.code-mode-script-body')).toBeNull()
  await click(line())
  expect(tree.container.querySelector('.code-mode-script-row.is-active')?.textContent).toContain('Read();')
})

test('a step disclosure leaves selection alone and the gutter and line link share it', async () => {
  const value = row('workspace-step-select', { code: '// Read files\nRead();\n// Verify\nBash();\n' + 'void 0;\n'.repeat(400) })
  const tree = await harness.mount(sourceWorkspace(value))
  await click(tree.container.querySelector('.code-mode-step .code-mode-member')!)
  expect(tree.container.querySelector('.code-mode-script-body')).toBeNull()
  expect(tree.container.querySelector('.code-mode-step.is-selected')).toBeNull()
  await openSource(tree.container)
  expect(tree.container.querySelector('.code-mode-script-row.is-active')).toBeNull()
  await click(tree.container.querySelector('.code-mode-line')!)
  expect(tree.container.querySelector('.code-mode-step.is-selected')?.textContent).toContain('/a')
  expect(tree.container.querySelector('.code-mode-script-row.is-active')?.textContent).toContain('Read();')
  await click(tree.container.querySelector('button[aria-label="Select line 4, executed"]')!)
  expect(tree.container.querySelector('.code-mode-step.is-selected')?.textContent).toContain('Bash')
  expect(tree.container.querySelector('.code-mode-script-row.is-active')?.textContent).toContain('Bash();')
})

test('streamed background child updates keep an open source fold and its scroll box', async () => {
  const fixture = codeModeBackgroundFixture('source-fold-streaming')
  const tree = await harness.mount(sourceWorkspace(fixture.row()))
  await openSource(tree.container)
  const body = tree.container.querySelector('.code-mode-script-body')!
  fixture.start('read', 'Read', 2)
  await tree.render(sourceWorkspace(fixture.row()))
  fixture.finish('read')
  await tree.render(sourceWorkspace(fixture.row()))
  expect(tree.container.querySelector('.code-mode-script-body') === body).toBe(true)
  expect(tree.container.querySelector('button[aria-label="Select line 2, executed"]')).not.toBeNull()
})

test('explicit source reveals do not notify an identical cell in another session', async () => {
  const first = { ...row('reveal-shared-cell'), sessionId: 'reveal-session-a' }
  const second = { ...row('reveal-shared-cell'), sessionId: 'reveal-session-b' }
  let secondCommits = 0
  const tree = await harness.mount(<>
    <div data-reveal-pane="a">{transcript([first])}</div>
    <Profiler id="reveal-b" onRender={() => { secondCommits++ }}><div data-reveal-pane="b">{transcript([second])}</div></Profiler>
  </>)
  const before = secondCommits
  await act(async () => { revealCodeModeLine(first.sessionId, first.toolUseId, 2) })
  expect(tree.container.querySelector('[data-reveal-pane="a"] .code-mode-step.is-selected')).not.toBeNull()
  expect(tree.container.querySelector('[data-reveal-pane="b"] .code-mode-step.is-selected')).toBeNull()
  expect(secondCommits).toBe(before)
})

test('guest MCP arguments that resemble omission control remain visible data without omission UI', async () => {
  const fixture = codeModeBackgroundFixture('guest-omission-data-dom')
  const input = { omitted: true, reason: 'Final executable input display limit', bytes: 1, file_path: '/actual-target', inputOmission: { bytes: 90000 } }
  fixture.start('save', 'mcp__fixture__save', 2)
  fixture.finish('save', JSON.stringify(input))
  const submitted = fixture.row().children[0] as NestedToolUseRow
  const observed = codeModeLiveView(fixture.row())!.calls[0]!
  fixture.receipt('completed', [{ ...observed, input }])
  const inspector = findToolOutputRow(fixture.rows(), submitted.id)!
  const tree = await harness.mount(<>{transcript([fixture.row()])}<ToolInspector row={inspector} /></>)
  expect(inspector.input).toEqual(input)
  expect(inspector.codeModeInputOmitted).toBeUndefined()
  expect(Boolean(tree.container.querySelector('.code-mode-input-note'))).toBe(false)
  expect(tree.container.textContent).toContain('/actual-target')
  expect(tree.container.textContent).toContain('omitted')
})

test('genuine host omission UI clears when the canonical input becomes small', async () => {
  const fixture = codeModeBackgroundFixture('host-omission-clearing-dom')
  fixture.start('save', 'Bash', 2)
  fixture.finish('save', 'Actual child output')
  const submitted = fixture.row().children[0] as NestedToolUseRow
  const observed = codeModeLiveView(fixture.row())!.calls[0]!
  fixture.receipt('completed', [{ ...observed, input: { omitted: true, reason: 'Final executable input display limit', bytes: 90000 }, inputOmission: { bytes: 90000 } }])
  const view = () => <>{transcript([fixture.row()])}<ToolInspector row={findToolOutputRow(fixture.rows(), submitted.id)} /></>
  const tree = await harness.mount(view())
  expect(tree.container.querySelectorAll('.code-mode-input-note')).toHaveLength(2)
  fixture.receipt('completed', [{ ...observed, input: { command: 'printf small-final-input' } }])
  await tree.render(view())
  expect(Boolean(tree.container.querySelector('.code-mode-input-note'))).toBe(false)
  expect(tree.container.querySelector('.code-mode-linked-call')?.textContent).toContain('small-final-input')
  expect(tree.container.querySelector('.tool-output-target')?.textContent).toContain('small-final-input')
  expect(submitted.input.command).toBe('test -e /repo/a')
})
