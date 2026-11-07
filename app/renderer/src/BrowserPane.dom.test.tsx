import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
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
const state: BrowserPaneSnapshot = { appSessionId: 'browser-test', url: 'http://localhost:3000/profile', displayUrl: 'localhost:3000/profile', controller: 'agent', canGoBack: true, canGoForward: false, still: null }
beforeAll(async () => { harness = await createDomTestHarness(); bridge = window.catcode })
afterEach(async () => { await harness.unmountAll(); disposeFilePaneSession(state.appSessionId); reports = []; commands = [] })
afterAll(async () => { window.catcode = bridge; await harness.teardown() })
function setup() {
  window.catcode = { getFilePreviewApplications: async () => ({ applications: [], selected: 'default' }), refreshFilePreview: async () => null, subscribeFilePreview: () => () => {}, releaseFilePreview: () => {}, browserPaneCommand: async ({ command }: { command: string }) => { commands.push(command); return { ok: true } }, reportBrowserPaneLayout: (layout: BrowserPaneLayout) => reports.push(layout) } as unknown as Window['catcode']
  applyBrowserPaneEvent({ appSessionId: state.appSessionId, state })
}
test('approved file chrome has exactly five header actions and the touch takeover note', async () => {
  setup()
  const tree = await harness.mount(<BrowserPane state={state} active />)
  expect([...tree.container.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))).toEqual(['Back', 'Forward', 'Reload', 'Open in default browser', 'Close browser'])
  expect(tree.container.querySelector('.file-pane-path')?.textContent).toBe(state.displayUrl)
  expect(tree.container.querySelector('button[aria-label="Forward"]')?.hasAttribute('disabled')).toBe(true)
  for (const button of tree.container.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')) await act(async () => button.click())
  expect(commands).toEqual(['back', 'reload', 'external', 'close'])
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
test('browser coexists with file worker and output without losing shared width or stealing later selection', () => {
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
test('layout heartbeat reports host bounds, ignores the resize rail, detects overlays and still click takes over', async () => {
  setup()
  const tree = await harness.mount(<BrowserPane state={{ ...state, still: 'data:image/png;base64,AA==' }} active />)
  const host = tree.container.querySelector<HTMLElement>('.browser-pane-host')!
  host.getBoundingClientRect = () => ({ x: 10, y: 20, left: 10, top: 20, right: 510, bottom: 420, width: 500, height: 400, toJSON() {} })
  host.style.setProperty('--accent', '#bb3e84')
  const rail = document.createElement('div'); rail.className = 'subagent-shared-resize'; rail.style.position = 'absolute'
  rail.getBoundingClientRect = () => ({ x: 8, y: 20, left: 8, top: 20, right: 16, bottom: 420, width: 8, height: 400, toJSON() {} })
  document.body.append(rail)
  await act(async () => { window.dispatchEvent(new Event('resize')) })
  expect(reports.at(-1)).toMatchObject({ rect: { x: 10, y: 20, width: 500, height: 400 }, overlay: false })
  rail.remove()
  const overlay = document.createElement('div'); overlay.className = 'composer-popover'; overlay.style.position = 'fixed'
  overlay.getBoundingClientRect = () => ({ x: 50, y: 50, left: 50, top: 50, right: 150, bottom: 150, width: 100, height: 100, toJSON() {} })
  document.body.append(overlay)
  await act(async () => { window.dispatchEvent(new Event('resize')) })
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
  await act(async () => browser.click())
  expect(browser.getAttribute('aria-selected')).toBe('true')
  await tree.render(<div />)
  expect(reports.at(-1)?.rect).toBeNull()
  expect(getBrowserPaneSnapshot(state.appSessionId)).toEqual(state)
})
