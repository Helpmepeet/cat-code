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
const steps: ComputerStep[] = [{ id: 'one', title: 'Opening Reminders', status: 'success', observation: '', image }, { id: 'two', title: 'Checking the list', status: 'pending', observation: '', image: null }]

test('running, between steps, stopped and finished statuses retain screenshot follow controls', async () => {
  let stops = 0
  const selections: (string | null)[] = []
  const view = (running: boolean, selectedId: string | null, current = steps, stopped = false) => <ComputerPane steps={current} running={running} stopped={stopped} selectedId={selectedId} onSelect={id => selections.push(id)} onClose={() => {}} onStop={() => { stops++ }} />
  const tree = await harness.mount(view(true, null))
  expect([...tree.container.querySelectorAll('.computer-pane-header button')].map(button => button.getAttribute('aria-label') ?? button.textContent)).toEqual(['Back', 'Forward', 'Stop', 'Close computer panel'])
  expect(tree.container.querySelector('.computer-pane-header button[aria-label="Back"]')?.hasAttribute('disabled')).toBe(true)
  expect(tree.container.querySelector('.computer-pane-caption button[aria-label="Previous computer step"]')).toBeNull()
  expect(tree.container.querySelector('.computer-pane-status')?.textContent).toBe('Using your Mac')
  expect(tree.container.querySelector('.computer-pane-now')?.textContent).toBe('now')
  expect(tree.container.querySelector('.computer-pane-status .computer-pane-live-dot[data-live]')).not.toBeNull()
  expect(tree.container.querySelectorAll('.computer-pane-thumbnail')).toHaveLength(1)
  expect(tree.container.querySelectorAll('.computer-pane-dot[data-status]')).toHaveLength(1)
  expect(tree.container.querySelector('.computer-pane-latest')).toBeNull()
  await act(async () => tree.container.querySelector<HTMLButtonElement>('.computer-pane-stop')!.click())
  expect(stops).toBe(1)
  await tree.render(view(true, 'one'))
  expect(tree.container.querySelector('.computer-pane-latest')?.textContent).toBe('Back to latest')
  await act(async () => tree.container.querySelector<HTMLButtonElement>('.computer-pane-latest')!.click())
  expect(selections).toEqual([null])
  const completed: ComputerStep[] = [steps[0]!, { ...steps[1]!, status: 'error' }]
  await tree.render(view(true, 'two', completed))
  expect(tree.container.querySelector('.computer-pane-status')?.textContent).toBe('Using your Mac')
  expect(tree.container.querySelector('.computer-pane-now')).toBeNull()
  expect(tree.container.querySelector('.computer-pane-reason')?.textContent).toBe('Step failed')
  await tree.render(view(false, 'two', completed))
  expect(tree.container.querySelector('.computer-pane-status')?.textContent).toBe('Finished')
  expect(tree.container.querySelector('.computer-pane-live-dot')).toBeNull()
  expect(tree.container.querySelector('.computer-pane-latest')?.textContent).toBe('Back to latest')
  expect(tree.container.querySelector('.computer-pane-stop')).toBeNull()
  await tree.render(view(false, null, completed, true))
  expect(tree.container.querySelector('.computer-pane-status')?.textContent).toBe('Stopped')
  expect(tree.container.querySelector('.computer-pane-status .computer-pane-live-dot:not([data-live])')).not.toBeNull()
  await tree.render(view(false, null, [steps[0]!]))
  expect(tree.container.querySelector('.computer-pane-status')?.textContent).toBe('Finished')
})

test('navigation, Latest output, close and screenshotless selection use supplied state', async () => {
  const calls: (string | null)[] = []
  let closed = false
  const view = (selectedId: string | null, active = true) => <ComputerPane steps={steps} selectedId={selectedId} onSelect={id => calls.push(id)} onClose={() => { closed = true }} active={active} />
  const tree = await harness.mount(view(null))
  expect(tree.container.querySelector('img')?.src).toContain('data:image/png;base64,')
  expect(tree.container.textContent).not.toContain('Step 1')
  await act(async () => { tree.container.querySelectorAll<HTMLButtonElement>('.computer-pane-step')[1]!.click() })
  expect(calls).toEqual(['two'])
  await tree.render(view('two'))
  expect(tree.container.querySelector('.computer-pane-screen img')?.getAttribute('alt')).toBe('Computer screenshot')
  await act(async () => tree.container.querySelector<HTMLButtonElement>('.computer-pane-thumbnail')!.click())
  expect(calls).toEqual(['two', 'one'])
  await act(async () => { tree.container.querySelector<HTMLButtonElement>('.computer-pane-latest')!.click(); tree.container.querySelector<HTMLButtonElement>('[aria-label="Close computer panel"]')!.click() })
  expect(calls).toEqual(['two', 'one', null])
  expect(closed).toBe(true)
  await tree.render(view(null, false))
  expect(tree.container.querySelector('section')?.hidden).toBe(true)
})

