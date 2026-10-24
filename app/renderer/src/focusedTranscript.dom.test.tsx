import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { TranscriptRowsView } from './TranscriptView.js'
import { TranscriptModeContext, type TranscriptMode } from './transcriptMode.js'
import { ToolsExpandedContext } from './toolsExpanded.js'
import { createToolCardExpansionStore } from './toolCardExpansion.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })
const source = (id: string) => ({ id, sessionId: 'focused-test', messageId: id, frameId: id, blockIndex: 0, parentToolUseId: null, children: [] })
const user: NestedTranscriptRow = { ...source('user'), kind: 'user-text', role: 'user', content: 'Check the loader', isReplay: false }
const text = (id: string, content: string): Extract<NestedTranscriptRow, { kind: 'assistant-text' }> => ({ ...source(id), kind: 'assistant-text', role: 'assistant', content })
const thinking: NestedTranscriptRow = { ...source('thought'), kind: 'thinking', reasoningKind: 'summary', content: 'Tracing the loader' }
const tool: NestedTranscriptRow = { ...source('tool'), kind: 'tool-use', toolUseId: 'call-1', toolName: 'Bash', toolFamily: 'bash', input: { command: 'bun test src/loader' }, status: 'success', agentCompletion: null, result: { content: '12 pass\n0 fail', isError: false, diff: null } }
const result: NestedTranscriptRow = { ...source('result'), kind: 'result', subtype: 'success', isError: false, errors: [], result: 'Fixed.', durationMs: 104000 }
const work = [user, text('update-1', 'I will trace the loader.'), thinking, tool, text('update-2', 'The tests pass. I will check the edge case.')]
const complete = [...work, text('answer', 'The loader is fixed.'), result]
function view(rows: NestedTranscriptRow[], live = false, expanded = false, mode: TranscriptMode = 'focused', store = createToolCardExpansionStore(), revealAgent?: { toolUseId: string; sequence: number }) {
  return <TranscriptModeContext.Provider value={{ mode, setMode() {} }}><ToolsExpandedContext.Provider value={{ expanded, setExpanded() {} }}>
    <TranscriptRowsView rows={rows} turnLive={live} toolCardExpansionStore={store} revealAgent={revealAgent} />
  </ToolsExpandedContext.Provider></TranscriptModeContext.Provider>
}
async function click(button: Element | null) {
  expect(button).not.toBeNull()
  await act(async () => { (button as HTMLElement).click() })
  await act(async () => { await harness.nextFrame() })
}

test('Working keeps updates and reasoning in order, with tool rows behind their command summary', async () => {
  const tree = await harness.mount(view(work, true, true))
  const head = tree.container.querySelector('.focused-fold-head')!
  expect(head.textContent).toContain('Working')
  expect(head.getAttribute('aria-expanded')).toBe('true')
  expect([...tree.container.querySelectorAll('[data-focused-update]')].map(node => node.textContent)).toEqual(['I will trace the loader.', 'The tests pass. I will check the edge case.'])
  const step = tree.container.querySelector('.focused-step-head')!
  expect(step.textContent).toContain('Ran bun test src/loader')
  expect(step.getAttribute('aria-expanded')).toBe('false')
  expect(tree.container.querySelector('.focused-turn-body')?.textContent).toContain('Tracing the loader')
  await click(step)
  expect(tree.container.textContent).toContain('Tracing the loader')
  expect(tree.container.textContent).toContain('bun test src/loader')
  expect(tree.container.textContent).toContain('12 pass')
})

test('successful work folds at turn end and reopens with all updates, independent of expanded tool detail', async () => {
  const tree = await harness.mount(view(complete, false, true))
  const head = tree.container.querySelector('.focused-fold-head')!
  expect(head.textContent).toContain('Worked')
  expect(head.textContent).toContain('1m 44s')
  expect(head.getAttribute('aria-expanded')).toBe('false')
  expect(tree.container.textContent).toContain('The loader is fixed.')
  expect(tree.container.textContent).not.toContain('I will trace the loader.')
  await click(head)
  expect(tree.container.querySelectorAll('[data-focused-update]').length).toBe(2)
  expect(tree.container.querySelector('.focused-step-head')?.getAttribute('aria-expanded')).toBe('false')
})

test('a live Working row closes automatically on successful finish without losing the answer', async () => {
  const store = createToolCardExpansionStore()
  const tree = await harness.mount(view(work, true, false, 'focused', store))
  await tree.render(view(complete, false, false, 'focused', store))
  expect(tree.container.querySelector('.focused-fold-head')?.getAttribute('aria-expanded')).toBe('false')
  expect(tree.container.querySelector('[aria-hidden="true"][inert]')).not.toBeNull()
  expect(tree.container.textContent).toContain('The loader is fixed.')
  // The settle fades the work before its height closes.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)) })
  expect(tree.container.querySelectorAll('[data-focused-update]').length).toBe(0)
  await click(tree.container.querySelector('.focused-fold-head'))
  expect(tree.container.querySelectorAll('[data-focused-update]').length).toBe(2)
})

