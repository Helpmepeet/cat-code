import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, createElement as h, useContext, useState } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { SubagentWorkspace } from './SubagentWorkspace.js'
import { useSubagentDock } from './subagentDockController.js'
import { RendererErrorBoundary } from './RendererErrorBoundary.js'
import { ToolOutputContext } from './toolOutputPanel.js'
import { closeFilePane, disposeFilePaneSession, getFilePaneSession, registerFilePaneScroll, rejectFilePaneCandidate, rememberSlotWidth, requestOpenFile, showSlotOccupant, stepFilePaneHistory, updateFilePaneSession, useFilePaneSession } from './filePaneState.js'
import type { FilePreviewDescriptor } from '../../shared/filePreview.js'
import type { SubagentDockInput, SubagentDockRow } from './subagentDockState.js'
import type { NestedToolUseRow } from './transcriptProjector.js'

let harness: DomTestHarness
let originalBridge: Window['catcode']
const ids = new Set<string>()
const releases: string[] = []
let sequence = 0
const session = () => { const id = `shared-pane-${++sequence}`; ids.add(id); return id }
const image = (id: string, path: string): FilePreviewDescriptor => ({ id: `${id}:${path}:${++sequence}`, appSessionId: id, path, displayPath: path, kind: 'image', url: `cat-preview://test/${sequence}`, revision: 1 })
beforeAll(async () => {
  harness = await createDomTestHarness()
  originalBridge = window.catcode
  window.catcode = { prepareFilePreview: async (id: string, path: string) => ({ok: true, descriptor: image(id, path)}), releaseFilePreview: (id: string) => { releases.push(id) } } as unknown as Window['catcode']
})
afterEach(async () => {
  await harness.unmountAll()
  for (const id of ids) disposeFilePaneSession(id)
  ids.clear(); releases.length = 0; window.localStorage.clear()
})
afterAll(async () => { window.catcode = originalBridge; await harness.teardown() })

const launch: NestedToolUseRow = {
  kind: 'tool-use', id: 'launch-row', sessionId: 'engine', frameId: 'frame', messageId: 'message', blockIndex: 0,
  parentToolUseId: null, toolUseId: 'launch-a', toolName: 'Agent', toolFamily: 'agent',
  input: { description: 'Check pane', run_in_background: true }, status: 'success',
  result: { isError: false, content: 'Started', diff: null, agentId: 'agent-a' }, agentCompletion: null,
  children: [{ kind: 'assistant-text', id: 'child', sessionId: 'engine', frameId: 'child', messageId: 'child', blockIndex: 0, parentToolUseId: 'launch-a', role: 'assistant', content: 'Worker transcript', children: [] }],
}
const outputRow: NestedToolUseRow = { ...launch, id: 'output-row', toolUseId: 'output-tool', toolName: 'Bash', toolFamily: 'bash', input: { command: 'synthetic' }, result: { content: 'Output body', isError: false, diff: null }, children: [] }
const rows = [launch, outputRow]
type Sources = Omit<SubagentDockInput, 'nowMs' | 'clearMarkers' | 'reducedMotion'>
function sources(status: 'running' | 'completed', resumedAt?: number): Sources {
  const resume: NestedToolUseRow = { ...launch, id: 'resume-row', toolUseId: 'resume-a', toolName: 'ResumeAgent', input: { agentId: 'agent-a', prompt: 'Continue' }, status: 'pending', result: null, children: [] }
  const transcriptRows = resumedAt ? [...rows, resume] : rows
  return { workers: [{ agentId: 'agent-a', handle: '@Ada', role: 'Explore', status, description: 'Check pane', isBackgrounded: true }], tasks: { items: [{ id: 'agent-a', type: 'local_agent', label: 'Check pane', status, startTime: 100, isBackgrounded: true, ...(resumedAt ? { resumedAt } : {}) }], subagents: [] }, transcriptRows, leases: null }
}
function OutputTrigger() {
  const open = useContext(ToolOutputContext)
  return h('button', { id: 'open-output', onClick: () => open?.(outputRow) }, 'Open output')
}
let renders = 0
function Shell({ id, input, onFallback = () => {} }: { id: string; input: Sources; onFallback?: (row: SubagentDockRow) => void }) {
  renders++
  const [menu, setMenu] = useState(false)
  const pane = useFilePaneSession(menu ? id : '')
  const { dock, clearFinished, setDetailsVisible } = useSubagentDock(id, `${id}-engine`, input)
  return h('section', null, h('button', { id: 'menu', onClick: () => setMenu(true) }, 'Menu'),
    h('output', null, pane.visible), h(SubagentWorkspace, {
      appSessionId: id, dock, collapsed: false, onCollapsedChange() {}, onClearFinished: clearFinished,
      onDetailsVisibleChange: setDetailsVisible, onFallback, onOpenWorkers() {}, rows: [...input.transcriptRows], cwd: null,
      children: h(OutputTrigger),
    }))
}
for (const retainedBehindOutput of [false, true]) test(`subscribed parent converges with worker ${retainedBehindOutput ? 'retained behind output' : 'visible'} through live, settled, resumed updates`, async () => {
  const id = session()
  const faults: unknown[] = []
  const treeFor = (input: Sources) => h(RendererErrorBoundary, { onFault: fault => { faults.push(fault) }, children: h(Shell, { id, input }) })
  renders = 0
  const tree = await harness.mount(treeFor(sources('running')))
  await act(async () => { tree.container.querySelector<HTMLButtonElement>('[data-dock-row="agent-a"]')!.click() })
  const selection = getFilePaneSession(id).worker
  expect(selection).not.toBeNull()
  if (retainedBehindOutput) await act(async () => { tree.container.querySelector<HTMLButtonElement>('#open-output')!.click() })
  await act(async () => { tree.container.querySelector<HTMLButtonElement>('#menu')!.click() })
  for (const [input, status] of [[sources('running'), 'background'], [sources('completed'), 'completed'], [sources('running', Date.now() + 1_000), 'resumed']] as const) {
    const before = renders
    await tree.render(treeFor(input))
    expect(renders - before).toBeLessThan(10)
    expect(getFilePaneSession(id).worker).toBe(selection)
    expect(getFilePaneSession(id).visible).toBe(retainedBehindOutput ? 'output' : 'worker')
    expect(tree.container.querySelector('.subagent-side-panel')).not.toBeNull()
    expect(tree.container.querySelector('.subagent-side-panel')?.getAttribute('aria-label')).toContain(status)
    expect(faults).toEqual([])
    expect(tree.container.textContent).not.toContain('Something went wrong')
  }
  expect(tree.container.querySelector('.subagent-side-panel')?.getAttribute('aria-label')).toContain('resumed')
})

