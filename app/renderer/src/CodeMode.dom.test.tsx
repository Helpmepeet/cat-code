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
  expect(tree.container.querySelector('.code-mode-status-running')?.textContent).toBe('Running')
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

test('background child frames advance production Script, source gutter and Focused counts before final receipt', async () => {
  const fixture = codeModeBackgroundFixture('background-dom')
  const view = () => <>
    <div data-background-full>{transcript([fixture.row()])}</div>
    <ToolInspector row={fixture.row()} />
    <div data-background-focused><TranscriptModeContext.Provider value={{ mode: 'focused', setMode() {} }}>
      <TranscriptRowsView rows={fixture.rows()} turnLive={fixture.row().status === 'pending'} />
    </TranscriptModeContext.Provider></div>
  </>
  const tree = await harness.mount(view())
  const full = () => tree.container.querySelector('[data-background-full]')!
  const focusedCount = () => tree.container.querySelector('[data-background-focused] .focused-fold-detail > span:last-child')?.textContent ?? ''
  expect(full().querySelectorAll('.code-mode-step')).toHaveLength(0)
  fixture.start('live-read', 'Read', 2)
  await tree.render(view())
  expect(full().querySelectorAll('.code-mode-step')).toHaveLength(1)
  expect(full().querySelector('.code-mode-step summary')?.textContent).toContain('Read files')
  expect(tree.container.querySelector<HTMLButtonElement>('button[aria-label="Select line 2, executed"]')?.title).toContain('running')
  expect(focusedCount()).not.toContain('read 1')
  fixture.finish('live-read')
  await tree.render(view())
  expect(full().querySelector('.code-mode-step summary')?.textContent).toContain('1 file read')
  expect(focusedCount()).toContain('read 1')
  expect(fixture.row().result!.codeMode!.calls).toEqual([])
  expect(full().querySelector('.code-mode-step summary')?.textContent).not.toContain('Invented')
  expect(codeModeLiveView(fixture.row())!.calls.map(call => call.name)).toEqual(['Read'])
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
    let opened = ''
    const view = (mode: 'full' | 'focused') => <ToolOutputContext.Provider value={value => { opened = value.toolUseId }}>
      <TranscriptModeContext.Provider value={{ mode, setMode() {} }}><TranscriptRowsView rows={fixture.rows()} turnLive={status === 'running'} toolCardExpansionStore={store} /></TranscriptModeContext.Provider>
    </ToolOutputContext.Provider>
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
    expect(body.querySelector('.code-mode-source')?.textContent).toBe('Open')
    await click(body.querySelector('.code-mode-source')!)
    expect(opened).toBe(fixture.cellId)
    expect(body.querySelector('.code-mode-line')).not.toBeNull()
    await tree.render(view('full'))
    expect(tree.container.querySelector('.code-mode-disclosure')?.getAttribute('aria-expanded')).toBe('false')
    expect(tree.container.querySelector('.code-mode-body')).toBeNull()
    await tree.unmount()
  }
})

