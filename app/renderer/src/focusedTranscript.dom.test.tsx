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
function view(rows: NestedTranscriptRow[], live = false, expanded = false, mode: TranscriptMode = 'focused', store = createToolCardExpansionStore()) {
  return <TranscriptModeContext.Provider value={{ mode, setMode() {} }}><ToolsExpandedContext.Provider value={{ expanded, setExpanded() {} }}>
    <TranscriptRowsView rows={rows} turnLive={live} toolCardExpansionStore={store} />
  </ToolsExpandedContext.Provider></TranscriptModeContext.Provider>
}
async function click(button: Element | null) {
  expect(button).not.toBeNull()
  await act(async () => { (button as HTMLElement).click() })
  await act(async () => { await harness.nextFrame() })
}

test('Working keeps every update and one command stretch, revealing original reasoning and tool rows', async () => {
  const tree = await harness.mount(view(work, true, true))
  const head = tree.container.querySelector('.focused-fold-head')!
  expect(head.textContent).toContain('Working')
  expect(head.getAttribute('aria-expanded')).toBe('true')
  expect([...tree.container.querySelectorAll('[data-focused-update]')].map(node => node.textContent)).toEqual(['I will trace the loader.', 'The tests pass. I will check the edge case.'])
  const step = tree.container.querySelector('.focused-step-head')!
  expect(step.textContent).toContain('Ran 1 command')
  expect(step.getAttribute('aria-expanded')).toBe('false')
  expect(tree.container.textContent).not.toContain('Tracing the loader')
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
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 280)) })
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
