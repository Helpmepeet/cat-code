import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import { ExternalAppIcon } from './ExternalAppIcon.js'
import { SessionActionIcon } from './SessionActionIcons.js'
import { FilePathActionsMenu } from './FilePathActionsMenu.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'

let harness: DomTestHarness
let original: PropertyDescriptor | undefined
const png = 'data:image/png;base64,aWNvbg=='
beforeAll(async () => {
  harness = await createDomTestHarness()
  original = Object.getOwnPropertyDescriptor(window, 'catcode')
})
afterEach(async () => {
  await harness.unmountAll()
  if (original) Object.defineProperty(window, 'catcode', original)
  else Reflect.deleteProperty(window, 'catcode')
})
afterAll(async () => { await harness.teardown() })

function bridge(read: (request: unknown) => Promise<{ dataUrl: string | null }>) {
  Object.defineProperty(window, 'catcode', { configurable: true, value: { getExternalAppIcon: read } })
}

test('host PNG renders without adding a control or an accessible label', async () => {
  const requests: unknown[] = []
  bridge(async request => { requests.push(request); return { dataUrl: png } })
  const tree = await harness.mount(createElement(ExternalAppIcon, { request: { target: 'browser' } }))
  expect(requests).toEqual([{ target: 'browser' }])
  const img = tree.container.querySelector('img')!
  expect(img.getAttribute('src')).toBe(png)
  expect(img.alt).toBe('')
  expect(img.closest('[aria-hidden="true"]')).not.toBeNull()
  expect(tree.container.querySelector('button,a')).toBeNull()
})

test('missing apps, rejected reads and broken images retain a recognizable glyph', async () => {
  bridge(async () => ({ dataUrl: null }))
  const tree = await harness.mount(createElement(ExternalAppIcon, { request: { target: 'zed' } }))
  expect(tree.container.querySelector('svg')).not.toBeNull()
  bridge(async () => { throw new Error('offline') })
  await tree.render(createElement(ExternalAppIcon, { request: { target: 'cursor' } }))
  expect(tree.container.querySelector('svg')).not.toBeNull()
  bridge(async () => ({ dataUrl: png }))
  await tree.render(createElement(ExternalAppIcon, { request: { target: 'finder' } }))
  await act(async () => { tree.container.querySelector('img')!.dispatchEvent(new Event('error')) })
  expect(tree.container.querySelector('img')).toBeNull()
  expect(tree.container.querySelector('svg')).not.toBeNull()
})

test('late file association replies cannot replace the newly selected file icon', async () => {
  let resolveFirst!: (value: { dataUrl: string | null }) => void
  bridge(async request => (request as { path: string }).path === 'first.ts'
    ? new Promise(resolve => { resolveFirst = resolve }) : { dataUrl: null })
  const tree = await harness.mount(createElement(ExternalAppIcon, { request: { target: 'default', appSessionId: 'one', path: 'first.ts' } }))
  await tree.render(createElement(ExternalAppIcon, { request: { target: 'default', appSessionId: 'two', path: 'second.png' } }))
  await act(async () => { resolveFirst({ dataUrl: png }) })
  expect(tree.container.querySelector('img')).toBeNull()
})

test('chat folder action uses host file manager imagery rather than a launch glyph', async () => {
  bridge(async () => ({ dataUrl: png }))
  const tree = await harness.mount(createElement(SessionActionIcon, { kind: 'open-chat-folder' }))
  expect(tree.container.querySelector('[data-app-target="finder"] img')).not.toBeNull()
})

test('file menu requests each destination icon and keeps the original open target', async () => {
  const requests: unknown[] = []
  const opened: unknown[] = []
  Object.defineProperty(window, 'catcode', { configurable: true, value: {
    getExternalAppIcon: async (request: unknown) => { requests.push(request); return { dataUrl: png } },
    getWorkspaceFileAvailability: async () => true,
    openWorkspaceFile: async (...args: unknown[]) => { opened.push(args); return true },
  } })
  const tree = await harness.mount(createElement(FilePathActionsMenu, {
    sessionId: 'session', rawPath: 'source.ts:12', cwd: '/workspace',
    anchor: { type: 'pointer', x: 50, y: 100 }, onClose: () => {},
  }))
  const open = [...tree.container.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(item => item.textContent?.trim() === 'Open in')!
  await act(async () => {
    open.focus()
    open.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  })
  expect(requests).toEqual([
    { target: 'default', appSessionId: 'session', path: 'source.ts:12' },
    { target: 'vscode' }, { target: 'zed' }, { target: 'cursor' }, { target: 'finder' },
  ])
  expect(tree.container.querySelectorAll('.external-app-icon img')).toHaveLength(5)
  const vscode = [...tree.container.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')]
    .find(item => item.textContent?.trim() === 'Visual Studio Code')!
  await act(async () => { vscode.click() })
  expect(opened).toEqual([['session', 'source.ts:12', 'vscode']])
})
