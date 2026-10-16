import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { SubagentWorkspace } from './SubagentWorkspace.js'
import { ReasoningLayoutContext } from './reasoningLayout.js'
import { selectSubagentPanelBranch } from './subagentPanelState.js'
import { reportPaneLayoutChange } from './markdownScrollCoordinator.js'
import type { DerivedSubagentDock, SubagentDockRow } from './subagentDockState.js'
import { createTranscriptState, projectServerFrame, selectNestedTranscriptRows, type NestedToolUseRow, type NestedTranscriptRow } from './transcriptProjector.js'
import { SessionPane } from './SessionPane.js'
import { idleSessionPaneProps } from './sessionPaneTestProps.js'
import type { ServerFrame } from '../../shared/protocol.js'

let harness: DomTestHarness
let height = 1000
let originalHeight: PropertyDescriptor | undefined
let originalClient: PropertyDescriptor | undefined
beforeAll(async () => {
  harness = await createDomTestHarness()
  originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
  originalClient = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return this.classList.contains('subagent-side-body') ? height : 0 } })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return this.classList.contains('subagent-side-body') ? 400 : 0 } })
})
afterEach(async () => { await harness.unmountAll(); window.localStorage.clear(); height = 1000 })
afterAll(async () => {
  if (originalHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalHeight)
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight
  if (originalClient) Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClient)
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight
  await harness.teardown()
})

const source = { sessionId: 's', frameId: 'f', messageId: 'm', blockIndex: 0, parentToolUseId: 'launch-a', children: [] }
function prose(id: string, content = `Reply ${id}`): NestedTranscriptRow {
  return { ...source, id, kind: 'assistant-text', role: 'assistant', content }
}
function agent(id = 'a', children: NestedTranscriptRow[] = [
  { ...source, id: 'thinking-a', kind: 'thinking', content: '**Checking the click handler**' },
  { ...source, id: 'read-a', kind: 'tool-use', toolUseId: 'read-a', toolName: 'Read', toolFamily: 'read', input: { file_path: '/repo/dock.ts' }, status: 'pending', result: null, agentCompletion: null },
  prose('answer-a', 'The dock opens the worker.'),
]): NestedToolUseRow {
  return { ...source, id: `agent-${id}`, parentToolUseId: null, kind: 'tool-use', toolUseId: `launch-${id}`, toolName: 'Agent', toolFamily: 'agent',
    input: { description: `Task ${id}`, subagent_type: 'explore' }, status: 'pending', result: null, agentCompletion: null, children }
}
function worker(id = 'a', patch: Partial<SubagentDockRow> = {}): SubagentDockRow {
  return {
    agentId: id, runKey: `launch-${id}`, toolUseId: `launch-${id}`, name: `worker-${id}`, task: `Task ${id}`, type: 'explore',
    state: 'running', model: 'claude-sonnet-4-5', rowModel: null, recordedAccount: null, account: null, usageLabel: null,
    verdict: null, resultSummary: null, blockReason: null, launchOrder: 0, terminalAt: null, resumedAt: null,
    lastSeenAt: 0, missingSince: null, settleUntil: null, stateWord: '', stripLines: [null, null], chipLines: [null, null], settling: false, ...patch,
  }
}
const a = worker()
const b = worker('b')
const done = worker('c', { state: 'completed', usageLabel: '4 tool calls · 21.0k tokens' })
function workspace({ rows = [agent(), agent('b', [prose('answer-b', 'Second worker')]), agent('c', [prose('answer-c', 'Finished answer')])],
  active = [a, b], finished = [done], fallback = (_row: SubagentDockRow) => {}, loadMissing = () => {} }: {
  rows?: NestedTranscriptRow[]; active?: SubagentDockRow[]; finished?: SubagentDockRow[]; fallback?: (row: SubagentDockRow) => void; loadMissing?: () => void
} = {}) {
  const dock: DerivedSubagentDock = { active, finished, chipFaces: active, nextUpdateAt: null }
  return createElement(ReasoningLayoutContext.Provider, { value: { mode: 'trail', setMode() {} } },
    createElement(SubagentWorkspace, {
      dock, collapsed: false, onCollapsedChange() {}, onClearFinished() {}, onDetailsVisibleChange() {},
      onFallback: fallback, onOpenWorkers() {}, onLoadMissingHistory: loadMissing, rows, cwd: '/repo',
      children: createElement('main', { className: 'session-pane' }, 'Parent transcript'),
    }))
}
async function click(container: HTMLElement, selector: string) {
  const element = container.querySelector<HTMLButtonElement>(selector)
  expect(element).not.toBeNull()
  await act(async () => { element!.click() })
}

