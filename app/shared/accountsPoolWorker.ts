/**
 * Private main↔accounts-pool-worker boundary (accounts owner —
 * `docs/migration/decisions/ACCOUNTS-OWNERSHIP.md`). This is NOT a renderer or
 * sidecar socket protocol: Electron main re-spawns one short-lived, serialized
 * engine-graph worker on a timer; the worker reads the global account pool ONCE
 * and exits. The snapshot then reaches the renderer as a read-only OUTBOUND
 * `accounts-pool` host event (C3 precedent) — never an inbound verb.
 *
 * Sibling of `sessionsCatalogWorker.ts` and deliberately identical in posture:
 * the worker emits exactly ONE bounded NDJSON result record (a `pool` snapshot
 * or a `failure`), and main parses it fail-closed so a corrupt or compromised
 * child can neither grow main's buffers without bound nor smuggle a malformed
 * snapshot past the redaction contract.
 *
 * The record also carries the Accounts page's usage analytics for both ranges
 * (`usageStats`, optional — see the field). Same owner, same page, same reason:
 * that surface must work with no session open, and the numbers are a local-disk
 * aggregation this run can afford. It is aggregate arithmetic over transcript
 * metadata — token counts, dates, model names — and carries no prompt text.
 *
 * The payload reuses the existing `AccountsSnapshot` protocol type, which is
 * ALREADY the redacted projection (`accountsDomain.ts` `buildAccountsSnapshot`):
 * no `accessToken`, no `refreshToken`, no `vaultFilePath`, no `idToken` by
 * construction. `scanForSecrets` runs on the record in the worker before emit and
 * again at main's parse boundary, so the redaction is proven twice exactly as the
 * catalog boundary proves its display-metadata contract.
 */

import type {
  AccountDeleteMessage,
  AccountStatus,
  AccountsSnapshot,
  AnthropicAccountStatus,
  UsageStatsByRange,
  UsageStatsDailyActivityItem,
  UsageStatsDailyModelTokens,
  UsageStatsModelUsageItem,
  UsageStatsRange,
  UsageStatsSnapshot,
} from './protocol.js'
import { MAX_TEXT_FIELD_CHARS } from './limits.js'

export const ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION = 1

/**
 * Reject any NDJSON result record larger than this BEFORE parse (parse-DoS
 * defense). A realistic pool (tens of accounts, ~400 B per redacted row)
 * measures well under 20 KB; this is the same generous-but-bounded posture the
 * catalog boundary takes against its own measured size.
 */
export const MAX_ACCOUNTS_POOL_WORKER_RECORD_BYTES = 256 * 1024

export type AccountsPoolWorkerPoolResult = {
  type: 'pool'
  version: typeof ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION
  pool: AccountsSnapshot
  /**
   * Usage analytics for both ranges, aggregated from the engine's own transcript
   * logs in the SAME run that reads the pool. It rides this record rather than a
   * second worker because it serves the same page for the same reason (the
   * Accounts page must work with no session open) off the same disposable
   * engine-graph process, and the read is local disk (~1.2 s for both ranges,
   * ~5 KB) against a worker that already pays the engine import and a network
   * usage fetch every run.
   *
   * OPTIONAL on purpose, and the reason this stayed boundary-version 1: a stats
   * read that fails must not cost the pool its delivery, so the worker omits the
   * field and main still emits the accounts event. Absent means "this run had
   * none", never "the user has no history" — the renderer keeps its last good
   * value, exactly as it does for a failed pool run.
   */
  usageStats?: UsageStatsByRange
}

export type AccountsPoolWorkerFailureResult = {
  type: 'failure'
  version: typeof ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION
  reason: 'internal'
}

export type AccountsPoolWorkerDeleteRequest = {
  type: 'account-delete'
  version: typeof ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION
  verb: AccountDeleteMessage
}

export type AccountsPoolWorkerDeleteResult = {
  type: 'account-delete'
  version: typeof ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION
  requestId: string
  verb: 'account.delete'
  ok: boolean
  message: string
  pool: AccountsSnapshot
}

export type AccountsPoolWorkerResult =
  | AccountsPoolWorkerPoolResult
  | AccountsPoolWorkerFailureResult
  | AccountsPoolWorkerDeleteResult

