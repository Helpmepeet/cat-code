/** Durable one-shot desktop jump ledger. Node-compatible; no engine bootstrap.
 * Main is the sole writer. Engines read it before startup and turn admission.
 * A malformed record is an admission refusal, never an empty/unused capability.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { isSessionBinding } from '../../app/shared/sessionBinding.js'
import type { SessionLocation, SessionRelocation } from './sessionRelocationState.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const MAX_WORKSPACE_JUMP_STATE_BYTES = 16 * 1024
export type WorkspaceJumpBoundary = { tipUuid: string; toolUseId: string }
export type WorkspaceJumpStateV1 = {
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

export type WorkspaceJumpStateV2 = Omit<WorkspaceJumpStateV1, 'version' | 'cancelled' | 'requiresUserReconciliation' | 'sourceOutcomePersisted' | 'outcome' | 'continuation'> & {
  version: 2
  revision: number
  origin: 'fresh' | 'legacy'
  continuation: { id: string; admissionGeneration: string | null; dispatch: 'none' | 'unknown' | 'consumed'; outcome: 'pending' | 'success' | 'failed' | 'interrupted' | 'not_started' | 'unknown' | 'legacy_settled'; receiptRevision: number | null; checkpointSha256: string | null }
  cancellation: null | { cancelId: string; requestedBy: 'stop' | 'close'; application: 'unknown' | 'prevented_start' | 'abort_signalled' | 'too_late' }
  review: { required: boolean; noticeUuid: string | null; reconciledInputUuid: string | null }
  release: { target: 'held' | 'review' | 'open'; authorizedRevision: number | null; confirmed: null | { generation: string; mode: 'review' | 'open' } }
  legacy?: Pick<WorkspaceJumpStateV1, 'cancelled' | 'requiresUserReconciliation' | 'sourceOutcomePersisted' | 'outcome' | 'continuation'>
}
export type WorkspaceJumpState = WorkspaceJumpStateV1 | WorkspaceJumpStateV2

export function upgradeWorkspaceJumpState(state: WorkspaceJumpState): WorkspaceJumpStateV2 {
  if (state.version === 2) return state
  const { version: _version, cancelled, requiresUserReconciliation, sourceOutcomePersisted, outcome, continuation, ...identity } = state
  const settled = state.phase === 'settled' && continuation.state === 'settled' && !requiresUserReconciliation && (outcome === 'completed' || sourceOutcomePersisted)
  const attempted = continuation.state === 'admitted' || continuation.state === 'uncertain' || (continuation.state === 'settled' && state.consumed)
  return { ...identity, version: 2, revision: 1, origin: 'legacy',
    continuation: { id: continuation.id, admissionGeneration: null, dispatch: attempted ? 'unknown' : 'none', outcome: settled ? 'legacy_settled' : attempted ? 'unknown' : 'pending', receiptRevision: null, checkpointSha256: null },
    cancellation: cancelled ? { cancelId: state.operationId, requestedBy: 'stop', application: 'unknown' } : null,
    review: { required: !settled && (requiresUserReconciliation || state.phase === 'settled'), noticeUuid: null, reconciledInputUuid: null },
    release: { target: settled ? 'open' : sourceOutcomePersisted ? 'review' : 'held', authorizedRevision: null, confirmed: null },
    legacy: { cancelled, requiresUserReconciliation, sourceOutcomePersisted, ...(outcome ? { outcome } : {}), continuation },
  }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  return value
}
/** Immutable admission identity; semantic state is deliberately excluded. */
export function workspaceJumpOperationSha256(state: WorkspaceJumpState): string {
  return createHash('sha256').update(JSON.stringify([state.appSessionId, state.engineSessionId, state.operationId, state.sourceGeneration, canonical(state.source), canonical(state.target), canonical(state.boundary ?? null), state.continuation.id])).digest('hex')
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
function isWorkspaceJumpStateV1(value: unknown): value is WorkspaceJumpStateV1 {
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
const HEX = /^[0-9a-f]{64}$/
const uuidOrNull = (v: unknown) => v === null || typeof v === 'string' && UUID.test(v)
const integerOrNull = (v: unknown) => v === null || Number.isSafeInteger(v) && (v as number) > 0
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> { return object(value) && Object.keys(value).every(key => keys.includes(key)) && keys.every(key => key in value) }
export function isWorkspaceJumpState(value: unknown): value is WorkspaceJumpState {
  if (isWorkspaceJumpStateV1(value)) return true
  if (!object(value) || value.version !== 2) return false
  const { revision, origin, continuation, cancellation, review, release, legacy, ...identity } = value
  const permitted = ['version','appSessionId','engineSessionId','operationId','sourceGeneration','source','target','acceptedAt','phase','boundary','location','consumed','compensation']
  if (Object.keys(identity).some(key => !permitted.includes(key))) return false
  if (!Number.isSafeInteger(revision) || (revision as number) < 1 || !['fresh','legacy'].includes(origin as string)) return false
  if (!exact(continuation, ['id','admissionGeneration','dispatch','outcome','receiptRevision','checkpointSha256']) || typeof continuation.id !== 'string' || !UUID.test(continuation.id) || !uuidOrNull(continuation.admissionGeneration) || !['none','unknown','consumed'].includes(continuation.dispatch as string) || !['pending','success','failed','interrupted','not_started','unknown','legacy_settled'].includes(continuation.outcome as string) || !integerOrNull(continuation.receiptRevision) || !(continuation.checkpointSha256 === null || typeof continuation.checkpointSha256 === 'string' && HEX.test(continuation.checkpointSha256))) return false
  if (cancellation !== null && (!exact(cancellation,['cancelId','requestedBy','application']) || !uuidOrNull(cancellation.cancelId) || cancellation.cancelId === null || !['stop','close'].includes(cancellation.requestedBy as string) || !['unknown','prevented_start','abort_signalled','too_late'].includes(cancellation.application as string))) return false
  if (!exact(review,['required','noticeUuid','reconciledInputUuid']) || typeof review.required !== 'boolean' || !uuidOrNull(review.noticeUuid) || !uuidOrNull(review.reconciledInputUuid)) return false
  if (!exact(release,['target','authorizedRevision','confirmed']) || !['held','review','open'].includes(release.target as string) || !integerOrNull(release.authorizedRevision) || release.confirmed !== null && (!exact(release.confirmed,['generation','mode']) || !uuidOrNull(release.confirmed.generation) || release.confirmed.generation === null || !['review','open'].includes(release.confirmed.mode as string))) return false
  if (origin === 'fresh' && legacy !== undefined || origin === 'legacy' && !object(legacy)) return false
  if (origin === 'fresh' && (typeof identity.sourceGeneration !== 'string' || !UUID.test(identity.sourceGeneration))) return false
  const probe = { ...identity, version: 1, cancelled: false, requiresUserReconciliation: false, sourceOutcomePersisted: false, continuation: { id: continuation.id, state: 'not_admitted' } }
  if (!isWorkspaceJumpStateV1(probe)) return false
  if (legacy !== undefined && !isWorkspaceJumpStateV1({ ...probe, ...legacy })) return false
  if (continuation.outcome === 'success' && (origin !== 'fresh' || continuation.dispatch !== 'consumed' || continuation.admissionGeneration === null || continuation.receiptRevision === null || continuation.checkpointSha256 === null)) return false
  if (review.reconciledInputUuid !== null && (review.noticeUuid === null || review.required)) return false
  if (release.confirmed !== null && (release.confirmed.mode !== release.target || release.authorizedRevision === null)) return false
  return true
}
export function hasVerifiedSourceCompensation(state: WorkspaceJumpState | null, record: SessionRelocation,
  appSessionId: string, engineSessionId: string, cwd: string): boolean {
  return !!state && state.appSessionId === appSessionId && state.engineSessionId === engineSessionId && !state.consumed &&
    state.location === 'source' && state.phase === 'settled' && !workspaceJumpRequiresRetention(state) &&
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
/** A confirmed gate is historical evidence after convergence. Replacement
 * refreshes its live gate without revalidating a superseded transcript prefix. */
export function workspaceJumpHasConfirmedGate(state: WorkspaceJumpState): boolean {
  if (state.version === 1) return state.phase === 'settled' && state.continuation.state === 'settled' && !state.requiresUserReconciliation && (state.outcome === 'completed' || state.sourceOutcomePersisted)
  return state.phase === 'settled' && state.release.target !== 'held' && state.release.authorizedRevision !== null && state.release.confirmed?.mode === state.release.target
}
export function workspaceJumpRequiresRetention(state: WorkspaceJumpState, _liveGeneration?: string): boolean {
  if (state.version === 1) return state.phase !== 'settled' || state.requiresUserReconciliation || state.continuation.state === 'admitted' || state.continuation.state === 'uncertain'
  if (state.continuation.outcome === 'legacy_settled' && !state.review.required) return false
  if (workspaceJumpHasConfirmedGate(state) && state.release.target === 'open' && !state.review.required && (state.continuation.outcome === 'success' || state.review.reconciledInputUuid !== null)) return false
  return state.phase !== 'settled' || state.review.required || ['pending','unknown'].includes(state.continuation.outcome) || !workspaceJumpHasConfirmedGate(state)
}
/** Live activity comes from the authenticated current-generation observation. */
export function workspaceJumpAllowsQueuedInput(state: WorkspaceJumpState, live?: { observerGeneration: string; execution: string }): boolean {
  if (state.version === 1) return false
  return state.phase === 'settled' && state.location === 'destination' && state.continuation.dispatch === 'consumed' && state.continuation.admissionGeneration === live?.observerGeneration && live.execution === 'running' && !state.cancellation && !state.review.required
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
