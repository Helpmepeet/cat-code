import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { filePreviewKind, normalizeLocalhostPreviewUrl, localhostPreviewHostPort, type FilePreviewDescriptor, type FilePreviewScroll, type FilePreviewSource, type LocalhostPreviewNote } from '../../shared/filePreview.js'
import type { MarkdownReadingPosition } from './markdownReadingPosition.js'
import type { SubagentDockRow } from './subagentDockState.js'
import { defaultViewPreferenceStorage, readViewPreference, writeViewPreference } from './viewPreference.js'
import { findOpenedFile, rememberOpenedFile, updateOpenedFileScroll, type OpenedPaneFiles } from './filePaneOpened.js'
import { disposeWorkspaceFileAvailability } from './workspaceFileAvailabilityQueue.js'
import { readToolOutputWidth } from './toolOutputPanel.js'
import type { BrowserPaneSnapshot } from '../../shared/browserPanePresentation.js'
import { EMPTY_SCREEN_ACTIVITY, type ScreenActivityState, type ScreenKind } from './screenActivityState.js'

export type SlotOccupant = 'file' | 'worker' | 'output' | 'browser' | 'computer'
export type FilePaneScroll = FilePreviewScroll & { markdown?: MarkdownReadingPosition; topLine?: number; pdf?: { page: number; zoom: number; fitWidth: boolean }; table?: { row: number; column: number; sheet?: string; mode?: 'source' | 'table' }; textWindow?: 'start' | 'end' }
export type PreviewOpenResult = { ok: true } | { ok: false; message: string; reason?: string }
export type FilePaneHistoryEntry = { path: string; scroll: FilePaneScroll; routeKey?: string; baseUrl?: string; previewId?: string }
export type FilePaneOutput = { id: string; fileIndex: number; request: number }
type SidePaneEntry =
  | { kind: 'file'; target: FilePaneHistoryEntry | null }
  | { kind: 'worker'; worker: SubagentDockRow }
  | { kind: 'output'; output: FilePaneOutput }
  | { kind: 'browser'; entry: string }
  | { kind: 'computer' }
type FilePaneCheckpoint = Pick<FilePaneSession, 'open' | 'file' | 'committedFile' | 'lastPath' | 'history' | 'forward' | 'scroll' | 'note' | 'lineTarget' | 'requestedPath' | 'sideHistory' | 'sideHistoryIndex' | 'visible'>
export type FilePaneSession = {
  filesRequest: number
  sideHistory: readonly SidePaneEntry[]
  sideHistoryIndex: number
  opened: OpenedPaneFiles
  requestedPath: string | null
  lineTarget: { line: number; token: number } | null
  open: boolean
  file: FilePreviewDescriptor | null
  committedFile: FilePreviewDescriptor | null
  lastPath: string | null
  visible: SlotOccupant | null
  worker: SubagentDockRow | null
  output: FilePaneOutput | null
  browser: BrowserPaneSnapshot | null
  computer: { selectedId: string | null } | null
  screenActivity: ScreenActivityState
  hiddenScreens: readonly ScreenKind[]
  width: number | null
  history: FilePaneHistoryEntry[]
  forward: FilePaneHistoryEntry[]
  scroll: FilePaneScroll
  note: 'removed' | 'watch-error' | 'update-error' | 'server-stopped' | 'leave' | LocalhostPreviewNote | null
  checkpoint: FilePaneCheckpoint | null
}
const EMPTY: FilePaneSession = {
  filesRequest: 0, sideHistory: [], sideHistoryIndex: -1,
  opened: new Map(), requestedPath: null, lineTarget: null, open: false, file: null, committedFile: null, lastPath: null, visible: null,
  worker: null, output: null, browser: null, computer: null, screenActivity: EMPTY_SCREEN_ACTIVITY, hiddenScreens: [],
  width: null, history: [], forward: [], scroll: { x: 0, y: 0 }, note: null, checkpoint: null,
}
const sessions = new Map<string, FilePaneSession>()
const listeners = new Map<string, Set<() => void>>()
const focusers = new Map<string, () => void>()
const scrollReaders = new Map<string, () => Promise<FilePaneScroll>>()
const opening = new Map<string, number>()
const stepping = new Set<string>()
const sideNavigationVersions = new Map<string, number>()
function cancelSidePaneStep(id: string): void {
  if (stepping.has(id)) opening.set(id, (opening.get(id) ?? 0) + 1)
  sideNavigationVersions.set(id, (sideNavigationVersions.get(id) ?? 0) + 1)
  stepping.delete(id)
}
const pendingOpenings = new Map<string, Set<number>>()
const deferredReleases = new Map<string, Map<string, FilePreviewDescriptor>>()
const viewerFocusers = new Map<string, { focus: () => void; failed?: () => void }>()
const viewerFocusRequests = new Map<string, { token: number; origin: Element | null }>()
const FILE_WIDTH_KEY = 'catcode.filePaneWidth.v1'

