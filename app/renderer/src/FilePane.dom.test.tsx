import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workspaceFileAvailability } from '../../main/workspaceFileAvailability.js'
import { openWorkspaceFile } from '../../main/openWorkspaceFile.js'
import { createPreviewApplications } from '../../main/previewApplications.js'
import { createLocalhostPreviewService, type LocalhostFrozenPayload } from '../../main/localhostPreview.js'
import { normalizeLocalhostPreviewUrl } from '../../shared/filePreview.js'
import { createFilePreviewService } from '../../main/filePreview.js'
import { sessionDescriptorFixture } from '../../shared/sessionDescriptor.fixture.js'
import type { FilePreviewEvent } from '../../shared/filePreview.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { SubagentWorkspace } from './SubagentWorkspace.js'
import { TranscriptRowsView } from './TranscriptView.js'
import { ToolsExpandedContext } from './toolsExpanded.js'
import { ToastContext } from './toastContext.js'
import { captureFilePaneScroll, closeFilePane, disposeFilePaneSession, getFilePaneSession, rememberFilePaneScroll, requestOpenFile } from './filePaneState.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'

const NativeResponse = globalThis.Response
const nativeFetch = globalThis.fetch.bind(globalThis)
let harness: DomTestHarness
const originalConsoleError = console.error
const releases: Array<() => void> = []
beforeAll(async () => {
  harness = await createDomTestHarness()
  // Electron owns the custom protocol. Frame loads are driven explicitly here.
  const dom = window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }
  dom.happyDOM.settings.disableIframePageLoading = true
  console.error = (...args: unknown[]) => {
    const error = args[0]
    if (error instanceof Error && error.message.startsWith('Failed to load iframe page "') && error.message.endsWith('Iframe page loading is disabled.')) return
    originalConsoleError(...args)
  }
})
afterEach(async () => {
  await harness.unmountAll()
  for (const release of releases.splice(0)) release()
  window.localStorage.clear()
})
afterAll(async () => { console.error = originalConsoleError; await harness.teardown() })

