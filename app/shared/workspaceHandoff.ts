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
/**
 * V2 binds the exact archived prefix and its raw active tip, like V1.
 * projectionSha256/messageCount describe the identity-preserving deterministic
 * resume projection, not the raw archived chain. Only unresolved tool
 * trajectories, orphan thinking and whitespace-only assistants are filtered.
 * Sealing also requires independent raw engine rows to match archived rows
 * before filtering; finalized usage/stop metadata must already be persisted.
 */
export type ResumeCheckpointV2 = Omit<ResumeCheckpointV1, 'version'> & { version: 2 }
export type ResumeCheckpoint = ResumeCheckpointV1 | ResumeCheckpointV2
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
    checkpoint: ResumeCheckpoint
  }
  notice: null | {
    displayUuid: string
    contextUuid: string
    outcome: 'failed' | 'cancelled' | 'uncertain' | 'continuation_failed'
    checkpoint: ResumeCheckpoint
  }
  reconciliation: null | {
    noticeUuid: string
    inputUuid: string
    contextUuid: string
    checkpoint: ResumeCheckpoint
  }
}
export type WorkspaceHandoffRecordStatus =
  | { kind: 'absent' | 'unreadable' | 'invalid' }
  | { kind: 'valid'; record: WorkspaceHandoffExecutionRecord }
export type WorkspaceHandoffFailure = {
  stage: 'execution' | 'checkpoint_seal' | 'execution_record' | 'recovery_notice'
  reason: 'invalid_message_identity' | 'duplicate_message_identity' | 'unknown'
  messageUuid?: string
  messageType?: string
  ioCode?: 'EIO' | 'ENOSPC' | 'EACCES' | 'EPERM' | 'ENOENT' | 'EROFS' | 'EDQUOT' | 'EBUSY'
}
export function isWorkspaceHandoffFailure(value: unknown): value is WorkspaceHandoffFailure {
  if (!object(value) || Object.keys(value).some(key => !['stage', 'reason', 'messageUuid', 'messageType', 'ioCode'].includes(key))) return false
  return ['execution', 'checkpoint_seal', 'execution_record', 'recovery_notice'].includes(value.stage as string) &&
    ['invalid_message_identity', 'duplicate_message_identity', 'unknown'].includes(value.reason as string) &&
    (value.messageUuid === undefined || isHandoffUuid(value.messageUuid)) &&
    (value.messageType === undefined || ['user', 'assistant', 'attachment', 'system', 'progress'].includes(value.messageType as string)) &&
    (value.ioCode === undefined || ['EIO', 'ENOSPC', 'EACCES', 'EPERM', 'ENOENT', 'EROFS', 'EDQUOT', 'EBUSY'].includes(value.ioCode as string))
}
export type WorkspaceHandoffSnapshot = WorkspaceHandoffIdentity & {
  observerGeneration: string
  statusSeq: number
  execution: 'idle' | 'consuming' | 'running' | 'finalizing' | 'terminal' | 'unconfirmed'
  settled: boolean
  failure: WorkspaceHandoffFailure | null
  recoveryId: string | null
  record: WorkspaceHandoffRecordStatus
  gate: {
    mode: 'held' | 'review' | 'open'
    reservationOperationId: string | null
    requiresUserReconciliation: boolean
  }
}
export type WorkspaceHandoffAction = 'verify' | 'continue' | 'status' | 'cancel' | 'settle' | 'release' | 'prepare_recovery' | 'cancel_recovery'
export type WorkspaceHandoffDisposition = 'accepted' | 'already_applied' | 'busy' | 'refused'
export type WorkspaceHandoffReason = 'wrong_identity' | 'wrong_generation' | 'invalid_state' | 'not_trusted' |
  'durability_unconfirmed' | 'storage_unavailable' | 'conflict' | 'rate_limited' | 'unresolved_effects' | 'active_work' | 'pending_permissions' | 'live_tasks' | 'queued_input' | 'pending_receipts' | 'pending_writes' | 'effects_unavailable'

export type WorkspaceRecoveryPreparation = { ok: true } | { ok: false; reason: WorkspaceHandoffReason }

/** Eligibility is descriptive. The receiving sidecar must still reserve and recheck effects. */
export function isSettledWorkspaceRecoveryCandidate(status: WorkspaceHandoffSnapshot | null | undefined): boolean {
  if (!status?.settled || status.gate.mode !== 'held' || status.record.kind !== 'valid' ||
      !status.record.record.consumed || status.record.record.notice) return false
  return status.execution === 'unconfirmed' || status.execution === 'terminal' &&
    status.failure?.stage === 'recovery_notice' && status.record.record.terminal?.outcome !== 'success'
}

