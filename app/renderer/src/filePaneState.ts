import { useCallback, useSyncExternalStore } from 'react'
import { filePreviewKind, type FilePreviewDescriptor, type FilePreviewScroll } from '../../shared/filePreview.js'
import type { MarkdownReadingPosition } from './markdownReadingPosition.js'
import type { SubagentDockRow } from './subagentDockState.js'
import { defaultViewPreferenceStorage, readViewPreference, writeViewPreference } from './viewPreference.js'
import { readToolOutputWidth } from './toolOutputPanel.js'

export type SlotOccupant = 'file' | 'worker' | 'output'
export type FilePaneScroll = FilePreviewScroll & { markdown?: MarkdownReadingPosition }
export type FilePaneHistoryEntry = { path: string; scroll: FilePaneScroll }
export type FilePaneOutput = { id: string; fileIndex: number; request: number }
type FilePaneCheckpoint = Pick<FilePaneSession, 'open' | 'file' | 'committedFile' | 'lastPath' | 'visible' | 'width' | 'history' | 'forward' | 'scroll' | 'note'>
export type FilePaneSession = {
  open: boolean
  file: FilePreviewDescriptor | null
  committedFile: FilePreviewDescriptor | null
  lastPath: string | null
  candidatePath: string | null
  visible: SlotOccupant | null
  worker: SubagentDockRow | null
  output: FilePaneOutput | null
  width: number | null
  history: FilePaneHistoryEntry[]
  forward: FilePaneHistoryEntry[]
  scroll: FilePaneScroll
  note: 'removed' | 'watch-error' | 'update-error' | null
  checkpoint: FilePaneCheckpoint | null
}
const EMPTY: FilePaneSession = {
  open: false, file: null, committedFile: null, lastPath: null, candidatePath: null, visible: null,
  worker: null, output: null, width: null, history: [], forward: [], scroll: { x: 0, y: 0 }, note: null, checkpoint: null,
}
const sessions = new Map<string, FilePaneSession>()
const listeners = new Map<string, Set<() => void>>()
const focusers = new Map<string, () => void>()
const scrollReaders = new Map<string, () => Promise<FilePaneScroll>>()
const opening = new Map<string, number>()
const FILE_WIDTH_KEY = 'catcode.filePaneWidth.v1'