async function settle() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 130)) })
  await act(async () => { await harness.nextFrame(); await harness.nextFrame() })
}
async function click(root: ParentNode, label: string) {
  const button = root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  expect(button, `Missing ${label}: ${[...root.querySelectorAll('a,button')].map(node => node.outerHTML).join('\n')}`).not.toBeNull()
  await act(async () => { button!.click(); await new Promise(resolve => setTimeout(resolve, 70)) })
  await settle()
}
function setup(withOutput = false, local?: { url: string; snapshots?: Map<string, LocalhostFrozenPayload> }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cat-file-pane-dom-')))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'cat-file-pane-outside-')))
  const refusedPath = join(outside, 'outside.md')
  writeFileSync(refusedPath, '# Existing outside workspace')
  const sessionId = randomUUID()
  const otherSession = randomUUID()
  const firstPath = join(root, 'notes.md')
  const secondPath = join(root, 'second.markdown')
  const imagePath = join(root, 'image.png')
  const badImagePath = join(root, 'broken.png')
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=', 'base64')
  writeFileSync(imagePath, imageBytes)
  writeFileSync(badImagePath, Buffer.alloc(0))
  const brokenPath = join(root, 'broken.html')
  writeFileSync(brokenPath, '<!doctype html><link rel="stylesheet" href="oversized.css"><p>Unreadable stylesheet</p>')
  const missingAssetPath = join(root, 'missing-asset.html')
  writeFileSync(missingAssetPath, '<!doctype html><link rel="stylesheet" href="missing.css"><p>Missing stylesheet still paints</p>')
  writeFileSync(firstPath, '# Actual disk notes\n\n[Next document](second.markdown)')
  writeFileSync(secondPath, '# Actual second document\n\nAnother page.')
  const events = new Set<(event: FilePreviewEvent) => void>()
  const external: Array<{ path: string; target?: string; location?: unknown }> = []
  const sessions = [sessionDescriptorFixture({ appSessionId: sessionId, cwd: root }), sessionDescriptorFixture({ appSessionId: otherSession, cwd: root })]
  const publish = (event: FilePreviewEvent) => { events.forEach(callback => callback(event)) }
  const service = createFilePreviewService({ sessions: () => sessions, publish })
  const localhost = createLocalhostPreviewService({ sessions: () => sessions, publish,
    isLive: id => !!document.querySelector(`iframe[name*="${id}"]`), findSnapshot: () => [...local?.snapshots?.values() ?? []].at(-1) ?? null, getSnapshot: id => local?.snapshots?.get(id) ?? null })
  const captures: Array<{ id: string; connected: boolean }> = []
  let captureGate: Promise<void> | null = null
  const pauseNextCapture = () => {
    let resume!: () => void
    captureGate = new Promise<void>(resolve => { resume = resolve })
    return resume
  }
  const positions = new Map<string, { x: number; y: number }>()
  const currentDescriptor = (id: string, revision: number) => localhost.descriptor(id, revision) ?? service.descriptor(id, revision)
  const releasePreview = (id: string) => { if (localhost.has(id)) localhost.release(id); else service.release(id) }
  const refreshPreview = (id: string) => localhost.has(id) ? localhost.refresh(id) : service.refresh(id)
  const applicationsFor = (appSessionId: string, path: string) => normalizeLocalhostPreviewUrl(path)
    ? Promise.resolve({ applications: [{ target: 'chrome' as const, label: 'Google Chrome' }, { target: 'safari' as const, label: 'Safari' }], selected: 'chrome' as const })
    : applications.list({ appSessionId, path })
  const applications = createPreviewApplications({
    sessions: () => sessions, userData: root, installed: async () => true,
    open: async (path, target) => { external.push({ path, target }); return true },
  })
  const previous = Object.getOwnPropertyDescriptor(window, 'catcode')
  const ids = new Set<string>()
  const commitGates: Array<{ before: boolean; reached: () => void; waiting: Promise<void> }> = []
  const pauseNextCommit = (before = false) => {
    let reached!: () => void
    let resume!: () => void
    const reachedPromise = new Promise<void>(resolve => { reached = resolve })
    const waiting = new Promise<void>(resolve => { resume = resolve })
    commitGates.push({ before, reached, waiting })
    return { reached: reachedPromise, resume }
  }
  let prepareGate: Promise<void> | null = null
  const pauseNextPrepare = () => {
    let resume!: () => void
    prepareGate = new Promise<void>(resolve => { resume = resolve })
    return resume
  }
  Object.defineProperty(window, 'catcode', { configurable: true, value: {
    prepareFilePreview: async (appSessionId: string, path: string) => {
      const gate = prepareGate
      prepareGate = null
      if (gate) await gate
      const descriptor = await service.prepare({ appSessionId, path })
      if (descriptor) ids.add(descriptor.id)
      return descriptor
    },
    openWorkspaceFile: (appSessionId: string, path: string) => openWorkspaceFile({ appSessionId, path }, sessions, async (resolved, target, location) => { external.push({ path: resolved, target, ...(location ? { location } : {}) }); return true }),
    prepareLocalhostPreview: (appSessionId: string, url: string) => localhost.prepare({ appSessionId, url }),
    captureLocalhostPreview: async (id: string) => {
      captures.push({ id, connected: !!document.querySelector(`iframe[name*="${id}"]`) })
      const waiting = captureGate
      captureGate = null
      if (waiting) await waiting
    },
    navigateLocalhostPreview: async (id: string, key: string, scroll: { x: number; y: number }) => {
      if (!localhost.routeFor(id, key)) return null
      const descriptor = localhost.restoreRoute(id, key)
      if (descriptor) positions.set(`${id}:${descriptor.revision}`, scroll)
      return descriptor
    },
    openBlockedPreviewNavigation: async (id: string, target: string) => {
      const url = localhost.blockedUrl(id)
      if (!url) return false
      external.push({ path: url, target }); localhost.clearBlocked(id); return true
    },
    readFilePreviewScroll: async (id: string, revision: number) => positions.get(`${id}:${revision}`) ?? { x: 0, y: 0 },
    restoreFilePreviewScroll: async (id: string, revision: number, scroll: { x: number; y: number }) => { positions.set(`${id}:${revision}`, scroll) },
    getWorkspaceFileAvailability: (appSessionId: string, path: string) => workspaceFileAvailability({ appSessionId, path }, sessions),
    refreshFilePreview: refreshPreview,
    commitFilePreview: async (id: string, revision: number) => {
      const gate = commitGates.shift()
      if (gate?.before) { gate.reached(); await gate.waiting }
      const committed = localhost.has(id) ? localhost.commit(id, revision) : service.commit(id, revision)
      if (gate && !gate.before) { gate.reached(); await gate.waiting }
      return committed
    },
    releaseFilePreview: releasePreview,
    subscribeFilePreview: (listener: (event: FilePreviewEvent) => void) => { events.add(listener); return () => events.delete(listener) },
    getFilePreviewApplications: applicationsFor,
    chooseFilePreviewApplication: (appSessionId: string, path: string, target: string) => {
      const url = normalizeLocalhostPreviewUrl(path)
      if (url) { external.push({ path: url, target }); return Promise.resolve(true) }
      return applications.choose({ appSessionId, path, target })
    },
    getExternalAppIcon: async () => null,
  } })
  releases.push(() => {
    closeFilePane(sessionId); closeFilePane(otherSession)
    ids.forEach(id => service.release(id)); localhost.dispose()
    if (previous) Object.defineProperty(window, 'catcode', previous)
    else Reflect.deleteProperty(window, 'catcode')
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })
  const row: NestedTranscriptRow = {
    id: 'reply', sessionId, frameId: 'f', messageId: 'm', blockIndex: 0,
    parentToolUseId: null, kind: 'assistant-text', role: 'assistant', children: [],
    content: `[Notes](notes.md:12) [Second](second.markdown) [Refused](${refusedPath}) [Broken](broken.html) [Missing asset](missing-asset.html) [Image](image.png) [Bad image](broken.png)${local ? ` [Server](${local.url})` : ''}`,
  }
  const rows: NestedTranscriptRow[] = [row]
  if (withOutput) rows.push({
    id: 'long-output', sessionId, frameId: 'out-frame', messageId: 'out-message', blockIndex: 0,
    parentToolUseId: null, kind: 'tool-use', toolUseId: 'long-output', toolName: 'Bash', toolFamily: 'bash',
    input: { command: 'preview-scroll-output' }, status: 'success', agentCompletion: null, children: [],
    result: { content: Array.from({ length: 900 }, (_, index) => `output line ${index}`).join('\n'), isError: false, diff: null },
  })
  if (local) writeFileSync(firstPath, `# Actual disk notes\n\n[Next document](second.markdown) [Local app](${local.url})`)
  const toasts: string[] = []
  const pane = (id = sessionId) => <ToastContext.Provider value={message => { toasts.push(message) }}>
    <ToolsExpandedContext.Provider value={{ expanded: true, setExpanded: () => {} }}><SubagentWorkspace key={id} appSessionId={id}
      onFocusComposer={() => document.querySelector<HTMLInputElement>('[aria-label="Composer"]')?.focus({ preventScroll: true })}
      dock={{ active: [], finished: [], chipFaces: [], nextUpdateAt: null }} collapsed onCollapsedChange={() => {}}
      onClearFinished={() => {}} onDetailsVisibleChange={() => {}} onFallback={() => {}} onOpenWorkers={() => {}}
      rows={id === sessionId ? rows : []} cwd={root}>
      <main className="session-pane"><section className="session-transcript-region"><TranscriptRowsView rows={id === sessionId ? rows : []} cwd={root} /></section><input aria-label="Composer" /></main>
    </SubagentWorkspace></ToolsExpandedContext.Provider>
  </ToastContext.Provider>
  return { pane, sessionId, firstPath, secondPath, imagePath, imageBytes, badImagePath, brokenPath, missingAssetPath, refusedPath, otherSession, toasts, service, pauseNextPrepare, pauseNextCommit, pauseNextCapture, captures, localhost, currentDescriptor, ids, external }
}

