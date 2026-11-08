import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { ComputerPane } from './ComputerPane.js'
import { ComputerPaneContext } from './computerPaneContext.js'
import { TranscriptRowsView } from './TranscriptView.js'
import { ToolCardExpansionContext, createToolCardExpansionStore } from './toolCardExpansion.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'
import type { ComputerStep } from './computerPaneModel.js'
import { SubagentWorkspace } from './SubagentWorkspace.js'
import { disposeFilePaneSession, showSlotOccupant, updateFilePaneSession } from './filePaneState.js'
let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })
const image = { mediaType: 'image/png' as const, data: 'iVBORw0KGgo=' }
const steps: ComputerStep[] = [{ id: 'one', title: 'Opening Reminders', status: 'success', image }, { id: 'two', title: 'Checking the list', status: 'pending', image: null }]

test('live, between steps, stopped and finished statuses retain follow controls', async () => {
  let stops = 0
  const selections: (string | null)[] = []
  const view = (running: boolean, selectedId: string | null, current = steps, stopped = false) => <ComputerPane steps={current} running={running} stopped={stopped} selectedId={selectedId} onSelect={id => selections.push(id)} onClose={() => {}} onStop={() => { stops++ }} />
  const tree = await harness.mount(view(true, null))
  expect(tree.container.querySelector('.computer-pane-status')?.textContent).toBe('Using your Mac')
  expect(tree.container.querySelector('.computer-pane-now')?.textContent).toBe('NowChecking the list')
  expect(tree.container.querySelector('.computer-pane-screen')?.hasAttribute('data-agent')).toBe(true)
  expect(tree.container.querySelector('[data-now]')?.textContent).toBe('now')
  expect(tree.container.querySelector('.computer-pane-latest')).toBeNull()
  await act(async () => tree.container.querySelector<HTMLButtonElement>('.computer-pane-stop')!.click())
  expect(stops).toBe(1)
  await tree.render(view(true, 'one'))
  expect(tree.container.querySelector('.computer-pane-latest')?.textContent).toBe('Back to live')
  expect(tree.container.querySelector('.computer-pane-screen')?.hasAttribute('data-agent')).toBe(false)
  await act(async () => tree.container.querySelector<HTMLButtonElement>('.computer-pane-latest')!.click())
  expect(selections).toEqual([null])
  const completed: ComputerStep[] = [steps[0]!, { ...steps[1]!, status: 'error' }]
  await tree.render(view(true, 'two', completed))
  expect(tree.container.querySelector('.computer-pane-status')?.textContent).toBe('Between steps')
  expect(tree.container.querySelector('.computer-pane-now')).toBeNull()
  expect(tree.container.querySelector('.computer-pane-failed')?.textContent).toBe('Failed')
  await tree.render(view(false, 'two', completed))
  expect(tree.container.querySelector('.computer-pane-status')?.textContent).toBe('Finished2 steps · 1 failed')
  expect(tree.container.querySelector('.computer-pane-latest')?.textContent).toBe('Latest')
  expect(tree.container.querySelector('.computer-pane-stop')).toBeNull()
  await tree.render(view(false, null, completed, true))
  expect(tree.container.querySelector('.computer-pane-status')?.textContent).toBe('Stopped2 steps')
  await tree.render(view(false, null, [steps[0]!]))
  expect(tree.container.querySelector('.computer-pane-status')?.textContent).toBe('Finished1 steps')
})

test('navigation, Latest, close and screenshotless selection use supplied state', async () => {
  const calls: (string | null)[] = []
  let closed = false
  const view = (selectedId: string | null, active = true) => <ComputerPane steps={steps} selectedId={selectedId} onSelect={id => calls.push(id)} onClose={() => { closed = true }} active={active} />
  const tree = await harness.mount(view(null))
  expect(tree.container.querySelector('img')?.src).toContain('data:image/png;base64,')
  expect(tree.container.textContent).toContain('Step 1')
  await act(async () => { tree.container.querySelector<HTMLButtonElement>('[aria-label="Next computer step"]')!.click() })
  expect(calls).toEqual(['two'])
  await tree.render(view('two'))
  expect(tree.container.textContent).toContain('No screenshot yet')
  await act(async () => { tree.container.querySelector<HTMLButtonElement>('.computer-pane-latest')!.click(); tree.container.querySelector<HTMLButtonElement>('[aria-label="Close computer panel"]')!.click() })
  expect(calls).toEqual(['two', null])
  expect(closed).toBe(true)
  await tree.render(view(null, false))
  expect(tree.container.querySelector('section')?.hidden).toBe(true)
})

const row: NestedTranscriptRow = {
  id: 'one', sessionId: 'test', messageId: 'one', frameId: 'one', blockIndex: 0, parentToolUseId: null,
  kind: 'tool-use', toolUseId: 'one', toolName: 'mcp__codex-computer-use__js', toolFamily: 'computer',
  input: { title: 'Opening Reminders', code: 'await screenshot()' }, status: 'success', agentCompletion: null,
  result: { content: '', isError: false, diff: null, images: [image] }, children: [],
}

test('workspace forwards turn Stop for top-level computer activity but hides it for nested drivers', async () => {
  const id = 'computer-stop-test'
  let stops = 0
  updateFilePaneSession(id, { computer: { selectedId: null } })
  showSlotOccupant(id, 'computer')
  const view = (rows: NestedTranscriptRow[]) => <SubagentWorkspace appSessionId={id} dock={{ active: [], finished: [], chipFaces: [], nextUpdateAt: null }}
    collapsed={false} onCollapsedChange={() => {}} onClearFinished={() => {}} onDetailsVisibleChange={() => {}}
    onFallback={() => {}} onOpenWorkers={() => {}} rows={rows} cwd={null} running onStop={() => { stops++ }}><div /></SubagentWorkspace>
  try {
    const tree = await harness.mount(view([row]))
    expect(tree.container.querySelector('.computer-pane-status')?.textContent).toBe('Between steps')
    await act(async () => tree.container.querySelector<HTMLButtonElement>('.computer-pane-stop')!.click())
    expect(stops).toBe(1)
    const parent = { ...row, id: 'agent', toolFamily: 'agent' as const, children: [row] }
    await tree.render(view([parent]))
    expect(tree.container.querySelector('.computer-pane-stop')).toBeNull()
  } finally {
    await act(async () => disposeFilePaneSession(id))
  }
})

test('collapsed and expanded screenshots open their step, standalone retains zoom', async () => {
  const opened: string[] = []
  const store = createToolCardExpansionStore()
  const view = (panel: boolean) => <ToolCardExpansionContext.Provider value={store}>{panel ? <ComputerPaneContext.Provider value={{ openStep: id => opened.push(id), selectedStepId: 'one' }}><TranscriptRowsView rows={[row]} /></ComputerPaneContext.Provider> : <TranscriptRowsView rows={[row]} />}</ToolCardExpansionContext.Provider>
  const tree = await harness.mount(view(true))
  const shot = () => tree.container.querySelector<HTMLButtonElement>('[aria-label="Show screenshot in Computer panel"]')!
  expect(shot().getAttribute('aria-current')).toBe('true')
  await act(async () => { shot().click() })
  await act(async () => { tree.container.querySelector<HTMLButtonElement>('[aria-expanded]')!.click() })
  expect(shot()).not.toBeNull()
  await act(async () => { shot().click() })
  expect(opened).toEqual(['one', 'one'])
  await tree.render(view(false))
  const zoom = tree.container.querySelector<HTMLButtonElement>('[aria-label="Expand result image"]')!
  expect(zoom).not.toBeNull()
  await act(async () => { zoom.click() })
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
})
