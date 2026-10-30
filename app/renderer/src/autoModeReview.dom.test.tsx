import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { AutoModeReviewMark } from './AutoModeReviewMark.js'
import { TranscriptRowsView } from './TranscriptView.js'
import { TranscriptModeContext } from './transcriptMode.js'
import { ToolCardStyleContext } from './toolCardStyle.js'
import { ToolsExpandedContext } from './toolsExpanded.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'
import type { AutoModeReview } from '../../../src/app-runtime/autoModeReviewContract.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })
const reason = 'The user authorized this exact operation. '.repeat(100) + '<script>must stay text</script>'
const review: AutoModeReview = { type: 'tool.review', toolUseId: 'a', attemptId: 'attempt-a', startedAt: 1000, completedAt: 13000, outcome: 'allowed', reason }
const source = (id: string) => ({ id, sessionId: 'review', messageId: id, frameId: id, blockIndex: 0, parentToolUseId: null, children: [] })
const tool = (id: string, evidence?: AutoModeReview, toolName = 'Bash'): Extract<NestedTranscriptRow, { kind: 'tool-use' }> => ({ ...source(id), kind: 'tool-use', toolUseId: id, toolName, toolFamily: toolName === 'Read' ? 'read' : 'bash', input: toolName === 'Read' ? { file_path: `/repo/${id}.ts` } : { command: `echo ${id}` }, status: 'success', result: { content: 'Raw output stays intact', isError: false, diff: null }, agentCompletion: null, autoModeReview: evidence })
async function click(element: Element | null) { expect(element).not.toBeNull(); await act(async () => { (element as HTMLElement).click() }) }