test('a reply click crosses the real host file boundary before rendering, keeps composer focus, and refuses outside files', async () => {
  const { pane, sessionId, firstPath, refusedPath, toasts } = setup()
  const tree = await harness.mount(pane())
  expect(tree.container.querySelector('.file-pane')).toBeNull()
  await click(tree.container, 'Open ./notes.md:12')
  const paneElement = tree.container.querySelector('.file-pane')!
  expect(paneElement).not.toBeNull()
  expect(paneElement.querySelector('.file-pane-markdown:not(.file-pane-staging)')?.textContent).toContain('Actual disk notes')
  expect(paneElement.querySelector('.file-pane-path')?.getAttribute('title')).toBe(firstPath)
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Composer')
  const body = paneElement.querySelector('.file-pane-markdown:not(.file-pane-staging)')!
  await click(tree.container, 'Open ./notes.md:12')
  expect(paneElement.querySelector('.file-pane-markdown:not(.file-pane-staging)')).toBe(body)
  await click(tree.container, `Open ${refusedPath}`)
  expect(toasts).toEqual(['Could not open this file'])
  expect(getFilePaneSession(sessionId).file?.path).toBe(firstPath)
  expect(tree.container.querySelectorAll('.subagent-shared-slot')).toHaveLength(1)
})

