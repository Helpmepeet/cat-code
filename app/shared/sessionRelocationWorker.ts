import { isSessionBinding } from './sessionBinding.js'
import { isRelocationControls } from '../../src/utils/sessionRelocationState.js'
import type { RelocationRequest } from '../../src/utils/sessionRelocationState.js'

export const MAX_RELOCATION_RECORD_BYTES = 16_384
export type SessionRelocationRequest = RelocationRequest & { type: 'session-relocation'; version: 1 }
export type SessionRelocationResult = { type: 'session-relocation-result'; version: 1; ok: boolean }
export type MoveSessionCommand = { appSessionId: string; cwdToken: string | null }

/** Closed renderer-to-main input; the cwd remains an opaque one-time picker token. */
export function parseMoveSessionCommand(raw: unknown): MoveSessionCommand | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  if (Object.keys(r).sort().join(',') !== 'appSessionId,cwdToken' ||
      typeof r.appSessionId !== 'string' || !uuid.test(r.appSessionId) ||
      (r.cwdToken !== null && (typeof r.cwdToken !== 'string' || !uuid.test(r.cwdToken)))) return null
  return raw as MoveSessionCommand
}

export function parseSessionRelocationRequest(raw: unknown): SessionRelocationRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  const keys = Object.keys(r).sort().join(',')
  if ((keys !== 'appSessionId,controls,engineSessionId,source,target,type,version' &&
       keys !== 'appSessionId,controls,engineSessionId,rollback,source,target,type,version') ||
      r.type !== 'session-relocation' || r.version !== 1 ||
      (r.rollback !== undefined && r.rollback !== true) ||
      !isRelocationControls(r.controls) ||
      typeof r.engineSessionId !== 'string' || !uuid.test(r.engineSessionId) ||
      typeof r.appSessionId !== 'string' || !uuid.test(r.appSessionId)) return null
  for (const value of [r.source, r.target]) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const v = value as Record<string, unknown>
    if (Object.keys(v).sort().join(',') !== 'binding,cwd' || typeof v.cwd !== 'string' ||
        !v.cwd.startsWith('/') || v.cwd.length > 4096 || v.cwd.includes('\0') || !isSessionBinding(v.binding)) return null
  }
  return raw as SessionRelocationRequest
}

export function parseSessionRelocationResult(raw: unknown): SessionRelocationResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  return Object.keys(r).sort().join(',') === 'ok,type,version' &&
    r.type === 'session-relocation-result' && r.version === 1 && typeof r.ok === 'boolean'
    ? raw as SessionRelocationResult : null
}
