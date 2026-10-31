import { useCallback, useSyncExternalStore } from 'react'
import { filePreviewKind, normalizeLocalhostPreviewUrl, localhostPreviewHostPort, type FilePreviewDescriptor, type FilePreviewScroll, type LocalhostPreviewNote } from '../../shared/filePreview.js'
import type { MarkdownReadingPosition } from './markdownReadingPosition.js'
import type { SubagentDockRow } from './subagentDockState.js'
import { defaultViewPreferenceStorage, readViewPreference, writeViewPreference } from './viewPreference.js'
import { readToolOutputWidth } from './toolOutputPanel.js'

export type SlotOccupant = 'file' | 'worker' | 'output'
export type FilePaneScroll = FilePreviewScroll & { markdown?: MarkdownReadingPosition }
export type PreviewOpenResult = { ok: true } | { ok: false; message: string }
export type FilePaneHistoryEntry = { path: string; scroll: FilePaneScroll; routeKey?: string; baseUrl?: string; previewId?: string }
export type FilePaneOutput = { id: string; fileIndex: number; request: number }
type FilePaneCheckpoint = Pick<FilePaneSession, 'open' | 'file' | 'committedFile' | 'lastPath' | 'visible' | 'width' | 'history' | 'forward' | 'scroll' | 'note'>
export type FilePaneSession = {
  open: boolean
  file: FilePreviewDescriptor | null
  committedFile: FilePreviewDescriptor | null
  lastPath: string | null
  visible: SlotOccupant | null
  worker: SubagentDockRow | null
  output: FilePaneOutput | null
  width: number | null
  history: FilePaneHistoryEntry[]
  forward: FilePaneHistoryEntry[]
  scroll: FilePaneScroll
  note: 'removed' | 'watch-error' | 'update-error' | 'server-stopped' | 'leave' | LocalhostPreviewNote | null
  checkpoint: FilePaneCheckpoint | null
}
const EMPTY: FilePaneSession = {
  open: false, file: null, committedFile: null, lastPath: null, visible: null,
  worker: null, output: null, width: null, history: [], forward: [], scroll: { x: 0, y: 0 }, note: null, checkpoint: null,
}
const sessions = new Map<string, FilePaneSession>()
const listeners = new Map<string, Set<() => void>>()
const focusers = new Map<string, () => void>()
const scrollReaders = new Map<string, () => Promise<FilePaneScroll>>()
const opening = new Map<string, number>()
const pendingOpenings = new Map<string, Set<number>>()
const deferredReleases = new Map<string, Map<string, FilePreviewDescriptor>>()
const FILE_WIDTH_KEY = 'catcode.filePaneWidth.v1'

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
export function useFilePaneSession(id: string): FilePaneSession {
  const subscribe = useCallback((listener: () => void) => {
    let group = listeners.get(id)
    if (!group) { group = new Set(); listeners.set(id, group) }
    group.add(listener)
    return () => { group.delete(listener); if (!group.size) listeners.delete(id) }
  }, [id])
  const snapshot = useCallback(() => getFilePaneSession(id), [id])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
export function updateFilePaneSession(id: string, patch: Partial<FilePaneSession>): void {
  const next = { ...getFilePaneSession(id), ...patch }
  if (!next.open && !next.worker && !next.output) { next.visible = null; next.width = null }
  else if (next.visible === 'file' && !next.open || next.visible === 'worker' && !next.worker || next.visible === 'output' && !next.output) {
    next.visible = next.open ? 'file' : next.worker ? 'worker' : 'output'
  }
  sessions.set(id, next)
  listeners.get(id)?.forEach(listener => listener())
}
export function registerFilePaneFocus(id: string, focus: () => void): () => void {
  focusers.set(id, focus)
  return () => { if (focusers.get(id) === focus) focusers.delete(id) }
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
    sessions.set(id, { ...state, history, checkpoint: { ...state.checkpoint, scroll } })
    return
  }
  // Scroll is read when navigating. It does not repaint the shell on every pixel.
  sessions.set(id, { ...state, scroll })
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
  return scroll
}
export async function captureFilePaneScroll(id: string): Promise<void> {
  rememberFilePaneScroll(id, await captureForNavigation(id))
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
  const state = getFilePaneSession(id)
  const width = state.width ?? (visible === 'file' ? readFilePaneWidth() : visible === 'worker' ? 480 : readToolOutputWidth())
  updateFilePaneSession(id, { visible, width })
}
export function closeFilePane(id: string): void {
  opening.set(id, (opening.get(id) ?? 0) + 1)
  const { file, committedFile } = getFilePaneSession(id)
  updateFilePaneSession(id, { open: false, file: null, committedFile: null, history: [], forward: [], note: null, checkpoint: null })
  flushDeferredReleases(id, true)
  if (file) window.catcode?.releaseFilePreview(file.id)
  if (committedFile && committedFile.id !== file?.id) window.catcode?.releaseFilePreview(committedFile.id)
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
async function prepare(id: string, path: string): Promise<({ ok: true; descriptor: FilePreviewDescriptor } | { ok: false; message: string })> {
  try {
    const local = normalizeLocalhostPreviewUrl(path)
    if (local) {
      const result = await window.catcode.prepareLocalhostPreview(id, local)
      return result.ok ? result : { ok: false, message: result.reason === 'unavailable' ? `Nothing is running at ${result.hostPort}` : 'Could not open this page' }
    }
    const descriptor = await window.catcode.prepareFilePreview(id, path)
    return descriptor ? { ok: true, descriptor } : { ok: false, message: 'Could not open this file' }
  } catch { return { ok: false, message: normalizeLocalhostPreviewUrl(path) ? 'Could not open this page' : 'Could not open this file' } }
}
export async function requestOpenFile(id: string, path: string, options?: { external?: boolean }): Promise<PreviewOpenResult> {
  if (options?.external) {
    try {
      const apps = await window.catcode.getFilePreviewApplications(id, path)
      return await window.catcode.chooseFilePreviewApplication(id, path, apps.selected) ? HANDLED : refusal(path)
    } catch { return refusal(path) }
  }
  const token = (opening.get(id) ?? 0) + 1
  opening.set(id, token)
  beginOpening(id, token)
  try {
    const result = await prepare(id, path)
    if (!result.ok) return opening.get(id) === token ? result : HANDLED
    const descriptor = result.descriptor
    if (opening.get(id) !== token) { releaseUnusedCandidate(id, descriptor); return HANDLED }
    const previous = getFilePaneSession(id)
    if (previous.open && previous.file?.path === descriptor.path) {
      if (previous.file.id !== descriptor.id) window.catcode.releaseFilePreview(descriptor.id)
      showSlotOccupant(id, 'file')
      focusers.get(id)?.()
      return HANDLED
    }
    const scroll = await captureForNavigation(id)
    if (opening.get(id) !== token) { releaseUnusedCandidate(id, descriptor); return HANDLED }
    const settled = previous.checkpoint ?? previous
    updateFilePaneSession(id, {
      checkpoint: previous.checkpoint ?? { ...previous, scroll },
      file: descriptor, open: true, lastPath: descriptor.path, visible: 'file',
      width: previous.width ?? readFilePaneWidth(), note: previewDescriptorNote(descriptor), scroll: { x: 0, y: 0 },
      history: settled.open && settled.file ? [...settled.history, historyEntry(settled.file, previous.checkpoint ? settled.scroll : scroll)] : [], forward: [],
    })
    if (previous.file && previous.file.id !== previous.committedFile?.id && previous.file.id !== descriptor.id) window.catcode.releaseFilePreview(previous.file.id)
    focusers.get(id)?.()
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
      const result = await prepare(id, target.path)
      if (!result.ok) return opening.get(id) === token ? result : HANDLED
      descriptor = result.descriptor
    }
    if (opening.get(id) !== token || !getFilePaneSession(id).open) { releaseUnusedCandidate(id, descriptor); return HANDLED }
    const inPlace = descriptor.kind === 'localhost' && samePaneRevision(state.file, descriptor)
    const current = historyEntry(state.file, scroll)
    updateFilePaneSession(id, {
      checkpoint: inPlace ? null : state.checkpoint ?? { ...state, scroll },
      ...(inPlace ? { committedFile: descriptor } : {}),
      file: descriptor, lastPath: descriptor.path, scroll: target.scroll, note: previewDescriptorNote(descriptor),
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
  updateFilePaneSession(id, {
    file, ...(samePaneRevision(state.committedFile, file) ? { committedFile: file } : {}), lastPath: normalized,
    history: replace ? state.history : [...state.history, historyEntry(state.file, outgoingScroll)], forward: replace ? state.forward : [], scroll: { x: 0, y: 0 }, note: previewDescriptorNote(file),
  })
}

/** A file navigation becomes history only once its staged render is usable. */
export function rejectFilePaneCandidate(id: string, descriptor: FilePreviewDescriptor): boolean {
  const state = getFilePaneSession(id)
  if (!state.open || !samePaneRevision(state.file, descriptor)) return false
  const checkpoint = state.checkpoint
  if (checkpoint) {
    updateFilePaneSession(id, { ...checkpoint, checkpoint: null, visible: state.visible === 'file' ? checkpoint.visible : state.visible })
    if (descriptor.id !== checkpoint.file?.id && descriptor.id !== checkpoint.committedFile?.id) window.catcode.releaseFilePreview(descriptor.id)
    return true
  }
  updateFilePaneSession(id, { file: state.committedFile, note: previewDescriptorNote(state.committedFile) ?? 'update-error' })
  return false
}

/** Confirmed session retirement releases resources; an ordinary switch does not. */
export function disposeFilePaneSession(id: string): void {
  opening.set(id, (opening.get(id) ?? 0) + 1)
  const state = sessions.get(id)
  sessions.delete(id)
  flushDeferredReleases(id, true)
  focusers.delete(id)
  scrollReaders.delete(id)
  if (state?.file) window.catcode?.releaseFilePreview(state.file.id)
  if (state?.committedFile && state.committedFile.id !== state.file?.id) window.catcode?.releaseFilePreview(state.committedFile.id)
  listeners.get(id)?.forEach(listener => listener())
}