test('file history restores scroll and session switches preserve file and width without retaining live pages', async () => {
  const { pane, sessionId, firstPath, secondPath, otherSession } = setup()
  const tree = await harness.mount(pane())
  await click(tree.container, 'Open ./notes.md:12')
  const scroller = tree.container.querySelector<HTMLElement>('.file-pane-markdown:not(.file-pane-staging)')!
  await act(async () => { scroller.scrollTop = 180; scroller.dispatchEvent(new Event('scroll', { bubbles: true })) })
  const slot = tree.container.querySelector<HTMLElement>('.subagent-shared-slot')!
  await act(async () => { slot.querySelector('[role="separator"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })) })
  const width = slot.style.getPropertyValue('--shared-slot-width')
  await click(tree.container, 'Open second.markdown')
  expect(getFilePaneSession(sessionId).file?.path).toBe(secondPath)
  expect(slot.style.getPropertyValue('--shared-slot-width')).toBe(width)
  await click(tree.container, 'Back')
  expect(getFilePaneSession(sessionId).file?.path).toBe(firstPath)
  expect(tree.container.querySelector<HTMLElement>('.file-pane-markdown:not(.file-pane-staging)')?.scrollTop).toBe(180)
  await tree.render(pane(otherSession))
  expect(tree.container.querySelector('.file-pane')).toBeNull()
  await tree.render(pane())
  await settle()
  expect(tree.container.querySelector('.file-pane-path')?.getAttribute('title')).toBe(firstPath)
  expect(tree.container.querySelector<HTMLElement>('.file-pane-markdown:not(.file-pane-staging)')?.scrollTop).toBe(180)
  expect(tree.container.querySelector<HTMLElement>('.subagent-shared-slot')?.style.getPropertyValue('--shared-slot-width')).toBe(width)
  await click(tree.container, 'Close file')
  expect(getFilePaneSession(sessionId).history).toEqual([])
  expect(getFilePaneSession(sessionId).forward).toEqual([])
})

test('a watched file stages new bytes while removal keeps the last rendered version and recovers', async () => {
  const { pane, sessionId, firstPath, service } = setup()
  const tree = await harness.mount(pane())
  await click(tree.container, 'Open ./notes.md:12')
  const id = getFilePaneSession(sessionId).file!.id
  writeFileSync(firstPath, '# Revised disk notes')
  await act(async () => { await service.refresh(id) })
  await settle()
  expect(tree.container.querySelector('.file-pane-markdown:not(.file-pane-staging)')?.textContent).toContain('Revised disk notes')
  rmSync(firstPath)
  await act(async () => { await service.refresh(id) })
  expect(tree.container.querySelector('.file-pane-note')?.textContent).toBe('notes.md was removed. Showing the last version.')
  expect(tree.container.querySelector('.file-pane-markdown:not(.file-pane-staging)')?.textContent).toContain('Revised disk notes')
  writeFileSync(firstPath, '# Returned file')
  await act(async () => { await service.refresh(id) })
  await settle()
  expect(tree.container.querySelector('.file-pane-note')).toBeNull()
  expect(tree.container.querySelector('.file-pane-markdown:not(.file-pane-staging)')?.textContent).toContain('Returned file')
})


test('closing during an in-flight history request cannot reopen the pane or retain its host capability', async () => {
  const { pane, sessionId, pauseNextPrepare, service, ids } = setup()
  const tree = await harness.mount(pane())
  await click(tree.container, 'Open ./notes.md:12')
  await click(tree.container, 'Open second.markdown')
  const resume = pauseNextPrepare()
  await act(async () => { tree.container.querySelector<HTMLButtonElement>('[aria-label="Back"]')!.click() })
  await click(tree.container, 'Close file')
  await act(async () => { resume(); await new Promise(resolve => setTimeout(resolve, 100)) })
  await settle()
  expect(tree.container.querySelector('.file-pane')).toBeNull()
  expect(getFilePaneSession(sessionId).open).toBe(false)
  expect([...ids].filter(id => service.has(id))).toEqual([])
})


test('unreadable real local assets reject an initial paint and roll a later navigation back to its last good file', async () => {
  const { pane, sessionId, firstPath, brokenPath, service, toasts } = setup()
  // The asset exists, but exceeds the host's 16 MiB per-file read limit.
  writeFileSync(join(brokenPath, '..', 'oversized.css'), Buffer.alloc(16 * 1024 * 1024 + 1))
  const tree = await harness.mount(pane())
  const failStagedPage = async () => {
    const file = getFilePaneSession(sessionId).file!
    // Happy DOM has no protocol transport. Drive the actual host request that
    // Electron makes for this page's stylesheet, then the frame's load event.
    const response = await service.respond(new Request(new URL('oversized.css', file.url)))
    expect(response.status).toBe(404)
    expect(service.absentPaths(file.id, file.revision)).toEqual([])
    await act(async () => { tree.container.querySelector('iframe.file-pane-staging')!.dispatchEvent(new Event('load')) })
    await settle()
  }
  await click(tree.container, 'Open broken.html')
  await failStagedPage()
  expect(tree.container.querySelector('.file-pane')).toBeNull()
  expect(getFilePaneSession(sessionId).open).toBe(false)
  await click(tree.container, 'Open ./notes.md:12')
  const goodBody = tree.container.querySelector('.file-pane-markdown:not(.file-pane-staging)')!
  await click(tree.container, 'Open broken.html')
  await failStagedPage()
  expect(tree.container.querySelector('.file-pane-path')?.getAttribute('title')).toBe(firstPath)
  expect(tree.container.querySelector('.file-pane-markdown:not(.file-pane-staging)') === goodBody).toBe(true)
  expect(getFilePaneSession(sessionId).history).toEqual([])
  expect(getFilePaneSession(sessionId).forward).toEqual([])
  expect(toasts).toEqual(['Could not open this file', 'Could not open this file'])
})


test('a missing real local asset permits both an initial paint and navigation from a good file', async () => {
  const { pane, sessionId, firstPath, missingAssetPath, service, toasts } = setup()
  const tree = await harness.mount(pane())
  const paintMissingAssetPage = async () => {
    const file = getFilePaneSession(sessionId).file!
    // Happy DOM has no protocol transport, so request the stylesheet before load.
    const response = await service.respond(new Request(new URL('missing.css', file.url)))
    expect(response.status).toBe(403)
    expect(service.absentPaths(file.id, file.revision)).toEqual([new URL('missing.css', file.url).pathname])
    await paintLocalFrame(tree.container)
    expect(getFilePaneSession(sessionId).committedFile?.path).toBe(missingAssetPath)
    expect(tree.container.querySelector('.file-pane-path')?.getAttribute('title')).toBe(missingAssetPath)
  }
  await click(tree.container, 'Open missing-asset.html')
  await paintMissingAssetPage()
  expect(getFilePaneSession(sessionId).history).toEqual([])
  await click(tree.container, 'Open ./notes.md:12')
  await click(tree.container, 'Open missing-asset.html')
  await paintMissingAssetPage()
  expect(getFilePaneSession(sessionId).history.map(entry => entry.path)).toEqual([missingAssetPath, firstPath])
  expect(getFilePaneSession(sessionId).forward).toEqual([])
  expect(toasts).toEqual([])
})


test('a retained file removal survives a failed different-file candidate without changing its pending note', async () => {
  const { pane, sessionId, firstPath, service } = setup()
  const tree = await harness.mount(pane())
  await click(tree.container, 'Open ./notes.md:12')
  const retained = getFilePaneSession(sessionId).file!
  const body = tree.container.querySelector('.file-pane-markdown:not(.file-pane-staging)')!
  await click(tree.container, 'Open broken.png')
  rmSync(firstPath)
  await act(async () => { await service.refresh(retained.id) })
  expect(tree.container.querySelector('.file-pane-path')?.getAttribute('title')).not.toBe(firstPath)
  expect(tree.container.querySelector('.file-pane-note')).toBeNull()
  await act(async () => { tree.container.querySelector('.file-pane-staging.file-pane-image img')!.dispatchEvent(new Event('error')) })
  await settle()
  expect(tree.container.querySelector('.file-pane-path')?.getAttribute('title')).toBe(firstPath)
  expect(tree.container.querySelector('.file-pane-markdown:not(.file-pane-staging)')).toBe(body)
  expect(tree.container.querySelector('.file-pane-note')?.textContent).toBe('notes.md was removed. Showing the last version.')
})


test('confirmed session disposal releases its page and late scroll cleanup cannot restore session state', async () => {
  const { pane, sessionId, service, ids } = setup()
  const tree = await harness.mount(pane())
  await click(tree.container, 'Open ./notes.md:12')
  await act(async () => {
    const capturing = captureFilePaneScroll(sessionId)
    disposeFilePaneSession(sessionId)
    await capturing
  })
  await tree.unmount()
  expect(getFilePaneSession(sessionId).file).toBeNull()
  expect(getFilePaneSession(sessionId).lastPath).toBeNull()
  expect(getFilePaneSession(sessionId).visible).toBeNull()
  expect([...ids].filter(id => service.has(id))).toEqual([])
})


test('Cmd-click opens the resolved whole file in the chosen app without forwarding a source coordinate', async () => {
  const { pane, firstPath, secondPath, external } = setup()
  const tree = await harness.mount(pane())
  await act(async () => {
    tree.container.querySelector('[aria-label="Open ./notes.md:12"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }))
    await new Promise(resolve => setTimeout(resolve, 80))
  })
  expect(external).toEqual([{ path: firstPath, target: 'default' }])
  expect(tree.container.querySelector('.file-pane')).toBeNull()
  await click(tree.container, 'Open ./notes.md:12')
  await act(async () => {
    tree.container.querySelector('.file-pane-markdown-link')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }))
    await new Promise(resolve => setTimeout(resolve, 80))
  })
  expect(external.at(-1)).toEqual({ path: secondPath, target: 'default' })
  expect(tree.container.querySelector('.file-pane-path')?.getAttribute('title')).toBe(firstPath)
})


test('image decode errors reject a corrupt initial file and retain a good image during a corrupt live update', async () => {
  const { pane, sessionId, imagePath, imageBytes, service, toasts } = setup()
  const tree = await harness.mount(pane())
  const signalImage = async (event: 'load' | 'error') => {
    const image = tree.container.querySelector('.file-pane-staging.file-pane-image img')
    expect(image).not.toBeNull()
    // Happy DOM cannot decode pixels. These are Chromium's real element events;
    // file preparation, revisions and retained bytes use the actual host service.
    await act(async () => { image!.dispatchEvent(new Event(event)) })
    await settle()
  }
  await click(tree.container, 'Open broken.png')
  await signalImage('error')
  expect(tree.container.querySelector('.file-pane')).toBeNull()
  expect(toasts).toEqual(['Could not open this file'])

  await click(tree.container, 'Open image.png')
  await signalImage('load')
  const goodImage = tree.container.querySelector('.file-pane-image:not(.file-pane-staging) img')!
  expect(goodImage).not.toBeNull()
  const id = getFilePaneSession(sessionId).file!.id
  writeFileSync(imagePath, Buffer.alloc(0))
  await act(async () => { await service.refresh(id) })
  await signalImage('error')
  expect(tree.container.querySelector('.file-pane-image:not(.file-pane-staging) img') === goodImage).toBe(true)
  expect(tree.container.querySelector('.file-pane-note')?.textContent).toBe('Could not update this file. Showing the last version.')

  writeFileSync(imagePath, imageBytes)
  await act(async () => { await service.refresh(id) })
  await signalImage('load')
  expect(tree.container.querySelector('.file-pane-note')).toBeNull()
  expect(tree.container.querySelector('.file-pane-image:not(.file-pane-staging) img')).not.toBeNull()
})


test('capturing a Markdown file hidden behind real full output retains its semantic bookmark', async () => {
  const { pane, sessionId } = setup(true)
  const tree = await harness.mount(pane())
  await click(tree.container, 'Open ./notes.md:12')
  const leafId = tree.container.querySelector<HTMLElement>('.file-pane-markdown:not(.file-pane-staging) [data-markdown-unit]')!.dataset.markdownUnit!
  const bookmark = { x: 0, y: 180, markdown: { leafId, offset: 12 } }
  rememberFilePaneScroll(sessionId, bookmark)
  const output = [...tree.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.startsWith('Open full output'))!
  expect(output).toBeDefined()
  await act(async () => { output.click() })
  expect(tree.container.querySelector('.file-pane')?.closest<HTMLElement>('.subagent-slot-content')?.hidden).toBe(true)
  await act(async () => { await captureFilePaneScroll(sessionId) })
  // No layout is supplied here. A hidden node must preserve its known bookmark,
  // while the native gate separately checks capture and restoration on screen.
  expect(getFilePaneSession(sessionId).scroll).toEqual(bookmark)
})


test('Escape dismisses the header file menu without closing its pane, while Escape in the page still closes it', async () => {
  const { pane, sessionId, firstPath } = setup()
  const tree = await harness.mount(pane())
  await click(tree.container, 'Open ./notes.md:12')
  const body = tree.container.querySelector<HTMLElement>('.file-pane-markdown:not(.file-pane-staging)')!
  const path = tree.container.querySelector<HTMLElement>('.file-pane-path')!
  path.focus()
  await act(async () => { path.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 100 })) })
  await settle()
  const menu = tree.container.querySelector<HTMLElement>('[role="menu"][aria-label="File actions for notes.md"]')!
  expect(menu).not.toBeNull()
  expect(menu.textContent).toContain('Copy')
  expect(menu.textContent).toContain('Open in')
  expect(menu.contains(document.activeElement)).toBe(true)
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
  expect(tree.container.querySelector('[role="menu"][aria-label="File actions for notes.md"]')).toBeNull()
  expect(getFilePaneSession(sessionId).open).toBe(true)
  expect(tree.container.querySelector('.file-pane-path')?.getAttribute('title')).toBe(firstPath)
  expect(tree.container.querySelector('.file-pane-markdown:not(.file-pane-staging)') === body).toBe(true)
  body.focus()
  await act(async () => { body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
  expect(getFilePaneSession(sessionId).open).toBe(false)
})


