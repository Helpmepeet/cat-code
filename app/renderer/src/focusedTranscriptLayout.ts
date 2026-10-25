import { isPeerSpeechCall } from './peerSurfaces.js'
import type { NestedTranscriptRow, ToolFamily } from './transcriptProjector.js'
import { deriveTarget, toolCardFilePath } from './transcriptToolTarget.js'
import { selectToolDiffs } from './toolDiffs.js'

export type FocusedSummary = {
  readPaths: readonly string[]
  editedPaths: readonly string[]
  searchedPatterns: readonly string[]
  commands: number
  otherFamilies: Readonly<Partial<Record<ToolFamily, number>>>
  toolCalls: number
  additions: number
  deletions: number
  hasErrors: boolean
  /** Top-level rows that failed; zero when only the turn's result reported an error. */
  errorCount: number
  summary: string
  /** The same counts as `summary` in a short `verb n · verb n` form for the turn head. */
  compact: string
  activeLabel: string | null
}
export type FocusedSegment = {
  kind: 'update' | 'reasoning' | 'stretch' | 'speech'
  id: string
  rows: readonly NestedTranscriptRow[]
} & FocusedSummary
export type FocusedTurnItem = {
  kind: 'focused-turn'
  id: string
  rows: readonly NestedTranscriptRow[]
  segments: readonly FocusedSegment[]
  live: boolean
  completed: boolean
  /** An answer for this turn has begun outside the work, so nothing inside it is still the newest output. */
  answering: boolean
  durationMs: number | null
} & FocusedSummary
export type FocusedTranscriptItem = { kind: 'rows'; rows: readonly NestedTranscriptRow[] } | FocusedTurnItem

const verbs: Partial<Record<ToolFamily, string>> = {
  read: 'Reading', edit: 'Editing', write: 'Writing', grep: 'Searching', bash: 'Running',
  agent: 'Delegating', web: 'Fetching', notebook: 'Editing',
}
const pastVerbs: Partial<Record<ToolFamily, string>> = {
  read: 'Read', edit: 'Edited', write: 'Wrote', grep: 'Searched', bash: 'Ran',
  agent: 'Delegated', web: 'Fetched', notebook: 'Edited',
}

/**
 * A finished generated image is a result for the reader, like the answer, so it
 * stays outside the fold. It still counts toward its step's summary.
 */
export function isFocusedDeliverable(row: NestedTranscriptRow): boolean {
  return row.kind === 'tool-use' && row.toolFamily === 'imagegen' && row.status === 'success' &&
    row.result?.generatedImage !== undefined
}

/** A settled stretch of exactly one call is named by its target instead of counted. */
export function focusedNamedCall(rows: readonly NestedTranscriptRow[]): { verb: string; target: string } | null {
  const calls = rows.filter(row => row.kind === 'tool-use')
  const call = calls[0]
  if (calls.length !== 1 || call?.kind !== 'tool-use' || call.status === 'pending') return null
  return { verb: pastVerbs[call.toolFamily] ?? 'Used', target: deriveTarget(call) }
}

function rowHasError(row: NestedTranscriptRow): boolean {
  if (row.kind === 'tool-use' && isPeerSpeechCall(row.toolName)) return false
  return (row.kind === 'tool-use' && (row.status === 'error' || row.result?.isError === true)) ||
    (row.kind === 'result' && row.isError) ||
    (row.kind === 'system-notice' && row.noticeType === 'provider_error') ||
    row.children.some(rowHasError)
}

