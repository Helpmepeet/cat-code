import type { NestedTranscriptRow } from './transcriptProjector.js'
import { groupUserImages } from './userImageLayout.js'

export type TranscriptOutlineEntry = {
  id: string
  rowKey: string
  prompt: string
  answer: string
}

// Excerpts are text, not Markdown render plans. Bound work before normalizing
// whitespace, including for unfinished fences or hostile-looking HTML.
function preview(text: string): string {
  const bounded = text.slice(0, 4096).replace(/\s+/g, ' ').trim()
  return bounded.length > 240 ? `${bounded.slice(0, 239)}…` : bounded
}

function frameKey(row: NestedTranscriptRow): string {
  return JSON.stringify([row.sessionId, row.frameId])
}

function topLevel(row: NestedTranscriptRow): boolean {
  return !('parentToolUseId' in row && row.parentToolUseId != null) &&
    !('agentName' in row && row.agentName)
}

/** Derive navigation data without editing rows or traversing worker children. */
export function deriveTranscriptOutline(rows: readonly NestedTranscriptRow[]): TranscriptOutlineEntry[] {
  const excluded = new Set<string>()
  for (const row of rows) {
    if (row.isHidden || row.kind === 'injected-turn' || row.kind === 'task-notification' ||
      row.kind === 'question-reply' || ('origin' in row && row.origin != null)) {
      excluded.add(frameKey(row))
    }
  }
  const entries: TranscriptOutlineEntry[] = []
  const byFrame = new Map<string, TranscriptOutlineEntry>()
  const hasText = new Set<string>()
  const finalAnswers = new Set<string>()
  const promptParts = new Map<string, Set<string>>()
  let current: TranscriptOutlineEntry | undefined
  const items = groupUserImages(rows.map(row => ({ kind: 'single' as const, row })))
  for (const item of items) {
    if (item.kind !== 'single' && item.kind !== 'user-images') continue
    const row = item.kind === 'single' ? item.row : item.members[0]!
    if (!topLevel(row) || row.isHidden || excluded.has(frameKey(row))) continue
    if (row.kind === 'user-text' || row.kind === 'user-image' || row.kind === 'command-echo') {
      const id = frameKey(row)
      let entry = byFrame.get(id)
      if (!entry) {
        entry = { id, rowKey: item.kind === 'single' ? row.id : item.id, prompt: 'Image attachment', answer: '' }
        entries.push(entry)
        byFrame.set(id, entry)
        promptParts.set(id, new Set())
      }
      current = entry
      if (row.kind !== 'user-image') {
        const text = preview(row.kind === 'command-echo'
          ? `${row.commandName.startsWith('/') ? '' : '/'}${row.commandName}${row.args ? ` ${row.args}` : ''}`
          : row.content)
        const parts = promptParts.get(id)!
        if (text && !parts.has(text)) {
          entry.prompt = preview(hasText.has(id) ? `${entry.prompt} ${text}` : text)
          parts.add(text)
          hasText.add(id)
        }
      }
    } else if (row.kind === 'assistant-text' && current) {
      const text = preview(row.content)
      if (!text) continue
      if (row.phase === 'final_answer' && !finalAnswers.has(current.id)) {
        current.answer = text
        finalAnswers.add(current.id)
      } else if (!current.answer) {
        current.answer = text
      }
    }
  }
  return entries
}