test('a committed revision remains paintable when a newer update arrives before its commit reply', async () => {
  const { pane, sessionId, firstPath, service, pauseNextCommit } = setup()
  const tree = await harness.mount(pane())
  await click(tree.container, 'Open ./notes.md:12')
  const id = getFilePaneSession(sessionId).file!.id
  const intermediate = pauseNextCommit()
  const newer = pauseNextCommit(true)
  try {
    writeFileSync(firstPath, '# Intermediate committed version')
    await act(async () => { await service.refresh(id) })
    await act(async () => { await intermediate.reached })
    const committedRevision = getFilePaneSession(sessionId).file!.revision
    const intermediateBody = tree.container.querySelector('.file-pane-staging.file-pane-markdown')!
    writeFileSync(firstPath, '# Newest staged version')
    await act(async () => { await service.refresh(id) })
    const newestRevision = getFilePaneSession(sessionId).file!.revision
    expect(newestRevision).toBeGreaterThan(committedRevision)
    expect(tree.container.querySelector('.file-pane-staging.file-pane-markdown') === intermediateBody).toBe(true)
    await act(async () => { intermediate.resume() })
    await settle()
    await act(async () => { await newer.reached })
    const state = getFilePaneSession(sessionId)
    expect(state.file?.revision).toBe(newestRevision)
    expect(state.committedFile?.revision).toBe(committedRevision)
    expect(service.descriptor(id, state.committedFile!.revision)).not.toBeNull()
    expect(tree.container.querySelector('.file-pane-markdown:not(.file-pane-staging)') === intermediateBody).toBe(true)
    expect(tree.container.querySelector('.file-pane-markdown:not(.file-pane-staging)')?.textContent).toContain('Intermediate committed version')
  } finally {
    intermediate.resume(); newer.resume()
    await settle()
  }
})


test('a delayed successful update cannot replace a newer different-file navigation', async () => {
  const { pane, sessionId, firstPath, secondPath, service, pauseNextCommit } = setup()
  const tree = await harness.mount(pane())
  await click(tree.container, 'Open ./notes.md:12')
  const id = getFilePaneSession(sessionId).file!.id
  const delayed = pauseNextCommit()
  try {
    writeFileSync(firstPath, '# Delayed earlier file')
    await act(async () => { await service.refresh(id) })
    await act(async () => { await delayed.reached })
    await click(tree.container, 'Open second.markdown')
    const newerBody = tree.container.querySelector('.file-pane-markdown:not(.file-pane-staging)')!
    await act(async () => { delayed.resume() })
    await settle()
    expect(getFilePaneSession(sessionId).file?.path).toBe(secondPath)
    expect(getFilePaneSession(sessionId).committedFile?.path).toBe(secondPath)
    expect(tree.container.querySelector('.file-pane-markdown:not(.file-pane-staging)') === newerBody).toBe(true)
  } finally { delayed.resume(); await settle() }
})

