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
  AccountDeleteMessage,
  AccountLogoutMessage,
  AccountStatus,
  AccountSignOutReceipt,
  AccountsSnapshot,
  AnthropicAccountStatus,
  SignedOutCodexProfileStatus,
} from './protocol.js'
import { MAX_TEXT_FIELD_CHARS } from './limits.js'
import {
  isBoolean,
  isNumber,
  isNumberOrNull,
  isRecord,
  isString,
  isStringOrNull,
  isUnknownArray,
  narrowExact,
  oneOf,
  optional,
} from './narrow.js'

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

export type AccountsPoolWorkerSignOutRequest = {
  type: 'account-sign-out'
  version: typeof ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION
  verb: AccountLogoutMessage
}

export type AccountsPoolWorkerSignOutResult = {
  type: 'account-sign-out'
  version: typeof ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION
  requestId: string
  verb: 'account.logout'
  receipt: AccountSignOutReceipt
}

export type AccountsPoolWorkerResult =
  | AccountsPoolWorkerPoolResult
  | AccountsPoolWorkerFailureResult
  | AccountsPoolWorkerDeleteResult
  | AccountsPoolWorkerSignOutResult

export function parseAccountDeleteMessage(
  value: unknown,
): AccountDeleteMessage | null {
  return narrowExact(value, {
    type: oneOf(['account.delete'] as const),
    requestId: isBoundedText,
    accountId: isBoundedText,
    expectedCredentialGeneration: isSafeNonnegativeInteger,
    confirm: oneOf([true] as const),
  })
}

export function parseAccountLogoutMessage(
  value: unknown,
): AccountLogoutMessage | null {
  return narrowExact(value, {
    type: oneOf(['account.logout'] as const),
    requestId: isBoundedText,
    accountId: isBoundedText,
    expectedCredentialGeneration: isSafeNonnegativeInteger,
  })
}

export function parseAccountsPoolWorkerDeleteRequest(
  value: unknown,
): AccountsPoolWorkerDeleteRequest | null {
  const request = narrowExact(value, {
    type: oneOf(['account-delete'] as const),
    version: oneOf([ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION] as const),
    verb: isRecord,
  })
  if (!request) return null
  const verb = parseAccountDeleteMessage(request.verb)
  if (!verb) return null
  return { ...request, verb }
}

export function parseAccountsPoolWorkerSignOutRequest(
  value: unknown,
): AccountsPoolWorkerSignOutRequest | null {
  const request = narrowExact(value, {
    type: oneOf(['account-sign-out'] as const),
    version: oneOf([ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION] as const),
    verb: isRecord,
  })
  if (!request) return null
  const verb = parseAccountLogoutMessage(request.verb)
  if (!verb) return null
  return { ...request, verb }
}

export function parseAccountSignOutReceipt(
  value: unknown,
): AccountSignOutReceipt | null {
  return narrowExact(value, {
    outcome: oneOf([
      'committed',
      'already_committed',
      'superseded',
      'cleanup_pending',
      'retryable_unknown',
    ] as const),
    accountId: isBoundedText,
    expectedCredentialGeneration: isSafeNonnegativeInteger,
    observedCredentialGeneration: isSafeNonnegativeIntegerOrNull,
    lifecycleState: oneOf([
      'login_prepared',
      'credentialed',
      'signed_out',
      'reauth_required',
      null,
    ] as const),
    operationId: isBoundedText,
    targetWasActive: isBoolean,
    replacementActiveAccountId: isBoundedTextOrNull,
  })
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
    const deletion = narrowExact(value, {
      type: oneOf(['account-delete'] as const),
      version: oneOf([ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION] as const),
      requestId: isBoundedText,
      verb: oneOf(['account.delete'] as const),
      ok: isBoolean,
      message: isBoundedText,
      pool: isRecord,
    })
    if (!deletion) return null
    const pool = parseAccountsSnapshot(deletion.pool)
    if (!pool) return null
    return { ...deletion, pool }
  }
  if (value.type === 'account-sign-out') {
    const signOut = narrowExact(value, {
      type: oneOf(['account-sign-out'] as const),
      version: oneOf([ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION] as const),
      requestId: isBoundedText,
      verb: oneOf(['account.logout'] as const),
      receipt: isRecord,
    })
    if (!signOut) return null
    const receipt = parseAccountSignOutReceipt(signOut.receipt)
    if (!receipt) return null
    return { ...signOut, receipt }
  }
  if (value.type === 'failure') {
    return narrowExact(value, {
      type: oneOf(['failure'] as const),
      version: oneOf([ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION] as const),
      reason: oneOf(['internal'] as const),
    })
  }
  if (value.type !== 'pool') return null
  const record = narrowExact(value, {
    type: oneOf(['pool'] as const),
    version: oneOf([ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION] as const),
    pool: isRecord,
  })
  if (!record) return null
  const pool = parseAccountsSnapshot(record.pool)
  if (!pool) return null
  return {
    type: 'pool',
    version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
    pool,
  }
}