export function parseAccountDeleteMessage(
  value: unknown,
): AccountDeleteMessage | null {
  if (!isRecord(value)) return null
  if (!hasExactKeys(value, ['type', 'requestId', 'accountId', 'confirm'])) {
    return null
  }
  if (value.type !== 'account.delete' || value.confirm !== true) return null
  if (!isBoundedText(value.requestId) || !isBoundedText(value.accountId)) return null
  return {
    type: 'account.delete',
    requestId: value.requestId,
    accountId: value.accountId,
    confirm: true,
  }
}

export function parseAccountsPoolWorkerDeleteRequest(
  value: unknown,
): AccountsPoolWorkerDeleteRequest | null {
  if (!isRecord(value)) return null
  if (!hasExactKeys(value, ['type', 'version', 'verb'])) return null
  if (
    value.type !== 'account-delete' ||
    value.version !== ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION
  ) {
    return null
  }
  const verb = parseAccountDeleteMessage(value.verb)
  if (!verb) return null
  return {
    type: 'account-delete',
    version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
    verb,
  }
}

/**
 * Drop the optional half of a record that would not fit the size cap, in place,
 * and report whether it did. Returns the same object so the caller can emit it
 * either way.
 *
 * The two halves have very different size behaviour: the pool is a bounded list
 * of accounts, while `usageStats` carries a per-day map keyed by every model
 * name seen in a 30-day window, so its cardinality follows user data. Without
 * this the oversize case would throw at emit, exit the worker non-zero, and cost
 * the POOL its delivery too, on every run, permanently. Shedding the optional
 * half is exactly what makes it optional.
 */
export function shedOversizeUsageStats(result: AccountsPoolWorkerResult): {
  result: AccountsPoolWorkerResult
  shed: boolean
} {
  if (result.type !== 'pool' || !result.usageStats) return { result, shed: false }
  if (fitsAccountsPoolRecordLimit(result)) return { result, shed: false }
  delete result.usageStats
  return { result, shed: true }
}

/** The same measurement the worker's `emit` throws on, asked in advance. */
export function fitsAccountsPoolRecordLimit(
  result: AccountsPoolWorkerResult,
): boolean {
  return (
    Buffer.byteLength(JSON.stringify(result), 'utf8') <=
    MAX_ACCOUNTS_POOL_WORKER_RECORD_BYTES
  )
}

/**
 * Parse + validate one worker result record fail-closed. Returns the typed
 * result only when every gate passes; a wrong version, unknown discriminant,
 * extra keys, or a single malformed account row fails the WHOLE record (null).
 * The snapshot is narrowed field-by-field so the return carries no `as` cast on
 * the untrusted child output.
 */
export function parseAccountsPoolWorkerResult(
  value: unknown,
): AccountsPoolWorkerResult | null {
  if (!isRecord(value)) return null
  if (value.version !== ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION) return null
  if (value.type === 'account-delete') {
    if (
      !hasExactKeys(value, [
        'type',
        'version',
        'requestId',
        'verb',
        'ok',
        'message',
        'pool',
      ])
    ) {
      return null
    }
    if (
      !isBoundedText(value.requestId) ||
      value.verb !== 'account.delete' ||
      typeof value.ok !== 'boolean' ||
      !isBoundedText(value.message)
    ) {
      return null
    }
    const pool = parseAccountsSnapshot(value.pool)
    if (!pool) return null
    return {
      type: 'account-delete',
      version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
      requestId: value.requestId,
      verb: 'account.delete',
      ok: value.ok,
      message: value.message,
      pool,
    }
  }
  if (value.type === 'failure') {
    if (!hasExactKeys(value, ['type', 'version', 'reason'])) return null
    if (value.reason !== 'internal') return null
    return {
      type: 'failure',
      version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
      reason: 'internal',
    }
  }
  if (value.type !== 'pool') return null
  // `usageStats` is optional (see the field's doc): accept the record with OR
  // without it, but no OTHER key — the closed-vocabulary gate stands. A PRESENT
  // malformed value is malformed child output and fails the WHOLE record.
  if (
    !hasExactKeys(value, ['type', 'version', 'pool', 'usageStats']) &&
    !hasExactKeys(value, ['type', 'version', 'pool'])
  ) {
    return null
  }
  const pool = parseAccountsSnapshot(value.pool)
  if (!pool) return null
  const result: AccountsPoolWorkerResult = {
    type: 'pool',
    version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
    pool,
  }
  if (value.usageStats !== undefined) {
    const usageStats = parseUsageStatsByRange(value.usageStats)
    if (!usageStats) return null
    result.usageStats = usageStats
  }
  return result
}

