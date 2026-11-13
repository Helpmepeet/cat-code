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
import { MAX_MOUNTED_CHUNK_CHARS, MAX_MOUNTED_OUTPUT_LINES } from './lineWindow.js'
let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })
const image = { mediaType: 'image/png' as const, data: 'iVBORw0KGgo=' }
const steps: ComputerStep[] = [{ id: 'one', title: 'Opening Reminders', status: 'success', observation: '', image }, { id: 'two', title: 'Checking the list', status: 'pending', observation: '', image: null }]

test('running, between steps, stopped and finished statuses retain screenshot follow controls', async () => {
  let stops = 0
  const selections: (string | null)[] = []
  const view = (running: boolean, selectedId: string | null, current = steps, stopped = false) => <ComputerPane steps={current} running={running} stopped={stopped} selectedId={selectedId} onSelect={id => selections.push(id)} onClose={() => {}} onStop={() => { stops++ }} />
  const tree = await harness.mount(view(true, null))
  expect([...tree.container.querySelectorAll('.computer-pane-header button')].map(button => button.getAttribute('aria-label') ?? button.textContent)).toEqual(['Back', 'Forward', 'Stop', 'Close computer panel'])
  expect(tree.container.querySelector('.computer-pane-header button[aria-label="Back"]')?.hasAttribute('disabled')).toBe(true)
  expect(tree.container.querySelector('.computer-pane-caption button[aria-label="Previous computer step"]')).not.toBeNull()
  expect(tree.container.querySelector('.computer-pane-status')?.textContent).toBe('Using your Mac')
  expect(tree.container.querySelector('.computer-pane-now')?.textContent).toBe('NowChecking the list')
  expect(tree.container.querySelector('.computer-pane-screen')?.hasAttribute('data-agent')).toBe(true)
  expect(tree.container.querySelector('[data-now]')?.textContent).toBe('now')
  expect(tree.container.querySelector('.computer-pane-latest')).toBeNull()
  await act(async () => tree.container.querySelector<HTMLButtonElement>('.computer-pane-stop')!.click())
  expect(stops).toBe(1)
  await tree.render(view(true, 'one'))
  expect(tree.container.querySelector('.computer-pane-latest')?.textContent).toBe('Latest output')
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
  expect(tree.container.querySelector('.computer-pane-latest')?.textContent).toBe('Latest output')
  expect(tree.container.querySelector('.computer-pane-stop')).toBeNull()
  await tree.render(view(false, null, completed, true))
  expect(tree.container.querySelector('.computer-pane-status')?.textContent).toBe('Stopped2 steps')
  await tree.render(view(false, null, [steps[0]!]))
  expect(tree.container.querySelector('.computer-pane-status')?.textContent).toBe('Finished1 steps')
})

test('navigation, Latest output, close and screenshotless selection use supplied state', async () => {
  const calls: (string | null)[] = []
  let closed = false
  const view = (selectedId: string | null, active = true) => <ComputerPane steps={steps} selectedId={selectedId} onSelect={id => calls.push(id)} onClose={() => { closed = true }} active={active} />
  const tree = await harness.mount(view(null))
  expect(tree.container.querySelector('img')?.src).toContain('data:image/png;base64,')
  expect(tree.container.textContent).toContain('Step 1')
  await act(async () => { tree.container.querySelector<HTMLButtonElement>('[aria-label="Next computer step"]')!.click() })
  expect(calls).toEqual(['two'])
  await tree.render(view('two'))
  expect(tree.container.querySelector('img')?.alt).toBe('Screenshot: Opening Reminders')
  expect(tree.container.querySelector('.computer-pane-from')?.textContent).toBe('Screen from step 1')
  await act(async () => tree.container.querySelector<HTMLButtonElement>('.computer-pane-from')!.click())
  expect(calls).toEqual(['two', 'one'])
  await act(async () => { tree.container.querySelector<HTMLButtonElement>('.computer-pane-latest')!.click(); tree.container.querySelector<HTMLButtonElement>('[aria-label="Close computer panel"]')!.click() })
  expect(calls).toEqual(['two', 'one', null])
  expect(closed).toBe(true)
  await tree.render(view(null, false))
  expect(tree.container.querySelector('section')?.hidden).toBe(true)
})

