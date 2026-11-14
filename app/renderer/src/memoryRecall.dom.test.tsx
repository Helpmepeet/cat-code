import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { TranscriptRowsView } from './TranscriptView.js'
import { TranscriptModeContext, type TranscriptMode } from './transcriptMode.js'
import { ToolCardExpansionContext, createToolCardExpansionStore } from './toolCardExpansion.js'
import type { FocusedLiveState, NestedToolUseRow } from './transcriptProjector.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })
const numbered = (text: string) => text.split('\n').map((line, i) => `${i + 1}\t${line}`).join('\n')
const content = numbered('---\nname: Database conventions\ntype: project\ndescription: Use a real database.\n---\n\nUse **real connections**.')
const row: NestedToolUseRow = {
  id: 'memory', frameId: 'memory', sessionId: 's', messageId: 'memory', blockIndex: 0, parentToolUseId: null,
  kind: 'tool-use', toolUseId: 'memory', toolName: 'Read', toolFamily: 'read', input: { file_path: '/custom/projects/-work/memory/project_database.md' },
  status: 'success', result: { content, isError: false, diff: null }, agentCompletion: null, children: [],
}
const live: FocusedLiveState = { activities: {}, awaitingApproval: {}, preparing: {}, lastVisibleChangeAt: 0, streaming: false }
const modeValue = (mode: TranscriptMode) => ({ mode, setMode: () => {} })

test('Full recall expands a note, renders bold and remembers the tool expansion after remount', async () => {
  const store = createToolCardExpansionStore()
  const view = () => <TranscriptModeContext.Provider value={modeValue('full')}><ToolCardExpansionContext.Provider value={store}><TranscriptRowsView rows={[row]} /></ToolCardExpansionContext.Provider></TranscriptModeContext.Provider>
  const tree = await harness.mount(view())
  expect(tree.container.querySelector('.memory-recall-text')?.textContent).toBe('Recalled Database conventions · project')
  expect(tree.container.querySelector('.memory-recall-body')).toBeNull()
  await act(async () => { (tree.container.querySelector('.memory-recall-line') as HTMLButtonElement).click() })
  expect(tree.container.querySelector('.memory-note-lead')?.textContent).toBe('Use a real database.')
  expect(tree.container.querySelector('.memory-note-paragraph strong')?.textContent).toBe('real connections')
  expect(tree.container.querySelector('.memory-note-filename')?.textContent).toBe('project_database.md')
  expect(tree.container.querySelector('.memory-recall-body')?.textContent).not.toContain('name:')
  await tree.unmount()
  const remount = await harness.mount(view())
  expect(remount.container.querySelector('.memory-recall-body')).not.toBeNull()
})

test('live approval and failures fall back while successful reads return to recall', async () => {
  const pending = { ...row, status: 'pending' as const, result: null }
  const view = (source: NestedToolUseRow, state = live) => <TranscriptModeContext.Provider value={modeValue('full')}><TranscriptRowsView rows={[source]} focusedLiveState={state} /></TranscriptModeContext.Provider>
  const tree = await harness.mount(view(pending))
  expect(tree.container.querySelector('.memory-recall[data-live]')?.textContent).toContain('Recalling a memory')
  await tree.render(view(pending, { ...live, awaitingApproval: { memory: true } }))
  expect(tree.container.querySelector('.memory-recall')).toBeNull()
  expect(tree.container.textContent).toContain('project_database.md')
  await tree.render(view({ ...row, status: 'error', result: { content: 'Read failed', isError: true, diff: null } }))
  expect(tree.container.querySelector('.memory-recall')).toBeNull()
  await tree.render(view({ ...pending, status: 'cancelled' }))
  expect(tree.container.querySelector('.memory-recall')).toBeNull()
  await tree.render(view({ ...pending, autoModeReview: { type: 'tool.review', attemptId: 'a', toolUseId: 'memory', startedAt: 0, completedAt: 1, outcome: 'blocked', reason: 'Not approved' } }))
  expect(tree.container.querySelector('.memory-recall')).toBeNull()
  await tree.render(view(row))
  expect(tree.container.querySelector('.memory-recall')).not.toBeNull()
})

test('Focused uses a recall line, not a nested read step', async () => {
  const store = createToolCardExpansionStore()
  const tree = await harness.mount(<TranscriptModeContext.Provider value={modeValue('focused')}><ToolCardExpansionContext.Provider value={store}><TranscriptRowsView rows={[row]} turnLive /></ToolCardExpansionContext.Provider></TranscriptModeContext.Provider>)
  expect(tree.container.querySelector('.memory-recall-text')?.textContent).toBe('Recalled Database conventions · project')
  expect(tree.container.querySelector('.focused-step')).toBeNull()
})

test('expanded long notes use the existing bounded output window', async () => {
  const long = { ...row, result: { ...row.result!, content: numbered('---\nname: Long memory\ntype: project\ndescription: Many observations.\n---\n' + Array.from({ length: 1000 }, (_, i) => `Observation ${i}`).join('\n')) } }
  const tree = await harness.mount(<TranscriptModeContext.Provider value={modeValue('full')}><TranscriptRowsView rows={[long]} /></TranscriptModeContext.Provider>)
  await act(async () => { (tree.container.querySelector('.memory-recall-line') as HTMLButtonElement).click() })
  expect(tree.container.querySelectorAll('.memory-note-paragraph').length).toBeLessThan(1000)
  expect(tree.container.textContent).toContain('Observation 999')
})

test('old memory metadata and malformed frontmatter preserve their respective note and source views', async () => {
  const old = { ...row, result: { ...row.result!, content: '<system-reminder>This memory is 47 days old. Verify current code.</system-reminder>\n' + content } }
  const view = (source: NestedToolUseRow) => <TranscriptModeContext.Provider value={modeValue('full')}><TranscriptRowsView rows={[source]} /></TranscriptModeContext.Provider>
  const tree = await harness.mount(view(old))
  expect(tree.container.querySelector('.memory-recall-age')?.textContent).toBe('47 days old')
  const malformed = { ...row, result: { ...row.result!, content: numbered('---\nname: [invalid\n---\nBody') } }
  await tree.render(view(malformed))
  expect(tree.container.querySelector('.memory-recall-text')?.textContent).toBe('Recalled project_database')
  await act(async () => { (tree.container.querySelector('.memory-recall-line') as HTMLButtonElement).click() })
  expect(tree.container.querySelector('.memory-recall-body')?.textContent).toContain('name: [invalid')
  expect(tree.container.querySelector('.memory-note-lead')).toBeNull()
})