function fileCheckpoint(state: FilePaneSession, scroll: FilePaneScroll): FilePaneCheckpoint {
  return {
    open: state.open, file: state.file, committedFile: state.committedFile, lastPath: state.lastPath,
    history: state.history, forward: state.forward, scroll, note: state.note, lineTarget: state.lineTarget, requestedPath: state.requestedPath,
    sideHistory: state.sideHistory, sideHistoryIndex: state.sideHistoryIndex,
    visible: state.visible,
  }
}

export function isPaneFilePath(path: string): boolean { return filePreviewKind(path) !== null }
export function paneTargetLabel(path: string): string {
  return localhostPreviewHostPort(path) ?? path.replace(/:\d+(?::\d+)?$/, '').split('/').at(-1) ?? path
}
export function samePaneRevision(left: FilePreviewDescriptor | null | undefined, right: FilePreviewDescriptor | null | undefined): boolean {
  return !!left && !!right && left.id === right.id && left.revision === right.revision && left.url === right.url
}
export function previewDescriptorNote(file: FilePreviewDescriptor | null): FilePaneSession['note'] {
  return file?.serverStopped ? 'server-stopped' : file?.blockedHost ? 'leave' : file?.browserNote ?? (file?.watchError ? 'watch-error' : null)
}
function historyEntry(file: FilePreviewDescriptor, scroll: FilePaneScroll): FilePaneHistoryEntry {
  return { path: file.path, scroll, ...(file.routeKey ? { routeKey: file.routeKey } : {}),
    ...(file.baseUrl ? { baseUrl: file.baseUrl } : {}), ...(file.kind === 'localhost' ? { previewId: file.id } : {}) }
}
const HANDLED: PreviewOpenResult = { ok: true }
function refusal(path: string): PreviewOpenResult {
  return { ok: false, message: /^https?:\/\//i.test(path) ? 'Could not open this page' : 'Could not open this file' }
}

export function getFilePaneSession(id: string): FilePaneSession { return sessions.get(id) ?? EMPTY }
function useFilePaneSubscription(id: string) {
  return useCallback((listener: () => void) => {
    let group = listeners.get(id)
    if (!group) { group = new Set(); listeners.set(id, group) }
    group.add(listener)
    return () => { group.delete(listener); if (!group.size) listeners.delete(id) }
  }, [id])
}
export function useFilePaneSession(id: string): FilePaneSession {
  const subscribe = useFilePaneSubscription(id)
  const snapshot = useCallback(() => getFilePaneSession(id), [id])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
/** Keep scroll bookkeeping and other occupants' updates out of a panel's render path. */
export function useFilePaneFields<K extends keyof FilePaneSession>(id: string, fields: readonly K[]): Pick<FilePaneSession, K> {
  const subscribe = useFilePaneSubscription(id)
  const snapshot = useMemo(() => {
    let selected: Pick<FilePaneSession, K> | undefined
    return () => {
      const state = getFilePaneSession(id)
      if (!selected || fields.some(key => !Object.is(selected![key], state[key]))) {
        selected = Object.fromEntries(fields.map(key => [key, state[key]])) as Pick<FilePaneSession, K>
      }
      return selected
    }
  }, [id, fields])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
export function updateFilePaneSession(id: string, patch: Partial<FilePaneSession>): void {
  const previous = getFilePaneSession(id)
  const next = { ...previous, ...patch }
  if (!next.open && !next.worker && !next.output && !next.browser && !next.computer) { next.visible = null; next.width = null }
  else if (next.visible === 'file' && !next.open || next.visible === 'worker' && !next.worker || next.visible === 'output' && !next.output || next.visible === 'browser' && !next.browser || next.visible === 'computer' && !next.computer) {
    next.visible = null
  }
  if (!stepping.has(id) && patch.sideHistory === undefined) recordSidePaneEntry(previous, next)
  if ((Object.keys(next) as Array<keyof FilePaneSession>).every(key => Object.is(previous[key], next[key]))) return
  sessions.set(id, next)
  listeners.get(id)?.forEach(listener => listener())
}
function sidePaneEntry(state: FilePaneSession): SidePaneEntry | null {
  switch (state.visible) {
    case 'file':
      if (state.checkpoint || state.file && !samePaneRevision(state.file, state.committedFile)) return null
      return { kind: 'file', target: state.file ? historyEntry(state.file, state.scroll) : null }
    case 'worker': return state.worker ? { kind: 'worker', worker: state.worker } : null
    case 'output': return state.output ? { kind: 'output', output: state.output } : null
    case 'browser': return state.browser?.historyEntry ? { kind: 'browser', entry: state.browser.historyEntry } : null
    case 'computer': return { kind: 'computer' }
    default: return null
  }
}
function sameSidePaneEntry(a: SidePaneEntry | undefined, b: SidePaneEntry): boolean {
  if (!a || a.kind !== b.kind) return false
  switch (b.kind) {
    case 'file': return a.kind === 'file' && a.target?.path === b.target?.path && a.target?.routeKey === b.target?.routeKey
    case 'worker': return a.kind === 'worker' && a.worker.agentId === b.worker.agentId && a.worker.runKey === b.worker.runKey
    case 'output': return a.kind === 'output' && a.output.id === b.output.id && a.output.fileIndex === b.output.fileIndex
    case 'browser': return a.kind === 'browser' && a.entry === b.entry
    case 'computer': return true
  }
}
function recordSidePaneEntry(previous: FilePaneSession, next: FilePaneSession): void {
  const entry = sidePaneEntry(next)
  if (!entry) return
  const current = previous.sideHistory[previous.sideHistoryIndex]
  if (sameSidePaneEntry(current, entry)) return
  next.sideHistory = [...previous.sideHistory.slice(0, previous.sideHistoryIndex + 1), entry]
  next.sideHistoryIndex = next.sideHistory.length - 1
}
export function useSidePaneNavigation(id: string, onFailure?: (message: string) => void): { canGoBack: boolean; canGoForward: boolean; back: () => void; forward: () => void } {
  const state = useFilePaneSession(id)
  return {
    canGoBack: state.sideHistoryIndex > 0,
    canGoForward: state.sideHistoryIndex + 1 < state.sideHistory.length,
    back: useCallback(() => { void stepSidePaneHistory(id, 'back').then(result => { if (!result.ok) onFailure?.(result.message) }) }, [id, onFailure]),
    forward: useCallback(() => { void stepSidePaneHistory(id, 'forward').then(result => { if (!result.ok) onFailure?.(result.message) }) }, [id, onFailure]),
  }
}
export function requestFilePaneFiles(id: string): void {
  const state = getFilePaneSession(id)
  updateFilePaneSession(id, { open: true, filesRequest: state.filesRequest + 1 })
  showSlotOccupant(id, 'file')
}
export async function stepSidePaneHistory(id: string, direction: 'back' | 'forward'): Promise<PreviewOpenResult> {
  if (stepping.has(id)) return HANDLED
  const state = getFilePaneSession(id)
  const index = state.sideHistoryIndex + (direction === 'back' ? -1 : 1)
  const target = state.sideHistory[index]
  if (!target) return HANDLED
  const version = sideNavigationVersions.get(id) ?? 0
  const current = () => sessions.has(id) && (sideNavigationVersions.get(id) ?? 0) === version
  stepping.add(id)
  try {
    if (state.visible === 'file') await captureFilePaneScroll(id)
    if (!current()) return HANDLED
    if (target.kind === 'browser') {
      const result = await window.catcode.browserPaneCommand({ appSessionId: id, command: 'history', historyEntry: target.entry })
      if (!result.ok) return result
    } else if (target.kind === 'file' && target.target) {
      const file = getFilePaneSession(id).file
      let restored = false
      if (file?.kind === 'localhost' && target.target.routeKey && target.target.previewId === file.id) {
        let descriptor: FilePreviewDescriptor | null = null
        try { descriptor = await window.catcode.navigateLocalhostPreview(file.id, target.target.routeKey, target.target.scroll) } catch { /* Recreate retired routes through the normal preview boundary. */ }
        if (!current()) return HANDLED
        if (descriptor) {
          updateFilePaneSession(id, { file: descriptor, committedFile: descriptor, checkpoint: null, open: true, scroll: target.target.scroll, lastPath: descriptor.path, note: previewDescriptorNote(descriptor) })
          restored = true
        }
      }
      if (!restored) {
        const result = await openFile(id, target.target.path, { textWindow: target.target.scroll.textWindow })
        if (!result.ok) return result
        if (!current()) return HANDLED
        updateFilePaneSession(id, { scroll: target.target.scroll })
      }
    } else if (target.kind === 'file') updateFilePaneSession(id, { open: true, filesRequest: getFilePaneSession(id).filesRequest + 1 })
    else if (target.kind === 'worker') updateFilePaneSession(id, { worker: target.worker })
    else if (target.kind === 'output') updateFilePaneSession(id, { output: { ...target.output, request: (getFilePaneSession(id).output?.request ?? 0) + 1 } })
    if (!current()) return HANDLED
    revealSlotOccupant(id, target.kind)
    updateFilePaneSession(id, { sideHistoryIndex: index })
    return HANDLED
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'Could not restore this pane' } }
  finally { if ((sideNavigationVersions.get(id) ?? 0) === version) stepping.delete(id) }
}
export function registerFilePaneFocus(id: string, focus: () => void): () => void {
  focusers.set(id, focus)
  return () => { if (focusers.get(id) === focus) focusers.delete(id) }
}
export function registerFilePaneViewerFocus(id: string, focus: () => void, failed?: () => void): () => void {
  const callbacks = { focus, failed }
  viewerFocusers.set(id, callbacks)
  return () => { if (viewerFocusers.get(id) === callbacks) viewerFocusers.delete(id) }
}
function restoreViewerFocus(id: string, failed: boolean): void {
  const request = viewerFocusRequests.get(id)
  if (!request || request.token !== opening.get(id)) return
  viewerFocusRequests.delete(id)
  const active = typeof document === 'undefined' ? null : document.activeElement
  const ownsFocus = active === request.origin || !request.origin?.isConnected && (active === null || typeof document !== 'undefined' && active === document.body)
  if (ownsFocus) {
    const callbacks = viewerFocusers.get(id)
    if (failed) callbacks?.failed?.()
    else callbacks?.focus()
  }
}
export function failFilePaneOpen(id: string): void { restoreViewerFocus(id, true) }
export function commitOpenedFilePane(id: string, descriptor: FilePreviewDescriptor): void {
  const state = getFilePaneSession(id)
  if (!state.open || !samePaneRevision(state.committedFile, descriptor)) return
  if (descriptor.kind !== 'localhost') updateFilePaneSession(id, {
    opened: rememberOpenedFile(state.opened, descriptor.path, state.scroll, state.requestedPath ?? undefined),
  })
  restoreViewerFocus(id, false)
}
export function registerFilePaneScroll(id: string, read: () => Promise<FilePaneScroll>): () => void {
  scrollReaders.set(id, read)
  return () => { if (scrollReaders.get(id) === read) scrollReaders.delete(id) }
}
export function rememberFilePaneScroll(id: string, scroll: FilePaneScroll, source?: FilePreviewDescriptor): void {
  if (!sessions.has(id)) return
  const state = getFilePaneSession(id)
  const matches = (file: FilePreviewDescriptor | null) => !!source && samePaneRevision(file, source) && file?.path === source.path && file.routeKey === source.routeKey
  // The old painted page remains live while another target loads. Its samples
  // belong to the rollback bookmark, never to that incoming target's scroll.
  if (source && !matches(state.file)) {
    if (!state.checkpoint || !matches(state.checkpoint.file) && !matches(state.checkpoint.committedFile)) return
    const history = [...state.history]
    const last = history.at(-1)
    if (last?.path === source.path && last.routeKey === source.routeKey) history[history.length - 1] = { ...last, scroll }
    const withScroll = (entries: readonly SidePaneEntry[], index: number) => entries.map((entry, position) =>
      position === index && entry.kind === 'file' && entry.target?.path === source.path && entry.target.routeKey === source.routeKey
        ? { ...entry, target: { ...entry.target, scroll } } : entry)
    sessions.set(id, { ...state, history,
      sideHistory: withScroll(state.sideHistory, state.sideHistoryIndex),
      checkpoint: { ...state.checkpoint, scroll, sideHistory: withScroll(state.checkpoint.sideHistory, state.checkpoint.sideHistoryIndex) },
      opened: source.kind !== 'localhost' ? updateOpenedFileScroll(state.opened, source.path, scroll) : state.opened })
    return
  }
  // Scroll is read when navigating. It does not repaint the shell on every pixel.
  const current = state.sideHistory[state.sideHistoryIndex]
  const sideHistory = current?.kind === 'file' && current.target && (!source || current.target.path === source.path && current.target.routeKey === source.routeKey)
    ? state.sideHistory.map((entry, index) => index === state.sideHistoryIndex ? { ...current, target: { ...current.target!, scroll } } : entry) : state.sideHistory
  sessions.set(id, { ...state, sideHistory, scroll, opened: source && source.kind !== 'localhost' ? updateOpenedFileScroll(state.opened, source.path, scroll) : state.opened })
}
async function captureScroll(id: string): Promise<FilePaneScroll> {
  try { return await scrollReaders.get(id)?.() ?? getFilePaneSession(id).scroll } catch { return getFilePaneSession(id).scroll }
}
async function captureForNavigation(id: string): Promise<FilePaneScroll> {
  const state = getFilePaneSession(id)
  const page = state.committedFile?.kind === 'localhost' ? state.committedFile : state.file?.kind === 'localhost' ? state.file : null
  const scroll = await captureScroll(id)
  if (page) {
    try { await window.catcode.captureLocalhostPreview(page.id) } catch { /* Navigation remains available if a bounded capture cannot finish. */ }
  }
  rememberFilePaneScroll(id, scroll, state.checkpoint?.committedFile ?? state.committedFile ?? state.file ?? undefined)
  return scroll
}
export async function captureFilePaneScroll(id: string): Promise<void> {
  const state = getFilePaneSession(id)
  const source = state.checkpoint?.committedFile ?? state.checkpoint?.file ?? state.committedFile ?? state.file
  rememberFilePaneScroll(id, await captureForNavigation(id), source ?? undefined)
}
export function readFilePaneWidth(): number {
  return readViewPreference(defaultViewPreferenceStorage(), FILE_WIDTH_KEY, 'width', value =>
    typeof value === 'number' && Number.isFinite(value) && value >= 360 && value <= 4000 ? value : null) ?? 620
}
export function rememberSlotWidth(id: string, width: number): void {
  const state = getFilePaneSession(id)
  updateFilePaneSession(id, { width })
  if (state.open) writeViewPreference(defaultViewPreferenceStorage(), FILE_WIDTH_KEY, 'width', width)
}
export function showSlotOccupant(id: string, visible: SlotOccupant): void {
  cancelSidePaneStep(id)
  revealSlotOccupant(id, visible)
}
function revealSlotOccupant(id: string, visible: SlotOccupant): void {
  const state = getFilePaneSession(id)
  if (state.visible === 'file' && visible !== 'file') {
    const index = state.sideHistoryIndex
    const entry = state.sideHistory[index]
    void captureForNavigation(id).then(scroll => {
      const current = sessions.get(id)
      if (!current || entry?.kind !== 'file' || !entry.target || !sameSidePaneEntry(current.sideHistory[index], entry)) return
      updateFilePaneSession(id, { sideHistory: current.sideHistory.map((item, position) => position === index ? { ...entry, target: { ...entry.target!, scroll } } : item) })
    })
  }
  const width = state.width ?? (visible === 'file' ? readFilePaneWidth() : visible === 'worker' ? 480 : readToolOutputWidth())
  updateFilePaneSession(id, {
    visible, width,
    ...(state.hiddenScreens.includes(visible as ScreenKind) ? { hiddenScreens: state.hiddenScreens.filter(kind => kind !== visible) } : {}),
  })
}
/** Hiding a screen does not end browser automation or discard captured computer steps. */
export function hideScreenPane(id: string, kind: ScreenKind): void {
  cancelSidePaneStep(id)
  const state = getFilePaneSession(id)
  updateFilePaneSession(id, {
    ...(state.visible === kind ? { visible: null } : {}),
    screenActivity: { ...state.screenActivity, revealed: true },
    hiddenScreens: state.hiddenScreens.includes(kind) ? state.hiddenScreens : [...state.hiddenScreens, kind],
  })
}
export function closeFilePane(id: string): void {
  hideSidePane(id)
}
export function hideSidePane(id: string): void {
  cancelSidePaneStep(id)
  opening.set(id, (opening.get(id) ?? 0) + 1)
  viewerFocusRequests.delete(id)
  if (getFilePaneSession(id).visible === 'file') void captureFilePaneScroll(id)
  updateFilePaneSession(id, { visible: null })
}
function releaseUnusedCandidate(id: string, descriptor: FilePreviewDescriptor): void {
  const state = getFilePaneSession(id)
  if ([state.file?.id, state.committedFile?.id, state.checkpoint?.file?.id, state.checkpoint?.committedFile?.id].some(retained => retained === descriptor.id)) return
  if ((pendingOpenings.get(id)?.size ?? 0) > 1) {
    let deferred = deferredReleases.get(id)
    if (!deferred) { deferred = new Map(); deferredReleases.set(id, deferred) }
    deferred.set(descriptor.id, descriptor)
  } else window.catcode.releaseFilePreview(descriptor.id)
}
function beginOpening(id: string, token: number): void {
  let pending = pendingOpenings.get(id)
  if (!pending) { pending = new Set(); pendingOpenings.set(id, pending) }
  pending.add(token)
}
function flushDeferredReleases(id: string, force = false): void {
  const deferred = deferredReleases.get(id)
  deferredReleases.delete(id)
  deferred?.forEach(descriptor => { if (force) window.catcode.releaseFilePreview(descriptor.id); else releaseUnusedCandidate(id, descriptor) })
}
function finishOpening(id: string, token: number): void {
  const pending = pendingOpenings.get(id)
  pending?.delete(token)
  if (!pending?.size) {
    pendingOpenings.delete(id)
    flushDeferredReleases(id)
  }
}
async function prepare(id: string, path: string, source?: FilePreviewSource, textWindow?: 'start' | 'end'): Promise<({ ok: true; descriptor: FilePreviewDescriptor; location?: { line: number; column?: number } } | { ok: false; message: string; reason?: string })> {
  try {
    const local = normalizeLocalhostPreviewUrl(path)
    if (local) {
      const result = await window.catcode.prepareLocalhostPreview(id, local)
      return result.ok ? result : { ok: false, message: result.reason === 'unavailable' ? `Nothing is running at ${result.hostPort}` : 'Could not open this page' }
    }
    const result = await window.catcode.prepareFilePreview(id, path, source, textWindow)
    return result.ok ? result : { ok: false, reason: result.reason,
      message: result.reason === 'missing' ? `Could not find ${paneTargetLabel(path)}` : result.reason === 'binary' ? `${paneTargetLabel(path)} is not a text file` : 'Could not open this file' }
  } catch { return { ok: false, message: normalizeLocalhostPreviewUrl(path) ? 'Could not open this page' : 'Could not open this file' } }
}
export async function requestOpenFile(id: string, path: string, options?: { external?: boolean; source?: FilePreviewSource; focus?: 'composer' | 'viewer'; textWindow?: 'start' | 'end' }): Promise<PreviewOpenResult> {
  cancelSidePaneStep(id)
  return openFile(id, path, options)
}
async function openFile(id: string, path: string, options?: { external?: boolean; source?: FilePreviewSource; focus?: 'composer' | 'viewer'; textWindow?: 'start' | 'end' }): Promise<PreviewOpenResult> {
  if (options?.external || !options?.source && !isPaneFilePath(path) && !normalizeLocalhostPreviewUrl(path)) {
    try {
      if (!isPaneFilePath(path) && !normalizeLocalhostPreviewUrl(path)) return await window.catcode.openWorkspaceFile(id, path) ? HANDLED : refusal(path)
      const apps = await window.catcode.getFilePreviewApplications(id, path)
      return await window.catcode.chooseFilePreviewApplication(id, path, apps.selected) ? HANDLED : refusal(path)
    } catch { return refusal(path) }
  }
  const token = (opening.get(id) ?? 0) + 1
  opening.set(id, token)
  beginOpening(id, token)
  if (options?.focus === 'viewer') viewerFocusRequests.set(id, { token, origin: typeof document === 'undefined' ? null : document.activeElement })
  else viewerFocusRequests.delete(id)
  try {
    const saved = findOpenedFile(getFilePaneSession(id).opened, path)
    const result = await prepare(id, path, options?.source, options?.textWindow ?? saved?.scroll.textWindow)
    if (!result.ok) {
      if (opening.get(id) !== token) return HANDLED
      if (result.reason === 'external' && !options?.source) return await window.catcode.openWorkspaceFile(id, path) ? HANDLED : refusal(path)
      return result
    }
    const descriptor = result.descriptor
    if (opening.get(id) !== token) { releaseUnusedCandidate(id, descriptor); return HANDLED }
    let previous = getFilePaneSession(id)
    if (previous.open && previous.file?.path === descriptor.path && previous.file.id === descriptor.id) {
      if (descriptor.kind === 'text' && result.location) updateFilePaneSession(id, { lineTarget: { line: result.location.line, token }, scroll: { x: 0, y: 0, topLine: result.location.line }, requestedPath: path })
      if (descriptor.kind === 'text' && options?.textWindow && descriptor.textWindow?.side !== previous.file.textWindow?.side) updateFilePaneSession(id, { file: descriptor, scroll: { x: 0, y: 0 }, lineTarget: null })
      revealSlotOccupant(id, 'file')
      if (options?.focus !== 'viewer') focusers.get(id)?.()
      else commitOpenedFilePane(id, previous.committedFile ?? descriptor)
      return HANDLED
    }
    const scroll = await captureForNavigation(id)
    if (opening.get(id) !== token) { releaseUnusedCandidate(id, descriptor); return HANDLED }
    previous = getFilePaneSession(id)
    const settled = previous.checkpoint ?? previous
    const outgoing = settled.committedFile ?? settled.file
    const opened = outgoing && outgoing.kind !== 'localhost' ? updateOpenedFileScroll(previous.opened, outgoing.path, scroll) : previous.opened
    const incomingScroll = findOpenedFile(opened, path)?.scroll
    updateFilePaneSession(id, {
      opened,
      checkpoint: previous.checkpoint ? { ...previous.checkpoint, scroll } : fileCheckpoint(previous, scroll),
      file: descriptor, open: true, lastPath: descriptor.path, visible: 'file',
      width: previous.width ?? readFilePaneWidth(), note: previewDescriptorNote(descriptor),
      requestedPath: path,
      lineTarget: descriptor.kind === 'text' && result.location ? { line: result.location.line, token } : null,
      scroll: descriptor.kind === 'text' && result.location ? { x: 0, y: 0, topLine: result.location.line } : options?.textWindow ? { x: 0, y: 0 } : incomingScroll ?? { x: 0, y: 0 },
      history: settled.open && settled.file ? settled.file.path === descriptor.path ? settled.history : [...settled.history, historyEntry(settled.file, scroll)] : [], forward: [],
    })
    if (previous.file && previous.file.id !== previous.committedFile?.id && previous.file.id !== descriptor.id) window.catcode.releaseFilePreview(previous.file.id)
    if (options?.focus !== 'viewer') focusers.get(id)?.()
    return HANDLED
  } finally { finishOpening(id, token) }
}
export async function toggleFilePane(id: string, newestPath?: string | null): Promise<PreviewOpenResult> {
  const state = getFilePaneSession(id)
  if (state.open) {
    if (state.visible === 'file') closeFilePane(id)
    else showSlotOccupant(id, 'file')
    focusers.get(id)?.()
    return HANDLED
  }
  const path = state.lastPath ?? newestPath
  return path ? requestOpenFile(id, path) : HANDLED
}
export async function stepFilePaneHistory(id: string, direction: 'back' | 'forward'): Promise<PreviewOpenResult> {
  const state = getFilePaneSession(id)
  const entries = direction === 'back' ? state.history : state.forward
  const target = entries.at(-1)
  if (!state.open || !state.file || !target) return HANDLED
  const token = (opening.get(id) ?? 0) + 1
  opening.set(id, token)
  beginOpening(id, token)
  try {
    const scroll = await captureForNavigation(id)
    if (opening.get(id) !== token || !getFilePaneSession(id).open) return HANDLED
    let descriptor: FilePreviewDescriptor | null = null
    if (state.file.kind === 'localhost' && target.routeKey && target.previewId === state.file.id) {
      try { descriptor = await window.catcode.navigateLocalhostPreview(state.file.id, target.routeKey, { x: target.scroll.x, y: target.scroll.y }) } catch { /* The host can recreate a retired route from its bounded boot record. */ }
    }
    if (!descriptor) {
      const result = await prepare(id, target.path, undefined, target.scroll.textWindow)
      if (!result.ok) return opening.get(id) === token ? result : HANDLED
      descriptor = result.descriptor
    }
    if (opening.get(id) !== token || !getFilePaneSession(id).open) { releaseUnusedCandidate(id, descriptor); return HANDLED }
    const inPlace = descriptor.kind === 'localhost' && samePaneRevision(state.file, descriptor)
    const outgoing = state.checkpoint?.committedFile ?? state.checkpoint?.file ?? state.committedFile ?? state.file
    const current = historyEntry(outgoing, scroll)
    updateFilePaneSession(id, {
      opened: outgoing.kind !== 'localhost' ? updateOpenedFileScroll(getFilePaneSession(id).opened, outgoing.path, scroll) : getFilePaneSession(id).opened,
      checkpoint: inPlace ? null : state.checkpoint ? { ...state.checkpoint, scroll } : fileCheckpoint(state, scroll),
      ...(inPlace ? { committedFile: descriptor } : {}),
      file: descriptor, lastPath: descriptor.path, requestedPath: target.path, lineTarget: null, scroll: target.scroll, note: previewDescriptorNote(descriptor),
      history: direction === 'back' ? state.history.slice(0, -1) : [...state.history, current],
      forward: direction === 'forward' ? state.forward.slice(0, -1) : [...state.forward, current],
    })
    if (state.file.id !== state.committedFile?.id && state.file.id !== descriptor.id) window.catcode.releaseFilePreview(state.file.id)
    return HANDLED
  } finally { finishOpening(id, token) }
}

export function recordLocalhostRoute(id: string, url: string, outgoingScroll: FilePreviewScroll, routeKey: string, replace = false, browserNote?: LocalhostPreviewNote): void {
  const state = getFilePaneSession(id)
  const normalized = normalizeLocalhostPreviewUrl(url)
  if (!state.open || state.file?.kind !== 'localhost' || !normalized || !routeKey || state.file.routeKey === routeKey) return
  const parsed = new URL(normalized)
  const path = parsed.pathname === '/' && !parsed.search && !parsed.hash ? '' : `${parsed.pathname}${parsed.search}${parsed.hash}`
  const file: FilePreviewDescriptor = { ...state.file, path: normalized, displayPath: `${parsed.host}${path}`, routeKey, blockedHost: undefined, browserNote }
  rememberFilePaneScroll(id, outgoingScroll, state.file)
  const retained = getFilePaneSession(id)
  updateFilePaneSession(id, {
    file, ...(samePaneRevision(state.committedFile, file) ? { committedFile: file } : {}), lastPath: normalized,
    history: replace ? state.history : [...state.history, historyEntry(state.file, outgoingScroll)], forward: replace ? state.forward : [], scroll: { x: 0, y: 0 }, note: previewDescriptorNote(file),
    ...(replace ? { sideHistory: retained.sideHistory.map((entry, index) => index === retained.sideHistoryIndex && entry.kind === 'file' ? { kind: 'file' as const, target: historyEntry(file, { x: 0, y: 0 }) } : entry) } : {}),
  })
}

/** A file navigation becomes history only once its staged render is usable. */
export function rejectFilePaneCandidate(id: string, descriptor: FilePreviewDescriptor): boolean {
  const state = getFilePaneSession(id)
  if (!state.open || !samePaneRevision(state.file, descriptor)) return false
  const checkpoint = state.checkpoint
  if (checkpoint) {
    const retired = checkpoint.visible === 'worker' && !state.worker || checkpoint.visible === 'output' && !state.output ||
      checkpoint.visible === 'browser' && !state.browser || checkpoint.visible === 'computer' && !state.computer
    const previousVisible = retired ? checkpoint.open ? 'file' : null : checkpoint.visible
    updateFilePaneSession(id, {
      ...checkpoint,
      ...(state.visible !== 'file' ? { sideHistory: state.sideHistory, sideHistoryIndex: state.sideHistoryIndex } : {}),
      visible: state.visible === 'file' ? previousVisible : state.visible,
      checkpoint: null,
    })
    if (descriptor.id !== checkpoint.file?.id && descriptor.id !== checkpoint.committedFile?.id) window.catcode.releaseFilePreview(descriptor.id)
    return true
  }
  updateFilePaneSession(id, { file: state.committedFile, note: previewDescriptorNote(state.committedFile) ?? 'update-error' })
  return false
}

/** Confirmed session retirement releases resources; an ordinary switch does not. */
export function disposeFilePaneSession(id: string): void {
  cancelSidePaneStep(id)
  disposeWorkspaceFileAvailability(id)
  opening.set(id, (opening.get(id) ?? 0) + 1)
  const state = sessions.get(id)
  sessions.delete(id)
  flushDeferredReleases(id, true)
  focusers.delete(id)
  viewerFocusers.delete(id)
  viewerFocusRequests.delete(id)
  scrollReaders.delete(id)
  if (state?.file) window.catcode?.releaseFilePreview(state.file.id)
  if (state?.committedFile && state.committedFile.id !== state.file?.id) window.catcode?.releaseFilePreview(state.committedFile.id)
  listeners.get(id)?.forEach(listener => listener())
}