test('a live selection without published steps still falls back when it becomes terminal', async () => {
  const id = session()
  const fallbacks: SubagentDockRow[] = []
  const input = (status: 'running' | 'completed'): Sources => ({ ...sources(status), transcriptRows: [{ ...launch, children: [] }] })
  const onFallback = (row: SubagentDockRow) => { fallbacks.push(row) }
  const tree = await harness.mount(h(Shell, { id, input: input('running'), onFallback }))
  await act(async () => { tree.container.querySelector<HTMLButtonElement>('[data-dock-row="agent-a"]')!.click() })
  expect(getFilePaneSession(id).worker).not.toBeNull()
  await act(async () => { tree.container.querySelector<HTMLButtonElement>('#menu')!.click() })
  await tree.render(h(Shell, { id, input: input('completed'), onFallback }))
  expect(getFilePaneSession(id).worker).toBeNull()
  expect(fallbacks).toHaveLength(1)
  expect(fallbacks[0]?.state).toBe('completed')
})

// Use the real navigation checkpoint and rejection, not a manufactured checkpoint.
for (const navigation of ['first-open', 'open', 'back', 'forward'] as const) {
  for (const interaction of ['new-worker', 'switch-worker', 'close-worker', 'new-output', 'close-output'] as const) {
    test(`${navigation} rejection rolls back file state without undoing ${interaction}`, async () => {
      const id = session()
      if (navigation !== 'first-open') {
        await requestOpenFile(id, '/first.png')
        updateFilePaneSession(id, { committedFile: getFilePaneSession(id).file, checkpoint: null })
      }
      const first = getFilePaneSession(id).file
      const worker = { agentId: 'worker-A' } as SubagentDockRow
      const output = { id: 'output-A', fileIndex: 0, request: 1 }
      if (interaction === 'switch-worker' || interaction === 'close-worker') { updateFilePaneSession(id, { worker }); showSlotOccupant(id, 'worker') }
      if (interaction === 'close-output') { updateFilePaneSession(id, { output }); showSlotOccupant(id, 'output') }
      if (navigation === 'back' || navigation === 'forward') {
        updateFilePaneSession(id, { [navigation === 'back' ? 'history' : 'forward']: [{ path: '/target.png', scroll: { x: 3, y: 7 } }] })
      }
      const prior = getFilePaneSession(id)
      if (navigation === 'open' || navigation === 'first-open') await requestOpenFile(id, '/target.png')
      else await stepFilePaneHistory(id, navigation)
      const candidate = getFilePaneSession(id).file!
      expect(candidate.path).toBe('/target.png')
      expect(Object.keys(getFilePaneSession(id).checkpoint!)).not.toContain('worker')
      expect(Object.keys(getFilePaneSession(id).checkpoint!)).not.toContain('output')
      if (interaction === 'new-worker' || interaction === 'switch-worker') { updateFilePaneSession(id, { worker: { ...worker, agentId: 'worker-B' } }); showSlotOccupant(id, 'worker') }
      if (interaction === 'close-worker') updateFilePaneSession(id, { worker: null })
      if (interaction === 'new-output') { updateFilePaneSession(id, { output: { ...output, id: 'output-B' } }); showSlotOccupant(id, 'output') }
      if (interaction === 'close-output') updateFilePaneSession(id, { output: null })
      rememberSlotWidth(id, 720)
      const newer = getFilePaneSession(id)
      expect(rejectFilePaneCandidate(id, candidate)).toBe(true)
      const restored = getFilePaneSession(id)
      expect(restored.file).toBe(first)
      expect(restored.committedFile).toBe(first)
      expect(restored.history).toEqual(prior.history)
      expect(restored.forward).toEqual(prior.forward)
      expect(restored.worker).toBe(newer.worker)
      expect(restored.output).toBe(newer.output)
      const empty = !restored.open && !restored.worker && !restored.output
      expect(restored.visible).toBe(empty ? null : newer.visible)
      expect(restored.width).toBe(empty ? null : 720)
      expect(releases).toContain(candidate.id)
      if (first) expect(releases).not.toContain(first.id)
    })
  }
}