export function workspaceRecoveryRefusalText(reason: WorkspaceHandoffReason): string {
  switch (reason) {
    case 'active_work': return 'This Chat is still finishing a turn. Wait for it to settle before recovering.'
    case 'pending_permissions': return 'Resolve the pending approvals before recovering this Chat.'
    case 'live_tasks': return 'Background work is still active. Stop it using the existing controls before recovering.'
    case 'queued_input': return 'This Chat has queued input. Review or recall it before recovering.'
    case 'pending_receipts': return 'Tool results are still pending. Wait for them to settle before recovering.'
    case 'pending_writes': return 'Saved changes are still being written. Wait for them to finish before recovering.'
    case 'effects_unavailable': return 'Active work could not be checked. This Chat remains held and your draft is kept.'
    case 'durability_unconfirmed': return 'Saved history could not be verified. This Chat remains held. Inspect or export it before trying recovery again. Your draft is kept.'
    case 'wrong_identity': case 'wrong_generation': case 'conflict': return 'This Chat changed while recovery was preparing. Refresh its status and try again. Your draft is kept.'
    default: return 'Recovery could not confirm this Chat is ready. Your draft is kept.'
  }
}

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
export function isResumeCheckpointV2(value: unknown): value is ResumeCheckpointV2 {
  return object(value) && keys(value, ['version', 'prefixBytes', 'prefixSha256', 'activeTipUuid', 'projectionSha256', 'messageCount']) &&
    value.version === 2 && integer(value.prefixBytes) && sha(value.prefixSha256) &&
    isHandoffUuid(value.activeTipUuid) && sha(value.projectionSha256) && integer(value.messageCount, 0)
}
export function isResumeCheckpoint(value: unknown): value is ResumeCheckpoint {
  return isResumeCheckpointV1(value) || isResumeCheckpointV2(value)
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
      !integer(terminal.order) || !isResumeCheckpoint(terminal.checkpoint)) return false
    if (terminal.outcome === 'success' && (value.origin !== 'fresh' || !value.consumed || !value.inputCommitted || value.admissionGeneration === null ||
      (object(cancel) && cancel.application === 'prevented_start'))) return false
    if (!value.consumed && terminal.outcome !== 'not_started') return false
  }
  const notice = value.notice
  if (notice !== null && (!object(notice) || !keys(notice, ['displayUuid', 'contextUuid', 'outcome', 'checkpoint']) ||
    !isHandoffUuid(notice.displayUuid) || !isHandoffUuid(notice.contextUuid) ||
    !['failed', 'cancelled', 'uncertain', 'continuation_failed'].includes(notice.outcome as string) || !isResumeCheckpoint(notice.checkpoint))) return false
  if (object(notice) && notice.outcome === 'continuation_failed' &&
    (!value.consumed || value.admissionGeneration === null || !object(terminal) || terminal.outcome !== 'failed')) return false
  const reconciliation = value.reconciliation
  if (reconciliation !== null && (!object(reconciliation) || !keys(reconciliation, ['noticeUuid', 'inputUuid', 'contextUuid', 'checkpoint']) ||
    !object(notice) || reconciliation.noticeUuid !== notice.displayUuid || !isHandoffUuid(reconciliation.inputUuid) ||
    !isHandoffUuid(reconciliation.contextUuid) || !isResumeCheckpoint(reconciliation.checkpoint))) return false
  return true
}
export function isWorkspaceHandoffSnapshot(value: unknown): value is WorkspaceHandoffSnapshot {
  if (!object(value) || !keys(value, [...identityKeys, 'observerGeneration', 'statusSeq', 'execution', 'settled', 'failure', 'recoveryId', 'record', 'gate']) ||
    !identity(value) || !isHandoffUuid(value.observerGeneration) || !integer(value.statusSeq) ||
    !['idle', 'consuming', 'running', 'finalizing', 'terminal', 'unconfirmed'].includes(value.execution as string) ||
    typeof value.settled !== 'boolean' || (value.failure !== null && !isWorkspaceHandoffFailure(value.failure)) ||
    (value.recoveryId !== null && !isHandoffUuid(value.recoveryId)) || !object(value.record) || !object(value.gate)) return false
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
  return ['verify', 'continue', 'status', 'cancel', 'settle', 'release', 'prepare_recovery', 'cancel_recovery'].includes(value as string)
}
export function isWorkspaceHandoffReason(value: unknown): value is WorkspaceHandoffReason {
  return ['wrong_identity', 'wrong_generation', 'invalid_state', 'not_trusted', 'durability_unconfirmed', 'storage_unavailable', 'conflict', 'rate_limited', 'unresolved_effects', 'active_work', 'pending_permissions', 'live_tasks', 'queued_input', 'pending_receipts', 'pending_writes', 'effects_unavailable'].includes(value as string)
}
