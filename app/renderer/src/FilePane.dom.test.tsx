import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkspaceFile } from '../../main/openWorkspaceFile.js'
import { createPreviewApplications } from '../../main/previewApplications.js'
import { createFilePreviewService } from '../../main/filePreview.js'
import { sessionDescriptorFixture } from '../../shared/sessionDescriptor.fixture.js'
import type { FilePreviewEvent } from '../../shared/filePreview.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { SubagentWorkspace } from './SubagentWorkspace.js'
import { TranscriptRowsView } from './TranscriptView.js'
import { ToolsExpandedContext } from './toolsExpanded.js'
import { ToastContext } from './toastContext.js'
import { captureFilePaneScroll, closeFilePane, disposeFilePaneSession, getFilePaneSession, rememberFilePaneScroll } from './filePaneState.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'

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
    if (error instanceof Error && error.message.startsWith('Failed to load iframe page "cat-preview:') && error.message.endsWith('Iframe page loading is disabled.')) return
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
function setup(withOutput = false) {
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
  writeFileSync(brokenPath, '<!doctype html><link rel="stylesheet" href="missing.css"><p>Incomplete page</p>')
  writeFileSync(firstPath, '# Actual disk notes\n\n[Next document](second.markdown)')
  writeFileSync(secondPath, '# Actual second document\n\nAnother page.')
  const events = new Set<(event: FilePreviewEvent) => void>()
  const external: Array<{ path: string; target?: string; location?: unknown }> = []
  const sessions = [sessionDescriptorFixture({ appSessionId: sessionId, cwd: root }), sessionDescriptorFixture({ appSessionId: otherSession, cwd: root })]
  const service = createFilePreviewService({ sessions: () => sessions, publish: event => { events.forEach(callback => callback(event)) } })
  const applications = createPreviewApplications({
    sessions: () => sessions, userData: root, installed: async () => true,
    open: async (path, target) => { external.push({ path, target }); return true },
  })
  const previous = Object.getOwnPropertyDescriptor(window, 'catcode')
  const ids = new Set<string>()
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
    refreshFilePreview: service.refresh,
    commitFilePreview: async (id: string, revision: number) => service.commit(id, revision),
    releaseFilePreview: service.release,
    subscribeFilePreview: (listener: (event: FilePreviewEvent) => void) => { events.add(listener); return () => events.delete(listener) },
    getFilePreviewApplications: (appSessionId: string, path: string) => applications.list({ appSessionId, path }),
    chooseFilePreviewApplication: (appSessionId: string, path: string, target: string) => applications.choose({ appSessionId, path, target }),
    getExternalAppIcon: async () => null,
  } })
  releases.push(() => {
    closeFilePane(sessionId); closeFilePane(otherSession)
    ids.forEach(id => service.release(id))
    if (previous) Object.defineProperty(window, 'catcode', previous)
    else Reflect.deleteProperty(window, 'catcode')
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })
  const row: NestedTranscriptRow = {
    id: 'reply', sessionId, frameId: 'f', messageId: 'm', blockIndex: 0,
    parentToolUseId: null, kind: 'assistant-text', role: 'assistant', children: [],
    content: `[Notes](notes.md:12) [Second](second.markdown) [Refused](${refusedPath}) [Broken](broken.html) [Image](image.png) [Bad image](broken.png)`,
  }
  const rows: NestedTranscriptRow[] = [row]
  if (withOutput) rows.push({
    id: 'long-output', sessionId, frameId: 'out-frame', messageId: 'out-message', blockIndex: 0,
    parentToolUseId: null, kind: 'tool-use', toolUseId: 'long-output', toolName: 'Bash', toolFamily: 'bash',
    input: { command: 'preview-scroll-output' }, status: 'success', agentCompletion: null, children: [],
    result: { content: Array.from({ length: 900 }, (_, index) => `output line ${index}`).join('\n'), isError: false, diff: null },
  })
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
  return { pane, sessionId, firstPath, secondPath, imagePath, imageBytes, badImagePath, brokenPath, refusedPath, otherSession, toasts, service, pauseNextPrepare, ids, external }
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


test('failed real local assets reject an initial paint and roll a later navigation back to its last good file', async () => {
  const { pane, sessionId, firstPath, service, toasts } = setup()
  const tree = await harness.mount(pane())
  const failStagedPage = async () => {
    const file = getFilePaneSession(sessionId).file!
    // Happy DOM has no protocol transport. Drive the actual host request that
    // Electron makes for this page's stylesheet, then the frame's load event.
    const response = await service.respond(new Request(new URL('missing.css', file.url)))
    expect(response.status).toBe(403)
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
  const { pane, firstPath, external } = setup()
  const tree = await harness.mount(pane())
  await act(async () => {
    tree.container.querySelector('[aria-label="Open ./notes.md:12"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }))
    await new Promise(resolve => setTimeout(resolve, 80))
  })
  expect(external).toEqual([{ path: firstPath, target: 'default' }])
  expect(tree.container.querySelector('.file-pane')).toBeNull()
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
