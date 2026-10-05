/** Durable one-shot desktop jump ledger. Node-compatible; no engine bootstrap.
 * Main is the sole writer. Engines read it before startup and turn admission.
 * A malformed record is an admission refusal, never an empty/unused capability.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { isSessionBinding } from '../../app/shared/sessionBinding.js'
import type { SessionLocation, SessionRelocation } from './sessionRelocationState.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const MAX_WORKSPACE_JUMP_STATE_BYTES = 16 * 1024
export type WorkspaceJumpBoundary = { tipUuid: string; toolUseId: string }
export type WorkspaceJumpState = {
  version: 1
  appSessionId: string
  engineSessionId: string
  operationId: string
  sourceGeneration: string
  source: SessionLocation
  target: SessionLocation
  acceptedAt: number
  phase: 'accepted' | 'ready' | 'moving' | 'settled'
  boundary?: WorkspaceJumpBoundary
  location: 'source' | 'destination' | 'unknown'
  consumed: boolean
  cancelled: boolean
  requiresUserReconciliation: boolean
  sourceOutcomePersisted: boolean
  /** Exact publication proof for this feature's verified return to source. A
   * later manual move replaces it and cannot re-enable the agent capability.
   */
  compensation?: { movedAt: number; backup: string; projectCwd: string }
  outcome?: 'completed' | 'failed' | 'cancelled' | 'uncertain'
  continuation: { id: string; state: 'not_admitted' | 'admitted' | 'settled' | 'uncertain' }
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function bounded(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}
function location(value: unknown): value is SessionLocation {
  return object(value) && Object.keys(value).every(key => key === 'cwd' || key === 'binding') &&
    typeof value.cwd === 'string' && value.cwd.length <= 4096 && isAbsolute(value.cwd) && isSessionBinding(value.binding)
}
export function isWorkspaceJumpState(value: unknown): value is WorkspaceJumpState {
  if (!object(value)) return false
  const keys = ['version', 'appSessionId', 'engineSessionId', 'operationId', 'sourceGeneration', 'source', 'target',
    'acceptedAt', 'phase', 'boundary', 'location', 'consumed', 'cancelled', 'requiresUserReconciliation', 'sourceOutcomePersisted', 'compensation', 'outcome', 'continuation']
  if (Object.keys(value).some(key => !keys.includes(key))) return false
  return value.version === 1 && typeof value.appSessionId === 'string' && UUID.test(value.appSessionId) &&
    typeof value.engineSessionId === 'string' && UUID.test(value.engineSessionId) &&
    typeof value.operationId === 'string' && UUID.test(value.operationId) && bounded(value.sourceGeneration) &&
    location(value.source) && value.source.binding.kind === 'managed' && location(value.target) && value.target.binding.kind === 'project' &&
    value.source.cwd !== value.target.cwd && typeof value.acceptedAt === 'number' && Number.isFinite(value.acceptedAt) &&
    ['accepted', 'ready', 'moving', 'settled'].includes(value.phase as string) &&
    (value.boundary === undefined || (object(value.boundary) && Object.keys(value.boundary).length === 2 && bounded(value.boundary.tipUuid) && bounded(value.boundary.toolUseId))) &&
    (value.phase !== 'ready' && value.phase !== 'moving' || value.boundary !== undefined) &&
    ['source', 'destination', 'unknown'].includes(value.location as string) &&
    typeof value.consumed === 'boolean' && (value.location !== 'destination' || value.consumed) &&
    typeof value.cancelled === 'boolean' && typeof value.requiresUserReconciliation === 'boolean' && typeof value.sourceOutcomePersisted === 'boolean' &&
    (value.compensation === undefined || (object(value.compensation) && Object.keys(value.compensation).length === 3 &&
      typeof value.compensation.movedAt === 'number' && Number.isFinite(value.compensation.movedAt) &&
      typeof value.compensation.backup === 'string' && value.compensation.backup.length <= 4096 && isAbsolute(value.compensation.backup) &&
      typeof value.compensation.projectCwd === 'string' && value.compensation.projectCwd.length <= 4096 && isAbsolute(value.compensation.projectCwd))) &&
    (value.outcome === undefined || ['completed', 'failed', 'cancelled', 'uncertain'].includes(value.outcome as string)) &&
    object(value.continuation) && Object.keys(value.continuation).length === 2 &&
    typeof value.continuation.id === 'string' && UUID.test(value.continuation.id) &&
    ['not_admitted', 'admitted', 'settled', 'uncertain'].includes(value.continuation.state as string)
}
export function hasVerifiedSourceCompensation(state: WorkspaceJumpState | null, record: SessionRelocation,
  appSessionId: string, engineSessionId: string, cwd: string): boolean {
  return !!state && state.appSessionId === appSessionId && state.engineSessionId === engineSessionId && !state.consumed &&
    state.location === 'source' && state.phase === 'settled' && !state.requiresUserReconciliation && state.sourceOutcomePersisted &&
    !!state.compensation && record.appSessionId === appSessionId && record.engineSessionId === engineSessionId && record.phase === 'complete' &&
    record.target.cwd === cwd && JSON.stringify(record.target) === JSON.stringify(state.source) &&
    record.source.cwd === state.compensation.projectCwd && record.source.binding.kind === 'project' &&
    JSON.stringify(record.original) === JSON.stringify(state.source) &&
    record.movedAt === state.compensation.movedAt && record.backup === state.compensation.backup
}
export function workspaceJumpDirectory(): string {
  return join((process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.cat-code')).normalize('NFC'), 'workspace-jumps')
}
function recordPath(id: string, directory: string): string {
  if (!UUID.test(id)) throw new Error('Invalid conversation identity')
  return join(directory, `${id}.json`)
}
export function readWorkspaceJump(id: string, directory = workspaceJumpDirectory()): WorkspaceJumpState | null {
  // Legacy/imported identities have no jump ledger. Creating an operation and
  // writing one remain UUID-only at the receiving/storage boundaries.
  if (!UUID.test(id)) return null
  let text: string
  try { text = readFileSync(recordPath(id, directory), 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  if (Buffer.byteLength(text) > MAX_WORKSPACE_JUMP_STATE_BYTES) throw new Error('Workspace jump state is too large')
  const value: unknown = JSON.parse(text)
  if (!isWorkspaceJumpState(value) || value.appSessionId !== id) throw new Error('Workspace jump state could not be read')
  return value
}
export function writeWorkspaceJump(state: WorkspaceJumpState, directory = workspaceJumpDirectory()): void {
  if (!isWorkspaceJumpState(state)) throw new Error('Invalid workspace jump state')
  const text = `${JSON.stringify(state)}\n`
  if (Buffer.byteLength(text) > MAX_WORKSPACE_JUMP_STATE_BYTES) throw new Error('Workspace jump state is too large')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `${state.appSessionId}.${randomUUID()}.tmp`)
  const fd = openSync(temporary, 'wx', 0o600)
  try { writeFileSync(fd, text); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temporary, recordPath(state.appSessionId, directory))
  const parent = openSync(directory, 'r')
  try { fsyncSync(parent) } finally { closeSync(parent) }
}
export function workspaceJumpRequiresRetention(state: WorkspaceJumpState): boolean {
  return state.phase !== 'settled' || state.requiresUserReconciliation ||
    state.continuation.state === 'admitted' || state.continuation.state === 'uncertain'
}
/** Queueing into the admitted destination turn does not release the move hold. */
export function workspaceJumpAllowsQueuedInput(state: WorkspaceJumpState): boolean {
  return state.phase === 'settled' && state.location === 'destination' &&
    state.outcome === 'completed' && state.continuation.state === 'admitted' &&
    !state.cancelled && !state.requiresUserReconciliation
}
/** Call before registry.launch. Unreadable named records retain their own rows;
 * a directory read failure retains all rows until explicit recovery.
 */
export function loadWorkspaceJumpRetention(directory = workspaceJumpDirectory()): { appSessionIds: Set<string>; retainAll: boolean } {
  const appSessionIds = new Set<string>()
  let names: string[]
  try { names = readdirSync(directory) }
  catch (error) { return { appSessionIds, retainAll: (error as NodeJS.ErrnoException).code !== 'ENOENT' } }
  for (const name of names) {
    const id = name.endsWith('.json') ? name.slice(0, -5) : ''
    if (!UUID.test(id)) continue
    try { const state = readWorkspaceJump(id, directory); if (state && workspaceJumpRequiresRetention(state)) appSessionIds.add(id) }
    catch { appSessionIds.add(id) }
  }
  return { appSessionIds, retainAll: false }
}