/**
 * Fail-closed `AccountsSnapshot` validator. Exported so the boundary is the ONE
 * place the untrusted snapshot shape is narrowed; a single malformed row fails
 * the whole snapshot.
 */
export function parseAccountsSnapshot(value: unknown): AccountsSnapshot | null {
  const snapshot = narrowExact(value, {
    accounts: isUnknownArray,
    signedOutProfiles: isUnknownArray,
    activeAccountId: isStringOrNull,
    readyCount: isNumber,
    poolCount: isNumber,
    initialized: isBoolean,
    anthropicAccounts: isUnknownArray,
    anthropicActiveAccountId: isStringOrNull,
    anthropicReadyCount: isNumber,
    anthropicPoolCount: isNumber,
    anthropicInitialized: isBoolean,
    anthropicRouteAvailable: isBoolean,
    // `anthropicSubscriptionActive` is optional on the protocol type: accept the
    // record with OR without it, but no OTHER key — the closed-vocabulary gate
    // stands. A PRESENT non-boolean is malformed child output.
    anthropicSubscriptionActive: optional(isBoolean),
  })
  if (!snapshot) return null

  const accounts: AccountStatus[] = []
  for (const candidate of snapshot.accounts) {
    const account = parseAccountStatus(candidate)
    if (!account) return null
    accounts.push(account)
  }
  const signedOutProfiles: SignedOutCodexProfileStatus[] = []
  for (const candidate of snapshot.signedOutProfiles) {
    const profile = parseSignedOutCodexProfileStatus(candidate)
    if (!profile) return null
    signedOutProfiles.push(profile)
  }
  const anthropicAccounts: AnthropicAccountStatus[] = []
  for (const candidate of snapshot.anthropicAccounts) {
    const account = parseAnthropicAccountStatus(candidate)
    if (!account) return null
    anthropicAccounts.push(account)
  }

  return { ...snapshot, accounts, signedOutProfiles, anthropicAccounts }
}

function parseAccountStatus(value: unknown): AccountStatus | null {
  return narrowExact(value, {
    id: isBoundedText,
    credentialGeneration: isSafeNonnegativeInteger,
    alias: isStringOrNull,
    status: oneOf(['healthy', 'dead', 'capped', 'quarantined'] as const),
    statusReason: isStringOrNull,
    availability: oneOf(['available', 'warned', 'blocked'] as const),
    availabilityLabel: isString,
    isDefault: isBoolean,
    hasVaultProfile: isBoolean,
    source: oneOf(['vault', 'config'] as const),
    usagePrimary: isNumberOrNull,
    usageWeekly: isNumberOrNull,
    usagePrimaryWindowSeconds: optional(isNonNegativeFiniteNumberOrNull),
    usageSecondaryWindowSeconds: optional(isNonNegativeFiniteNumberOrNull),
    usageLimitReached: isBoolean,
    usageResetAt: isNumberOrNull,
    usageWeeklyResetAt: optional(isNumberOrNull),
    lastRefreshIso: isStringOrNull,
    lastError: isStringOrNull,
    planType: isStringOrNull,
    switchable: isBoolean,
  })
}

function parseSignedOutCodexProfileStatus(
  value: unknown,
): SignedOutCodexProfileStatus | null {
  return narrowExact(value, {
    id: isBoundedText,
    alias: isStringOrNull,
    state: oneOf(['signed_out', 'recovery_required'] as const),
    credentialGeneration: isSafeNonnegativeIntegerOrNull,
    lifecycleGeneration: isSafeNonnegativeIntegerOrNull,
    credentialGenerationState: oneOf(
      ['lifecycle_bound', 'legacy_unbound', null] as const,
    ),
    lifecycleState: oneOf(
      [
        'login_prepared',
        'credentialed',
        'signed_out',
        'reauth_required',
        null,
      ] as const,
    ),
    lifecycleReadStatus: oneOf(
      ['absent', 'valid', 'malformed', 'unreadable'] as const,
    ),
  })
}

function parseAnthropicAccountStatus(
  value: unknown,
): AnthropicAccountStatus | null {
  return narrowExact(value, {
    id: isString,
    alias: isStringOrNull,
    email: isString,
    status: oneOf(['healthy', 'dead'] as const),
    isDefault: isBoolean,
    hasVaultProfile: isBoolean,
    subscriptionType: isStringOrNull,
  })
}

function isBoundedText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TEXT_FIELD_CHARS
  )
}

function isNonNegativeFiniteNumberOrNull(
  value: unknown,
): value is number | null {
  return value === null || (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0
  )
}

function isBoundedTextOrNull(value: unknown): value is string | null {
  return value === null || isBoundedText(value)
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isSafeNonnegativeIntegerOrNull(
  value: unknown,
): value is number | null {
  return value === null || isSafeNonnegativeInteger(value)
}
