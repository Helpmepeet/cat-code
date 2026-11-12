import { backgroundAgentState, focusedCallLine, isDeclinedQuestion, type FocusedCallContext, type FocusedCallLine } from './focusedCallText.js'
import { isPeerSpeechCall } from './peerSurfaces.js'
import type { NestedToolUseRow, NestedTranscriptRow, ToolFamily } from './transcriptProjector.js'
import { patchFilePaths, toolCardFilePath } from './transcriptToolTarget.js'
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
  /** Top-level calls the user or a stop cancelled; not failures. */
  stoppedCount: number
  /** Top-level calls auto mode refused before they ran; not failures and not in the per-family counts. */
  blockedCount: number
  summary: string
  /** The same counts as `summary` in a short `verb n · verb n` form for the turn head. */
  compact: string
  /** The first call still pending, with its Focus target, for naming what a stopped turn was doing. */
  activeCall: { toolUseId: string; target: string } | null
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

/**
 * A finished generated image is a result for the reader, like the answer, so it
 * stays outside the fold. It still counts toward its step's summary.
 */
export function isFocusedDeliverable(row: NestedTranscriptRow): boolean {
  // Questions stay with the step that asked them, not below later work.
  return row.kind === 'tool-use' && row.status === 'success' &&
    row.toolFamily === 'imagegen' && row.result?.generatedImage !== undefined
}

/** The newest screenshot a stretch's computer steps returned, for its closed line. */
export function latestComputerScreenshot(rows: readonly NestedTranscriptRow[]): { mediaType: string; data: string } | null {
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!
    const image = row.kind === 'tool-use' && row.toolFamily === 'computer' ? row.result?.images?.at(-1) : undefined
    if (image) return image
  }
  return null
}

/** A settled stretch of exactly one call is named by its line instead of counted. */
export function focusedNamedCall(rows: readonly NestedTranscriptRow[], ctx: Omit<FocusedCallContext, 'signalled'>): { line: FocusedCallLine; toolUseId: string } | null {
  const calls = rows.filter(row => row.kind === 'tool-use')
  const call = calls[0]
  if (calls.length !== 1 || call?.kind !== 'tool-use' || call.status === 'pending') return null
  return { line: focusedCallLine(call, { ...ctx, signalled: false }), toolUseId: call.toolUseId }
}

const isBlocked = (row: NestedToolUseRow) => row.status === 'error' && row.autoModeReview?.outcome === 'blocked'

function rowHasError(row: NestedTranscriptRow): boolean {
  if (row.kind === 'tool-use' && (isPeerSpeechCall(row.toolName) || isDeclinedQuestion(row))) return false
  return (row.kind === 'tool-use' && row.status !== 'cancelled' && !isBlocked(row) &&
      (row.status === 'error' || row.result?.isError === true || backgroundAgentState(row) === 'failed')) ||
    (row.kind === 'result' && row.isError) ||
    (row.kind === 'system-notice' && row.noticeType === 'provider_error') ||
    row.children.some(rowHasError)
}

