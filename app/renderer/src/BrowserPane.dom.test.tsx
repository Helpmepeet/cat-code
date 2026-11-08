import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { BrowserPane } from './BrowserPane.js'
import { SubagentWorkspace } from './SubagentWorkspace.js'
import { applyBrowserPaneEvent, getBrowserPaneSnapshot, installBrowserPaneSubscription } from './browserPaneState.js'
import { disposeFilePaneSession, getFilePaneSession, rememberSlotWidth, showSlotOccupant, updateFilePaneSession } from './filePaneState.js'
import type { BrowserPaneEvent, BrowserPaneLayout, BrowserPaneSnapshot } from '../../shared/browserPanePresentation.js'
let harness: DomTestHarness
let bridge: Window['catcode']
let reports: BrowserPaneLayout[] = []
let commands: string[] = []
const cleanups: Array<() => void> = []
const state: BrowserPaneSnapshot = { appSessionId: 'browser-test', url: 'http://localhost:3000/profile', displayUrl: 'localhost:3000/profile', controller: 'agent', canGoBack: true, canGoForward: false, still: null }
beforeAll(async () => { harness = await createDomTestHarness(); bridge = window.catcode })
afterEach(async () => { await harness.unmountAll(); for (const cleanup of cleanups.splice(0)) cleanup(); disposeFilePaneSession(state.appSessionId); reports = []; commands = [] })
afterAll(async () => { window.catcode = bridge; await harness.teardown() })
function setup() {
  window.catcode = { getFilePreviewApplications: async () => ({ applications: [], selected: 'default' }), refreshFilePreview: async () => null, subscribeFilePreview: () => () => {}, releaseFilePreview: () => {}, browserPaneCommand: async ({ command }: { command: string }) => { commands.push(command); return { ok: true } }, reportBrowserPaneLayout: (layout: BrowserPaneLayout) => reports.push(layout) } as unknown as Window['catcode']
  applyBrowserPaneEvent({ appSessionId: state.appSessionId, state })
  showSlotOccupant(state.appSessionId, 'browser')
}
function animationFrames() {
  const originalRequest = globalThis.requestAnimationFrame
  const originalCancel = globalThis.cancelAnimationFrame
  const callbacks = new Map<number, FrameRequestCallback>()
  let id = 0
  let now = performance.now()
  globalThis.requestAnimationFrame = callback => { callbacks.set(++id, callback); return id }
  globalThis.cancelAnimationFrame = id => { callbacks.delete(id) }
  cleanups.push(() => { globalThis.requestAnimationFrame = originalRequest; globalThis.cancelAnimationFrame = originalCancel })
  return {
    get pending() { return callbacks.size },
    async flush(milliseconds = 17) {
      now += milliseconds
      await act(async () => {
        const batch = [...callbacks.values()]
        callbacks.clear()
        for (const callback of batch) callback(now)
      })
    },
  }
}
async function resizeEvent() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
    window.dispatchEvent(new Event('resize'))
    await harness.nextFrame()
  })
}
test('approved file chrome has exactly five header actions and the touch takeover note', async () => {
  setup()
  const tree = await harness.mount(<BrowserPane state={state} active />)
  expect([...tree.container.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))).toEqual(['Back', 'Forward', 'Reload', 'Open in default browser', 'Hide browser'])
  expect(tree.container.querySelector('.file-pane-path')?.textContent).toBe(state.displayUrl)
  expect(tree.container.querySelector('button[aria-label="Forward"]')?.hasAttribute('disabled')).toBe(true)
  for (const button of tree.container.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')) await act(async () => button.click())
  expect(commands).toEqual(['back', 'reload', 'external'])
  expect(getBrowserPaneSnapshot(state.appSessionId)).toEqual(state)
  expect(getFilePaneSession(state.appSessionId).visible).toBeNull()
  await tree.render(<BrowserPane state={{ ...state, displayUrl: state.url }} active />)
  expect(tree.container.querySelector('.file-pane-path')?.textContent).toBe('localhost:3000/profile')
  expect(tree.container.querySelector('.file-pane-path .file-pane-folder')?.textContent).toBe('/profile')
  await tree.render(<BrowserPane state={{ ...state, controller: 'user' }} active />)
  expect(tree.container.querySelector('.file-pane-note')?.textContent).toBe('You have the browser. Your next message hands it back.')
  expect(tree.container.querySelector('[data-agent]')).toBeNull()
})
test('shell snapshot subscription survives pane remounts and event wins over late snapshot', async () => {
  setup()
  let callback!: (event: BrowserPaneEvent) => void
  let resolve!: (states: BrowserPaneSnapshot[]) => void
  Object.assign(window.catcode, { browserPaneSnapshot: () => new Promise<BrowserPaneSnapshot[]>(done => { resolve = done }), onBrowserPane: (cb: typeof callback) => { callback = cb; return () => {} } })
  const stop = installBrowserPaneSubscription()
  callback({ appSessionId: state.appSessionId, state: { ...state, controller: 'user' } })
  resolve([state]); await act(async () => { await Promise.resolve() })
  expect(getBrowserPaneSnapshot(state.appSessionId)?.controller).toBe('user')
  const tree = await harness.mount(<BrowserPane state={getBrowserPaneSnapshot(state.appSessionId)!} active />)
  await tree.render(<div />)
  await tree.render(<BrowserPane state={getBrowserPaneSnapshot(state.appSessionId)!} active />)
  expect(tree.container.textContent).toContain('Your next message hands it back.')
  callback({ appSessionId: state.appSessionId, state: null })
  expect(getBrowserPaneSnapshot(state.appSessionId)).toBeNull()
  stop()
})
test('still and control updates keep active layout ownership without a hide-and-recapture loop', async () => {
  setup()
  const tree = await harness.mount(<BrowserPane state={state} active />)
  const host = tree.container.querySelector<HTMLElement>('.browser-pane-host')!
  host.getBoundingClientRect = () => ({ x: 10, y: 20, left: 10, top: 20, right: 510, bottom: 420, width: 500, height: 400, toJSON() {} })
  reports = []
  await tree.render(<BrowserPane state={{ ...state, still: 'data:image/png;base64,AA==', controller: 'user' }} active />)
  expect(reports.some(report => report.rect === null)).toBe(false)
})
test('ordinary browser updates preserve file selection and shared width', () => {
  setup()
  expect(getFilePaneSession(state.appSessionId).visible).toBe('browser')
  rememberSlotWidth(state.appSessionId, 690)
  updateFilePaneSession(state.appSessionId, { open: true, worker: {} as never, output: { id: 'output', fileIndex: 0, request: 1 } })
  showSlotOccupant(state.appSessionId, 'file')
  applyBrowserPaneEvent({ appSessionId: state.appSessionId, state: { ...state, displayUrl: 'localhost:3000/next' } })
  expect(getFilePaneSession(state.appSessionId).visible).toBe('file')
  showSlotOccupant(state.appSessionId, 'browser')
  expect(getFilePaneSession(state.appSessionId).width).toBe(690)
  applyBrowserPaneEvent({ appSessionId: state.appSessionId, state: null })
  expect(getFilePaneSession(state.appSessionId).visible).toBe('file')
  expect(getFilePaneSession(state.appSessionId).worker).not.toBeNull()
})
test('new agent browser use preserves user panel selection and does not change another chat', () => {
  setup()
  rememberSlotWidth(state.appSessionId, 690)
  updateFilePaneSession(state.appSessionId, { open: true, worker: {} as never, output: { id: 'output', fileIndex: 0, request: 1 } })
  showSlotOccupant(state.appSessionId, 'file')
  applyBrowserPaneEvent({ appSessionId: state.appSessionId, state: { ...state, agentUseSequence: 1 } })
  expect(getFilePaneSession(state.appSessionId).visible).toBe('file')
  expect(getFilePaneSession(state.appSessionId).width).toBe(690)
  expect(getFilePaneSession(state.appSessionId).open).toBe(true)
  expect(getFilePaneSession(state.appSessionId).worker).not.toBeNull()
  expect(getFilePaneSession(state.appSessionId).output?.id).toBe('output')
  showSlotOccupant(state.appSessionId, 'worker')
  applyBrowserPaneEvent({ appSessionId: state.appSessionId, state: { ...state, agentUseSequence: 1, controller: 'user' } })
  expect(getFilePaneSession(state.appSessionId).visible).toBe('worker')
  applyBrowserPaneEvent({ appSessionId: state.appSessionId, state: { ...state, agentUseSequence: 2 } })
  expect(getFilePaneSession(state.appSessionId).visible).toBe('worker')
  const before = getFilePaneSession(state.appSessionId)
  const otherId = 'browser-other-chat'
  applyBrowserPaneEvent({ appSessionId: otherId, state: { ...state, appSessionId: otherId, agentUseSequence: 2 } })
  expect(getFilePaneSession(otherId).visible).toBeNull()
  expect(getFilePaneSession(state.appSessionId)).toBe(before)
  disposeFilePaneSession(otherId)
})
test('layout heartbeat reports host bounds, ignores the resize rail, detects overlays and still click takes over', async () => {
  setup()
  const tree = await harness.mount(<BrowserPane state={{ ...state, still: 'data:image/png;base64,AA==' }} active />)
  const host = tree.container.querySelector<HTMLElement>('.browser-pane-host')!
  host.getBoundingClientRect = () => ({ x: 10, y: 20, left: 10, top: 20, right: 510, bottom: 420, width: 500, height: 400, toJSON() {} })
  host.style.setProperty('--accent', '#bb3e84')
  const rail = document.createElement('div'); rail.className = 'subagent-shared-resize'; rail.style.position = 'absolute'
  rail.getBoundingClientRect = () => ({ x: 8, y: 20, left: 8, top: 20, right: 16, bottom: 420, width: 8, height: 400, toJSON() {} })
  document.body.append(rail)
  await resizeEvent()
  expect(reports.at(-1)).toMatchObject({ rect: { x: 10, y: 20, width: 500, height: 400 }, overlay: false })
  rail.remove()
  const overlay = document.createElement('div'); overlay.className = 'composer-popover'; overlay.style.position = 'fixed'
  overlay.getBoundingClientRect = () => ({ x: 50, y: 50, left: 50, top: 50, right: 150, bottom: 150, width: 100, height: 100, toJSON() {} })
  document.body.append(overlay)
  await resizeEvent()
  expect(reports.at(-1)).toMatchObject({ rect: { x: 10, y: 20, width: 500, height: 400 }, overlay: true, accent: { r: 187, g: 62, b: 132 } })
  await act(async () => tree.container.querySelector<HTMLImageElement>('img')!.click())
  expect(commands).toEqual(['takeover'])
  overlay.remove()
  await act(async () => { await new Promise(done => setTimeout(done, 450)) })
  expect(reports.at(-1)?.overlay).toBe(false)
  await tree.render(<BrowserPane state={state} active={false} />)
  expect(reports.at(-1)?.rect).toBeNull()
  const count = reports.length
  await act(async () => { window.dispatchEvent(new Event('resize')); await new Promise(done => setTimeout(done, 450)) })
  expect(reports.length).toBe(count)
})
test('workspace renders the globe browser tab beside the file and hides its native host on file selection and unmount', async () => {
  setup()
  updateFilePaneSession(state.appSessionId, { open: true, file: { id: 'image', appSessionId: state.appSessionId, path: '/plan.png', displayPath: 'plan.png', kind: 'image', url: 'cat-preview://test/image', revision: 1 } })
  const tree = await harness.mount(<SubagentWorkspace appSessionId={state.appSessionId} dock={{ active: [], finished: [], chipFaces: [], nextUpdateAt: null }}
    collapsed={false} onCollapsedChange={() => {}} onClearFinished={() => {}} onDetailsVisibleChange={() => {}}
    onFallback={() => {}} onOpenWorkers={() => {}} rows={[]} cwd={null}><div /></SubagentWorkspace>)
  const browser = tree.container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="localhost:3000"]')!
  expect(browser).not.toBeNull()
  expect(browser.querySelector('svg circle')).not.toBeNull()
  expect(browser.getAttribute('aria-selected')).toBe('true')
  await act(async () => tree.container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="plan.png"]')!.click())
  expect(tree.container.querySelector('.browser-pane')?.closest('[hidden]')).not.toBeNull()
  expect(reports.at(-1)?.rect).toBeNull()
  await act(async () => applyBrowserPaneEvent({ appSessionId: state.appSessionId, state: { ...state, agentUseSequence: 1 } }))
  expect(browser.getAttribute('aria-selected')).toBe('false')
  expect(tree.container.querySelector('.browser-pane')?.closest('[hidden]')).not.toBeNull()
  const reopen = tree.container.querySelector<HTMLButtonElement>('.screen-activity-chip')!
  expect(reopen.textContent).toContain('localhost:3000')
  await act(async () => reopen.click())
  expect(browser.getAttribute('aria-selected')).toBe('true')
  expect(tree.container.querySelector('.browser-pane')?.closest('[hidden]')).toBeNull()
  await tree.render(<div />)
  expect(reports.at(-1)?.rect).toBeNull()
  expect(getBrowserPaneSnapshot(state.appSessionId)).toEqual({ ...state, agentUseSequence: 1 })
})

