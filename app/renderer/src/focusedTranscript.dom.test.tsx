import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { TranscriptRowsView } from './TranscriptView.js'
import { TranscriptModeContext, type TranscriptMode } from './transcriptMode.js'
import { ToolsExpandedContext } from './toolsExpanded.js'
import { createToolCardExpansionStore } from './toolCardExpansion.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'
import type { SessionDescriptor } from '../../shared/hostApi.js'

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
function view(rows: NestedTranscriptRow[], live = false, expanded = false, mode: TranscriptMode = 'focused', store = createToolCardExpansionStore(), revealAgent?: { toolUseId: string; sequence: number }, contextTransitions?: SessionDescriptor['contextTransitions']) {
  return <TranscriptModeContext.Provider value={{ mode, setMode() {} }}><ToolsExpandedContext.Provider value={{ expanded, setExpanded() {} }}>
    <TranscriptRowsView rows={rows} turnLive={live} toolCardExpansionStore={store} revealAgent={revealAgent} contextTransitions={contextTransitions} />
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

test('a step naming one finished command shows its output without repeating the command', async () => {
  const tree = await harness.mount(view(complete, false, false))
  await click(tree.container.querySelector('.focused-fold-head'))
  const step = tree.container.querySelector('.focused-step-head')!
  expect(step.textContent).toContain('Ran bun test src/loader')
  await click(step)
  const body = tree.container.querySelector('.focused-step-body')!
  expect(body.textContent).toContain('12 pass')
  expect(body.textContent).not.toContain('bun test src/loader')
  expect(body.querySelector('button')).toBeNull()
  // A second command in the stretch is counted by the head, so each card keeps its own header.
  const second: NestedTranscriptRow = { ...tool, id: 'tool-2', toolUseId: 'call-2', input: { command: 'bun test src/other' } }
  await tree.render(view([...work.slice(0, 4), second, ...complete.slice(4)], false, false))
  expect(tree.container.querySelector('.focused-step-head')?.textContent).toContain('Ran 2 commands')
  expect(tree.container.querySelector('.focused-step-body')?.textContent).toContain('bun test src/other')
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
  // The settle fades the work before its height closes, so it stays mounted past the old 260ms exit.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
  expect(tree.container.querySelectorAll('[data-focused-update]').length).toBe(2)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)) })
  expect(tree.container.querySelectorAll('[data-focused-update]').length).toBe(0)
  await click(tree.container.querySelector('.focused-fold-head'))
  expect(tree.container.querySelectorAll('[data-focused-update]').length).toBe(2)
})

test('workspace dividers preserve whole-turn auto-collapse and manual disclosure on both sides', async () => {
  const transitions: SessionDescriptor['contextTransitions'] = [{
    id: 'move', afterFrameId: 'jump', cwd: '/repo', binding: { kind: 'project' },
  }]
  const jump: NestedTranscriptRow = { ...tool, ...source('jump'), toolUseId: 'jump-call', toolName: 'JumpWorkspace' }
  const withJump = (rows: NestedTranscriptRow[]) => [...rows.slice(0, 2), jump, ...rows.slice(2)]
  const store = createToolCardExpansionStore()
  const render = (rows: NestedTranscriptRow[], live: boolean) =>
    view(withJump(rows), live, false, 'focused', store, undefined, transitions)
  const tree = await harness.mount(render(work, true))
  const heads = () => [...tree.container.querySelectorAll('.focused-fold-head')]
  const ids = () => [...tree.container.querySelectorAll('[data-focused-turn]')].map(node => node.getAttribute('data-focused-turn'))
  expect(heads().map(head => head.getAttribute('aria-expanded'))).toEqual(['true', 'true'])
  const liveIds = ids()
  await tree.render(render(complete, false))
  expect(ids()).toEqual(liveIds)
  expect(heads().map(head => head.getAttribute('aria-expanded'))).toEqual(['false', 'false'])
  expect(tree.container.querySelectorAll('[data-focused-completed]')).toHaveLength(2)
  expect(tree.container.querySelector('[data-context-transition="move"]')).not.toBeNull()
  expect(tree.container.textContent).toContain('The loader is fixed.')
  expect([...tree.container.querySelectorAll('.focused-turn')].some(node => node.textContent?.includes('The loader is fixed.'))).toBe(false)
  expect(tree.container.querySelector('.focused-fold-detail')?.textContent).not.toContain('1m 44s')
  await click(heads()[0]!)
  await click(heads()[1]!)
  expect([...tree.container.querySelectorAll('[data-focused-update]')].map(node => node.textContent))
    .toEqual(['I will trace the loader.', 'The tests pass. I will check the edge case.'])
  const order = [...tree.container.querySelectorAll('[data-focused-turn], [data-context-transition]')]
  expect(order.map(node => node.hasAttribute('data-context-transition') ? 'move' : 'work')).toEqual(['work', 'move', 'work'])
  await click(heads()[0]!)
  await click(heads()[1]!)
  expect(heads().map(head => head.getAttribute('aria-expanded'))).toEqual(['false', 'false'])
})

test('workspace divider fragments preserve explicit disclosure choices when the turn finishes', async () => {
  const transitions: SessionDescriptor['contextTransitions'] = [{
    id: 'move', afterFrameId: 'update-1', cwd: '/repo', binding: { kind: 'project' },
  }]
  const store = createToolCardExpansionStore()
  const render = (rows: NestedTranscriptRow[], live: boolean) => view(rows, live, false, 'focused', store, undefined, transitions)
  const tree = await harness.mount(render(work, true))
  await click(tree.container.querySelector('.focused-fold-head'))
  await click(tree.container.querySelector('.focused-fold-head'))
  await tree.render(render(complete, false))
  expect([...tree.container.querySelectorAll('.focused-fold-head')].map(head => head.getAttribute('aria-expanded'))).toEqual(['true', 'false'])
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
  // Cleared after its animation even when no animationend arrives.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 260)) })
  expect(tree.container.querySelector('.focused-tick-out')).toBeNull()
  expect(tree.container.querySelector('.focused-step-text')?.textContent).toBe('Ran bun test src/loader')
})