/**
 * Fail-closed `UsageStatsByRange` validator. Both ranges must be present, and
 * each snapshot's own `range` must MATCH the key it arrived under — otherwise a
 * compromised child could file 30-day totals under the 7-day toggle, which the
 * renderer keys by and would never re-check.
 */
export function parseUsageStatsByRange(value: unknown): UsageStatsByRange | null {
  if (!isRecord(value)) return null
  if (!hasExactKeys(value, ['7d', '30d'])) return null
  const sevenDay = parseUsageStatsSnapshot(value['7d'])
  const thirtyDay = parseUsageStatsSnapshot(value['30d'])
  if (!sevenDay || !thirtyDay) return null
  if (sevenDay.range !== '7d' || thirtyDay.range !== '30d') return null
  return { '7d': sevenDay, '30d': thirtyDay }
}

/**
 * Fail-closed `UsageStatsSnapshot` validator — the ONE place this untrusted
 * shape is narrowed. Numbers are required to be FINITE: the record arrives as
 * JSON, where `NaN`/`Infinity` cannot survive `JSON.stringify` (they serialize
 * to `null`), so a non-finite number here is malformed output, and letting one
 * through would poison every chart axis it divides.
 */
export function parseUsageStatsSnapshot(value: unknown): UsageStatsSnapshot | null {
  if (!isRecord(value)) return null
  if (
    !hasExactKeys(value, [
      'range',
      'totalTokens',
      'dailyModelTokens',
      'modelUsage',
      'dailyActivity',
      'cacheHitRate',
      'cacheReadTokens',
      'cacheWriteTokens',
      'freshInputTokens',
      'totalSessions',
      'totalMessages',
      'activeDays',
    ])
  ) {
    return null
  }
  const range = value.range
  if (!isUsageStatsRange(range)) return null
  if (!isFiniteNumber(value.totalTokens)) return null
  if (!isFiniteNumber(value.cacheHitRate)) return null
  if (!isFiniteNumber(value.cacheReadTokens)) return null
  if (!isFiniteNumber(value.cacheWriteTokens)) return null
  if (!isFiniteNumber(value.freshInputTokens)) return null
  if (!isFiniteNumber(value.totalSessions)) return null
  if (!isFiniteNumber(value.totalMessages)) return null
  if (!isFiniteNumber(value.activeDays)) return null

  if (!Array.isArray(value.dailyModelTokens)) return null
  const dailyModelTokens: UsageStatsDailyModelTokens[] = []
  for (const candidate of value.dailyModelTokens) {
    if (!isRecord(candidate)) return null
    if (!hasExactKeys(candidate, ['date', 'tokensByModel'])) return null
    if (typeof candidate.date !== 'string') return null
    const tokensByModel = parseNumberMap(candidate.tokensByModel)
    if (!tokensByModel) return null
    dailyModelTokens.push({ date: candidate.date, tokensByModel })
  }

  if (!Array.isArray(value.dailyActivity)) return null
  const dailyActivity: UsageStatsDailyActivityItem[] = []
  for (const candidate of value.dailyActivity) {
    if (!isRecord(candidate)) return null
    if (
      !hasExactKeys(candidate, [
        'date',
        'messageCount',
        'sessionCount',
        'toolCallCount',
      ])
    ) {
      return null
    }
    if (typeof candidate.date !== 'string') return null
    if (!isFiniteNumber(candidate.messageCount)) return null
    if (!isFiniteNumber(candidate.sessionCount)) return null
    if (!isFiniteNumber(candidate.toolCallCount)) return null
    dailyActivity.push({
      date: candidate.date,
      messageCount: candidate.messageCount,
      sessionCount: candidate.sessionCount,
      toolCallCount: candidate.toolCallCount,
    })
  }

  if (!isRecord(value.modelUsage)) return null
  // `Object.create(null)`, not `{}`: model names come from transcript files, and
  // a key of `__proto__` survives `JSON.parse` as an enumerable own property.
  // Assigning it into an object literal invokes the prototype SETTER, so the row
  // vanishes and the object this validator returns carries a caller-shaped
  // prototype. A null-prototype accumulator makes every such key an ordinary
  // own property, which is what a fail-closed narrower of untrusted child output
  // has to guarantee.
  const modelUsage: Record<string, UsageStatsModelUsageItem> =
    Object.create(null)
  for (const [model, candidate] of Object.entries(value.modelUsage)) {
    if (!isRecord(candidate)) return null
    if (
      !hasExactKeys(candidate, [
        'inputTokens',
        'outputTokens',
        'cacheCreationInputTokens',
        'cacheReadInputTokens',
      ])
    ) {
      return null
    }
    if (!isFiniteNumber(candidate.inputTokens)) return null
    if (!isFiniteNumber(candidate.outputTokens)) return null
    if (!isFiniteNumber(candidate.cacheCreationInputTokens)) return null
    if (!isFiniteNumber(candidate.cacheReadInputTokens)) return null
    modelUsage[model] = {
      inputTokens: candidate.inputTokens,
      outputTokens: candidate.outputTokens,
      cacheCreationInputTokens: candidate.cacheCreationInputTokens,
      cacheReadInputTokens: candidate.cacheReadInputTokens,
    }
  }

  // Field-by-field so the return is a real `UsageStatsSnapshot`, no `as` on the
  // untrusted worker output (each read above narrowed its field).
  return {
    range,
    totalTokens: value.totalTokens,
    dailyModelTokens,
    modelUsage,
    dailyActivity,
    cacheHitRate: value.cacheHitRate,
    cacheReadTokens: value.cacheReadTokens,
    cacheWriteTokens: value.cacheWriteTokens,
    freshInputTokens: value.freshInputTokens,
    totalSessions: value.totalSessions,
    totalMessages: value.totalMessages,
    activeDays: value.activeDays,
  }
}

