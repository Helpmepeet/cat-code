import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CatCodeBridge, SessionId } from '../../shared/protocol.js'
import { sessionDescriptorFixture } from '../../shared/sessionDescriptor.fixture.js'
import { workspaceFileAvailability } from '../../main/workspaceFileAvailability.js'
import { FilePathActionsMenu } from './FilePathActionsMenu.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import type { FilePathActionsAnchor, FilePathMenuExtras } from './filePathActions.js'

let harness: DomTestHarness
let root: string
let workspace: string
let images: string
let previousBridge: PropertyDescriptor | undefined
const sessionId = 'file-menu-session'
const anchor: FilePathActionsAnchor = { type: 'pointer', x: 100, y: 150 }
const noop = () => {}

beforeAll(async () => {
  harness = await createDomTestHarness()
  root = mkdtempSync(join(tmpdir(), 'catcode-file-menu-'))
  workspace = join(root, 'workspace')
  images = join(root, 'generated-images')
  mkdirSync(workspace)
  mkdirSync(images)
  mkdirSync(join(workspace, 'folder'))
  writeFileSync(join(workspace, 'source.ts'), 'source')
  writeFileSync(join(images, 'image.png'), 'image')
  writeFileSync(join(root, 'outside.txt'), 'outside')
  symlinkSync(join(workspace, 'source.ts'), join(workspace, 'file-link'))
  symlinkSync(join(workspace, 'folder'), join(workspace, 'folder-link'))
  symlinkSync(join(root, 'outside.txt'), join(workspace, 'escape-link'))
})
beforeEach(() => { previousBridge = Object.getOwnPropertyDescriptor(window, 'catcode') })
afterEach(async () => {
  await harness.unmountAll()
  if (previousBridge) Object.defineProperty(window, 'catcode', previousBridge)
  else Reflect.deleteProperty(window, 'catcode')
})
afterAll(async () => {
  rmSync(root, { recursive: true, force: true })
  await harness.teardown()
})

function availability(id: SessionId, path: string): Promise<boolean> {
  return workspaceFileAvailability(
    { appSessionId: id, path },
    [sessionDescriptorFixture({ appSessionId: sessionId, cwd: workspace })],
    { generatedImagesRoot: images },
  )
}

function bridge(read: (id: SessionId, path: string) => Promise<boolean>, opened: unknown[] = []) {
  const pending: Promise<boolean>[] = []
  const api: Pick<CatCodeBridge, 'getWorkspaceFileAvailability' | 'openWorkspaceFile'> = {
    getWorkspaceFileAvailability: (id, path) => {
      const result = read(id, path)
      pending.push(result)
      return result
    },
    openWorkspaceFile: async (...args) => { opened.push(args); return true },
  }
  Object.defineProperty(window, 'catcode', { configurable: true, value: api })
  return async () => { await act(async () => { await Promise.all(pending) }) }
}

function menu(path: string, options: {
  sessionId?: SessionId
  cwd?: string
  anchor?: FilePathActionsAnchor
  extras?: FilePathMenuExtras
} = {}) {
  return createElement(FilePathActionsMenu, {
    anchor: options.anchor ?? anchor,
    rawPath: path,
    cwd: options.cwd ?? workspace,
    sessionId: options.sessionId ?? sessionId,
    extras: options.extras,
    onClose: noop,
  })
}

function hasOpen(container: HTMLElement): boolean {
  return [...container.querySelectorAll('[role="menuitem"]')]
    .some(item => item.textContent?.trim() === 'Open in')
}

function deferredRead() {
  const requests: Array<{
    id: SessionId
    path: string
    resolve: (available: boolean) => void
    reject: (error: Error) => void
  }> = []
  bridge((id, path) => new Promise((resolve, reject) => { requests.push({ id, path, resolve, reject }) }))
  return {
    requests,
    respond: async (index: number) => {
      const request = requests[index]!
      await act(async () => { request.resolve(await availability(request.id, request.path)) })
    },
  }
}

