import { afterEach, expect, test } from 'bun:test'
import { applyBrowserPaneEvent } from './browserPaneState.js'
import { closeFilePane, disposeFilePaneSession, getFilePaneSession, hideScreenPane, hideSidePane, registerFilePaneScroll, requestFilePaneFiles, requestOpenFile, rejectFilePaneCandidate, showSlotOccupant, stepSidePaneHistory, updateFilePaneSession } from './filePaneState.js'
import type { FilePreviewDescriptor } from '../../shared/filePreview.js'
import type { SubagentDockRow } from './subagentDockState.js'

const id = 'side-history-test'
const commands: unknown[] = []
const released: string[] = []
let previousWindow: PropertyDescriptor | undefined
const file = (path: string): FilePreviewDescriptor => ({ id: path, path, displayPath: path, kind: 'text', revision: 1, url: `cat-preview://${path}` }) as FilePreviewDescriptor
function install() {
  commands.length = 0; released.length = 0
  previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.assign(globalThis, { window: { catcode: {
    browserPaneCommand: async (command: unknown) => { commands.push(command); return { ok: true } },
    releaseFilePreview: (preview: string) => { released.push(preview) },
    prepareFilePreview: async (_id: string, path: string) => ({ ok: true, descriptor: file(path) }),
  } } })
}
function browser(entry: string) {
  applyBrowserPaneEvent({ appSessionId: id, state: { appSessionId: id, url: `http://localhost/${entry}`, displayUrl: entry, controller: 'agent', canGoBack: true, canGoForward: false, still: null, historyEntry: entry } })
}
function commit(path: string) {
  const descriptor = file(path)
  updateFilePaneSession(id, { open: true, file: descriptor, committedFile: descriptor, checkpoint: null, visible: 'file' })
}
afterEach(() => {
  disposeFilePaneSession(id)
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

test('one trail restores native browser entries between file and Computer', async () => {
  install(); commit('a.ts'); browser('page1'); showSlotOccupant(id, 'browser'); browser('page2')
  updateFilePaneSession(id, { computer: { selectedId: null } }); showSlotOccupant(id, 'computer')
  expect(getFilePaneSession(id).sideHistory.map(entry => entry.kind)).toEqual(['file', 'browser', 'browser', 'computer'])
  await stepSidePaneHistory(id, 'back')
  expect(commands).toEqual([{ appSessionId: id, command: 'history', historyEntry: 'page2' }])
  await stepSidePaneHistory(id, 'back')
  expect(commands.at(-1)).toEqual({ appSessionId: id, command: 'history', historyEntry: 'page1' })
  await stepSidePaneHistory(id, 'back')
  expect(getFilePaneSession(id).visible).toBe('file')
  expect(getFilePaneSession(id).sideHistory).toHaveLength(4)
})

test('hidden browser pages stay out of trail and reopen records the current page', () => {
  install(); browser('one'); showSlotOccupant(id, 'browser'); hideSidePane(id)
  browser('two'); browser('three')
  expect(getFilePaneSession(id).visible).toBeNull()
  expect(getFilePaneSession(id).sideHistory).toHaveLength(1)
  showSlotOccupant(id, 'browser')
  expect(getFilePaneSession(id).sideHistory.at(-1)).toEqual({ kind: 'browser', entry: 'three' })
  browser('three')
  expect(getFilePaneSession(id).sideHistory).toHaveLength(2)
})

test('closing and reopening the same item adds no duplicate trail entry', () => {
  install(); browser('one'); showSlotOccupant(id, 'browser')
  hideSidePane(id); showSlotOccupant(id, 'browser')
  expect(getFilePaneSession(id).sideHistory).toHaveLength(1)
  expect(getFilePaneSession(id).sideHistoryIndex).toBe(0)
})

test('worker identity and output selection changes are tracked, Computer steps are not', async () => {
  install()
  const worker = { agentId: 'w1', runKey: 'r1' } as SubagentDockRow
  updateFilePaneSession(id, { worker }); showSlotOccupant(id, 'worker')
  updateFilePaneSession(id, { worker: { ...worker, task: 'new status' } })
  updateFilePaneSession(id, { worker: { ...worker, agentId: 'w2' } })
  updateFilePaneSession(id, { output: { id: 'o', fileIndex: 0, request: 1 } }); showSlotOccupant(id, 'output')
  updateFilePaneSession(id, { output: { id: 'o', fileIndex: 1, request: 2 } })
  updateFilePaneSession(id, { computer: { selectedId: 'first' } }); showSlotOccupant(id, 'computer')
  updateFilePaneSession(id, { computer: { selectedId: 'second' } })
  expect(getFilePaneSession(id).sideHistory).toHaveLength(5)
  await stepSidePaneHistory(id, 'back')
  expect(getFilePaneSession(id).output?.fileIndex).toBe(1)
  await stepSidePaneHistory(id, 'back')
  expect(getFilePaneSession(id).output?.fileIndex).toBe(0)
  showSlotOccupant(id, 'worker')
  expect(getFilePaneSession(id).sideHistory).toHaveLength(4)
  expect(getFilePaneSession(id).sideHistoryIndex).toBe(3)
})

test('ordinary close retains bodies and scroll without fallback; disposal releases resources', async () => {
  install(); commit('a.ts')
  updateFilePaneSession(id, { output: { id: 'o', fileIndex: 0, request: 1 } })
  registerFilePaneScroll(id, async () => ({ x: 3, y: 150 }))
  closeFilePane(id)
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  expect(getFilePaneSession(id)).toMatchObject({ visible: null, open: true, scroll: { x: 3, y: 150 } })
  expect(getFilePaneSession(id).file?.id).toBe('a.ts')
  expect(released).toEqual([])
  expect(getFilePaneSession(id).sideHistory).toHaveLength(1)
  disposeFilePaneSession(id)
  expect(released).toEqual(['a.ts'])
})

test('closing a screen hides the shared slot and retains other occupants', () => {
  install(); commit('a.ts'); browser('one'); showSlotOccupant(id, 'browser')
  hideScreenPane(id, 'browser')
  expect(getFilePaneSession(id).visible).toBeNull()
  expect(getFilePaneSession(id).file?.id).toBe('a.ts')
  expect(getFilePaneSession(id).browser?.historyEntry).toBe('one')
})

test('Files request reveals an empty file pane and advances request counter', () => {
  install(); requestFilePaneFiles(id); requestFilePaneFiles(id)
  expect(getFilePaneSession(id)).toMatchObject({ open: true, file: null, visible: 'file', filesRequest: 2 })
  expect(getFilePaneSession(id).sideHistory).toHaveLength(1)
})

test('staged files enter the trail only on commit and rollback retains its branch', async () => {
  install(); commit('a.ts'); browser('one'); showSlotOccupant(id, 'browser')
  await requestOpenFile(id, 'b.ts')
  expect(getFilePaneSession(id).sideHistory).toHaveLength(2)
  rejectFilePaneCandidate(id, getFilePaneSession(id).file!)
  expect(getFilePaneSession(id).sideHistory).toHaveLength(2)
  await requestOpenFile(id, 'b.ts')
  updateFilePaneSession(id, { committedFile: getFilePaneSession(id).file, checkpoint: null })
  expect(getFilePaneSession(id).sideHistory.map(entry => entry.kind)).toEqual(['file', 'browser', 'file'])
})

test('a failed staged file cannot undo a newer pane selection or its trail', async () => {
  install(); commit('a.ts'); browser('one'); showSlotOccupant(id, 'browser')
  await requestOpenFile(id, 'b.ts')
  const candidate = getFilePaneSession(id).file!
  updateFilePaneSession(id, { worker: { agentId: 'w', runKey: 'run' } as SubagentDockRow })
  showSlotOccupant(id, 'worker')
  rejectFilePaneCandidate(id, candidate)
  expect(getFilePaneSession(id).visible).toBe('worker')
  expect(getFilePaneSession(id).sideHistory.map(entry => entry.kind)).toEqual(['file', 'browser', 'worker'])
})

test.each(['hide', 'switch', 'dispose'] as const)('late browser history completion does not override a newer %s', async action => {
  install(); browser('one'); showSlotOccupant(id, 'browser')
  updateFilePaneSession(id, { computer: { selectedId: null } }); showSlotOccupant(id, 'computer')
  let resume!: () => void
  window.catcode.browserPaneCommand = async () => { await new Promise<void>(resolve => { resume = resolve }); return { ok: true } }
  const step = stepSidePaneHistory(id, 'back')
  if (action === 'hide') hideSidePane(id)
  else if (action === 'switch') requestFilePaneFiles(id)
  else disposeFilePaneSession(id)
  resume(); await step
  expect(getFilePaneSession(id).visible).toBe(action === 'switch' ? 'file' : null)
})

test('failure to restore a retired native history entry leaves the shared cursor unchanged', async () => {
  install(); browser('one'); showSlotOccupant(id, 'browser')
  updateFilePaneSession(id, { computer: { selectedId: null } }); showSlotOccupant(id, 'computer')
  window.catcode.browserPaneCommand = async () => ({ ok: false, message: 'This browser history entry is no longer available' })
  expect((await stepSidePaneHistory(id, 'back')).ok).toBe(false)
  expect(getFilePaneSession(id).sideHistoryIndex).toBe(1)
  expect(getFilePaneSession(id).visible).toBe('computer')
})
