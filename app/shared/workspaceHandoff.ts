/** Bounded operation evidence shared by the engine and desktop control plane.
 * No transcript content or paths cross this boundary. See CHAT-RELOCATION's
 * 2026-10-09 amendment and the handoff implementation plan.
 */
export type ResumeCheckpointV1 = {
  version: 1
  prefixBytes: number
  prefixSha256: string
  activeTipUuid: string
  projectionSha256: string
  messageCount: number
}
export type WorkspaceHandoffIdentity = {
  appSessionId: string
  engineSessionId: string
  operationId: string
  continuationId: string
  sourceGeneration: string
  admissionGeneration: string | null
  operationSha256: string
}
export type WorkspaceHandoffExecutionOutcome = 'success' | 'failed' | 'interrupted' | 'not_started'
export type WorkspaceHandoffExecutionRecord = WorkspaceHandoffIdentity & {
  version: 1
  origin: 'fresh' | 'legacy'
  revision: number
  consumed: boolean
  inputCommitted: boolean
  cancellation: null | {
    cancelId: string
    application: 'prevented_start' | 'abort_signalled' | 'too_late'
    order: number
  }
  terminal: null | {
    outcome: WorkspaceHandoffExecutionOutcome
    order: number
    checkpoint: ResumeCheckpointV1
  }
  notice: null | {
    displayUuid: string
    contextUuid: string
    outcome: 'failed' | 'cancelled' | 'uncertain'
    checkpoint: ResumeCheckpointV1
  }
  reconciliation: null | {
    noticeUuid: string
    inputUuid: string
    contextUuid: string
    checkpoint: ResumeCheckpointV1
  }
}
export type WorkspaceHandoffRecordStatus =
  | { kind: 'absent' | 'unreadable' | 'invalid' }
  | { kind: 'valid'; record: WorkspaceHandoffExecutionRecord }
export type WorkspaceHandoffSnapshot = WorkspaceHandoffIdentity & {
  observerGeneration: string
  statusSeq: number
  execution: 'idle' | 'consuming' | 'running' | 'finalizing' | 'terminal' | 'unconfirmed'
  record: WorkspaceHandoffRecordStatus
  gate: {
    mode: 'held' | 'review' | 'open'
    reservationOperationId: string | null
    requiresUserReconciliation: boolean
  }
}
export type WorkspaceHandoffAction = 'verify' | 'continue' | 'status' | 'cancel' | 'settle' | 'release'
export type WorkspaceHandoffDisposition = 'accepted' | 'already_applied' | 'busy' | 'refused'
export type WorkspaceHandoffReason = 'wrong_identity' | 'wrong_generation' | 'invalid_state' | 'not_trusted' |
  'durability_unconfirmed' | 'storage_unavailable' | 'conflict' | 'rate_limited'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[0-9a-f]{64}$/
