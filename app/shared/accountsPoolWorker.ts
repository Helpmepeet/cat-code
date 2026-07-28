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
 * The payload reuses the existing `AccountsSnapshot` protocol type, which is
 * ALREADY the redacted projection (`accountsDomain.ts` `buildAccountsSnapshot`):
 * no `accessToken`, no `refreshToken`, no `vaultFilePath`, no `idToken` by
 * construction. `scanForSecrets` runs on the record in the worker before emit and
 * again at main's parse boundary, so the redaction is proven twice exactly as the
 * catalog boundary proves its display-metadata contract.
 */

import type {
  AccountStatus,
  AccountsSnapshot,
  AnthropicAccountStatus,
} from './protocol.js'

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
}

export type AccountsPoolWorkerFailureResult = {
  type: 'failure'
  version: typeof ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION
  reason: 'internal'
}

export type AccountsPoolWorkerResult =
  | AccountsPoolWorkerPoolResult
  | AccountsPoolWorkerFailureResult

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
  if (!hasExactKeys(value, ['type', 'version', 'pool'])) return null
  const pool = parseAccountsSnapshot(value.pool)
  if (!pool) return null
  return { type: 'pool', version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION, pool }
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
  if (
    !hasExactKeys(value, [
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
    ])
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
