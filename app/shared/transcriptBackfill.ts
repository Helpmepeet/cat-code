/**
 * Private main↔backfill-worker boundary for PL-B. This is NOT a renderer or
 * sidecar socket protocol: Electron main starts one short-lived, serialized
 * engine-graph worker after first paint and remains the sole cache writer.
 *
 * Both ends runtime-validate this boundary. Limits keep a corrupt/compromised
 * child from growing main's buffers without bound, and the result vocabulary is
 * deliberately transcript-only (message events plus the visible truncation
 * boundary already allowed in TranscriptCache).
 */

import { isAbsolute, basename } from 'node:path'

import {
  HISTORY_REPLAY_TRUNCATION_REQUEST_ID,
  PROTOCOL_VERSION,
  type ServerFrame,
  type SessionId,
} from './protocol.js'
import {
  MAX_HISTORY_REPLAY_BYTES,
  MAX_HISTORY_REPLAY_FRAMES,
} from './limits.js'

export const TRANSCRIPT_BACKFILL_BOUNDARY_VERSION = 1
export const MAX_TRANSCRIPT_BACKFILL_SESSIONS = 32
export const MAX_TRANSCRIPT_BACKFILL_INPUT_BYTES = 256 * 1024
export const MAX_TRANSCRIPT_BACKFILL_RECORD_BYTES =
  MAX_HISTORY_REPLAY_BYTES + 256 * 1024

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type TranscriptBackfillItem = {
  appSessionId: SessionId
  engineSessionId: string
  transcriptPath: string
}

export type TranscriptBackfillRequest = {
  version: typeof TRANSCRIPT_BACKFILL_BOUNDARY_VERSION
  items: TranscriptBackfillItem[]
}

export type TranscriptBackfillSessionResult = {
  type: 'session'
  appSessionId: SessionId
  engineSessionId: string
  frames: ServerFrame[]
}

export type TranscriptBackfillFailureResult = {
  type: 'failure'
  appSessionId: SessionId
  engineSessionId: string
  reason: 'missing' | 'invalid' | 'session_mismatch' | 'internal'
}

export type TranscriptBackfillDoneResult = {
  type: 'done'
  attempted: number
}

export type TranscriptBackfillResult =
  | TranscriptBackfillSessionResult
  | TranscriptBackfillFailureResult
  | TranscriptBackfillDoneResult

export function parseTranscriptBackfillRequest(
  value: unknown,
): TranscriptBackfillRequest | null {
  if (!hasExactKeys(value, ['version', 'items'])) return null
  if (value.version !== TRANSCRIPT_BACKFILL_BOUNDARY_VERSION) return null
  if (
    !Array.isArray(value.items) ||
    value.items.length > MAX_TRANSCRIPT_BACKFILL_SESSIONS
  ) {
    return null
  }
  const items: TranscriptBackfillItem[] = []
  const seen = new Set<string>()
  for (const item of value.items) {
    if (!hasExactKeys(item, ['appSessionId', 'engineSessionId', 'transcriptPath'])) {
      return null
    }
    if (
      !isUuid(item.appSessionId) ||
      !isUuid(item.engineSessionId) ||
      typeof item.transcriptPath !== 'string' ||
      item.transcriptPath.length === 0 ||
      item.transcriptPath.length > 4096 ||
      !isAbsolute(item.transcriptPath) ||
      basename(item.transcriptPath) !== `${item.engineSessionId}.jsonl` ||
      seen.has(item.appSessionId)
    ) {
      return null
    }
    seen.add(item.appSessionId)
    items.push({
      appSessionId: item.appSessionId,
      engineSessionId: item.engineSessionId,
      transcriptPath: item.transcriptPath,
    })
  }
  return { version: TRANSCRIPT_BACKFILL_BOUNDARY_VERSION, items }
}

export function parseTranscriptBackfillResult(
  value: unknown,
): TranscriptBackfillResult | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null
  if (value.type === 'done') {
    if (!hasExactKeys(value, ['type', 'attempted'])) return null
    if (
      typeof value.attempted !== 'number' ||
      !Number.isInteger(value.attempted) ||
      value.attempted < 0 ||
      value.attempted > MAX_TRANSCRIPT_BACKFILL_SESSIONS
    ) {
      return null
    }
    return { type: 'done', attempted: value.attempted }
  }
  if (value.type === 'failure') {
    if (
      !hasExactKeys(value, [
        'type',
        'appSessionId',
        'engineSessionId',
        'reason',
      ]) ||
      !isUuid(value.appSessionId) ||
      !isUuid(value.engineSessionId) ||
      !['missing', 'invalid', 'session_mismatch', 'internal'].includes(
        String(value.reason),
      )
    ) {
      return null
    }
    return {
      type: 'failure',
      appSessionId: value.appSessionId,
      engineSessionId: value.engineSessionId,
      reason: value.reason as TranscriptBackfillFailureResult['reason'],
    }
  }
  if (value.type !== 'session') return null
  if (
    !hasExactKeys(value, [
      'type',
      'appSessionId',
      'engineSessionId',
      'frames',
    ]) ||
    !isUuid(value.appSessionId) ||
    !isUuid(value.engineSessionId) ||
    !Array.isArray(value.frames) ||
    value.frames.length > MAX_HISTORY_REPLAY_FRAMES + 1
  ) {
    return null
  }
  const frames: ServerFrame[] = []
  for (let i = 0; i < value.frames.length; i++) {
    const frame = parseTranscriptFrame(
      value.frames[i],
      value.appSessionId,
      value.engineSessionId,
      i === 0,
    )
    if (!frame) return null
    frames.push(frame)
  }
  return {
    type: 'session',
    appSessionId: value.appSessionId,
    engineSessionId: value.engineSessionId,
    frames,
  }
}

function parseTranscriptFrame(
  value: unknown,
  appSessionId: string,
  engineSessionId: string,
  first: boolean,
): ServerFrame | null {
  if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION) return null
  if (value.sessionId !== appSessionId) return null
  if (value.kind === 'error') {
    if (!first) return null
    if (
      !hasExactKeys(value, [
        'kind',
        'protocolVersion',
        'sessionId',
        'requestId',
        'code',
        'message',
        'retryable',
      ]) ||
      value.requestId !== HISTORY_REPLAY_TRUNCATION_REQUEST_ID ||
      value.code !== 'internal_error' ||
      typeof value.message !== 'string' ||
      value.message.length > 1024 ||
      value.retryable !== false
    ) {
      return null
    }
    return value as unknown as ServerFrame
  }
  if (value.kind !== 'event') return null
  if (
    !hasExactKeys(value, [
      'kind',
      'protocolVersion',
      'sessionId',
      'replay',
      'event',
    ]) ||
    value.replay !== true ||
    !hasExactKeys(value.event, ['type', 'message']) ||
    value.event.type !== 'message' ||
    !isRecord(value.event.message) ||
    typeof value.event.message.type !== 'string' ||
    value.event.message.session_id !== engineSessionId
  ) {
    return null
  }
  return value as unknown as ServerFrame
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, i) => key === wanted[i])
}