test('failed first file leaves a newer worker visible and preserves its resized width', async () => {
  const id = session()
  await requestOpenFile(id, '/broken.png')
  const candidate = getFilePaneSession(id).file!
  const worker = { agentId: 'worker-B' } as SubagentDockRow
  updateFilePaneSession(id, { worker }); showSlotOccupant(id, 'worker'); rememberSlotWidth(id, 720)
  rejectFilePaneCandidate(id, candidate)
  expect(getFilePaneSession(id)).toMatchObject({ open: false, file: null, worker, visible: 'worker', width: 720 })
})

test('successful open preserves resize during held scroll capture', async () => {
  const id = session()
  await requestOpenFile(id, '/first.png')
  const first = getFilePaneSession(id).file!
  updateFilePaneSession(id, { committedFile: first, checkpoint: null, width: 480 })
  let begin!: () => void
  let finish!: (scroll: { x: number; y: number }) => void
  const started = new Promise<void>(resolve => { begin = resolve })
  const captured = new Promise<{ x: number; y: number }>(resolve => { finish = resolve })
  const unregister = registerFilePaneScroll(id, () => { begin(); return captured })
  try {
    const opening = requestOpenFile(id, '/second.png')
    await started
    rememberSlotWidth(id, 720)
    finish({ x: 4, y: 12 })
    expect(await opening).toEqual({ ok: true })
    expect(getFilePaneSession(id).file?.path).toBe('/second.png')
    expect(getFilePaneSession(id).width).toBe(720)
    expect(getFilePaneSession(id).history.at(-1)?.scroll).toEqual({ x: 4, y: 12 })
    expect(releases).not.toContain(first.id)
  } finally { unregister() }
})

test('closing during held scroll capture cancels navigation and releases its candidate', async () => {
  const id = session()
  let finish!: (scroll: { x: number; y: number }) => void
  let begin!: () => void
  const started = new Promise<void>(resolve => { begin = resolve })
  const unregister = registerFilePaneScroll(id, () => { begin(); return new Promise(resolve => { finish = resolve }) })
  try {
    const opening = requestOpenFile(id, '/cancelled.png')
    await started
    closeFilePane(id)
    finish({ x: 0, y: 0 })
    await opening
    expect(getFilePaneSession(id).open).toBe(false)
    expect(releases.some(id => id.includes('/cancelled.png'))).toBe(true)
  } finally { unregister() }
})