/** Only top-level calls contribute counts; their original nested rows remain reachable. */
export function summarizeFocusedWork(rows: readonly NestedTranscriptRow[]): FocusedSummary {
  const reads = new Set<string>(), edits = new Set<string>(), searches = new Set<string>()
  const other: Partial<Record<ToolFamily, number>> = {}
  let commands = 0, toolCalls = 0, additions = 0, deletions = 0, errorCount = 0, stoppedCount = 0, blockedCount = 0, questions = 0
  let activeCall: FocusedSummary['activeCall'] = null
  for (const row of rows) {
    if (rowHasError(row)) errorCount++
    if (row.kind !== 'tool-use' || isPeerSpeechCall(row.toolName)) continue
    toolCalls++
    if (row.status === 'pending' && activeCall === null) {
      activeCall = { toolUseId: row.toolUseId, target: focusedCallLine(row, { signalled: false, cwd: null, tasks: null, turnRows: rows }).target }
    }
    if (row.status === 'cancelled') stoppedCount++
    // A refused call never ran, so it names no file, pattern or command.
    if (isBlocked(row)) { blockedCount++; continue }
    const path = toolCardFilePath(row)
    switch (row.toolFamily) {
      case 'read': if (path) reads.add(path); break
      case 'edit': case 'write': {
        // Diffs name every file a call changed (added below). Without them, a patch's
        // headers still say which files it was for, as a failed patch has none.
        if (!selectToolDiffs(row.result).length) {
          if (path) edits.add(path)
          for (const header of patchFilePaths(row)) edits.add(header)
        }
        break
      }
      case 'grep': {
        const pattern = row.input.pattern
        if (typeof pattern === 'string' && pattern) searches.add(pattern)
        break
      }
      case 'bash': commands++; break
      default:
        other[row.toolFamily] = (other[row.toolFamily] ?? 0) + 1
        if (row.toolName === 'AskUserQuestion') questions++
    }
    for (const diff of selectToolDiffs(row.result)) {
      edits.add(diff.filePath)
      for (const hunk of diff.hunks) for (const line of hunk.lines) {
        if (line.startsWith('+')) additions++
        else if (line.startsWith('-')) deletions++
      }
    }
  }
  // A patch header is relative and a diff path absolute; one file must not count twice.
  for (const edited of [...edits]) {
    if (!edited.startsWith('/') && [...edits].some(other => other.endsWith(`/${edited}`))) edits.delete(edited)
  }
  const parts: string[] = [], compact: string[] = []
  const count = (verb: string, n: number, noun: string) => {
    if (!n) return
    parts.push(`${verb} ${n} ${noun}${n === 1 ? '' : 's'}`)
    compact.push(`${verb} ${n}`)
  }
  count('read', reads.size, 'file'); count('edited', edits.size, 'file')
  count('searched', searches.size, 'pattern'); count('ran', commands, 'command')
  count('delegated', other.agent ?? 0, 'task')
  // Everything else is a noun; only a lead noun gets its old verb so it still reads as a sentence.
  const nouns: readonly (readonly [number, string, string, string])[] = [
    [other['agent-control'] ?? 0, 'agent message', 'message', 'sent'], [other.web ?? 0, 'web request', 'web', 'made'],
    [other.mcp ?? 0, 'MCP call', 'MCP', 'made'], [other.skill ?? 0, 'skill', 'skill', 'used'],
    [other.imagegen ?? 0, 'image', 'image', 'requested'], [other.notebook ?? 0, 'notebook', 'notebook', 'edited'],
    [other.computer ?? 0, 'computer step', 'computer', 'used'], [other.lsp ?? 0, 'code intelligence request', 'LSP', 'made'],
    [questions, 'question', 'question', 'asked'], [(other.other ?? 0) - questions, 'other call', 'other', 'made'],
  ]
  for (const [n, noun, label, verb] of nouns) {
    if (!n) continue
    const leading = parts.length === 0 || label === 'notebook'
    parts.push(`${leading ? `${verb} ` : ''}${n} ${noun}${n === 1 ? '' : 's'}`)
    compact.push(`${label} ${n}`)
  }
  const refusedAll = blockedCount > 0 && blockedCount === toolCalls
  const summary = parts.join(', ') || (refusedAll ? `blocked ${blockedCount} call${blockedCount === 1 ? '' : 's'}`
    : toolCalls ? `used ${toolCalls} tool${toolCalls === 1 ? '' : 's'}` : 'Reasoned')
  return { readPaths: [...reads], editedPaths: [...edits], searchedPatterns: [...searches], commands,
    otherFamilies: other, toolCalls, additions, deletions, hasErrors: errorCount > 0, errorCount, stoppedCount, blockedCount, summary,
    compact: compact.join(' · ') || (refusedAll ? '' : summary), activeCall }
}

const segmentCache = new WeakMap<readonly NestedTranscriptRow[], readonly FocusedSegment[]>()
// Source rows are immutable. Keep only the latest model per first row, so new
// outer arrays can reuse history without retaining a session-wide version log.
const segmentModels = new WeakMap<NestedTranscriptRow, FocusedSegment>()
const turnModels = new WeakMap<NestedTranscriptRow, FocusedTurnItem>()
const sameRows = (left: readonly NestedTranscriptRow[], right: readonly NestedTranscriptRow[]) =>
  left.length === right.length && left.every((row, index) => row === right[index])

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
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!
    const key = segment.rows[0]!
    const previous = segmentModels.get(key)
    if (previous?.kind === segment.kind && previous.id === segment.id && sameRows(previous.rows, segment.rows)) {
      segments[index] = previous
    } else segmentModels.set(key, segment)
  }
  segmentCache.set(rows, segments)
  return segments
}

const cache = new WeakMap<readonly NestedTranscriptRow[], Map<boolean, readonly FocusedTranscriptItem[]>>()
const isWork = (row: NestedTranscriptRow) => !row.isHidden &&
  (row.kind === 'assistant-text' || row.kind === 'thinking' || row.kind === 'redacted-thinking' || row.kind === 'tool-use') &&
  !row.parentToolUseId

const isOperator = (row: NestedTranscriptRow) =>
  (row.kind === 'user-text' || row.kind === 'user-image' || row.kind === 'question-reply') && !row.isHidden && !row.parentToolUseId
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
      const id = fragmentIndex === 0 ? `focused-turn:${anchor.id}` : `focused-turn:${anchor.id}:after:${rows[fragment.start - 1]!.id}`
      const completed = successful && answers.size > 0
      const answering = answers.size > 0
      const durationMs = typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? duration : null
      const key = work[0] ?? anchor
      const previous = turnModels.get(key)
      if (previous?.id === id && previous.live === live && previous.completed === completed &&
        previous.answering === answering && previous.durationMs === durationMs &&
        // A result can change failure state without changing any work row.
        previous.hasErrors === (previous.errorCount > 0 || result?.isError === true) &&
        sameRows(previous.rows, work)) {
        items.push(previous)
      } else {
        const summary = summarizeFocusedWork(work)
        const model: FocusedTurnItem = { kind: 'focused-turn', id, rows: work,
          segments: deriveFocusedSegments(work), live, completed, answering, durationMs,
          ...summary, hasErrors: summary.hasErrors || result?.isError === true }
        turnModels.set(key, model)
        items.push(model)
      }
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