test('mounted file actions match real file, directory, symlink, and generated-image availability', async () => {
  const settle = bridge(availability)
  const observed: boolean[] = []
  for (const [path, extras] of [
    ['folder', undefined], ['folder-link', undefined],
    ['missing', undefined], ['escape-link', undefined],
    ['source.ts:42:3', undefined], ['file-link', undefined],
    [join(images, 'image.png'), { canOpen: true }],
    [join(root, 'outside.txt'), { canOpen: true }],
  ] as const) {
    const tree = await harness.mount(menu(path, { extras }))
    await settle()
    observed.push(hasOpen(tree.container))
    expect(tree.container.textContent).toContain('Copy')
    await tree.unmount()
  }
  expect(observed).toEqual([false, false, false, false, true, true, true, false])
})

test('pending and rejected availability keep Copy usable without offering Open', async () => {
  const read = deferredRead()
  const copied: string[] = []
  const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true, value: { writeText: async (text: string) => { copied.push(text) } },
  })
  try {
    const tree = await harness.mount(menu('folder'))
    expect(hasOpen(tree.container)).toBe(false)
    const copy = tree.container.querySelector<HTMLElement>('[role="menuitem"]')!
    await act(async () => { copy.click() })
    expect(copied).toEqual([join(workspace, 'folder')])
    await act(async () => { read.requests[0]!.reject(new Error('bridge unavailable')) })
    expect(hasOpen(tree.container)).toBe(false)
  } finally {
    if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

test('path, session, workspace, and menu changes suppress stale availability replies', async () => {
  const read = deferredRead()
  const tree = await harness.mount(menu('source.ts'))
  expect(hasOpen(tree.container)).toBe(false)
  await tree.render(menu('folder'))
  await read.respond(1)
  await read.respond(0)
  expect(hasOpen(tree.container)).toBe(false)

  await tree.render(menu('source.ts'))
  await read.respond(2)
  expect(hasOpen(tree.container)).toBe(true)
  await tree.render(menu('source.ts', { sessionId: 'unknown-session' }))
  expect(hasOpen(tree.container)).toBe(false)
  await read.respond(3)
  expect(hasOpen(tree.container)).toBe(false)

  await tree.render(menu('source.ts'))
  await read.respond(4)
  expect(hasOpen(tree.container)).toBe(true)
  await tree.render(menu('source.ts', { cwd: join(root, 'moved-workspace') }))
  expect(hasOpen(tree.container)).toBe(false)
  await tree.render(menu('source.ts', { anchor: { type: 'pointer', x: 120, y: 150 } }))
  await read.respond(5)
  expect(hasOpen(tree.container)).toBe(false)
  await read.respond(6)
  expect(hasOpen(tree.container)).toBe(true)

  await tree.render(menu('source.ts', { anchor: { type: 'pointer', x: 130, y: 150 } }))
  await tree.unmount()
  const reopened = await harness.mount(menu('folder'))
  await read.respond(7)
  expect(hasOpen(reopened.container)).toBe(false)
  await read.respond(8)
  expect(hasOpen(reopened.container)).toBe(false)

  await reopened.render(menu('folder', { anchor: { type: 'pointer', x: 140, y: 150 } }))
  await reopened.render(menu('source.ts'))
  await read.respond(10)
  expect(hasOpen(reopened.container)).toBe(true)
  await read.respond(9)
  expect(hasOpen(reopened.container)).toBe(true)

  await reopened.render(menu('folder'))
  await reopened.render(menu('source.ts'))
  expect(hasOpen(reopened.container)).toBe(false)
  await read.respond(12)
  expect(hasOpen(reopened.container)).toBe(true)
  await read.respond(11)
  expect(hasOpen(reopened.container)).toBe(true)
})

test('accepted availability offers Finder and editors for the unchanged raw citation', async () => {
  const opened: unknown[] = []
  const settle = bridge(availability, opened)
  const tree = await harness.mount(menu('source.ts:42:3'))
  await settle()
  const open = [...tree.container.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(item => item.textContent?.trim() === 'Open in')!
  await act(async () => {
    open.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
  })
  const items = [...tree.container.querySelectorAll<HTMLButtonElement>('[role="menu"][aria-label="Open in"] button')]
  expect(items).toHaveLength(5)
  const finder = items.find(item => /Finder|file manager/.test(item.textContent ?? ''))!
  await act(async () => { finder.click() })
  expect(opened).toEqual([[sessionId, 'source.ts:42:3', 'finder']])
})
