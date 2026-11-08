import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { SubagentWorkspace } from './SubagentWorkspace.js'
import { TranscriptRowsView } from './TranscriptView.js'
import { applyBrowserPaneEvent } from './browserPaneState.js'
import { closeFilePane, disposeFilePaneSession, getFilePaneSession, showSlotOccupant, updateFilePaneSession } from './filePaneState.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'
import type { BrowserPaneLayout, BrowserPaneSnapshot } from '../../shared/browserPanePresentation.js'

let harness: DomTestHarness
let bridge: Window['catcode']
const id = 'screen-workspace'
const other = 'other-screen-workspace'
const image = { mediaType: 'image/png' as const, data: 'iVBORw0KGgo=' }
let commands: string[] = []
let layouts: BrowserPaneLayout[] = []
beforeAll(async () => { harness = await createDomTestHarness(); bridge = window.catcode })
afterEach(async () => { await harness.unmountAll(); disposeFilePaneSession(id); disposeFilePaneSession(other); commands = []; layouts = []; window.catcode = bridge })
afterAll(async () => { await harness.teardown() })
function setup() {
  window.catcode = {
    getFilePreviewApplications: async () => ({ applications: [], selected: 'default' }), refreshFilePreview: async () => null,
    subscribeFilePreview: () => () => {}, releaseFilePreview: () => {},
    browserPaneCommand: async ({ command }: { command: string }) => { commands.push(command); return { ok: true } },
    reportBrowserPaneLayout: (layout: BrowserPaneLayout) => layouts.push(layout),
  } as unknown as Window['catcode']
}
function step(key: string, status: 'success' | 'pending' = 'success'): NestedTranscriptRow {
  return { id: key, sessionId: id, frameId: key, messageId: key, blockIndex: 0, parentToolUseId: null,
    kind: 'tool-use', toolUseId: key, toolName: 'mcp__codex-computer-use__js', toolFamily: 'computer',
    input: { title: `Step ${key}`, code: 'screenshot()' }, status, agentCompletion: null,
    result: status === 'pending' ? null : { content: '', isError: false, diff: null, images: [image] }, children: [] }
}
function view(rows: NestedTranscriptRow[], runKey = 'turn-1', running = true) {
  return <SubagentWorkspace appSessionId={id} running={running} runKey={runKey} rows={rows} cwd={null}
    dock={{ active: [], finished: [], chipFaces: [], nextUpdateAt: null }} collapsed={false} onCollapsedChange={() => {}}
    onClearFinished={() => {}} onDetailsVisibleChange={() => {}} onFallback={() => {}} onOpenWorkers={() => {}}>
    <TranscriptRowsView rows={rows} />
  </SubagentWorkspace>
}
const browser: BrowserPaneSnapshot = { appSessionId: id, url: 'http://localhost:3000/', displayUrl: 'localhost:3000',
  controller: 'agent', canGoBack: false, canGoForward: false, still: null, agentUseSequence: 1 }

test('Computer auto-opens once, stays hidden through later steps, and the chip reopens latest', async () => {
  setup()
  const tree = await harness.mount(view([]))
  await tree.render(view([step('one')]))
  expect(getFilePaneSession(id).visible).toBe('computer')
  expect(tree.container.querySelector('.computer-pane-title')?.textContent).toBe('Step one')
  await act(async () => tree.container.querySelector<HTMLButtonElement>('[aria-label="Close computer panel"]')!.click())
  expect(getFilePaneSession(id).visible).toBeNull()
  await tree.render(view([step('one'), step('two')]))
  expect(getFilePaneSession(id).visible).toBeNull()
  expect(tree.container.querySelector('.subagent-shared-slot')?.hasAttribute('hidden')).toBe(true)
  await act(async () => tree.container.querySelector<HTMLButtonElement>('[aria-label="Show Computer"]')!.click())
  expect(getFilePaneSession(id).visible).toBe('computer')
  expect(tree.container.querySelector('.computer-pane-title')?.textContent).toBe('Step two')
  await act(async () => tree.container.querySelector<HTMLButtonElement>('[aria-label="Previous computer step"]')!.click())
  await tree.render(view([step('one'), step('two'), step('three')]))
  expect(tree.container.querySelector('.computer-pane-title')?.textContent).toBe('Step one')
  expect(tree.container.querySelectorAll('[aria-label="Show screenshot in Computer panel"][aria-current="true"]')).toHaveLength(1)
  await act(async () => tree.container.querySelector<HTMLButtonElement>('.computer-pane-latest')!.click())
  expect(tree.container.querySelector('.computer-pane-title')?.textContent).toBe('Step three')
  expect(getFilePaneSession(other).visible).toBeNull()
})

test('historical screenshots open on click without auto-opening and hide/reveal follows run boundaries', async () => {
  setup()
  const rows = [step('history')]
  const tree = await harness.mount(view(rows, 'old', false))
  expect(getFilePaneSession(id).visible).toBeNull()
  await act(async () => tree.container.querySelector<HTMLButtonElement>('[aria-label="Show screenshot in Computer panel"]')!.click())
  expect(getFilePaneSession(id).computer?.selectedId).toBe('history')
  await act(async () => tree.container.querySelector<HTMLButtonElement>('[aria-label="Close computer panel"]')!.click())
  await tree.render(view(rows, 'turn-2'))
  expect(getFilePaneSession(id).visible).toBeNull()
  await tree.render(view([...rows, step('new')], 'turn-2'))
  expect(getFilePaneSession(id).visible).toBe('computer')
})

test('browser hiding keeps its session, never steals a file, and reopens without sending a close command', async () => {
  setup()
  updateFilePaneSession(id, { open: true, file: { id: 'image', appSessionId: id, path: '/plan.png', displayPath: 'plan.png', kind: 'image', url: 'cat-preview://test/image', revision: 1 } })
  showSlotOccupant(id, 'file')
  const tree = await harness.mount(view([]))
  await act(async () => applyBrowserPaneEvent({ appSessionId: id, state: browser }))
  expect(getFilePaneSession(id).visible).toBe('file')
  await act(async () => tree.container.querySelector<HTMLButtonElement>('[aria-label="Show localhost:3000"]')!.click())
  expect(getFilePaneSession(id).visible).toBe('browser')
  await act(async () => tree.container.querySelector<HTMLButtonElement>('[aria-label="Hide browser"]')!.click())
  expect(getFilePaneSession(id).visible).toBe('file')
  expect(getFilePaneSession(id).browser).toEqual(browser)
  expect(layouts.at(-1)?.rect).toBeNull()
  await act(async () => closeFilePane(id))
  expect(getFilePaneSession(id).visible).toBeNull()
  await act(async () => applyBrowserPaneEvent({ appSessionId: id, state: { ...browser, agentUseSequence: 2 } }))
  expect(getFilePaneSession(id).visible).toBeNull()
  await act(async () => tree.container.querySelector<HTMLButtonElement>('[aria-label="Show localhost:3000"]')!.click())
  expect(getFilePaneSession(id).visible).toBe('browser')
  expect(commands).toEqual([])
})