test('unrelated transcript mutations do not measure the browser or send layout reports', async () => {
  setup()
  const frames = animationFrames()
  const tree = await harness.mount(<BrowserPane state={state} active />)
  const host = tree.container.querySelector<HTMLElement>('.browser-pane-host')!
  let measurements = 0
  host.getBoundingClientRect = () => { measurements++; return new DOMRect(10, 20, 500, 400) }
  const transcript = document.createElement('div')
  tree.container.append(transcript)
  await frames.flush()
  reports = []; measurements = 0
  for (let index = 0; index < 10; index++) {
    await act(async () => { transcript.textContent = `Transcript update ${index}`; await new Promise(resolve => setTimeout(resolve, 1)) })
    await frames.flush()
  }
  expect(measurements).toBe(0)
  expect(reports).toEqual([])
})

test('resize bursts coalesce, unchanged layouts are skipped, and high-refresh frames are capped', async () => {
  setup()
  const frames = animationFrames()
  const tree = await harness.mount(<BrowserPane state={state} active />)
  const host = tree.container.querySelector<HTMLElement>('.browser-pane-host')!
  let width = 500
  host.getBoundingClientRect = () => new DOMRect(10, 20, width, 400)
  reports = []
  await act(async () => { for (let index = 0; index < 125; index++) window.dispatchEvent(new Event('resize')) })
  expect(reports).toHaveLength(0)
  expect(frames.pending).toBe(1)
  await frames.flush()
  expect(reports).toHaveLength(1)
  expect(reports[0]?.rect?.width).toBe(500)
  window.dispatchEvent(new Event('resize'))
  await frames.flush()
  expect(reports).toHaveLength(1)
  width = 600
  window.dispatchEvent(new Event('resize'))
  await frames.flush(4)
  expect(reports).toHaveLength(1)
  await frames.flush(13)
  expect(reports).toHaveLength(2)
  expect(reports.at(-1)?.rect?.width).toBe(600)
})

