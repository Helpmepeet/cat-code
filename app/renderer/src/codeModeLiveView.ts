import { codeModeForRow, type CodeModeCall, type CodeModeEnvelope } from './codeMode.js'
import type { NestedToolUseRow, NestedTranscriptRow } from './transcriptProjector.js'

const views = new WeakMap<NestedToolUseRow, CodeModeEnvelope>()
const childViews = new WeakMap<readonly NestedTranscriptRow[], {
  audit?: CodeModeEnvelope; input?: NestedToolUseRow['input']; sessionId: string; cellId: string; view: CodeModeEnvelope
}>()
const childCalls = new WeakMap<NestedToolUseRow, CodeModeCall>()
const canonicalCalls = new WeakMap<CodeModeCall, WeakMap<CodeModeCall, CodeModeCall>>()

function observedCall(child: NestedToolUseRow): CodeModeCall {
  const cached = childCalls.get(child)
  if (cached) return cached
  const status = child.autoModeReview?.outcome === 'blocked' ? 'blocked'
    : child.status === 'success' ? 'completed' : child.status === 'error' ? 'failed'
    : child.status === 'cancelled' ? 'cancelled' : 'running'
  const call: CodeModeCall = {
    toolUseId: child.toolUseId, name: child.toolName, input: child.input, status,
    ...(child.codeMode?.line !== undefined ? { line: child.codeMode.line } : {}),
    ...(child.result ? { result: { content: child.result.content, isError: child.result.isError } } : {}),
    ...(child.result?.isError ? { error: child.result.content } : {}),
  }
  childCalls.set(child, call)
  return call
}

/** Project foreground child frames before the receipt arrives, and use the
 * same frames to advance a background launch snapshot. Terminal host ledgers
 * remain authoritative. */
export function codeModeLiveView(row: NestedToolUseRow): CodeModeEnvelope | undefined {
  const audit = codeModeForRow(row)
  if (audit && audit.status !== 'running') return audit
  if (!audit && (row.toolName !== 'REPL' || row.status !== 'pending' || row.result || !row.children.length)) return undefined
  const cached = views.get(row)
  if (cached) return cached
  const input = audit ? undefined : row.input
  const previousChildren = childViews.get(row.children)
  if (previousChildren && previousChildren.audit === audit && previousChildren.input === input &&
      previousChildren.sessionId === row.sessionId && previousChildren.cellId === row.toolUseId) {
    views.set(row, previousChildren.view)
    return previousChildren.view
  }
  const calls = new Map(audit?.calls.map(call => [call.toolUseId, call]))
  let generation = audit?.generation
  let changed = false
  for (const child of row.children) {
    if (child.kind !== 'tool-use' || child.sessionId !== row.sessionId ||
      child.codeMode?.cellId !== row.toolUseId) continue
    generation ??= child.codeMode.generation
    if (child.codeMode.generation !== generation) continue
    const previous = calls.get(child.toolUseId)
    // A partial host ledger can already contain a settled call and richer data.
    if (previous && (previous.status !== 'running' || previous.name !== child.toolName)) continue
    const observed = observedCall(child)
    let merged = observed
    if (previous && (previous.input !== observed.input || previous.inputOmission !== undefined)) {
      let byObserved = canonicalCalls.get(previous)
      if (!byObserved) { byObserved = new WeakMap(); canonicalCalls.set(previous, byObserved) }
      merged = byObserved.get(observed) ?? { ...observed, input: previous.input, ...(previous.inputOmission ? { inputOmission: previous.inputOmission } : {}) }
      byObserved.set(observed, merged)
    }
    calls.set(child.toolUseId, merged)
    changed = true
  }
  const base = audit ?? (generation === undefined ? undefined : {
    kind: 'code-mode' as const,
    cellId: row.toolUseId,
    generation,
    description: typeof row.input.description === 'string' ? row.input.description : 'Script',
    code: typeof row.input.code === 'string' ? row.input.code : '',
    status: 'running' as const,
    output: '',
    calls: [],
    changedFiles: [],
  })
  if (!base) return undefined
  const view = changed ? { ...base, calls: [...calls.values()] } : base
  childViews.set(row.children, { audit, input, sessionId: row.sessionId, cellId: row.toolUseId, view })
  views.set(row, view)
  return view
}