test('text-only results do not expose observations and keep the previous screenshot', async () => {
  const first: ComputerStep = { ...steps[1]!, status: 'success', observation: 'Browser tab: 12, Title: "Drive"\n42 button Share' }
  const second: ComputerStep = { ...first, id: 'three', title: 'Reading sharing settings', observation: '+ 45 text Restricted\n<script>not markup</script>' }
  const view = (current: ComputerStep[], selectedId: string | null = null) => <ComputerPane steps={current} running selectedId={selectedId} onSelect={() => {}} onClose={() => {}} />
  const tree = await harness.mount(view([first]))
  expect(tree.container.querySelector('.computer-pane-screen')).toBeNull()
  expect(tree.container.textContent).not.toContain('42 button Share')
  expect(tree.container.querySelector('.computer-pane-empty')?.textContent).toContain('Waiting for a screenshot')
  await tree.render(view([steps[0]!, first, second]))
  expect(tree.container.querySelector('.computer-pane-step[aria-current]')?.textContent).toBe('Reading sharing settings')
  expect(tree.container.textContent).not.toContain('Restricted')
  expect(tree.container.querySelector('script')).toBeNull()
  expect(tree.container.querySelector('.computer-pane-screen img')?.getAttribute('alt')).toBe('Computer screenshot')
  await tree.render(view([steps[0]!, first, second], first.id))
  expect(tree.container.querySelector('.computer-pane-step[aria-current]')?.textContent).toBe(first.title)
  await tree.render(view([steps[0]!, first, second, { ...steps[1]!, id: 'pending' }]))
  expect(tree.container.querySelector('.computer-pane-now')).not.toBeNull()
})

test('an empty step before the first capture never displays future output', async () => {
  const tree = await harness.mount(<ComputerPane steps={[steps[1]!, steps[0]!]} selectedId="two" onSelect={() => {}} onClose={() => {}} />)
  expect(tree.container.querySelector('.computer-pane-screen img')).toBeNull()
  expect(tree.container.querySelector('.computer-pane-empty')?.textContent).toContain('No screenshot available')
  expect(tree.container.querySelector('.computer-pane-latest')?.textContent).toBe('Back to latest')
  await tree.render(<ComputerPane steps={[steps[1]!]} running selectedId={null} onSelect={() => {}} onClose={() => {}} />)
  expect(tree.container.querySelector('.computer-pane-empty')?.textContent).toContain('Waiting for a screenshot')
})

test('pictureless groups use the plain list layout without changing failed row selection', async () => {
  const failed = { ...steps[0]!, status: 'error' as const, observation: 'Window closed' }
  const view = (withPicture: boolean) => <ComputerPane steps={[{ ...failed, image: withPicture ? image : null }]}
    selectedId={failed.id} onSelect={() => {}} onClose={() => {}} />
  const tree = await harness.mount(view(false))
  const group = () => tree.container.querySelector('.computer-pane-group')!
  const selectedReason = () => group().querySelector('.computer-pane-step[aria-current="true"] .computer-pane-reason')?.textContent
  expect(group().hasAttribute('data-has-picture')).toBe(false)
  expect(group().querySelector('.computer-pane-thumbnail')).toBeNull()
  expect(selectedReason()).toBe('Window closed')
  await tree.render(view(true))
  expect(group().hasAttribute('data-has-picture')).toBe(true)
  expect(group().querySelector('.computer-pane-thumbnail')).not.toBeNull()
  expect(selectedReason()).toBe('Window closed')
})

test('permission denial explains how to enable screen recording', async () => {
  const tree = await harness.mount(<ComputerPane steps={[steps[0]!]} captures={new Map([['one', { status: 'denied' }]])} selectedId={null} onSelect={() => {}} onClose={() => {}} />)
  expect(tree.container.querySelector('[role="status"]')?.textContent).toContain('Screen Recording is off for Cat Code')
  expect(tree.container.querySelector('[role="status"] button')?.textContent).toBe('Open Privacy Settings')
  expect(tree.container.querySelector('.computer-pane-screen img')).not.toBeNull()
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
    expect(tree.container.querySelector('.computer-pane-status')?.textContent).toBe('Using your Mac')
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