test('a delayed successful update cannot reopen a closed pane', async () => {
  const { pane, sessionId, firstPath, service, pauseNextCommit } = setup()
  const tree = await harness.mount(pane())
  await click(tree.container, 'Open ./notes.md:12')
  const id = getFilePaneSession(sessionId).file!.id
  const delayed = pauseNextCommit()
  try {
    writeFileSync(firstPath, '# Delayed closed file')
    await act(async () => { await service.refresh(id) })
    await act(async () => { await delayed.reached })
    await click(tree.container, 'Close file')
    await act(async () => { delayed.resume() })
    await settle()
    expect(getFilePaneSession(sessionId).open).toBe(false)
    expect(tree.container.querySelector('.file-pane')).toBeNull()
    expect(service.has(id)).toBe(false)
  } finally { delayed.resume(); await settle() }
})


function localServer(port = 0) {
  const requests: Array<{ method: string; path: string }> = []
  const server = Bun.serve({ hostname: '127.0.0.1', port,
    fetch(request) {
      const path = new URL(request.url).pathname
      requests.push({ method: request.method, path })
      return new NativeResponse(path === '/' ? '<!doctype html><title>Local root</title><h1>Local app</h1>' : 'Client-only route',
        { status: path === '/' ? 200 : 404, headers: { 'Content-Type': 'text/html' } })
    },
  })
  return { server, requests, url: server.url.href }
}
async function paintLocalFrame(root: ParentNode) {
  const iframe = root.querySelector<HTMLIFrameElement>('iframe.file-pane-staging')!
  expect(iframe).not.toBeNull()
  await act(async () => { iframe.dispatchEvent(new Event('load')) })
  await settle()
  expect(root.querySelector('iframe.file-pane-content:not(.file-pane-staging)') === iframe).toBe(true)
  return iframe
}

test('a reply click preflights real HTTP and unifies SPA route receipts with file history without reloading the live frame', async () => {
  const web = localServer()
  try {
    const { pane, sessionId, localhost, captures, pauseNextCapture, external } = setup(false, { url: web.url })
    const tree = await harness.mount(pane())
    await click(tree.container, `Open ${web.url}`)
    const frame = await paintLocalFrame(tree.container)
    const initial = getFilePaneSession(sessionId).file!
    expect(web.requests.some(request => request.method === 'HEAD' && request.path === '/')).toBe(true)
    expect(frame.name).toBe(initial.frameName!)
    expect(frame.src).toBe(initial.url)
    expect(tree.container.querySelector('.file-pane-path')?.getAttribute('title')).toBe(web.url)
    const client = `${web.url}client-only`
    await act(async () => { localhost.route(initial.id, client, { x: 0, y: 140 }, { view: 'client' }) })
    expect(tree.container.querySelector('.file-pane-path')?.getAttribute('title')).toBe(client)
    expect(tree.container.querySelector('iframe.file-pane-content:not(.file-pane-staging)') === frame).toBe(true)
    expect(frame.src).toBe(initial.url)
    expect(getFilePaneSession(sessionId).history[0]?.scroll).toEqual({ x: 0, y: 140 })
    const replacement = `${web.url}replacement`
    await act(async () => { localhost.route(initial.id, replacement, { x: 0, y: 280 }, { view: 'replacement' }, true) })
    expect(getFilePaneSession(sessionId).history).toHaveLength(1)
    await click(tree.container, 'Back')
    expect(getFilePaneSession(sessionId).file?.path).toBe(web.url)
    expect(tree.container.querySelector('iframe.file-pane-content:not(.file-pane-staging)') === frame).toBe(true)
    await click(tree.container, 'Forward')
    expect(getFilePaneSession(sessionId).file?.path).toBe(replacement)
    await click(tree.container, 'Choose an app')
    const menu = document.querySelector('[role="menu"][aria-label="Open file in"]')!
    expect(menu.textContent).toContain('Google Chrome')
    expect(menu.textContent).toContain('Safari')
    expect(menu.textContent).not.toContain('Finder')
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    const resumeCapture = pauseNextCapture()
    await act(async () => { tree.container.querySelector<HTMLButtonElement>('[aria-label="Open ./notes.md:12"]')!.click(); await new Promise(resolve => setTimeout(resolve, 90)) })
    expect(getFilePaneSession(sessionId).file?.kind).toBe('localhost')
    expect(frame.isConnected).toBe(true)
    resumeCapture()
    await settle()
    expect(getFilePaneSession(sessionId).file?.kind).toBe('markdown')
    const localLink = [...tree.container.querySelectorAll<HTMLButtonElement>('.file-pane-markdown-link')].find(link => link.textContent === 'Local app')!
    await act(async () => { localLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })); await new Promise(resolve => setTimeout(resolve, 70)) })
    expect(external.at(-1)).toEqual({ path: web.url, target: 'chrome' })
    expect(getFilePaneSession(sessionId).file?.kind).toBe('markdown')
    expect(captures.some(capture => capture.id === initial.id && capture.connected)).toBe(true)
    await click(tree.container, 'Back')
    const restored = getFilePaneSession(sessionId).file!
    expect(restored.path).toBe(replacement)
    expect(restored.url).toBe(web.url)
    expect(web.requests.at(-1)?.path).toBe('/')
    await paintLocalFrame(tree.container)
  } finally { await web.server.stop(true) }
})

test('an unavailable real HTTP address reports its host and never opens an empty pane', async () => {
  const web = localServer()
  await web.server.stop(true)
  const { pane, toasts } = setup(false, { url: web.url })
  const tree = await harness.mount(pane())
  await click(tree.container, `Open ${web.url}`)
  expect(tree.container.querySelector('.file-pane')).toBeNull()
  expect(toasts).toEqual([`Nothing is running at 127.0.0.1:${new URL(web.url).port}`])
})

