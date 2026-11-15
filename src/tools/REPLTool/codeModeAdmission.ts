import { AsyncLocalStorage } from 'node:async_hooks'
import type { ToolUseContext } from '../../Tool.js'

// These handles stay in the engine. They must never cross the guest bridge.
export type CodeModeAdmissionOwner = Readonly<{ runtimeIncarnation: object }>
export type CodeModeCell = Readonly<{ cellId: string; code: string }>
type OwnerState = {
  context: ToolUseContext
  policy: unknown
  mode: string
  epoch: number
  current?: CodeModeCell
}
type CellState = { owner: CodeModeAdmissionOwner; epoch: number; admitted: boolean }
const owners = new WeakMap<CodeModeAdmissionOwner, OwnerState>()
const cells = new WeakMap<CodeModeCell, CellState>()
const scope = new AsyncLocalStorage<CodeModeCell>()

export function createCodeModeAdmissionOwner(
  context: ToolUseContext,
  runtimeIncarnation: object,
): CodeModeAdmissionOwner {
  const owner = Object.freeze({ runtimeIncarnation })
  owners.set(owner, {
    context,
    policy: context.getAppState().toolPermissionContext,
    mode: context.getAppState().toolPermissionContext.mode,
    epoch: 0,
  })
  return owner
}

/** Call at instruction barriers, policy changes, stop, and runtime disposal. */
export function revokeCodeModeAdmission(owner: CodeModeAdmissionOwner): void {
  const state = owners.get(owner)
  if (!state) throw new Error('Unknown Code Mode admission owner')
  state.epoch++
  state.current = undefined
}

/** Beginning a script fences future dispatch by all older background cells. */
export function beginCodeModeCell(
  owner: CodeModeAdmissionOwner,
  submitted: { cellId: string; code: string },
): CodeModeCell {
  const state = owners.get(owner)
  if (!state) throw new Error('Unknown Code Mode admission owner')
  revokeCodeModeAdmission(owner)
  state.policy = state.context.getAppState().toolPermissionContext
  state.mode = state.context.getAppState().toolPermissionContext.mode
  const cell = Object.freeze({ cellId: submitted.cellId, code: submitted.code })
  cells.set(cell, { owner, epoch: state.epoch, admitted: false })
  state.current = cell
  return cell
}

/** Only call after the ordinary outer pipeline approves this exact final source. */
export function admitCodeModeCell(cell: CodeModeCell): void {
  const entry = cells.get(cell)
  if (!entry || !isCurrent(cell, entry)) throw new Error('Code Mode cell is no longer current')
  entry.admitted = true
}

function isCurrent(cell: CodeModeCell, entry: CellState): boolean {
  const owner = owners.get(entry.owner)!
  const policy = owner.context.getAppState().toolPermissionContext
  if (owner.policy !== policy || owner.mode !== policy.mode) {
    revokeCodeModeAdmission(entry.owner)
  }
  return owner.current === cell && owner.epoch === entry.epoch &&
    !owner.context.abortController.signal.aborted
}

/** Wrap complete iterator consumption, not merely creation of runToolUse(). */
export function withCodeModeAdmission<T>(cell: CodeModeCell, run: () => T): T {
  if (!cells.has(cell)) throw new Error('Unknown Code Mode cell')
  return scope.run(cell, run)
}

/** Undefined means an ordinary call; false means explicit approval, never reclassification. */
export function getCodeModeAdmission(context: ToolUseContext): boolean | undefined {
  const cell = scope.getStore()
  if (!cell) return undefined
  const entry = cells.get(cell)!
  const owner = owners.get(entry.owner)!
  const principalMatches = owner.context.getAppState === context.getAppState &&
    owner.context.agentId === context.agentId &&
    owner.context.abortController === context.abortController
  return principalMatches && isCurrent(cell, entry) && entry.admitted
}