test('dock opens an inline read-only panel, hides the dock, switches faces including Finished, and closes', async () => {
  const tree = await harness.mount(workspace())
  await click(tree.container, '[data-dock-row="a"]')
  const panel = tree.container.querySelector('aside')!
  expect(panel.parentElement?.className).toBe('subagent-workspace')
  expect(panel.previousElementSibling?.contains(tree.container.querySelector('main')!)).toBe(true)
  expect(tree.container.querySelector<HTMLElement>('.subagent-dock')?.hidden).toBe(true)
  expect(tree.container.querySelector('.subagent-dock')?.hasAttribute('inert')).toBe(true)
  expect(panel.textContent).toContain('Checking the click handler')
  expect(panel.textContent).toContain('The dock opens the worker.')
  expect(panel.querySelector('[data-tool-use-id], [data-tool-row]')).not.toBeNull()
  expect(panel.querySelector('textarea, [contenteditable="true"], [aria-label="Stop the turn"]')).toBeNull()
  expect(panel.querySelector('header')?.textContent).not.toContain('Read')
  expect(panel.querySelector('[aria-current="true"]')?.getAttribute('aria-label')).toBe('worker-a, running')
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Close subagent panel')
  const firstBody = panel.querySelector<HTMLElement>('.subagent-side-body')!
  expect(firstBody.scrollTop).toBe(600)
  firstBody.scrollTop = 100
  await click(tree.container, '.subagent-side-switch[aria-current="true"]')
  expect(tree.container.querySelector('.subagent-side-body')).toBe(firstBody)
  expect(firstBody.scrollTop).toBe(100)
  await click(tree.container, '.subagent-side-switch[aria-label="worker-b, running"]')
  expect(tree.container.querySelector('aside')?.textContent).toContain('Second worker')
  expect(tree.container.querySelector<HTMLElement>('.subagent-side-body')?.scrollTop).toBe(600)
  await click(tree.container, '.subagent-side-switch[aria-label="worker-c, completed"]')
  expect(tree.container.querySelector('header')?.textContent).toContain('4 tool calls · 21.0k tokens')
  expect(tree.container.querySelector('aside')?.textContent).toContain('Finished answer')
  await click(tree.container, '[aria-label="Close subagent panel"]')
  await act(async () => { await harness.nextFrame() })
  expect(tree.container.querySelector('aside')).toBeNull()
  expect(tree.container.querySelector<HTMLElement>('.subagent-dock')?.hidden).toBe(false)
  await click(tree.container, '[data-dock-row="a"]')
  expect(tree.container.querySelector<HTMLElement>('.subagent-side-body')?.scrollTop).toBe(600)
})

