import { PROTOCOL_VERSION, type SessionId } from './protocol.js'

export const WORK_STATUS_COUNT_LIMIT = 4096
export const WORK_STATUS_MAX_BYTES = 2048

/** Host-only query; no renderer or preload API can originate this read. */
export type WorkStatusRequest = {
  type: 'work.status'
  requestId: string
  forGeneration: string
}

export type WorkStatusSummary = {
  version: 1
  available: boolean
  hasUnfinishedWork: boolean
  activeTurn: boolean
  pendingContinuation: boolean
  activeSubagents: number
  activeBackgroundTasks: number
  queuedWork: number
  waitingForApproval: boolean
}

export type WorkStatusFrame = {
  kind: 'work.status'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  requestId: string
  generation: string
  sequence: number
  work: WorkStatusSummary
}

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const SUMMARY_KEYS = [
  'version', 'available', 'hasUnfinishedWork', 'activeTurn',
  'pendingContinuation', 'activeSubagents', 'activeBackgroundTasks',
  'queuedWork', 'waitingForApproval',
]

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

export function isWorkStatusRequest(value: unknown): value is WorkStatusRequest {
  return object(value) && exactKeys(value, ['type', 'requestId', 'forGeneration']) &&
    value.type === 'work.status' &&
    typeof value.requestId === 'string' && UUID.test(value.requestId) &&
    typeof value.forGeneration === 'string' && UUID.test(value.forGeneration)
}

export function isWorkStatusSummary(value: unknown): value is WorkStatusSummary {
  if (!object(value) || !exactKeys(value, SUMMARY_KEYS) || value.version !== 1 ||
      typeof value.available !== 'boolean' || typeof value.hasUnfinishedWork !== 'boolean' ||
      typeof value.activeTurn !== 'boolean' || typeof value.pendingContinuation !== 'boolean' ||
      typeof value.waitingForApproval !== 'boolean') return false
  for (const key of ['activeSubagents', 'activeBackgroundTasks', 'queuedWork'] as const) {
    const count = value[key]
    if (typeof count !== 'number' || !Number.isSafeInteger(count) ||
        count < 0 || count > WORK_STATUS_COUNT_LIMIT) return false
  }
  if (value.available && !value.hasUnfinishedWork) {
    return !value.activeTurn && !value.pendingContinuation && !value.waitingForApproval &&
      value.activeSubagents === 0 && value.activeBackgroundTasks === 0 && value.queuedWork === 0
  }
  return true
}

export function isWorkStatusFrame(value: unknown): value is WorkStatusFrame {
  if (!object(value) || Object.keys(value).some(key =>
    !['kind', 'protocolVersion', 'sessionId', 'requestId', 'generation', 'sequence', 'work'].includes(key)) ||
      value.kind !== 'work.status' || value.protocolVersion !== PROTOCOL_VERSION ||
      typeof value.sessionId !== 'string' ||
      typeof value.requestId !== 'string' || !UUID.test(value.requestId) ||
      typeof value.generation !== 'string' || !UUID.test(value.generation) ||
      typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
      !isWorkStatusSummary(value.work)) return false
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= WORK_STATUS_MAX_BYTES
  } catch {
    return false
  }
}