test('text-only observations display without images and follow new output, not the last screenshot', async () => {
  const first: ComputerStep = { ...steps[1]!, status: 'success', observation: 'Browser tab: 12, Title: "Drive"\n42 button Share' }
  const second: ComputerStep = { ...first, id: 'three', title: 'Reading sharing settings', observation: '+ 45 text Restricted\n<script>not markup</script>' }
  const view = (current: ComputerStep[], selectedId: string | null = null) => <ComputerPane steps={current} running selectedId={selectedId} onSelect={() => {}} onClose={() => {}} />
  const tree = await harness.mount(view([first]))
  expect(tree.container.querySelector('.computer-pane-screen')).toBeNull()
  expect(tree.container.querySelector('[aria-label="Computer observation"]')?.textContent).toContain('42 button Share')
  expect(tree.container.querySelector('.computer-pane-empty')).toBeNull()
  await tree.render(view([steps[0]!, first, second]))
  expect(tree.container.querySelector('.computer-pane-title')?.textContent).toBe('Reading sharing settings')
  expect(tree.container.querySelector('[aria-label="Computer observation"]')?.textContent).toContain('+ 45 text Restricted')
  expect(tree.container.querySelector('[aria-label="Computer observation"]')?.textContent).toContain('<script>not markup</script>')
  expect(tree.container.querySelector('script')).toBeNull()
  expect(tree.container.querySelector('.computer-pane-observation-heading')?.textContent).toContain('may show only what changed')
  expect(tree.container.querySelector('img')?.alt).toBe('Screenshot: Opening Reminders')
  expect(tree.container.querySelector('.computer-pane-from')?.textContent).toBe('Screen from step 1')
  await tree.render(view([steps[0]!, first, second], first.id))
  expect(tree.container.querySelector('[aria-label="Computer observation"]')?.textContent).toContain('42 button Share')
  expect(tree.container.querySelector('[aria-label="Computer observation"]')?.textContent).not.toContain('Restricted')
  await tree.render(view([steps[0]!, first, second, { ...steps[1]!, id: 'pending' }]))
  expect(tree.container.querySelector('.computer-pane-title')?.textContent).toBe('Reading sharing settings')
  expect(tree.container.querySelector('.computer-pane-now')).not.toBeNull()
})

test('an empty step before the first capture never displays future output', async () => {
  const tree = await harness.mount(<ComputerPane steps={[steps[1]!, steps[0]!]} selectedId="two" onSelect={() => {}} onClose={() => {}} />)
  expect(tree.container.querySelector('img')).toBeNull()
  expect(tree.container.querySelector('[role="status"]')?.textContent).toContain('No output for this step')
  expect(tree.container.querySelector('.computer-pane-latest')?.textContent).toBe('Latest output')
  await tree.render(<ComputerPane steps={[steps[1]!]} running selectedId={null} onSelect={() => {}} onClose={() => {}} />)
  expect(tree.container.querySelector('[role="status"]')?.textContent).toContain('Waiting for output')
})

test('large observations stay windowed, unchanged output retains its DOM, and hidden panes unmount observation work', async () => {
  const large: ComputerStep = { ...steps[0]!, image: null, observation: `${'x'.repeat(20_000)}\n${Array.from({ length: 10_000 }, (_, i) => `line ${i}`).join('\n')}` }
  const view = (current: ComputerStep[], active = true) => <ComputerPane steps={current} active={active} selectedId={null} onSelect={() => {}} onClose={() => {}} />
  const tree = await harness.mount(view([large]))
  const output = tree.container.querySelector('[aria-label="Computer observation"]')!
  expect(output.querySelectorAll('div').length).toBeLessThan(MAX_MOUNTED_OUTPUT_LINES * 3)
  expect(output.textContent!.length).toBeLessThan(MAX_MOUNTED_CHUNK_CHARS + 10_000)
  await tree.render(view([large, steps[1]!]))
  expect(tree.container.querySelector('[aria-label="Computer observation"]')).toBe(output)
  await tree.render(view([large, steps[1]!], false))
  expect(tree.container.querySelector('[aria-label="Computer observation"]')).toBeNull()
  expect(tree.container.innerHTML).not.toContain('computer-pane-observation-heading')
})

test('long observation lines remain fully reachable through bounded part navigation', async () => {
  const long: ComputerStep = { ...steps[0]!, image: null, observation: `START ${'x'.repeat(MAX_MOUNTED_CHUNK_CHARS * 2)} TAIL_SENTINEL` }
  const tree = await harness.mount(<ComputerPane steps={[long]} selectedId={null} onSelect={() => {}} onClose={() => {}} />)
  const output = () => tree.container.querySelector('[aria-label="Computer observation"]')!
  expect(output().textContent).not.toContain('TAIL_SENTINEL')
  const next = () => output().querySelector<HTMLButtonElement>('[aria-label="Next part of line 1"]')
  expect(next()).not.toBeNull()
  await act(async () => next()!.click())
  expect(output().textContent!.length).toBeLessThan(MAX_MOUNTED_CHUNK_CHARS + 500)
  await act(async () => next()!.click())
  expect(output().textContent).toContain('TAIL_SENTINEL')
  expect(next()).toBeNull()
  await act(async () => output().querySelector<HTMLButtonElement>('[aria-label="Previous part of line 1"]')!.click())
  expect(output().textContent).not.toContain('TAIL_SENTINEL')
  expect(next()).not.toBeNull()
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