test('geometry-only resize reuses overlay candidates and the cached accent', async () => {
  setup()
  const frames = animationFrames()
  const originalObserver = globalThis.ResizeObserver
  let resized!: ResizeObserverCallback
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) { resized = callback }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  cleanups.push(() => { globalThis.ResizeObserver = originalObserver })
  const tree = await harness.mount(<BrowserPane state={state} active />)
  const host = tree.container.querySelector<HTMLElement>('.browser-pane-host')!
  let width = 500
  host.getBoundingClientRect = () => new DOMRect(10, 20, width, 400)
  window.dispatchEvent(new Event('resize'))
  await frames.flush()
  const scan = spyOn(document.body, 'querySelectorAll')
  const probe = spyOn(host, 'append')
  cleanups.push(() => { scan.mockRestore(); probe.mockRestore() })
  width = 600
  resized([], {} as ResizeObserver)
  await frames.flush()
  expect(reports.at(-1)?.rect?.width).toBe(600)
  expect(scan).not.toHaveBeenCalled()
  expect(probe).not.toHaveBeenCalled()
})

test('new overlays, changed roles and hidden ancestors update coverage without a window resize', async () => {
  setup()
  const frames = animationFrames()
  const tree = await harness.mount(<BrowserPane state={state} active />)
  const host = tree.container.querySelector<HTMLElement>('.browser-pane-host')!
  host.getBoundingClientRect = () => new DOMRect(10, 20, 500, 400)
  window.dispatchEvent(new Event('resize'))
  await frames.flush()
  const parent = document.createElement('div')
  const overlay = document.createElement('div')
  overlay.style.position = 'fixed'
  overlay.getBoundingClientRect = () => new DOMRect(50, 50, 100, 100)
  parent.append(overlay)
  tree.container.append(parent)
  await act(async () => { overlay.setAttribute('role', 'menu'); await new Promise(resolve => setTimeout(resolve, 1)) })
  await frames.flush()
  expect(reports.at(-1)?.overlay).toBe(true)
  await act(async () => { parent.hidden = true; await new Promise(resolve => setTimeout(resolve, 1)) })
  await frames.flush()
  expect(reports.at(-1)?.overlay).toBe(false)
  await act(async () => { parent.hidden = false; await new Promise(resolve => setTimeout(resolve, 1)) })
  await frames.flush()
  expect(reports.at(-1)?.overlay).toBe(true)
  await act(async () => { overlay.removeAttribute('role'); await new Promise(resolve => setTimeout(resolve, 1)) })
  await frames.flush()
  expect(reports.at(-1)?.overlay).toBe(false)
})