test('server stop preserves the current frame, recovery stages a new revision, and departure uses the host-private URL', async () => {
  let web = localServer()
  try {
    const { pane, sessionId, localhost, external } = setup(false, { url: web.url })
    const tree = await harness.mount(pane())
    await click(tree.container, `Open ${web.url}`)
    const old = await paintLocalFrame(tree.container)
    const id = getFilePaneSession(sessionId).file!.id
    const port = web.server.port!
    await click(tree.container, 'Open broken.png')
    await web.server.stop(true)
    await act(async () => { await localhost.refresh(id) })
    expect(tree.container.querySelector('.file-pane-note')).toBeNull()
    await act(async () => { tree.container.querySelector('.file-pane-staging.file-pane-image img')!.dispatchEvent(new Event('error')) })
    await settle()
    expect(tree.container.querySelector('.file-pane-note')?.textContent).toBe('The server stopped. Showing the last version.')
    expect(tree.container.querySelector('iframe.file-pane-content:not(.file-pane-staging)') === old).toBe(true)
    web = localServer(port)
    await act(async () => { await localhost.refresh(id) })
    expect(tree.container.querySelectorAll('iframe')).toHaveLength(2)
    const recovered = await paintLocalFrame(tree.container)
    expect(recovered === old).toBe(false)
    expect(tree.container.querySelector('.file-pane-note')).toBeNull()
    const blocked = 'https://example.com/sign-in?return=private-route'
    await act(async () => { localhost.leave(id, blocked) })
    expect(tree.container.querySelector('.file-pane-note')?.textContent).toContain('This page wants to open example.com')
    expect(tree.container.querySelector('.file-pane-note')?.textContent).not.toContain('private-route')
    const open = [...tree.container.querySelectorAll<HTMLButtonElement>('.file-pane-note-action')][0]!
    await act(async () => { open.click() })
    expect(external.at(-1)).toEqual({ path: blocked, target: 'chrome' })
    expect(tree.container.querySelector('.file-pane-note')).toBeNull()
    expect(tree.container.querySelector('iframe.file-pane-content:not(.file-pane-staging)') === recovered).toBe(true)
  } finally { await web.server.stop(true) }
})

for (const [note, text] of [
  ['browser-required', 'This page needs a browser to continue.'],
  ['frame-blocked', 'Part of this page can only show in a browser.'],
] as const) test(`${note} reuses the note action to open the displayed page in the selected browser without replay`, async () => {
  const web = localServer()
  try {
    const { pane, sessionId, localhost, external } = setup(false, { url: web.url })
    const tree = await harness.mount(pane())
    await click(tree.container, `Open ${web.url}`)
    const frame = await paintLocalFrame(tree.container)
    const initial = getFilePaneSession(sessionId).file!
    const displayed = `${web.url}displayed-route`
    await act(async () => { localhost.route(initial.id, displayed, { x: 0, y: 0 }, null) })
    await act(async () => { localhost.browserNote(initial.id, initial.revision, note) })
    expect(tree.container.querySelectorAll('.file-pane-note')).toHaveLength(1)
    expect(tree.container.querySelector('.file-pane-note span')?.textContent).toBe(text)
    const action = tree.container.querySelector<HTMLButtonElement>('.file-pane-note-action')!
    expect(action.textContent).toBe('Open in Google Chrome')
    const requests = web.requests.length
    await act(async () => { action.click() })
    expect(external).toEqual([{ path: displayed, target: 'chrome' }])
    expect(web.requests).toHaveLength(requests)
    expect(localhost.blockedUrl(initial.id)).toBeNull()
    expect(tree.container.querySelector('iframe.file-pane-content:not(.file-pane-staging)')).toBe(frame)
    await click(tree.container, 'Choose an app')
    const safari = [...document.querySelectorAll<HTMLButtonElement>('.file-pane-app-row')].find(button => button.textContent === 'Safari')!
    await act(async () => { safari.click() })
    expect(action.textContent).toBe('Open in Safari')
    await act(async () => { action.click() })
    expect(external.at(-1)).toEqual({ path: displayed, target: 'safari' })
    expect(web.requests).toHaveLength(requests)
    await click(tree.container, 'Reload')
    await paintLocalFrame(tree.container)
    expect(tree.container.querySelectorAll('.file-pane-note')).toHaveLength(1)
    expect(tree.container.querySelector('.file-pane-note span')?.textContent).toBe(text)
    const current = getFilePaneSession(sessionId).file!
    expect(localhost.browserNote(current.id, current.revision, note)).toBe(false)
    await act(async () => { localhost.route(initial.id, `${web.url}another-page`, { x: 0, y: 0 }, null) })
    expect(tree.container.querySelector('.file-pane-note')).toBeNull()
  } finally { await web.server.stop(true) }
})

test('browser notes from the still-painted page survive a rejected candidate without appearing on that candidate', async () => {
  const web = localServer()
  try {
    const { pane, sessionId, localhost } = setup(false, { url: web.url })
    const tree = await harness.mount(pane())
    await click(tree.container, `Open ${web.url}`)
    await paintLocalFrame(tree.container)
    const initial = getFilePaneSession(sessionId).file!
    await click(tree.container, 'Open broken.png')
    await act(async () => { localhost.browserNote(initial.id, initial.revision, 'browser-required') })
    expect(tree.container.querySelector('.file-pane-note')).toBeNull()
    await act(async () => { tree.container.querySelector('.file-pane-staging.file-pane-image img')!.dispatchEvent(new Event('error')) })
    await settle()
    expect(tree.container.querySelector('.file-pane-note span')?.textContent).toBe('This page needs a browser to continue.')
    expect(getFilePaneSession(sessionId).file?.path).toBe(web.url)
  } finally { await web.server.stop(true) }
})

test('returning to an offline session waits for its frozen host descriptor before creating an iframe', async () => {
  const web = localServer()
  const snapshots = new Map<string, LocalhostFrozenPayload>()
  try {
    const snapshot = { id: randomUUID(), html: await (await nativeFetch(web.url)).text(), resources: new Map() }
    snapshots.set(snapshot.id, snapshot)
    const { pane, sessionId, otherSession } = setup(false, { url: web.url, snapshots })
    const tree = await harness.mount(pane())
    await click(tree.container, `Open ${web.url}`)
    await paintLocalFrame(tree.container)
    await act(async () => { await captureFilePaneScroll(sessionId) })
    await tree.render(pane(otherSession))
    await web.server.stop(true)
    await tree.render(pane())
    await settle()
    const file = getFilePaneSession(sessionId).file!
    expect(file.serverStopped).toBe(true)
    expect(file.path).toBe(web.url)
    expect(file.url.startsWith('cat-preview:')).toBe(true)
    expect([...tree.container.querySelectorAll<HTMLIFrameElement>('iframe')].every(frame => frame.src.startsWith('cat-preview:'))).toBe(true)
    await paintLocalFrame(tree.container)
    expect(tree.container.querySelector('.file-pane-note')?.textContent).toBe('The server stopped. Showing the last version.')
  } finally { await web.server.stop(true) }
})