function parseNumberMap(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null
  // Null-prototype for the same reason as `modelUsage` above.
  const out: Record<string, number> = Object.create(null)
  for (const [key, candidate] of Object.entries(value)) {
    if (!isFiniteNumber(candidate)) return null
    out[key] = candidate
  }
  return out
}

function isUsageStatsRange(value: unknown): value is UsageStatsRange {
  return value === '7d' || value === '30d'
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Fail-closed `AccountsSnapshot` validator. Exported so the boundary is the ONE
 * place the untrusted snapshot shape is narrowed; a single malformed row fails
 * the whole snapshot.
 */
export function parseAccountsSnapshot(value: unknown): AccountsSnapshot | null {
  if (!isRecord(value)) return null
  const base = [
    'accounts',
    'activeAccountId',
    'readyCount',
    'poolCount',
    'initialized',
    'anthropicAccounts',
    'anthropicActiveAccountId',
    'anthropicReadyCount',
    'anthropicPoolCount',
    'anthropicInitialized',
    'anthropicRouteAvailable',
  ] as const
  // `anthropicSubscriptionActive` is optional on the protocol type: accept the
  // record with OR without it, but no OTHER key — the closed-vocabulary gate
  // stands. A PRESENT non-boolean is malformed child output.
  if (
    !hasExactKeys(value, [...base, 'anthropicSubscriptionActive']) &&
    !hasExactKeys(value, base)
  ) {
    return null
  }
  if (!isStringOrNull(value.activeAccountId)) return null
  if (typeof value.readyCount !== 'number') return null
  if (typeof value.poolCount !== 'number') return null
  if (typeof value.initialized !== 'boolean') return null
  if (!isStringOrNull(value.anthropicActiveAccountId)) return null
  if (typeof value.anthropicReadyCount !== 'number') return null
  if (typeof value.anthropicPoolCount !== 'number') return null
  if (typeof value.anthropicInitialized !== 'boolean') return null
  if (typeof value.anthropicRouteAvailable !== 'boolean') return null
  if (
    value.anthropicSubscriptionActive !== undefined &&
    typeof value.anthropicSubscriptionActive !== 'boolean'
  ) {
    return null
  }
  if (!Array.isArray(value.accounts)) return null
  if (!Array.isArray(value.anthropicAccounts)) return null

  const accounts: AccountStatus[] = []
  for (const candidate of value.accounts) {
    const account = parseAccountStatus(candidate)
    if (!account) return null
    accounts.push(account)
  }
  const anthropicAccounts: AnthropicAccountStatus[] = []
  for (const candidate of value.anthropicAccounts) {
    const account = parseAnthropicAccountStatus(candidate)
    if (!account) return null
    anthropicAccounts.push(account)
  }

  const snapshot: AccountsSnapshot = {
    accounts,
    activeAccountId: value.activeAccountId,
    readyCount: value.readyCount,
    poolCount: value.poolCount,
    initialized: value.initialized,
    anthropicAccounts,
    anthropicActiveAccountId: value.anthropicActiveAccountId,
    anthropicReadyCount: value.anthropicReadyCount,
    anthropicPoolCount: value.anthropicPoolCount,
    anthropicInitialized: value.anthropicInitialized,
    anthropicRouteAvailable: value.anthropicRouteAvailable,
  }
  if (value.anthropicSubscriptionActive !== undefined) {
    snapshot.anthropicSubscriptionActive = value.anthropicSubscriptionActive
  }
  return snapshot
}

function parseAccountStatus(value: unknown): AccountStatus | null {
  if (!isRecord(value)) return null
  const baseKeys = [
    'id',
    'alias',
    'status',
    'statusReason',
    'availability',
    'availabilityLabel',
    'isDefault',
    'hasVaultProfile',
    'source',
    'usagePrimary',
    'usageWeekly',
    'usageLimitReached',
    'usageResetAt',
    'lastRefreshIso',
    'lastError',
    'planType',
    'switchable',
  ] as const
  if (
    !hasExactKeys(value, baseKeys) &&
    !hasExactKeys(value, [...baseKeys, 'usageWeeklyResetAt'])
  ) {
    return null
  }
  if (typeof value.id !== 'string') return null
  if (!isStringOrNull(value.alias)) return null
  const status = value.status
  if (
    !(
      status === 'healthy' ||
      status === 'dead' ||
      status === 'capped' ||
      status === 'quarantined'
    )
  ) {
    return null
  }
  if (!isStringOrNull(value.statusReason)) return null
  const availability = value.availability
  if (
    !(
      availability === 'available' ||
      availability === 'warned' ||
      availability === 'blocked'
    )
  ) {
    return null
  }
  if (typeof value.availabilityLabel !== 'string') return null
  if (typeof value.isDefault !== 'boolean') return null
  if (typeof value.hasVaultProfile !== 'boolean') return null
  const source = value.source
  if (!(source === 'vault' || source === 'config')) return null
  if (!isNumberOrNull(value.usagePrimary)) return null
  if (!isNumberOrNull(value.usageWeekly)) return null
  if (typeof value.usageLimitReached !== 'boolean') return null
  if (!isNumberOrNull(value.usageResetAt)) return null
  const usageWeeklyResetAt = value.usageWeeklyResetAt
  if (
    usageWeeklyResetAt !== undefined &&
    !isNumberOrNull(usageWeeklyResetAt)
  ) {
    return null
  }
  if (!isStringOrNull(value.lastRefreshIso)) return null
  if (!isStringOrNull(value.lastError)) return null
  if (!isStringOrNull(value.planType)) return null
  if (typeof value.switchable !== 'boolean') return null
  // Field-by-field so the return is a real `AccountStatus`, no `as` on the
  // untrusted worker output (each read above narrowed its field).
  return {
    id: value.id,
    alias: value.alias,
    status,
    statusReason: value.statusReason,
    availability,
    availabilityLabel: value.availabilityLabel,
    isDefault: value.isDefault,
    hasVaultProfile: value.hasVaultProfile,
    source,
    usagePrimary: value.usagePrimary,
    usageWeekly: value.usageWeekly,
    usageLimitReached: value.usageLimitReached,
    usageResetAt: value.usageResetAt,
    ...(usageWeeklyResetAt !== undefined ? { usageWeeklyResetAt } : {}),
    lastRefreshIso: value.lastRefreshIso,
    lastError: value.lastError,
    planType: value.planType,
    switchable: value.switchable,
  }
}

function parseAnthropicAccountStatus(
  value: unknown,
): AnthropicAccountStatus | null {
  if (!isRecord(value)) return null
  if (
    !hasExactKeys(value, [
      'id',
      'alias',
      'email',
      'status',
      'isDefault',
      'hasVaultProfile',
      'subscriptionType',
    ])
  ) {
    return null
  }
  if (typeof value.id !== 'string') return null
  if (!isStringOrNull(value.alias)) return null
  if (typeof value.email !== 'string') return null
  const status = value.status
  if (!(status === 'healthy' || status === 'dead')) return null
  if (typeof value.isDefault !== 'boolean') return null
  if (typeof value.hasVaultProfile !== 'boolean') return null
  if (!isStringOrNull(value.subscriptionType)) return null
  return {
    id: value.id,
    alias: value.alias,
    email: value.email,
    status,
    isDefault: value.isDefault,
    hasVaultProfile: value.hasVaultProfile,
    subscriptionType: value.subscriptionType,
  }
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === 'string' || value === null
}

function isNumberOrNull(value: unknown): value is number | null {
  return typeof value === 'number' || value === null
}

function isBoundedText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TEXT_FIELD_CHARS
  )
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