test('failed and stopped turns do not hide their updates behind a completed fold', async () => {
  for (const subtype of ['error_during_execution', 'interrupted']) {
    const tree = await harness.mount(view([...work, { ...result, subtype, isError: true, errors: ['Turn stopped'] }]))
    expect(tree.container.querySelector('.focused-fold-head')?.getAttribute('aria-expanded')).toBe('true')
    expect(tree.container.querySelector('[data-focused-completed]')).toBeNull()
    expect(tree.container.querySelectorAll('[data-focused-update]').length).toBe(2)
    await tree.unmount()
  }
})

test('Full keeps the original transcript and switching modes remembers explicit focused disclosures', async () => {
  const store = createToolCardExpansionStore()
  const tree = await harness.mount(view(complete, false, false, 'full', store))
  expect(tree.container.querySelector('.focused-fold-head')).toBeNull()
  expect(tree.container.textContent).toContain('I will trace the loader.')
  await tree.render(view(complete, false, false, 'focused', store))
  await click(tree.container.querySelector('.focused-fold-head'))
  await click(tree.container.querySelector('.focused-step-head'))
  await tree.render(view(complete, false, false, 'full', store))
  await tree.render(view(complete, false, false, 'focused', store))
  expect(tree.container.querySelector('.focused-fold-head')?.getAttribute('aria-expanded')).toBe('true')
  expect(tree.container.querySelector('.focused-step-head')?.getAttribute('aria-expanded')).toBe('true')
})

test('an explicit worker reveal opens the containing work and command line', async () => {
  const tree = await harness.mount(<TranscriptModeContext.Provider value={{ mode: 'focused', setMode() {} }}>
    <TranscriptRowsView rows={complete} revealAgent={{ toolUseId: 'call-1', sequence: 1 }} />
  </TranscriptModeContext.Provider>)
  await act(async () => { await harness.nextFrame() })
  expect(tree.container.querySelector('.focused-fold-head')?.getAttribute('aria-expanded')).toBe('true')
  expect(tree.container.querySelector('.focused-step-head')?.getAttribute('aria-expanded')).toBe('true')
})

test('opening a long tool stretch bounds mounted rows while its summary counts all work', async () => {
  const tools: NestedTranscriptRow[] = Array.from({ length: 300 }, (_, index) => ({
    ...tool, id: `tool-${index}`, toolUseId: `call-${index}`, input: { command: `printf check-${index}` },
  }))
  const rows = [user, text('update', 'Checking commands.'), ...tools]
  const store = createToolCardExpansionStore()
  const sheet = document.createElement('style')
  sheet.textContent = '.focused-test-scroll { overflow-y: auto; }'
  document.head.append(sheet)
  const render = (reveal?: { toolUseId: string; sequence: number }) => <div className="focused-test-scroll">{view(rows, true, false, 'focused', store, reveal)}</div>
  const tree = await harness.mount(render())
  try {
    const step = tree.container.querySelector('.focused-step-head')!
    expect(step.textContent).toContain('Ran 300 commands')
    expect(tree.container.querySelectorAll('[data-tool-row]').length).toBe(0)
    await click(step)
    const mounted = tree.container.querySelectorAll('[data-tool-row]').length
    expect(mounted).toBeGreaterThan(0)
    expect(mounted).toBeLessThanOrEqual(80)
    const scroller = tree.container.querySelector<HTMLElement>('.focused-test-scroll')!
    const list = tree.container.querySelector<HTMLElement>('.focused-step-rows')!
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 500 })
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, 800, 500)
    list.getBoundingClientRect = () => new DOMRect(0, -scroller.scrollTop, 800, 14400)
    await tree.render(render({ toolUseId: 'call-299', sequence: 1 }))
    await act(async () => { await harness.nextFrame() })
    await act(async () => { await harness.nextFrame() })
    expect(tree.container.textContent).toContain('printf check-299')
    expect(tree.container.querySelectorAll('[data-tool-row]').length).toBeLessThanOrEqual(80)
  } finally { sheet.remove() }
})