/** Only top-level calls contribute counts; their original nested rows remain reachable. */
export function summarizeFocusedWork(rows: readonly NestedTranscriptRow[]): FocusedSummary {
  const reads = new Set<string>(), edits = new Set<string>(), searches = new Set<string>()
  const other: Partial<Record<ToolFamily, number>> = {}
  let commands = 0, toolCalls = 0, additions = 0, deletions = 0, errorCount = 0
  let activeLabel: string | null = null
  for (const row of rows) {
    if (rowHasError(row)) errorCount++
    if (row.kind !== 'tool-use' || isPeerSpeechCall(row.toolName)) continue
    toolCalls++
    if (row.status === 'pending' && activeLabel === null) activeLabel = `${verbs[row.toolFamily] ?? 'Using'} ${deriveTarget(row)}`
    const path = toolCardFilePath(row)
    switch (row.toolFamily) {
      case 'read': if (path) reads.add(path); break
      case 'edit': case 'write': if (path) edits.add(path); break
      case 'grep': {
        const pattern = row.input.pattern
        if (typeof pattern === 'string' && pattern) searches.add(pattern)
        break
      }
      case 'bash': commands++; break
      default: other[row.toolFamily] = (other[row.toolFamily] ?? 0) + 1
    }
    for (const diff of selectToolDiffs(row.result)) {
      edits.add(diff.filePath)
      for (const hunk of diff.hunks) for (const line of hunk.lines) {
        if (line.startsWith('+')) additions++
        else if (line.startsWith('-')) deletions++
      }
    }
  }
  const parts: string[] = [], compact: string[] = []
  const count = (verb: string, n: number, noun: string) => {
    if (!n) return
    parts.push(`${verb} ${n} ${noun}${n === 1 ? '' : 's'}`)
    compact.push(`${verb} ${n}`)
  }
  count('read', reads.size, 'file'); count('edited', edits.size, 'file')
  count('searched', searches.size, 'pattern'); count('ran', commands, 'command')
  const actions: Partial<Record<ToolFamily, readonly [string, string]>> = {
    agent: ['delegated', 'task'], 'agent-control': ['sent', 'agent request'],
    web: ['made', 'web request'], mcp: ['made', 'MCP call'], skill: ['used', 'skill'],
    imagegen: ['requested', 'image'], notebook: ['edited', 'notebook'],
    lsp: ['made', 'code intelligence request'],
  }
  for (const family of Object.keys(other) as ToolFamily[]) {
    const [verb, noun] = actions[family] ?? ['made', 'tool call']
    count(verb, other[family]!, noun)
  }
  const summary = parts.join(', ') || (toolCalls ? `used ${toolCalls} tool${toolCalls === 1 ? '' : 's'}` : 'Reasoned')
  return { readPaths: [...reads], editedPaths: [...edits], searchedPatterns: [...searches], commands,
    otherFamilies: other, toolCalls, additions, deletions, hasErrors: errorCount > 0, errorCount, summary,
    compact: compact.join(' · ') || summary, activeLabel }
}

const segmentCache = new WeakMap<readonly NestedTranscriptRow[], readonly FocusedSegment[]>()
export function deriveFocusedSegments(rows: readonly NestedTranscriptRow[]): readonly FocusedSegment[] {
  const cached = segmentCache.get(rows)
  if (cached) return cached
  const segments: FocusedSegment[] = []
  let stretch: NestedTranscriptRow[] = []
  const flush = () => {
    if (!stretch.length) return
    segments.push({ kind: 'stretch', id: `focused-stretch:${stretch[0]!.id}`, rows: stretch, ...summarizeFocusedWork(stretch) })
    stretch = []
  }
  for (const row of rows) {
    if (row.kind === 'tool-use' && isPeerSpeechCall(row.toolName)) {
      flush()
      segments.push({ kind: 'speech', id: `focused-speech:${row.id}`, rows: [row], ...summarizeFocusedWork([row]) })
    } else if (row.kind === 'assistant-text') {
      flush()
      segments.push({ kind: 'update', id: `focused-update:${row.id}`, rows: [row], ...summarizeFocusedWork([row]) })
    } else if (row.kind === 'thinking' && row.content.trim().length > 0) {
      flush()
      const previous = segments.at(-1)
      if (previous?.kind === 'reasoning') previous.rows = [...previous.rows, row]
      else segments.push({ kind: 'reasoning', id: `focused-reasoning:${row.id}`, rows: [row], ...summarizeFocusedWork([row]) })
    } else stretch.push(row)
  }
  flush()
  segmentCache.set(rows, segments)
  return segments
}

const cache = new WeakMap<readonly NestedTranscriptRow[], Map<boolean, readonly FocusedTranscriptItem[]>>()
const isWork = (row: NestedTranscriptRow) => !row.isHidden &&
  (row.kind === 'assistant-text' || row.kind === 'thinking' || row.kind === 'redacted-thinking' || row.kind === 'tool-use') &&
  !row.parentToolUseId

const isOperator = (row: NestedTranscriptRow) =>
  (row.kind === 'user-text' || row.kind === 'user-image') && !row.isHidden && !row.parentToolUseId
const isControlPoint = (row: NestedTranscriptRow) =>
  row.kind === 'system-notice' || row.kind === 'injected-turn' || row.kind === 'task-notification' ||
  (row.isHidden && (row.kind === 'assistant-text' || row.kind === 'thinking' ||
    row.kind === 'redacted-thinking' || row.kind === 'tool-use'))