test('the head holds its live wording briefly when the turn finishes, then shows the duration', async () => {
  const store = createToolCardExpansionStore()
  const tree = await harness.mount(view(work, true, false, 'focused', store))
  await tree.render(view(complete, false, false, 'focused', store))
  expect(tree.container.querySelector('.focused-fold-head')?.textContent).toContain('Working')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)) })
  expect(tree.container.querySelector('.focused-fold-head .focused-fold-label')?.textContent).toBe('Working')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 140)) })
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

test('a failure inside a still-running agent shows on the head as well as its step', async () => {
  const child = { ...source('child'), parentToolUseId: 'call-agent', kind: 'tool-use', toolUseId: 'child-1', toolName: 'Bash', toolFamily: 'bash',
    input: { command: 'bun test' }, status: 'error', agentCompletion: null, result: { content: '1 fail', isError: true, diff: null } } as NestedTranscriptRow
  const agent = { ...source('agent'), kind: 'tool-use', toolUseId: 'call-agent', toolName: 'Agent', toolFamily: 'agent',
    input: { description: 'Check the loader' }, status: 'pending', agentCompletion: null, result: null, children: [child] } as unknown as NestedTranscriptRow
  const tree = await harness.mount(view([user, agent], true))
  expect(tree.container.querySelector('.focused-step-head .focused-fail-note')?.textContent).toBe('1 failed')
  expect(tree.container.querySelector('.focused-fold-head .focused-fail-note')?.textContent).toBe('1 failed')
})

test('reasoning stops reading as live once the answer has started outside the work', async () => {
  const answer = { ...text('answer', 'The loader is fixed.'), phase: 'final_answer' } as NestedTranscriptRow
  const tree = await harness.mount(view([user, thinking], true))
  expect(tree.container.querySelector('.focused-reasoning')?.hasAttribute('data-live')).toBe(true)
  await tree.render(view([user, thinking, answer], true))
  expect(tree.container.querySelector('.focused-reasoning')?.hasAttribute('data-live')).toBe(false)
})

test('settled reasoning made only of titles takes the faint tone marker', async () => {
  const tree = await harness.mount(view(work, true))
  expect(tree.container.querySelector('.focused-reasoning')?.hasAttribute('data-title-only')).toBe(true)
})

test('opening a finished turn cascades its parts, except under reduced motion', async () => {
  const original = globalThis.matchMedia
  try {
    const tree = await harness.mount(view(complete))
    await click(tree.container.querySelector('.focused-fold-head'))
    expect(tree.container.querySelector('.focused-turn-body')?.hasAttribute('data-cascade')).toBe(true)
    await tree.unmount()
    globalThis.matchMedia = ((query: string) => ({ matches: query.includes('reduce') })) as unknown as typeof matchMedia
    const reduced = await harness.mount(view(complete))
    await click(reduced.container.querySelector('.focused-fold-head'))
    expect(reduced.container.querySelector('.focused-turn-body')?.hasAttribute('data-cascade')).toBe(false)
  } finally { globalThis.matchMedia = original }
})

const image = (status: 'pending' | 'success'): NestedTranscriptRow => ({ ...source('image'), kind: 'tool-use', toolUseId: 'image-1', toolName: 'GenerateImage', toolFamily: 'imagegen',
  input: { prompt: 'A neon city portrait' }, status, agentCompletion: null,
  result: status === 'pending' ? null : { content: 'Saved image', isError: false, diff: null,
    generatedImage: { filePath: '/tmp/portrait.png', model: 'gpt-image-1', size: '1024x1024', outputFormat: 'png', bytes: 4, preview: { mediaType: 'image/png', data: 'AAAA' } } } })

test('a finished generated image stays outside the fold, shown once, while its step still counts it', async () => {
  const done = [user, text('update-1', 'I will make the image.'), image('success'), text('answer', 'Here is the portrait.'), result]
  const tree = await harness.mount(view(done))
  expect(tree.container.querySelector('.focused-fold-head')?.getAttribute('aria-expanded')).toBe('false')
  const outside = () => [...tree.container.querySelectorAll('.focused-deliverables img[alt="Generated image"]')]
  expect(outside().length).toBe(1)
  expect(tree.container.querySelector('.focused-turn')?.contains(outside()[0]!)).toBe(false)
  await click(tree.container.querySelector('.focused-fold-head'))
  const step = tree.container.querySelector('.focused-step-head')!
  expect(step.textContent).toContain('A neon city portrait')
  await click(step)
  expect(tree.container.querySelectorAll('img[alt="Generated image"]').length).toBe(1)
})

test('a generated image leaves the closed live step as soon as it finishes', async () => {
  const store = createToolCardExpansionStore()
  const tree = await harness.mount(view([user, text('update-1', 'I will make the image.'), image('pending')], true, false, 'focused', store))
  expect(tree.container.querySelector('.focused-deliverables')).toBeNull()
  await tree.render(view([user, text('update-1', 'I will make the image.'), image('success')], true, false, 'focused', store))
  expect(tree.container.querySelector('.focused-step-head')?.getAttribute('aria-expanded')).toBe('false')
  expect(tree.container.querySelectorAll('.focused-deliverables img[alt="Generated image"]').length).toBe(1)
})
