import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { ComputerPane } from './ComputerPane.js'
import { ComputerPaneContext } from './computerPaneContext.js'
import { TranscriptRowsView } from './TranscriptView.js'
import { ToolCardExpansionContext, createToolCardExpansionStore } from './toolCardExpansion.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'
import type { ComputerStep } from './computerPaneModel.js'
let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })
const image = { mediaType: 'image/png' as const, data: 'iVBORw0KGgo=' }
const steps: ComputerStep[] = [{ id: 'one', title: 'Opening Reminders', status: 'success', image }, { id: 'two', title: 'Checking the list', status: 'pending', image: null }]

test('navigation, Latest, close and screenshotless selection use supplied state', async () => {
  const calls: (string | null)[] = []
  let closed = false
  const view = (selectedId: string | null, active = true) => <ComputerPane steps={steps} selectedId={selectedId} onSelect={id => calls.push(id)} onClose={() => { closed = true }} active={active} />
  const tree = await harness.mount(view(null))
  expect(tree.container.querySelector('img')?.src).toContain('data:image/png;base64,')
  expect(tree.container.textContent).toContain('1 of 2')
  await act(async () => { tree.container.querySelector<HTMLButtonElement>('[aria-label="Next computer step"]')!.click() })
  expect(calls).toEqual(['two'])
  await tree.render(view('two'))
  expect(tree.container.textContent).toContain('Waiting for a screenshot.')
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
