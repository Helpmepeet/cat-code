import { codeModeForRow, codeModeInput, codeModeInputWasOmitted, type CodeModeCall, type CodeModeEnvelope } from './codeMode.js'
import { projectCodeModeCall, type NestedToolUseRow } from './transcriptProjector.js'

const childViews = new WeakMap<CodeModeCall, WeakMap<NestedToolUseRow, NestedToolUseRow>>()
const ledgerCalls = new WeakMap<CodeModeEnvelope, ReadonlyMap<string, CodeModeCall>>()

/** History retains submitted input; only the host ledger can replace it with
 * final executable input. Keep real child receipts, identity and Agent history. */
export function codeModeChildView(parent: NestedToolUseRow, call: CodeModeCall, child?: NestedToolUseRow): NestedToolUseRow {
  const audit = codeModeForRow(parent)
  let indexed = audit ? ledgerCalls.get(audit) : undefined
  if (audit && !indexed) { indexed = new Map(audit.calls.map(entry => [entry.toolUseId, entry])); ledgerCalls.set(audit, indexed) }
  const canonical = indexed?.get(call.toolUseId)
  if (!child) return projectCodeModeCall(parent, canonical ?? call)
  if (!canonical) return child
  if (child.toolUseId !== canonical.toolUseId || child.sessionId !== parent.sessionId ||
    child.codeMode && (child.codeMode.cellId !== parent.toolUseId || child.codeMode.generation !== audit!.generation)) return projectCodeModeCall(parent, canonical)
  const cached = childViews.get(canonical)?.get(child)
  if (cached) return cached
  const input = codeModeInput(canonical)
  const omitted = codeModeInputWasOmitted(canonical)
  const keys = Object.keys(input)
  if (!omitted && !child.codeModeInputOmitted && (child.input === input || keys.length === Object.keys(child.input).length &&
    keys.every(key => Object.is(input[key], child.input[key])))) return child
  let byChild = childViews.get(canonical)
  if (!byChild) { byChild = new WeakMap(); childViews.set(canonical, byChild) }
  const { codeModeInputOmitted: _previousOmission, ...retained } = child
  const view: NestedToolUseRow = { ...retained, input, ...(omitted ? { codeModeInputOmitted: true } : {}) }
  byChild.set(child, view)
  return view
}
