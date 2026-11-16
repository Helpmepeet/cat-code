import { codeModeForRow, type CodeModeCall, type CodeModeEnvelope } from './codeMode.js'
import type { NestedToolUseRow, NestedTranscriptRow } from './transcriptProjector.js'

const views = new WeakMap<NestedToolUseRow, CodeModeEnvelope>()
const childViews = new WeakMap<readonly NestedTranscriptRow[], {
  audit: CodeModeEnvelope; sessionId: string; cellId: string; view: CodeModeEnvelope
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

/** A running receipt is a snapshot, not a second high-volume activity stream.
 * Only authenticated same-session/generation SDK children can advance it.
 * Terminal host ledgers are returned verbatim and never reconstructed. */
export function codeModeLiveView(row: NestedToolUseRow): CodeModeEnvelope | undefined {
  const audit = codeModeForRow(row)
  if (!audit || audit.status !== 'running') return audit
  const cached = views.get(row)
  if (cached) return cached
  const previousChildren = childViews.get(row.children)
  if (previousChildren?.audit === audit && previousChildren.sessionId === row.sessionId && previousChildren.cellId === row.toolUseId) {
    views.set(row, previousChildren.view)
    return previousChildren.view
  }
  const calls = new Map(audit.calls.map(call => [call.toolUseId, call]))
  let changed = false
  for (const child of row.children) {
    if (child.kind !== 'tool-use' || child.sessionId !== row.sessionId ||
      child.codeMode?.cellId !== row.toolUseId || child.codeMode.generation !== audit.generation) continue
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
  const view = changed ? { ...audit, calls: [...calls.values()] } : audit
  childViews.set(row.children, { audit, sessionId: row.sessionId, cellId: row.toolUseId, view })
  views.set(row, view)
  return view
}
