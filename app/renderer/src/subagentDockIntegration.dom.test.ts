import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { SubagentDock } from './SubagentDock.js'
import { useSubagentDock } from './subagentDockController.js'
import { readSubagentDockSessionsFromStorage } from './subagentDockPersistence.js'
import type { SubagentDockInput } from './subagentDockState.js'
import type { LiveWorkerItem, TaskSnapshotItem } from '../../shared/protocol.js'
import type { NestedToolUseRow } from './transcriptProjector.js'

let harness: DomTestHarness
let originalWindowMatchMedia: typeof window.matchMedia
let originalGlobalMatchMedia: typeof globalThis.matchMedia
beforeAll(async () => {
  harness = await createDomTestHarness()
  originalWindowMatchMedia = window.matchMedia
  originalGlobalMatchMedia = globalThis.matchMedia
  const matchMedia = (() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  window.matchMedia = matchMedia
  globalThis.matchMedia = matchMedia
})
afterEach(async () => { await harness.unmountAll(); window.localStorage.clear() })
afterAll(async () => {
  window.matchMedia = originalWindowMatchMedia
  globalThis.matchMedia = originalGlobalMatchMedia
  await harness.teardown()
})

type Sources = Omit<SubagentDockInput, 'nowMs' | 'clearMarkers' | 'reducedMotion'>
function Pane({ appId, sources }: { appId: string; sources: Sources }) {
  const { dock, clearFinished } = useSubagentDock(appId, 'engine-history', sources)
  return createElement('section', {
    ref: (element: HTMLElement | null) => {
      if (element) element.getBoundingClientRect = () => new DOMRect(0, 0, 1600, 600)
    },
  }, createElement(SubagentDock, {
    state: dock, collapsed: false, onCollapsedChange() {}, onClearFinished: clearFinished,
    onOpenWorker() {}, onOpenWorkers() {},
  }))
}
const worker = (patch: Partial<LiveWorkerItem> = {}): LiveWorkerItem => ({
  agentId: 'agent-a', handle: '@Ada', role: 'Explore', status: 'running',
  description: 'Check restore', isBackgrounded: true, ...patch,
})
const task = (patch: Partial<TaskSnapshotItem> = {}): TaskSnapshotItem => ({
  id: 'agent-a', type: 'local_agent', label: 'Check restore', status: 'running',
  startTime: 100, isBackgrounded: true, ...patch,
})
// A successful Agent launch acknowledgement is still a background run. No
// terminal transcript row is manufactured to rescue the controller's write path.
const launch: NestedToolUseRow = {
  kind: 'tool-use', id: 'launch-row', sessionId: 'engine-history', frameId: 'frame',
  messageId: 'message', blockIndex: 0, parentToolUseId: null, toolUseId: 'launch-a',
  toolName: 'Agent', toolFamily: 'agent', input: { description: 'Check restore', run_in_background: true },
  status: 'success', result: { isError: false, content: 'Started', diff: null, agentId: 'agent-a' },
  agentCompletion: null, children: [],
}
function sources(workers: LiveWorkerItem[], items: TaskSnapshotItem[]): Sources {
  return { workers, tasks: { items, subagents: [] }, transcriptRows: [launch], leases: null }
}

// This boundary owns the integration risk: selectors and codecs can both pass
// while the production hook never saves the durable key or never restores it.
test('finished background history persists by engine identity through eviction, Clear, and a later resumed finish', async () => {
  window.localStorage.clear()
  const tree = await harness.mount(createElement(Pane, { appId: 'app-before-restart', sources: sources([worker()], [task()]) }))
  expect(tree.container.querySelector('[aria-label="Ada, background"]')).not.toBeNull()
  await tree.render(createElement(Pane, {
    appId: 'app-before-restart', sources: sources([worker({ status: 'completed' })], [task({ status: 'completed' })]),
  }))
  expect(tree.container.querySelector('[aria-label="Ada, completed"]')).not.toBeNull()
  const saved = readSubagentDockSessionsFromStorage(window.localStorage)!
  expect(saved['engine-history'].finished).toHaveLength(1)
  expect(saved['app-before-restart']).toBeUndefined()
  const firstRun = saved['engine-history'].finished[0]!
  await tree.render(createElement(Pane, { appId: 'app-before-restart', sources: sources([], []) }))
  expect(tree.container.querySelector('[aria-label="Ada, completed"]')).not.toBeNull()
  await tree.unmount()

  const restored = await harness.mount(createElement(Pane, { appId: 'app-after-restart', sources: sources([], []) }))
  const toggle = restored.container.querySelector<HTMLButtonElement>('[data-finished-toggle]')!
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  await act(async () => { toggle.click() })
  expect(restored.container.querySelector('[aria-label="Ada, completed"]')?.parentElement?.hasAttribute('inert')).toBe(false)
  const clear = [...restored.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Clear')!
  await act(async () => { clear.click() })
  expect(restored.container.querySelector('.subagent-dock')).toBeNull()
  expect(readSubagentDockSessionsFromStorage(window.localStorage)?.['engine-history'].cleared).toEqual([{ agentId: 'agent-a', runKey: firstRun.runKey }])
  await restored.unmount()

  const cleared = await harness.mount(createElement(Pane, { appId: 'app-second-restart', sources: sources([], []) }))
  expect(cleared.container.querySelector('.subagent-dock')).toBeNull()
  const resumedAt = firstRun.terminalAt! + 1_000
  await cleared.render(createElement(Pane, {
    appId: 'app-second-restart', sources: sources([worker()], [task({ resumedAt })]),
  }))
  expect(cleared.container.querySelector('[aria-label="Ada, resumed"]')).not.toBeNull()
  await cleared.render(createElement(Pane, {
    appId: 'app-second-restart', sources: sources([worker({ status: 'completed' })], [task({ status: 'completed', resumedAt, endTime: resumedAt + 100 })]),
  }))
  expect(cleared.container.querySelectorAll('[aria-label="Ada, completed"]')).toHaveLength(1)
  const latest = readSubagentDockSessionsFromStorage(window.localStorage)!['engine-history']
  expect(latest.finished).toHaveLength(1)
  expect(latest.finished[0]?.runKey).not.toBe(firstRun.runKey)
  expect(latest.cleared).toEqual([{ agentId: 'agent-a', runKey: firstRun.runKey }])
})