test('zero-call parse failures keep a visible Focused body and reachable Script inspector', async () => {
  const value = { ...row('named-parse', { status: 'failed', calls: [], code: 'const = ;', error: 'SyntaxError: unexpected token' }), status: 'error' as const }
  const user = { id: 'parse-user', sessionId: value.sessionId, frameId: 'parse-user', messageId: 'parse-user', blockIndex: 0, parentToolUseId: null, children: [], kind: 'user-text' as const, role: 'user' as const, content: 'Inspect', isReplay: false }
  let opened = ''
  const tree = await harness.mount(<ToolOutputContext.Provider value={target => { opened = target.toolUseId }}>
    <TranscriptModeContext.Provider value={{ mode: 'focused', setMode() {} }}><TranscriptRowsView rows={[user, value]} /></TranscriptModeContext.Provider>
  </ToolOutputContext.Provider>)
  const turn = tree.container.querySelector('.focused-fold-head')!
  if (turn.getAttribute('aria-expanded') === 'false') await click(turn)
  const step = tree.container.querySelector('.focused-step-head')
  expect(step).not.toBeNull()
  if (step!.getAttribute('aria-expanded') === 'false') await click(step!)
  const body = tree.container.querySelector('.focused-step-body')!
  expect(Boolean(body.querySelector('.code-mode-header'))).toBe(false)
  expect(body.textContent).toContain('SyntaxError: unexpected token')
  await click(body.querySelector('.code-mode-source')!)
  expect(opened).toBe(value.toolUseId)
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

test('real workspace Line links reveal Script again, including the same previously selected line', async () => {
  const value = row('workspace-line-reveal', { code: '// Read files\nRead();\n// Verify\nBash();\n' + 'void 0;\n'.repeat(400) })
  const tree = await harness.mount(sourceWorkspace(value))
  const line = () => tree.container.querySelector('.code-mode-line')!
  await click(line())
  const firstPanel = tree.container.querySelector('.code-mode-panel')!
  const output = [...firstPanel.querySelectorAll('[role="tab"]')].find(tab => tab.textContent === 'Output')!
  await click(output)
  expect(output.getAttribute('aria-selected')).toBe('true')
  await click(line())
  const reopened = tree.container.querySelector('.code-mode-panel')!
  expect(reopened !== firstPanel).toBe(true)
  expect(reopened.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Script')
  expect(reopened.querySelector('button[aria-label="Select line 2, executed"]')?.getAttribute('aria-pressed')).toBe('true')
  const scroller = reopened.querySelector<HTMLElement>('.tool-output-scroller')!
  await act(async () => { scroller.scrollTop = 5000; scroller.dispatchEvent(new Event('scroll')); await harness.nextFrame() })
  expect(scroller.scrollTop).toBe(5000)
  await click(line())
  const reset = tree.container.querySelector<HTMLElement>('.code-mode-panel .tool-output-scroller')!
  expect(reset.scrollTop).toBeLessThan(5000)
  expect(tree.container.querySelector('.code-mode-panel .tool-output-row.is-active')?.textContent).toContain('Read();')
})

test('step selection reveals Script from Output and can reveal the same line without reopening the inspector', async () => {
  const value = row('workspace-step-reveal', { code: '// Read files\nRead();\n// Verify\nBash();\n' + 'void 0;\n'.repeat(400) })
  const tree = await harness.mount(sourceWorkspace(value))
  await click(tree.container.querySelector('.code-mode-line')!)
  const panel = tree.container.querySelector('.code-mode-panel')!
  await click([...panel.querySelectorAll('[role="tab"]')].find(tab => tab.textContent === 'Output')!)
  const wrap = [...panel.querySelectorAll('button')].find(button => button.textContent === 'Wrap')!
  const wasWrapped = wrap.getAttribute('aria-pressed')
  await click(wrap)
  await click(tree.container.querySelector('.code-mode-step summary')!)
  expect(tree.container.querySelector('.code-mode-panel') === panel).toBe(true)
  expect(panel.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Script')
  expect([...panel.querySelectorAll('button')].find(button => button.textContent === 'Wrap')?.getAttribute('aria-pressed')).not.toBe(wasWrapped)
  expect(Boolean(panel.querySelector('button[aria-label="Copy output"]'))).toBe(true)
  const scroller = panel.querySelector<HTMLElement>('.tool-output-scroller')!
  await act(async () => { scroller.scrollTop = 5000; scroller.dispatchEvent(new Event('scroll')); await harness.nextFrame() })
  expect(scroller.scrollTop).toBe(5000)
  await click(tree.container.querySelector('.code-mode-step summary')!)
  expect(panel.querySelector('.tool-output-scroller') === scroller).toBe(true)
  expect(scroller.scrollTop).toBeLessThan(5000)
  expect(panel.querySelector('.tool-output-row.is-active')?.textContent).toContain('Read();')
  await click([...panel.querySelectorAll('button')].find(button => button.textContent === 'Wrap')!)
})

test('streamed background child updates do not switch an explicitly selected Output tab', async () => {
  const fixture = codeModeBackgroundFixture('output-tab-streaming')
  const tree = await harness.mount(sourceWorkspace(fixture.row()))
  await click(tree.container.querySelector('.code-mode-source')!)
  const panel = tree.container.querySelector('.code-mode-panel')!
  await click([...panel.querySelectorAll('[role="tab"]')].find(tab => tab.textContent === 'Output')!)
  fixture.start('read', 'Read', 2)
  await tree.render(sourceWorkspace(fixture.row()))
  fixture.finish('read')
  await tree.render(sourceWorkspace(fixture.row()))
  expect(tree.container.querySelector('.code-mode-panel') === panel).toBe(true)
  expect(panel.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Output')
  expect(panel.textContent).toContain('Background started')
})

test('explicit source reveals do not change tabs or notify an identical cell in another session', async () => {
  const first = { ...row('reveal-shared-cell'), sessionId: 'reveal-session-a' }
  const second = { ...row('reveal-shared-cell'), sessionId: 'reveal-session-b' }
  let secondCommits = 0
  const tree = await harness.mount(<>
    <div data-reveal-pane="a"><ToolInspector row={first} /></div>
    <Profiler id="reveal-b" onRender={() => { secondCommits++ }}><div data-reveal-pane="b"><ToolInspector row={second} /></div></Profiler>
  </>)
  const paneA = tree.container.querySelector('[data-reveal-pane="a"]')!
  const paneB = tree.container.querySelector('[data-reveal-pane="b"]')!
  for (const pane of [paneA, paneB]) await click([...pane.querySelectorAll('[role="tab"]')].find(tab => tab.textContent === 'Output')!)
  const before = secondCommits
  await act(async () => { revealCodeModeLine(first.sessionId, first.toolUseId, 2) })
  expect(paneA.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Script')
  expect(paneB.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Output')
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