test('new update and command blocks open their height without replaying restored or growing segments', async () => {
  const store = createToolCardExpansionStore()
  const tree = await harness.mount(view(work, true, false, 'focused', store))
  expect([...tree.container.querySelectorAll('.focused-segment')].every(element => element.hasAttribute('data-open'))).toBe(true)
  const frames = new Map<number, FrameRequestCallback>()
  let sequence = 0
  const request = spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
    frames.set(++sequence, callback)
    return sequence
  })
  const cancel = spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id) })
  try {
    const update = text('new-update', 'I will check the other entry point.')
    const pending: NestedTranscriptRow = { ...tool, id: 'new-tool', toolUseId: 'new-call', status: 'pending', result: null }
    await tree.render(view([...work, update, pending], true, false, 'focused', store))
    const updateBlock = [...tree.container.querySelectorAll('[data-focused-update]')]
      .find(element => element.textContent === update.content)!.closest('.focused-segment')!
    const commandBlock = [...tree.container.querySelectorAll('.focused-step-head')]
      .find(element => element.textContent?.includes('Running bun test'))!.closest('.focused-segment')!
    expect(updateBlock.hasAttribute('data-open')).toBe(false)
    expect(commandBlock.hasAttribute('data-open')).toBe(false)
    await act(async () => {
      const batch = [...frames.values()]
      frames.clear()
      for (const callback of batch) callback(performance.now())
    })
    expect(updateBlock.hasAttribute('data-open')).toBe(true)
    expect(commandBlock.hasAttribute('data-open')).toBe(true)
    await tree.render(view([...work, { ...update, content: `${update.content} It shares the same loader.` }, pending], true, false, 'focused', store))
    expect(tree.container.contains(updateBlock)).toBe(true)
    expect(updateBlock.hasAttribute('data-open')).toBe(true)
  } finally {
    request.mockRestore()
    cancel.mockRestore()
  }
})

test('reasoning is one quiet block with every step shown, live only while it is the newest work', async () => {
  const tree = await harness.mount(view([...work, { ...thinking, id: 'thought-2', content: 'Checking the edge case' }], true))
  const blocks = [...tree.container.querySelectorAll('.focused-reasoning')]
  expect(blocks.map(block => block.textContent)).toEqual(['Tracing the loader', 'Checking the edge case'])
  expect(tree.container.querySelector('.focused-turn-body')?.textContent).not.toContain('Reasoning')
  expect(blocks.map(block => block.hasAttribute('data-live'))).toEqual([false, true])
})

test('a failed call is named in the step and head, and its step opens when the finished turn is reopened', async () => {
  const failed = { ...tool, status: 'error', result: { content: '1 fail', isError: true, diff: null } } as NestedTranscriptRow
  const tree = await harness.mount(view([user, text('update-1', 'I will trace the loader.'), failed, text('answer', 'The loader is fixed.'), result]))
  const head = tree.container.querySelector('.focused-fold-head')!
  expect(head.querySelector('.focused-fail-note')?.textContent).toBe('1 failed')
  await click(head)
  const step = tree.container.querySelector('.focused-step-head')!
  expect(step.querySelector('.focused-fail-note')?.textContent).toBe('1 failed')
  expect(step.getAttribute('aria-expanded')).toBe('true')
})

test('only the newest update is marked latest while working, and none once finished', async () => {
  const tree = await harness.mount(view(work, true))
  expect([...tree.container.querySelectorAll('[data-focused-update]')].map(node => node.hasAttribute('data-latest'))).toEqual([false, true])
  await tree.render(view(complete, false))
  expect(tree.container.querySelector('[data-latest]')).toBeNull()
})

test('changed step text keeps the outgoing line hidden from assistive tech while it leaves', async () => {
  const running = { ...tool, status: 'pending', result: null } as NestedTranscriptRow
  const tree = await harness.mount(view([user, running], true))
  expect(tree.container.querySelector('.focused-step-head')?.textContent).toContain('Running bun test src/loader')
  await tree.render(view([user, tool], true))
  const outgoing = tree.container.querySelector('.focused-step-text .focused-tick-out')
  expect(outgoing?.getAttribute('aria-hidden')).toBe('true')
  expect(outgoing?.textContent).toContain('Running')
  expect(tree.container.querySelector('.focused-step-text .focused-tick-in')?.textContent).toBe('Ran bun test src/loader')
})

test('the head holds its live wording briefly when the turn finishes, then shows the duration', async () => {
  const store = createToolCardExpansionStore()
  const tree = await harness.mount(view(work, true, false, 'focused', store))
  await tree.render(view(complete, false, false, 'focused', store))
  expect(tree.container.querySelector('.focused-fold-head')?.textContent).toContain('Working')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 340)) })
  const head = tree.container.querySelector('.focused-fold-head')!
  expect(head.textContent).toContain('Worked')
  expect(head.textContent).toContain('1m 44s')
})

test('diff totals omit a side with nothing to count', async () => {
  const edit = { ...source('edit'), kind: 'tool-use', toolUseId: 'call-edit', toolName: 'Edit', toolFamily: 'edit', input: { file_path: '/repo/loader.ts' }, status: 'success', agentCompletion: null,
    result: { content: 'ok', isError: false, diff: { filePath: '/repo/loader.ts', hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: ['+a', '+b'] }] } } } as unknown as NestedTranscriptRow
  const tree = await harness.mount(view([user, edit], true))
  const diff = tree.container.querySelector('.focused-step-head .focused-diff')
  expect(diff?.textContent).toBe('+2')
})
