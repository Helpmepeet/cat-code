import {
  USAGE_FAILURE_GUARDS, USAGE_FAILURE_PHASES, USAGE_FAILURE_REASONS, UsageFailure, sqliteCodeOf,
  type UsageFailureGuard, type UsageFailurePhase, type UsageFailureReason,
} from '../../src/utils/statsFailure.js'

/**
 * One tagged stderr line from the usage worker per failed refresh. Closed
 * enums and safe scalars only: the line never carries paths, SQL, stacks,
 * session identifiers, or raw error text, so main may log it verbatim-by-field.
 */
export const USAGE_DIAGNOSTIC_TAG = 'CATCODE_USAGE_DIAGNOSTIC'
export const USAGE_DIAGNOSTIC_VERSION = 1
export const MAX_USAGE_DIAGNOSTIC_LINE_BYTES = 512

export type UsageDiagnostic = Readonly<{
  reason: UsageFailureReason
  phase: UsageFailurePhase
  elapsedMs: number
  guard?: UsageFailureGuard
  observed?: number
  limit?: number
  sqliteCode?: string
  sources?: number
  rows?: number
}>

const SQLITE_CODE = /^SQLITE_[A-Z0-9_]{1,40}$/
const KEYS = new Set(['v', 'reason', 'phase', 'elapsedMs', 'guard', 'observed', 'limit', 'sqliteCode', 'sources', 'rows'])
const safeInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v)

export function usageDiagnosticFromError(error: unknown, elapsedMs: number): UsageDiagnostic {
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, Math.min(Math.round(elapsedMs), Number.MAX_SAFE_INTEGER)) : 0
  if (!(error instanceof UsageFailure)) {
    const sqliteCode = sqliteCodeOf(error)
    return { reason: 'unexpected', phase: 'unknown', elapsedMs: elapsed, ...(sqliteCode ? { sqliteCode } : {}) }
  }
  const { guard, observed, limit, sqliteCode, sources, rows } = error.detail
  return {
    reason: error.reason,
    phase: error.phase,
    elapsedMs: elapsed,
    ...(guard ? { guard } : {}),
    ...(safeInt(observed) ? { observed } : {}),
    ...(safeInt(limit) ? { limit } : {}),
    ...(sqliteCode && SQLITE_CODE.test(sqliteCode) ? { sqliteCode } : {}),
    ...(safeInt(sources) ? { sources } : {}),
    ...(safeInt(rows) ? { rows } : {}),
  }
}

export function formatUsageDiagnostic(diagnostic: UsageDiagnostic): string {
  return `${USAGE_DIAGNOSTIC_TAG} ${JSON.stringify({ v: USAGE_DIAGNOSTIC_VERSION, ...diagnostic })}`
}

/** The first valid tagged line in a worker's stderr; everything else is ignored. */
export function parseUsageDiagnostic(stderr: string): UsageDiagnostic | null {
  const prefix = `${USAGE_DIAGNOSTIC_TAG} `
  for (const line of stderr.split('\n')) {
    if (!line.startsWith(prefix) || Buffer.byteLength(line, 'utf8') > MAX_USAGE_DIAGNOSTIC_LINE_BYTES) continue
    let value: unknown
    try { value = JSON.parse(line.slice(prefix.length)) } catch { continue }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const item = value as Record<string, unknown>
    if (Object.keys(item).some(key => !KEYS.has(key)) || item.v !== USAGE_DIAGNOSTIC_VERSION) continue
    if (!oneOf(USAGE_FAILURE_REASONS, item.reason) || !oneOf(USAGE_FAILURE_PHASES, item.phase) || !safeInt(item.elapsedMs)) continue
    if (item.guard !== undefined && !oneOf(USAGE_FAILURE_GUARDS, item.guard)) continue
    if (item.observed !== undefined && !safeInt(item.observed)) continue
    if (item.limit !== undefined && !safeInt(item.limit)) continue
    if (item.sqliteCode !== undefined && !(typeof item.sqliteCode === 'string' && SQLITE_CODE.test(item.sqliteCode))) continue
    if (item.sources !== undefined && !safeInt(item.sources)) continue
    if (item.rows !== undefined && !safeInt(item.rows)) continue
    return {
      reason: item.reason, phase: item.phase, elapsedMs: item.elapsedMs,
      ...(item.guard !== undefined ? { guard: item.guard as UsageFailureGuard } : {}),
      ...(item.observed !== undefined ? { observed: item.observed as number } : {}),
      ...(item.limit !== undefined ? { limit: item.limit as number } : {}),
      ...(item.sqliteCode !== undefined ? { sqliteCode: item.sqliteCode as string } : {}),
      ...(item.sources !== undefined ? { sources: item.sources as number } : {}),
      ...(item.rows !== undefined ? { rows: item.rows as number } : {}),
    }
  }
  return null
}
