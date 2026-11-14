import { parseReadSource } from './readSource.js'
import { parseDocument } from 'yaml'
import type { NestedToolUseRow, NestedTranscriptRow } from './transcriptProjector.js'

/**
 * Display-only layout detection, independent of the configurable memory base.
 * Full-path overrides outside projects/<root>/memory retain the ordinary read UI.
 */
export function memoryReadPath(row: NestedTranscriptRow): string | null {
  if (row.kind !== 'tool-use' || row.toolFamily !== 'read') return null
  const path = row.input.file_path
  if (typeof path !== 'string') return null
  const normalized = path.replace(/\\/g, '/')
  if (normalized.split('/').some(part => part === '..' || part === '.')) return null
  return /^(?:\/|[A-Za-z]:\/).*\/projects\/[^/]+\/memory\/(?:[^/]+\/)*[^/]+\.md$/.test(normalized) ? normalized : null
}

export function isMemoryRecall(row: NestedTranscriptRow, awaitingApproval = false): boolean {
  return memoryReadPath(row) !== null && row.kind === 'tool-use' &&
    !awaitingApproval && (row.status === 'pending' || row.status === 'success') &&
    !row.result?.isError && (!row.autoModeReview || row.autoModeReview.outcome === 'allowed')
}

export type MemoryNote = {
  name: string
  type: string | null
  description: string | null
  body: string | null
  filename: string
  age: number | null
}

/** Parse only the read payload, never fetch a memory or infer its age from the clock. */
export function parseMemoryNote(path: string, content: string): MemoryNote {
  const filename = path.replace(/\\/g, '/').split('/').at(-1) ?? path
  const note: MemoryNote = { name: filename === 'MEMORY.md' ? 'memory index' : filename.replace(/\.md$/, ''), type: null, description: null, body: null, filename, age: null }
  const freshness = /^<system-reminder>This memory is (\d+) days old\.[\s\S]*?<\/system-reminder>\r?\n/.exec(content)
  if (freshness) {
    const age = Number(freshness[1])
    if (Number.isSafeInteger(age) && age > 1) note.age = age
    content = content.slice(freshness[0].length)
  }
  const source = parseReadSource(content.replace(/\r\n/g, '\n').replace(/\n$/, ''))
  if (source.numbers && source.numbers[0] !== 1) return note
  const text = source.lines.join('\n')
  if (filename === 'MEMORY.md') return { ...note, body: text }
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(text)
  if (!match) return note
  try {
    const document = parseDocument(match[1]!, { schema: 'failsafe' })
    if (document.errors.length) return note
    const fields: unknown = document.toJS({ maxAliasCount: 0 })
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return note
    const { name, type, description } = fields as Record<string, unknown>
    if (![name, type, description].every(value => typeof value === 'string' && value.trim())) return note
    return { ...note, name: name as string, type: type as string, description: description as string, body: match[2]!.trim() }
  } catch {
    return note
  }
}

const notes = new WeakMap<NestedToolUseRow, MemoryNote>()
export function selectMemoryNote(row: NestedToolUseRow): MemoryNote {
  let note = notes.get(row)
  if (!note) {
    note = parseMemoryNote(memoryReadPath(row) ?? '', row.result?.content ?? '')
    notes.set(row, note)
  }
  return note
}