test('new steps follow the bottom, preserve a reader scrolling back, and resume only at the bottom', async () => {
  const tree = await harness.mount(workspace())
  await click(tree.container, '[data-dock-row="a"]')
  const body = tree.container.querySelector<HTMLElement>('.subagent-side-body')!
  const append = async (index: number) => {
    height += 200
    await tree.render(workspace({ rows: [agent('a', [...agent().children, prose(`new-${index}`)])] }))
  }
  await append(1)
  expect(body.scrollTop).toBe(800)
  await act(async () => { body.scrollTop = 100; body.dispatchEvent(new Event('scroll')) })
  await append(2)
  expect(body.scrollTop).toBe(100)
  await act(async () => { body.scrollTop = 500; body.dispatchEvent(new Event('scroll')) })
  await append(3)
  expect(body.scrollTop).toBe(500)
  await act(async () => { body.scrollTop = height - 400; body.dispatchEvent(new Event('scroll')) })
  await append(4)
  expect(body.scrollTop).toBe(height - 400)
  expect(tree.container.querySelector('aside')?.textContent).not.toContain('Latest')
})

test('waiting header shows the baton instead of activity and settled headers use real usage', async () => {
  const tree = await harness.mount(workspace())
  await click(tree.container, '[data-dock-row="a"]')
  await tree.render(workspace({ active: [worker('a', { state: 'waiting' }), b] }))
  const header = tree.container.querySelector('.subagent-side-header')!
  expect(header.textContent).toContain('waiting')
  expect(header.textContent).toContain('→assistant')
  expect(header.textContent).not.toContain('Read')
  await tree.render(workspace({ active: [b], finished: [worker('a', { state: 'completed', usageLabel: '2 tool calls · 9.0k tokens' }), done] }))
  expect(header.textContent).toContain('2 tool calls · 9.0k tokens')
  expect(header.textContent).not.toContain('waiting')
})

test('delayed row measurements use the shared bottom lock without pulling a scrolled-back reader', async () => {
  const tree = await harness.mount(workspace())
  await click(tree.container, '[data-dock-row="a"]')
  const body = tree.container.querySelector<HTMLElement>('.subagent-side-body')!
  height = 1300
  await act(async () => { reportPaneLayoutChange(body); await harness.nextFrame() })
  expect(body.scrollTop).toBe(900)
  await act(async () => { body.scrollTop = 100; body.dispatchEvent(new Event('scroll')) })
  height = 1600
  await act(async () => { reportPaneLayoutChange(body); await harness.nextFrame() })
  expect(body.scrollTop).toBe(100)
})

test('Finished dock entries open and background or unbound rows keep the existing fallback', async () => {
  const calls: string[] = []
  const background = worker('bg', { state: 'background' })
  const resumed = worker('resumed', { state: 'resumed' })
  const waiting = worker('waiting', { state: 'waiting' })
  const unbound = worker('unbound', { toolUseId: null })
  const tree = await harness.mount(workspace({
    active: [a, background, resumed, waiting, unbound],
    rows: [agent(), agent('waiting', []), agent('c', [prose('answer-c', 'Finished answer')])],
    fallback: row => calls.push(row.agentId),
  }))
  await click(tree.container, '[data-dock-row="bg"]')
  await click(tree.container, '[data-dock-row="resumed"]')
  await click(tree.container, '[data-dock-row="waiting"]')
  await click(tree.container, '[data-dock-row="unbound"]')
  expect(calls).toEqual(['bg', 'resumed', 'waiting', 'unbound'])
  expect(tree.container.querySelector('aside')).toBeNull()
  await click(tree.container, '[data-dock-row="a"]')
  await click(tree.container, '.subagent-side-switch[aria-label="worker-bg, background"]')
  expect(calls.at(-1)).toBe('bg')
  expect(tree.container.querySelector('aside')).toBeNull()
  await click(tree.container, '[data-finished-toggle]')
  await click(tree.container, '[data-dock-row="c"]')
  expect(tree.container.querySelector('aside')?.textContent).toContain('Finished answer')
  await click(tree.container, '[aria-label="Close subagent panel"]')
  expect(tree.container.querySelector('[data-finished-toggle]')?.getAttribute('aria-expanded')).toBe('true')
})