export function isPaneFilePath(path: string): boolean { return filePreviewKind(path) !== null }
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
export function setFilePaneCandidate(id: string, path: string | null): void {
  if (getFilePaneSession(id).candidatePath !== path) updateFilePaneSession(id, { candidatePath: path })
}
export function registerFilePaneFocus(id: string, focus: () => void): () => void {
  focusers.set(id, focus)
  return () => { if (focusers.get(id) === focus) focusers.delete(id) }
}
export function registerFilePaneScroll(id: string, read: () => Promise<FilePaneScroll>): () => void {
  scrollReaders.set(id, read)
  return () => { if (scrollReaders.get(id) === read) scrollReaders.delete(id) }
}
export function rememberFilePaneScroll(id: string, scroll: FilePaneScroll): void {
  if (!sessions.has(id)) return
  // Scroll is read when navigating. It does not repaint the shell on every pixel.
  sessions.set(id, { ...getFilePaneSession(id), scroll })
}
async function captureScroll(id: string): Promise<FilePaneScroll> {
  try { return await scrollReaders.get(id)?.() ?? getFilePaneSession(id).scroll } catch { return getFilePaneSession(id).scroll }
}
export async function captureFilePaneScroll(id: string): Promise<void> {
  rememberFilePaneScroll(id, await captureScroll(id))
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
  if (file) window.catcode?.releaseFilePreview(file.id)
  if (committedFile && committedFile.id !== file?.id) window.catcode?.releaseFilePreview(committedFile.id)
}
function releaseUnusedCandidate(id: string, descriptor: FilePreviewDescriptor): void {
  const state = getFilePaneSession(id)
  if ([state.file?.id, state.committedFile?.id, state.checkpoint?.file?.id, state.checkpoint?.committedFile?.id].every(retained => retained !== descriptor.id)) window.catcode.releaseFilePreview(descriptor.id)
}
async function prepare(id: string, path: string): Promise<FilePreviewDescriptor | null> {
  try { return await window.catcode?.prepareFilePreview(id, path) ?? null } catch { return null }
}
export async function requestOpenFile(id: string, path: string, options?: { external?: boolean }): Promise<boolean> {
  if (options?.external) {
    try {
      const apps = await window.catcode.getFilePreviewApplications(id, path)
      return await window.catcode.chooseFilePreviewApplication(id, path, apps.selected)
    } catch { return false }
  }
  const token = (opening.get(id) ?? 0) + 1
  opening.set(id, token)
  const descriptor = await prepare(id, path)
  if (!descriptor) return false
  if (opening.get(id) !== token) { releaseUnusedCandidate(id, descriptor); return false }
  const previous = getFilePaneSession(id)
  if (previous.open && previous.file?.path === descriptor.path) {
    if (previous.file.id !== descriptor.id) window.catcode.releaseFilePreview(descriptor.id)
    showSlotOccupant(id, 'file')
    focusers.get(id)?.()
    return true
  }
  const scroll = await captureScroll(id)
  if (opening.get(id) !== token) { releaseUnusedCandidate(id, descriptor); return false }
  const settled = previous.checkpoint ?? previous
  updateFilePaneSession(id, {
    checkpoint: previous.checkpoint ?? { ...previous, scroll },
    file: descriptor, open: true, lastPath: descriptor.path, visible: 'file',
    width: previous.width ?? readFilePaneWidth(), note: descriptor.watchError ? 'watch-error' : null, scroll: { x: 0, y: 0 },
    history: settled.open && settled.file ? [...settled.history, { path: settled.file.path, scroll: previous.checkpoint ? settled.scroll : scroll }] : [], forward: [],
  })
  if (previous.file && previous.file.id !== previous.committedFile?.id && previous.file.id !== descriptor.id) window.catcode.releaseFilePreview(previous.file.id)
  focusers.get(id)?.()
  return true
}
export async function toggleFilePane(id: string, newestPath?: string | null): Promise<boolean> {
  const state = getFilePaneSession(id)
  if (state.open) {
    if (state.visible === 'file') closeFilePane(id)
    else showSlotOccupant(id, 'file')
    focusers.get(id)?.()
    return true
  }
  const path = state.lastPath ?? newestPath ?? state.candidatePath
  return path ? requestOpenFile(id, path) : false
}
export async function stepFilePaneHistory(id: string, direction: 'back' | 'forward'): Promise<boolean> {
  const state = getFilePaneSession(id)
  const entries = direction === 'back' ? state.history : state.forward
  const target = entries.at(-1)
  if (!state.open || !state.file || !target) return false
  const token = (opening.get(id) ?? 0) + 1
  opening.set(id, token)
  const descriptor = await prepare(id, target.path)
  if (!descriptor) return false
  if (opening.get(id) !== token) { releaseUnusedCandidate(id, descriptor); return false }
  const scroll = await captureScroll(id)
  if (opening.get(id) !== token || !getFilePaneSession(id).open) { releaseUnusedCandidate(id, descriptor); return false }
  const current = { path: state.file.path, scroll }
  updateFilePaneSession(id, {
    checkpoint: state.checkpoint ?? { ...state, scroll },
    file: descriptor, lastPath: descriptor.path, scroll: target.scroll, note: descriptor.watchError ? 'watch-error' : null,
    history: direction === 'back' ? state.history.slice(0, -1) : [...state.history, current],
    forward: direction === 'forward' ? state.forward.slice(0, -1) : [...state.forward, current],
  })
  if (state.file.id !== state.committedFile?.id && state.file.id !== descriptor.id) window.catcode.releaseFilePreview(state.file.id)
  return true
}

/** A file navigation becomes history only once its staged render is usable. */
export function rejectFilePaneCandidate(id: string, descriptor: FilePreviewDescriptor): boolean {
  const state = getFilePaneSession(id)
  if (!state.open || state.file?.url !== descriptor.url) return false
  const checkpoint = state.checkpoint
  if (checkpoint) {
    updateFilePaneSession(id, { ...checkpoint, checkpoint: null, visible: state.visible === 'file' ? checkpoint.visible : state.visible })
    if (descriptor.id !== checkpoint.file?.id && descriptor.id !== checkpoint.committedFile?.id) window.catcode.releaseFilePreview(descriptor.id)
    return true
  }
  updateFilePaneSession(id, { file: state.committedFile, note: 'update-error' })
  return false
}

/** Confirmed session retirement releases resources; an ordinary switch does not. */
export function disposeFilePaneSession(id: string): void {
  opening.set(id, (opening.get(id) ?? 0) + 1)
  const state = sessions.get(id)
  sessions.delete(id)
  focusers.delete(id)
  scrollReaders.delete(id)
  if (state?.file) window.catcode?.releaseFilePreview(state.file.id)
  if (state?.committedFile && state.committedFile.id !== state.file?.id) window.catcode?.releaseFilePreview(state.committedFile.id)
  listeners.get(id)?.forEach(listener => listener())
}