for (const mode of ['full', 'focused'] as const) for (const style of ['cards', 'lines'] as const) for (const theme of ['dark', 'light']) {
  test(`${mode}/${style}/${theme} keeps the mark beside status and the full long reason above unchanged output`, async () => {
    document.documentElement.dataset.appearance = theme
    const rows: NestedTranscriptRow[] = [
      { ...source('user'), kind: 'user-text', role: 'user', content: 'Run the command', isReplay: false },
      tool('a', review), tool('fast'),
    ]
    const tree = await harness.mount(<TranscriptModeContext.Provider value={{ mode, setMode() {} }}><ToolCardStyleContext.Provider value={{ style, setStyle() {} }}><ToolsExpandedContext.Provider value={{ expanded: true, setExpanded() {} }}><TranscriptRowsView rows={rows} turnLive /></ToolsExpandedContext.Provider></ToolCardStyleContext.Provider></TranscriptModeContext.Provider>)
    if (mode === 'focused') await click(tree.container.querySelector('.focused-step-head'))
    const field = tree.container.querySelector('.auto-mode-review-field')!
    expect(field.querySelector('.auto-mode-review-label')?.textContent).toBe('Auto mode')
    expect(field.querySelector('.auto-mode-review-value')?.textContent).toBe(reason)
    expect(field.querySelector('script')).toBeNull()
    expect(field.parentElement?.textContent).toContain('Raw output stays intact')
    const mark = [...tree.container.querySelectorAll('.auto-mode-review')].find(node => node.closest('button')?.textContent?.includes('echo a'))!
    expect(mark.getAttribute('aria-label')).toBe('Reviewed for 12s')
    expect(mark.nextElementSibling?.getAttribute('aria-label')).toBe('done')
    expect(mark.querySelector('svg')?.getAttribute('width')).toBe('13')
    expect(mark.hasAttribute('title')).toBe(false)
    expect(tree.container.querySelectorAll('.auto-mode-review-field')).toHaveLength(1)
    await act(async () => { mark.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    const tooltip = document.body.querySelector('[role="tooltip"]')!
    expect(tooltip.textContent).toBe('Reviewed for 12s')
    expect(tooltip.parentElement).toBe(document.body)
    expect(tooltip.textContent).not.toContain(reason)
    await act(async () => { window.dispatchEvent(new Event('scroll')) })
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull()
  })
}

test('collapsed Focused steps count reviewed calls only and a block wins without a count', async () => {
  let rows: NestedTranscriptRow[] = [{ ...source('user'), kind: 'user-text', role: 'user', content: 'Run commands', isReplay: false }, tool('a', review), tool('fast'), tool('b', { ...review, toolUseId: 'b', attemptId: 'b', completedAt: 20000 })]
  const view = () => <TranscriptModeContext.Provider value={{ mode: 'focused', setMode() {} }}><TranscriptRowsView rows={rows} turnLive /></TranscriptModeContext.Provider>
  const tree = await harness.mount(view())
  expect(tree.container.querySelector('.focused-step-head .auto-mode-review')?.getAttribute('aria-label')).toBe('Reviewed 2 commands for 31s')
  expect(tree.container.querySelector('.focused-step-head .auto-mode-review')?.textContent).toBe('2')
  rows = [...rows.slice(0, 3), tool('b', { ...review, toolUseId: 'b', attemptId: 'b', completedAt: 10000, outcome: 'blocked' })]
  await tree.render(view())
  const mark = tree.container.querySelector('.focused-step-head .auto-mode-review')!
  expect(mark.getAttribute('aria-label')).toBe('Blocked after 9s')
  expect(mark.getAttribute('data-outcome')).toBe('blocked')
  expect(mark.textContent).toBe('')
})

test('grouped reads show aggregate evidence and per-member reasons, without marking unreviewed members', async () => {
  const rows = [tool('a', review, 'Read'), tool('b', undefined, 'Read')]
  const tree = await harness.mount(<ToolsExpandedContext.Provider value={{ expanded: true, setExpanded() {} }}><TranscriptRowsView rows={rows} /></ToolsExpandedContext.Provider>)
  expect(tree.container.querySelectorAll('.auto-mode-review')).toHaveLength(2)
  expect(tree.container.querySelectorAll('.auto-mode-review-value')).toHaveLength(1)
  expect(tree.container.querySelector('.auto-mode-review-value')?.textContent).toBe(reason)
})

test('pending and inconclusive shields are empty, and keyboard focus opens an immediate non-native tooltip', async () => {
  const tree = await harness.mount(<AutoModeReviewMark review={{ ...review, outcome: 'reviewing', completedAt: undefined, reason: undefined }} />)
  let mark = tree.container.querySelector<HTMLElement>('.auto-mode-review')!
  expect(mark.querySelectorAll('path')).toHaveLength(1)
  await act(async () => { mark.focus() })
  expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe('Auto mode is reviewing this')
  await tree.render(<AutoModeReviewMark review={{ ...review, outcome: 'inconclusive', reason: undefined }} />)
  mark = tree.container.querySelector<HTMLElement>('.auto-mode-review')!
  expect(mark.querySelectorAll('path')).toHaveLength(1)
  expect(mark.getAttribute('aria-label')).toBe('Auto mode review ended without a decision')
  await tree.unmount()
  expect(document.body.querySelector('[role="tooltip"]')).toBeNull()
})

test('blocked reasons precede the unmodified raw denial output in both views', async () => {
  const raw = 'Permission for this action has been denied. Reason: Keep this raw denial unchanged.'
  const blocked = { ...tool('a', { ...review, outcome: 'blocked' }), status: 'error' as const, result: { content: raw, isError: true, diff: null } }
  for (const mode of ['full', 'focused'] as const) {
    const tree = await harness.mount(<TranscriptModeContext.Provider value={{ mode, setMode() {} }}><TranscriptRowsView rows={[blocked]} turnLive /></TranscriptModeContext.Provider>)
    if (mode === 'focused') {
      await click(tree.container.querySelector('.focused-step-head'))
      const head = tree.container.querySelector('.focused-step-body button')
      await click(head)
    }
    const field = tree.container.querySelector('.auto-mode-review-field')!
    expect(field.textContent).toBe(`Auto mode${reason}`)
    expect(field.parentElement?.textContent).toContain(raw)
    expect(field.parentElement?.textContent?.indexOf(reason)).toBeLessThan(field.parentElement!.textContent!.indexOf(raw))
    expect(tree.container.querySelector('[data-outcome=\"blocked\"]')).not.toBeNull()
    await tree.unmount()
  }
})

for (const family of ['grep', 'edit'] as const) {
  test(`grouped ${family} rows retain member reviews and block precedence`, async () => {
    const member = (id: string, evidence?: AutoModeReview) => ({
      ...tool(id, evidence), toolName: family === 'grep' ? 'Grep' : 'Edit', toolFamily: family,
      input: family === 'grep' ? { pattern: id, path: '/repo' } : { file_path: '/repo/a.ts', old_string: id, new_string: `${id}-new` },
    })
    const rows = [member('a', review), member('b', { ...review, toolUseId: 'b', attemptId: 'b', outcome: 'blocked', completedAt: 10000 })]
    const tree = await harness.mount(<ToolsExpandedContext.Provider value={{ expanded: true, setExpanded() {} }}><TranscriptRowsView rows={rows} /></ToolsExpandedContext.Provider>)
    expect(tree.container.querySelectorAll('.auto-mode-review')).toHaveLength(3)
    expect(tree.container.querySelectorAll('.auto-mode-review-value')).toHaveLength(2)
    expect(tree.container.querySelector('.auto-mode-review')?.getAttribute('aria-label')).toBe('Blocked after 9s')
  })
}

test('subagent internal calls keep their own review rather than attributing it to the parent agent', async () => {
  const child = { ...tool('a', review), parentToolUseId: 'agent' }
  const agent = { ...tool('agent'), toolName: 'Agent', toolFamily: 'agent' as const, input: { description: 'Check the branch', prompt: 'Check it' }, children: [child] }
  const tree = await harness.mount(<ToolsExpandedContext.Provider value={{ expanded: true, setExpanded() {} }}><TranscriptRowsView rows={[agent]} /></ToolsExpandedContext.Provider>)
  expect(tree.container.querySelector('[data-agent-tool-id] > button .auto-mode-review')).toBeNull()
  await click(tree.container.querySelector('[data-agent-tool-id] > button'))
  expect(tree.container.querySelector('.auto-mode-review-value')?.textContent).toBe(reason)
  expect(tree.container.querySelectorAll('.auto-mode-review')).toHaveLength(1)
})

test('successful generated images keep their existing image-only presentation', async () => {
  const image = { ...tool('a', review), toolName: 'GenerateImage', toolFamily: 'imagegen' as const,
    result: { content: 'Image created.', isError: false, diff: null, generatedImage: {
      filePath: '/sample-image.png', model: 'offline', size: '1024x1024', outputFormat: 'png' as const, bytes: 1,
      preview: { mediaType: 'image/png' as const, data: 'AA==' },
    } },
  }
  const tree = await harness.mount(<TranscriptRowsView rows={[image]} />)
  expect(tree.container.querySelector('img[alt=\"Generated image\"]')).not.toBeNull()
  expect(tree.container.querySelector('.auto-mode-review')).toBeNull()
  expect(tree.container.querySelector('.auto-mode-review-field')).toBeNull()
})

test('parallel agent cards keep each dispatch review and a group summary', async () => {
  const agent = (id: string, index: number, evidence?: AutoModeReview) => ({
    ...tool(id, evidence), toolName: 'Agent', toolFamily: 'agent' as const, messageId: 'parallel-agents', blockIndex: index,
    input: { description: `Check ${id}`, prompt: `Check ${id}` },
  })
  const tree = await harness.mount(<TranscriptRowsView rows={[agent('a', 0, review), agent('b', 1)]} />)
  expect(tree.container.querySelectorAll('.auto-mode-review')).toHaveLength(2)
  const head = tree.container.querySelector('[data-agent-tool-id=\"a\"] > button')
  expect(head?.querySelector('.auto-mode-review')?.getAttribute('aria-label')).toBe('Reviewed for 12s')
  await click(head)
  expect(tree.container.querySelector('.auto-mode-review-value')?.textContent).toBe(reason)
})