test('missing, orphaned and partially restored steps stay truthful and refresh when history arrives', async () => {
  const row = agent()
  const partial = { ...row, stepsNotLoaded: true as const }
  expect(selectSubagentPanelBranch([partial], 'launch-a').incomplete).toBe(true)
  let loads = 0
  const tree = await harness.mount(workspace({ rows: [], loadMissing: () => { loads += 1 } }))
  await click(tree.container, '[data-dock-row="a"]')
  expect(loads).toBe(1)
  expect(tree.container.querySelector('aside')?.textContent).toContain("This agent's steps aren't fully loaded.")
  await tree.render(workspace({ rows: [partial] }))
  expect(tree.container.querySelector('aside')?.textContent).toContain('The dock opens the worker.')
  expect(tree.container.querySelector('.subagent-side-availability')).not.toBeNull()
  await tree.render(workspace({ rows: [row] }))
  expect(tree.container.querySelector('.subagent-side-availability')).toBeNull()
  const orphan = { ...source, id: 'orphan', kind: 'orphaned-agent' as const, missingToolUseId: 'launch-a', agentName: 'worker-a', children: [prose('orphan-answer')] }
  await tree.render(workspace({ rows: [orphan] }))
  expect(tree.container.querySelector('aside')?.textContent).toContain('Reply orphan-answer')
  expect(tree.container.querySelector('.subagent-side-availability')).not.toBeNull()
})

test('real SessionPane opens projected child reasoning and keeps parent Agent expansion independent', async () => {
  let transcript = createTranscriptState()
  const message = (uuid: string, parent: string | null, role: 'assistant' | 'user', content: unknown[], extra = {}) => ({
    kind: 'event', protocolVersion: 4, sessionId: 'session-1',
    event: { type: 'message', message: { type: role, uuid, session_id: 'session-1', parent_tool_use_id: parent, message: { id: uuid, role, content }, ...extra } },
  } as unknown as ServerFrame)
  for (const frame of [
    { kind: 'ready', protocolVersion: 4, sessionId: 'session-1', engineSessionId: 'engine-1', payload: {
      type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false,
      abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [],
    } } as ServerFrame,
    message('parent', null, 'assistant', [{ type: 'tool_use', id: 'live-agent', name: 'Agent', input: { description: 'Inspect the dock', subagent_type: 'explore' } }]),
    message('child', 'live-agent', 'assistant', [{ type: 'thinking', thinking: '**Live child reasoning**', signature: '' }, { type: 'text', text: 'Child reply' }], { agent_name: 'live-reader' }),
    message('result', null, 'user', [{ type: 'tool_result', tool_use_id: 'live-agent', content: 'Complete' }], {
      tool_use_result: { agentId: 'live-id', agentName: 'live-reader', totalTokens: 21_000, totalToolUseCount: 3 },
    }),
  ]) transcript = projectServerFrame(transcript, frame)
  expect(selectNestedTranscriptRows(transcript, 'session-1')[0]?.children.length).toBe(2)
  const tree = await harness.mount(createElement(SessionPane, { ...idleSessionPaneProps(), transcript }))
  await click(tree.container, '[data-finished-toggle]')
  await click(tree.container, '[data-dock-row="live-id"]')
  expect(tree.container.querySelector('aside')?.textContent).toContain('Live child reasoning')
  expect(tree.container.querySelector('aside')?.textContent).toContain('Child reply')
  expect(tree.container.querySelector('.subagent-side-header')?.textContent).toContain('3 tool calls · 21.0k tokens')
  const parentCard = tree.container.querySelector('[data-agent-tool-id="live-agent"]')!
  const expand = parentCard.querySelector<HTMLButtonElement>('button[aria-expanded]')!
  expect(expand.getAttribute('aria-expanded')).toBe('false')
  await act(async () => { expand.click() })
  expect(expand.getAttribute('aria-expanded')).toBe('true')
  expect(tree.container.querySelector('aside')).not.toBeNull()
})