export function isHandoffUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}
function sha(value: unknown): value is string { return typeof value === 'string' && SHA256.test(value) }
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key))
}
function integer(value: unknown, minimum = 1): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}
const identityKeys = ['appSessionId', 'engineSessionId', 'operationId', 'continuationId', 'sourceGeneration', 'admissionGeneration', 'operationSha256'] as const
function identity(value: Record<string, unknown>): boolean {
  return isHandoffUuid(value.appSessionId) && isHandoffUuid(value.engineSessionId) &&
    isHandoffUuid(value.operationId) && isHandoffUuid(value.continuationId) &&
    typeof value.sourceGeneration === 'string' && value.sourceGeneration.length > 0 && value.sourceGeneration.length <= 256 &&
    (value.admissionGeneration === null || isHandoffUuid(value.admissionGeneration)) && sha(value.operationSha256)
}
export function isResumeCheckpointV1(value: unknown): value is ResumeCheckpointV1 {
  return object(value) && keys(value, ['version', 'prefixBytes', 'prefixSha256', 'activeTipUuid', 'projectionSha256', 'messageCount']) &&
    value.version === 1 && integer(value.prefixBytes) && sha(value.prefixSha256) &&
    isHandoffUuid(value.activeTipUuid) && sha(value.projectionSha256) && integer(value.messageCount, 0)
}
export function isWorkspaceHandoffExecutionRecord(value: unknown): value is WorkspaceHandoffExecutionRecord {
  if (!object(value) || !keys(value, [...identityKeys, 'version', 'origin', 'revision', 'consumed', 'inputCommitted', 'cancellation', 'terminal', 'notice', 'reconciliation']) ||
    !identity(value) || value.version !== 1 || !['fresh', 'legacy'].includes(value.origin as string) ||
    !integer(value.revision) || typeof value.consumed !== 'boolean' || typeof value.inputCommitted !== 'boolean') return false
  if (value.origin === 'fresh' && !isHandoffUuid(value.sourceGeneration)) return false
  if (value.inputCommitted && (!value.consumed || value.admissionGeneration === null)) return false
  const cancel = value.cancellation
  if (cancel !== null && (!object(cancel) || !keys(cancel, ['cancelId', 'application', 'order']) || !isHandoffUuid(cancel.cancelId) ||
    !['prevented_start', 'abort_signalled', 'too_late'].includes(cancel.application as string) || !integer(cancel.order))) return false
  const terminal = value.terminal
  if (terminal !== null) {
    if (!object(terminal) || !keys(terminal, ['outcome', 'order', 'checkpoint']) ||
      !['success', 'failed', 'interrupted', 'not_started'].includes(terminal.outcome as string) ||
      !integer(terminal.order) || !isResumeCheckpointV1(terminal.checkpoint)) return false
    if (terminal.outcome === 'success' && (value.origin !== 'fresh' || !value.consumed || !value.inputCommitted || value.admissionGeneration === null ||
      (object(cancel) && cancel.application === 'prevented_start'))) return false
    if (!value.consumed && terminal.outcome !== 'not_started') return false
  }
  const notice = value.notice
  if (notice !== null && (!object(notice) || !keys(notice, ['displayUuid', 'contextUuid', 'outcome', 'checkpoint']) ||
    !isHandoffUuid(notice.displayUuid) || !isHandoffUuid(notice.contextUuid) ||
    !['failed', 'cancelled', 'uncertain'].includes(notice.outcome as string) || !isResumeCheckpointV1(notice.checkpoint))) return false
  const reconciliation = value.reconciliation
  if (reconciliation !== null && (!object(reconciliation) || !keys(reconciliation, ['noticeUuid', 'inputUuid', 'contextUuid', 'checkpoint']) ||
    !object(notice) || reconciliation.noticeUuid !== notice.displayUuid || !isHandoffUuid(reconciliation.inputUuid) ||
    !isHandoffUuid(reconciliation.contextUuid) || !isResumeCheckpointV1(reconciliation.checkpoint))) return false
  return true
}
export function isWorkspaceHandoffSnapshot(value: unknown): value is WorkspaceHandoffSnapshot {
  if (!object(value) || !keys(value, [...identityKeys, 'observerGeneration', 'statusSeq', 'execution', 'record', 'gate']) ||
    !identity(value) || !isHandoffUuid(value.observerGeneration) || !integer(value.statusSeq) ||
    !['idle', 'consuming', 'running', 'finalizing', 'terminal', 'unconfirmed'].includes(value.execution as string) ||
    !object(value.record) || !object(value.gate)) return false
  const record = value.record
  if (record.kind === 'valid') {
    if (!keys(record, ['kind', 'record']) || !isWorkspaceHandoffExecutionRecord(record.record)) return false
    const evidence = record.record
    if (identityKeys.some(key => evidence[key] !== value[key])) return false
  } else if (!keys(record, ['kind']) || !['absent', 'invalid', 'unreadable'].includes(record.kind as string)) return false
  const gate = value.gate
  if (!keys(gate, ['mode', 'reservationOperationId', 'requiresUserReconciliation']) ||
    !['held', 'review', 'open'].includes(gate.mode as string) ||
    (gate.reservationOperationId !== null && !isHandoffUuid(gate.reservationOperationId)) ||
    typeof gate.requiresUserReconciliation !== 'boolean') return false
  if (gate.mode === 'open' && (gate.reservationOperationId !== null || gate.requiresUserReconciliation)) return false
  if (gate.mode === 'review' && !gate.requiresUserReconciliation) return false
  if (gate.mode === 'held' && gate.reservationOperationId !== value.operationId) return false
  if (value.execution === 'terminal' && (record.kind !== 'valid' || !isWorkspaceHandoffExecutionRecord(record.record) || !record.record.terminal)) return false
  return true
}
export function isWorkspaceHandoffAction(value: unknown): value is WorkspaceHandoffAction {
  return ['verify', 'continue', 'status', 'cancel', 'settle', 'release'].includes(value as string)
}
export function isWorkspaceHandoffReason(value: unknown): value is WorkspaceHandoffReason {
  return ['wrong_identity', 'wrong_generation', 'invalid_state', 'not_trusted', 'durability_unconfirmed', 'storage_unavailable', 'conflict', 'rate_limited'].includes(value as string)
}