test('a refused layout report retries on the heartbeat and unmount cancels queued reports', async () => {
  setup()
  const frames = animationFrames()
  let refuse = true
  const originalError = console.error
  const errors: unknown[][] = []
  console.error = (...args: unknown[]) => { errors.push(args) }
  cleanups.push(() => { console.error = originalError })
  window.catcode.reportBrowserPaneLayout = layout => {
    if (refuse) throw new Error('rate limited')
    reports.push(layout)
  }
  const tree = await harness.mount(<BrowserPane state={state} active />)
  expect(errors).toHaveLength(1)
  refuse = false
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 420)) })
  await frames.flush()
  expect(reports).toHaveLength(1)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 420)) })
  await frames.flush()
  expect(reports).toHaveLength(2)
  expect(reports[1]).toEqual(reports[0])
  window.dispatchEvent(new Event('resize'))
  await tree.unmount()
  expect(reports.at(-1)?.rect).toBeNull()
  const count = reports.length
  await frames.flush()
  expect(reports).toHaveLength(count)
})

test('drag previews only the latest width per frame and saves the final unpainted move on release', async () => {
  setup()
  const frames = animationFrames()
  const tree = await harness.mount(<SubagentWorkspace appSessionId={state.appSessionId} dock={{ active: [], finished: [], chipFaces: [], nextUpdateAt: null }}
    collapsed={false} onCollapsedChange={() => {}} onClearFinished={() => {}} onDetailsVisibleChange={() => {}}
    onFallback={() => {}} onOpenWorkers={() => {}} rows={[]} cwd={null}><div /></SubagentWorkspace>)
  const slot = tree.container.querySelector<HTMLElement>('.subagent-shared-slot')!
  const workspace = tree.container.querySelector<HTMLElement>('.subagent-workspace')!
  const handle = tree.container.querySelector<HTMLElement>('[role="separator"]')!
  slot.getBoundingClientRect = () => new DOMRect(500, 0, Number.parseInt(slot.style.getPropertyValue('--shared-slot-width')) || 560, 600)
  Object.defineProperty(workspace, 'clientWidth', { value: 1400 })
  handle.setPointerCapture = () => {}
  const pointer = async (type: string, x: number, pointerId = 1) => {
    await act(async () => { handle.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId, clientX: x })) })
  }
  await pointer('pointerdown', 500)
  await pointer('pointermove', 450)
  await pointer('pointermove', 400)
  expect(getFilePaneSession(state.appSessionId).width).toBe(560)
  expect(slot.style.getPropertyValue('--shared-slot-width')).toBe('560px')
  await frames.flush()
  expect(slot.style.getPropertyValue('--shared-slot-width')).toBe('660px')
  expect(handle.getAttribute('aria-valuenow')).toBe('660')
  expect(getFilePaneSession(state.appSessionId).width).toBe(560)
  await pointer('pointermove', 300, 2)
  await pointer('pointerup', 300, 2)
  expect(getFilePaneSession(state.appSessionId).width).toBe(560)
  await pointer('pointermove', 350)
  await pointer('pointerup', 350)
  expect(getFilePaneSession(state.appSessionId).width).toBe(710)
  expect(slot.style.getPropertyValue('--shared-slot-width')).toBe('710px')
  expect(handle.getAttribute('aria-valuenow')).toBe('710')
  await frames.flush()
  expect(slot.style.getPropertyValue('--shared-slot-width')).toBe('710px')
  await pointer('pointerdown', 500)
  await pointer('pointermove', 450)
  await frames.flush()
  expect(slot.style.getPropertyValue('--shared-slot-width')).toBe('760px')
  await pointer('pointermove', 500)
  await pointer('pointercancel', 500)
  expect(slot.style.getPropertyValue('--shared-slot-width')).toBe('710px')
  expect(handle.getAttribute('aria-valuenow')).toBe('710')
  await act(async () => { handle.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowLeft' })) })
  expect(getFilePaneSession(state.appSessionId).width).toBe(742)
  expect(slot.style.getPropertyValue('--shared-slot-width')).toBe('742px')
  await pointer('pointerdown', 500)
  await pointer('pointermove', 400)
  await tree.unmount()
  await frames.flush()
  expect(getFilePaneSession(state.appSessionId).width).toBe(742)
})
