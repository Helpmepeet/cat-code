import type { FilePreviewDescriptor } from '../shared/filePreview.js'
import {
  parseFilePreviewDocumentRequest,
  type FilePreviewDocumentResult,
  type PreviewDocumentTableResult,
} from '../shared/previewDocument.js'

export interface PreviewDocumentSnapshot { descriptor: FilePreviewDescriptor; bytes: Uint8Array }

/** A retained preview grants bytes; renderer requests never grant paths or parser formats. */
export function createPreviewDocumentHost(deps: {
  snapshot: (id: string, revision: number) => Promise<PreviewDocumentSnapshot | null>
  authorized: (id: string, revision: number) => Promise<boolean>
  table: (input: { format: 'csv' | 'tsv' | 'xlsx'; bytes: Uint8Array; sheet?: string; sourceTruncated?: boolean }, signal: AbortSignal) => Promise<PreviewDocumentTableResult>
  abort: () => void | Promise<void>
}) {
  let generation = 0
  let active: { id: string; control: AbortController } | null = null
  let owner: { id: string; revision: number; sequence: number } | null = null
  let authorityTimer: ReturnType<typeof setInterval> | undefined
  let checkingAuthority = false
  function clearOwner() {
    owner = null
    clearInterval(authorityTimer)
    authorityTimer = undefined
  }
  async function abort(id?: string) {
    const activeMatches = id === undefined || active?.id === id
    const ownerMatches = id === undefined || owner?.id === id
    if (!activeMatches && !ownerMatches) return
    if (activeMatches) { generation++; active?.control.abort(); active = null }
    if (ownerMatches) { clearOwner(); await deps.abort() }
  }
  function retain(id: string, revision: number, sequence: number) {
    owner = { id, revision, sequence }
    if (authorityTimer) return
    authorityTimer = setInterval(() => {
      const current = owner
      if (!current || checkingAuthority) return
      checkingAuthority = true
      void deps.authorized(current.id, current.revision).catch(() => false).then(allowed => {
        if (owner === current && !allowed) void abort(current.id)
      }).finally(() => { checkingAuthority = false })
    }, 1500)
    authorityTimer.unref?.()
  }
  return {
    abort,
    async read(input: unknown): Promise<FilePreviewDocumentResult> {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: 'refused' }
      const record = input as Record<string, unknown>
      if (Object.keys(record).length !== 3 || !['id', 'revision', 'request'].every(key => Object.hasOwn(record, key)) ||
        typeof record.id !== 'string' || !/^[a-f0-9]{48}$/.test(record.id) ||
        typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision) || record.revision < 1) return { ok: false, reason: 'refused' }
      const request = parseFilePreviewDocumentRequest(record.request)
      if (!request) return { ok: false, reason: 'refused' }
      const { id, revision } = record as { id: string; revision: number }
      const sequence = ++generation
      const previous = active
      previous?.control.abort()
      if (previous && owner?.id === previous.id) clearOwner()
      const own = { id, control: new AbortController() }
      active = own
      try {
        const snapshot = await deps.snapshot(id, revision)
        if (sequence !== generation || own.control.signal.aborted) return { ok: false, reason: 'cancelled' }
        if (!snapshot) return { ok: false, reason: 'refused' }
        let result: FilePreviewDocumentResult
        if (request.kind === 'pdf') {
          if (snapshot.descriptor.kind !== 'pdf') return { ok: false, reason: 'refused' }
          if (owner) { clearOwner(); await deps.abort() }
          result = { ok: true, kind: 'pdf', bytes: snapshot.bytes }
        } else {
          const extension = /\.([^.\/]+)$/.exec(snapshot.descriptor.path)?.[1]?.toLowerCase()
          const format = snapshot.descriptor.kind === 'xlsx' ? 'xlsx'
            : snapshot.descriptor.kind === 'text' && (extension === 'csv' || extension === 'tsv') ? extension : null
          if (!format || format !== 'xlsx' && snapshot.descriptor.textWindow?.truncated && snapshot.descriptor.textWindow.side === 'end') return { ok: false, reason: 'refused' }
          retain(id, revision, sequence)
          result = await deps.table({ format, bytes: snapshot.bytes,
            ...(request.sheet === undefined ? {} : { sheet: request.sheet }),
            sourceTruncated: snapshot.descriptor.textWindow?.truncated ?? false }, own.control.signal)
        }
        if (sequence !== generation || own.control.signal.aborted) return { ok: false, reason: 'cancelled' }
        const authorized = await deps.authorized(id, revision)
        if (sequence !== generation || own.control.signal.aborted) return { ok: false, reason: 'cancelled' }
        if ((!authorized || !result.ok) && owner?.sequence === sequence) { clearOwner(); await deps.abort() }
        return authorized ? result : { ok: false, reason: 'refused' }
      } catch {
        if (owner?.sequence === sequence) { clearOwner(); await deps.abort() }
        return { ok: false, reason: sequence === generation ? 'failed' : 'cancelled' }
      } finally { if (active === own) active = null }
    },
  }
}