/** Partial history and context chunks still group work, without attributing a whole-turn duration. */
export function deriveFocusedTranscript(
  rows: readonly NestedTranscriptRow[],
  turnLive: boolean,
  fragmentAfter?: ReadonlySet<string>,
): readonly FocusedTranscriptItem[] {
  const cached = fragmentAfter ? undefined : cache.get(rows)?.get(turnLive)
  if (cached) return cached
  const items: FocusedTranscriptItem[] = []
  let passthrough: NestedTranscriptRow[] = []
  const pass = (row: NestedTranscriptRow) => { passthrough.push(row) }
  const flush = () => { if (passthrough.length) { items.push({ kind: 'rows', rows: passthrough }); passthrough = [] } }
  for (let i = 0; i < rows.length;) {
    const anchor = rows[i]!
    const hasOperator = isOperator(anchor)
    if (hasOperator) {
      pass(rows[i++]!)
      // A submission may project images before or after its text.
      while (rows[i] && isOperator(rows[i]!) && rows[i]!.frameId === anchor.frameId) pass(rows[i++]!)
    } else if (!isWork(anchor)) {
      pass(rows[i++]!)
      continue
    }
    const start = i
    while (i < rows.length && (isWork(rows[i]!) || isControlPoint(rows[i]!))) i++
    const end = rows[i]
    const result = end?.kind === 'result' ? end : null
    const live = i === rows.length && turnLive
    const last = rows[i - 1]
    // Backfilled previews omit result frames, but retain the stored message's
    // stop reason. Do not apply this fallback to live, stopped or failed turns.
    const replayCompleted = !live && (!end || isOperator(end)) &&
      last?.kind === 'assistant-text' && last.replayEndTurn === true
    const successful = result ? result.subtype === 'success' && !result.isError && !result.errors.length : replayCompleted
    const answers = new Set<number>()
    for (let j = start; j < i; j++) {
      const row = rows[j]!
      if (isWork(row) && row.kind === 'assistant-text' && row.phase === 'final_answer') answers.add(j)
    }
    // Old transcripts and providers without phases retain the turn-end fallback.
    // Explicit commentary can never be promoted just because it was last.
    if (!answers.size && successful) for (let j = i - 1; j >= start; j--) {
      const row = rows[j]!
      if (!isWork(row)) continue
      if (row.kind === 'assistant-text' && row.phase === undefined) answers.add(j)
      break
    }
    const fragments: { start: number; end: number }[] = []
    for (let j = start; j < i;) {
      if (!isWork(rows[j]!) || answers.has(j)) { j++; continue }
      const from = j++
      // Display dividers split the work, not the producer turn or its completion evidence.
      while (j < i && isWork(rows[j]!) && !answers.has(j) && !fragmentAfter?.has(rows[j - 1]!.id)) j++
      fragments.push({ start: from, end: j })
    }
    if (!fragments.length && live && !answers.size) fragments.push({ start: i, end: i })
    let fragmentIndex = 0
    for (let j = start; j <= i;) {
      const fragment = fragments[fragmentIndex]
      if (!fragment || fragment.start !== j) {
        if (j < i) pass(rows[j]!)
        j++
        continue
      }
      flush()
      const work = rows.slice(fragment.start, fragment.end)
      // A result measures the whole turn, not an individual control-point fragment.
      const duration = hasOperator && fragments.length === 1 ? result?.durationMs : undefined
      const summary = summarizeFocusedWork(work)
      const id = fragmentIndex === 0 ? `focused-turn:${anchor.id}` : `focused-turn:${anchor.id}:after:${rows[fragment.start - 1]!.id}`
      items.push({ kind: 'focused-turn', id, rows: work,
        segments: deriveFocusedSegments(work), live, completed: successful && answers.size > 0, answering: answers.size > 0,
        durationMs: typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? duration : null,
        ...summary, hasErrors: summary.hasErrors || result?.isError === true })
      fragmentIndex++
      j = fragment.end > j ? fragment.end : j + 1
    }
    // The result and all non-work boundaries remain visible through the normal renderer.
  }
  flush()
  if (!fragmentAfter) {
    const variants = cache.get(rows) ?? new Map()
    variants.set(turnLive, items)
    cache.set(rows, variants)
  }
  return items
}