test.each([false, true])('overlapping canonical file opens keep the winning capability after a stale reply (close between requests: %s)', async closeBetween => {
  const { pane, sessionId, service } = setup()
  const tree = await harness.mount(pane())
  const prepare = window.catcode.prepareFilePreview.bind(window.catcode)
  const replies: Array<{ id: string; resume: () => void }> = []
  window.catcode.prepareFilePreview = async (...args) => {
    const descriptor = await prepare(...args)
    await new Promise<void>(resolve => { replies.push({ id: descriptor!.id, resume: resolve }) })
    return descriptor
  }
  const button = tree.container.querySelector<HTMLButtonElement>('[aria-label="Open ./notes.md:12"]')!
  await act(async () => { button.click(); await new Promise(resolve => setTimeout(resolve, 70)) })
  if (closeBetween) await act(async () => { closeFilePane(sessionId) })
  await act(async () => { button.click(); await new Promise(resolve => setTimeout(resolve, 70)) })
  expect(replies).toHaveLength(2)
  expect(replies[0]!.id).toBe(replies[1]!.id)
  await act(async () => { replies[0]!.resume(); await new Promise(resolve => setTimeout(resolve, 10)) })
  await act(async () => { replies[1]!.resume() })
  await settle()
  expect(getFilePaneSession(sessionId).open).toBe(true)
  expect(service.has(replies[1]!.id)).toBe(true)
  expect(tree.container.querySelector('.file-pane-markdown:not(.file-pane-staging)')?.textContent).toContain('Actual disk notes')
})

test('old painted page polling keeps the new target at its intended scroll and preserves outgoing history', async () => {
  const { pane, sessionId, firstPath, brokenPath } = setup()
  const nextPath = join(firstPath, '..', 'other.html')
  writeFileSync(brokenPath, '<!doctype html><p>First page</p>')
  writeFileSync(nextPath, '<!doctype html><p>Second page</p>')
  const tree = await harness.mount(pane())
  await click(tree.container, 'Open broken.html')
  await paintLocalFrame(tree.container)
  const first = getFilePaneSession(sessionId).file!
  await window.catcode.restoreFilePreviewScroll(first.id, first.revision, { x: 0, y: 500 })
  await act(async () => { await requestOpenFile(sessionId, nextPath) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)) })
  await paintLocalFrame(tree.container)
  expect(getFilePaneSession(sessionId).file?.path).toBe(nextPath)
  expect(getFilePaneSession(sessionId).scroll.y).toBe(0)
  await click(tree.container, 'Back')
  await paintLocalFrame(tree.container)
  expect(getFilePaneSession(sessionId).scroll.y).toBe(500)
})

test('a delayed application choice for one type cannot overwrite the newly displayed type', async () => {
  const { pane } = setup()
  const tree = await harness.mount(pane())
  await click(tree.container, 'Open ./notes.md:12')
  const choose = window.catcode.chooseFilePreviewApplication.bind(window.catcode)
  let resume!: () => void
  const waiting = new Promise<void>(resolve => { resume = resolve })
  window.catcode.chooseFilePreviewApplication = async (...args) => { await waiting; return choose(...args) }
  await click(tree.container, 'Choose an app')
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(node => node.textContent?.includes('Visual Studio Code'))!
  expect(option).not.toBeUndefined()
  await act(async () => { option.click() })
  await click(tree.container, 'Open image.png')
  await act(async () => { tree.container.querySelector('.file-pane-staging.file-pane-image img')!.dispatchEvent(new Event('load')) })
  await settle()
  expect(tree.container.querySelector('.file-pane-open-app')?.getAttribute('title')).toBe('Open in Default application')
  await act(async () => { resume(); await new Promise(resolve => setTimeout(resolve, 80)) })
  expect(tree.container.querySelector('.file-pane-open-app .external-app-icon')?.getAttribute('data-app-target')).toBe('default')
  expect(tree.container.querySelector('.file-pane-open-app')?.getAttribute('title')).toBe('Open in Default application')
})


test('late actual localhost refresh events and replies cannot downgrade the newer admitted revision', async () => {
  const web = localServer()
  let resume!: () => void
  const waiting = new Promise<void>(resolve => { resume = resolve })
  try {
    const { pane, sessionId, otherSession, localhost } = setup(false, { url: web.url })
    const tree = await harness.mount(pane())
    await click(tree.container, `Open ${web.url}`)
    await paintLocalFrame(tree.container)
    const id = getFilePaneSession(sessionId).file!.id
    await tree.render(pane(otherSession))
    const refresh = window.catcode.refreshFilePreview.bind(window.catcode)
    const subscribe = window.catcode.subscribeFilePreview.bind(window.catcode)
    let reached!: () => void
    const reachedRefresh = new Promise<void>(resolve => { reached = resolve })
    let deliverOlderEvent: (() => void) | null = null
    window.catcode.subscribeFilePreview = listener => subscribe(event => {
      if (event.kind === 'updated' && !deliverOlderEvent) { deliverOlderEvent = () => listener(event); return }
      listener(event)
    })
    window.catcode.refreshFilePreview = async previewId => {
      const descriptor = await refresh(previewId)
      reached()
      await waiting
      return descriptor
    }
    await tree.render(pane())
    await act(async () => { await reachedRefresh })
    await act(async () => { await localhost.refresh(id) })
    const newest = getFilePaneSession(sessionId).file!
    expect(localhost.descriptor(id, newest.revision)).not.toBeNull()
    await act(async () => { deliverOlderEvent!() })
    expect(getFilePaneSession(sessionId).file?.revision).toBe(newest.revision)
    await act(async () => { resume(); await new Promise(resolve => setTimeout(resolve, 50)) })
    expect(getFilePaneSession(sessionId).file?.revision).toBe(newest.revision)
    const frame = await paintLocalFrame(tree.container)
    expect(tree.container.querySelector('iframe.file-pane-content:not(.file-pane-staging)')).toBe(frame)
    expect(tree.container.querySelector('.file-pane-staging')).toBeNull()
  } finally { await act(async () => { resume(); await new Promise(resolve => setTimeout(resolve, 20)) }); await web.server.stop(true) }
})
