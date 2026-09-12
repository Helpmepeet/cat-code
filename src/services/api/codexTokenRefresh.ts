/**
 * Codex OAuth token refresh, touch-all orchestration, and periodic timer.
 *
 * Replaces the Python codex-nootp tool's token refresh functionality.
 * Refreshes tokens via POST to auth.openai.com/oauth/token.
 * Refresh tokens rotate — the old one becomes invalid after each use.
 */

import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { createHash, randomUUID } from 'crypto'
import {
  CODEX_CLIENT_ID,
  CODEX_TOKEN_URL,
  isWithinCodexRefreshSkew,
} from '../../constants/codex-oauth.js'

import { logForDebugging } from '../../utils/debug.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { lock } from '../../utils/lockfile.js'
import { writeFileAtomicDurableSync } from '../../utils/atomicFile.js'
import { extractCodexAccountId } from '../oauth/codex-client.js'
import {
  appendAccount,
  getPoolStatus,
  getVaultPath,
  getCodexCredentialGenerationFromVaultTokens,
  isAccountLocked,
  LEGACY_CODEX_CREDENTIAL_GENERATION,
  markAccountDead,
  markPoolAccountQuarantined,
  normalizeCodexAccountBlockReason,
} from './codexAccountPool.js'
import { emitAccountDiagnostic } from './accountDiagnostics.js'
import {
  codexCredentialLifecycle,
  type CodexCredentialLifecycle,
  type CodexCredentialLifecyclePermit,
  type CodexCredentialLifecycleReadResult,
} from './codexCredentialLifecycle.js'

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_REFRESH_INTERVAL_HOURS = 4
// Fallback expiry when the OAuth response omits expires_in. Chosen to match the
// typical 1h token TTL so the next request still refreshes before expiry.
const DEFAULT_TOKEN_EXPIRY_MS = 60 * 60 * 1000

function parseExpiresAt(data: Record<string, unknown>): number {
  const expiresIn = data.expires_in
  if (typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0) {
    return Date.now() + expiresIn * 1000
  }
  return Date.now() + DEFAULT_TOKEN_EXPIRY_MS
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface RefreshResult {
  accountId: string
  status: 'refreshed' | 'locked' | 'failed' | 'identity_mismatch' | 'skipped'
  detail?: string
  refreshedAccountId?: string
  transportClass?: CodexRefreshTransportClass
}

type RefreshAccountTokensResult = {
  accountId: string
  status: 'refreshed'
  accessToken: string
  refreshToken: string
  idToken: string
  expiresAt: number
  credentialGeneration: number
} | {
  accountId: string
  status: 'identity_mismatch'
  refreshedAccountId: string
  credentialGeneration: number
}

function refreshedVaultTokensResult(
  tokens: Record<string, unknown> | undefined,
  accountId: string,
  vaultFilePath: string,
  writer: string,
  credentialGeneration: number,
  lifecycle: CodexCredentialLifecycle,
): RefreshAccountTokensResult | undefined {
  const accessToken = tokens?.access_token as string | undefined
  const refreshToken = tokens?.refresh_token as string | undefined
  if (!accessToken || !refreshToken) return undefined
  const storedGeneration = getCodexCredentialGenerationFromVaultTokens(tokens)
  if (storedGeneration === null || storedGeneration !== credentialGeneration) {
    return undefined
  }

  const vaultAccountId = tokens?.account_id as string | undefined
  if (vaultAccountId !== accountId) return undefined
  requireCredentialedLifecycle(lifecycle, accountId, credentialGeneration)
  const expiresAt = (tokens?.expires_at as number | undefined) ?? Date.now() + DEFAULT_TOKEN_EXPIRY_MS
  appendAccount(
    {
      accessToken,
      refreshToken,
      idToken: tokens?.id_token as string | undefined,
      expiresAt,
      accountId: vaultAccountId,
      credentialGeneration,
    },
    {
      preserveCapped: true,
      writer,
      source: 'vault',
      vaultFilePath,
    },
  )
  return {
    status: 'refreshed',
    accountId: vaultAccountId,
    accessToken,
    refreshToken,
    idToken: (tokens?.id_token as string | undefined) || '',
    expiresAt,
    credentialGeneration,
  }
}

export type CodexRefreshTransportClass =
  | 'offline'
  | 'ambiguous'
  | 'server_transient'
  | 'server_fatal'

export class ReauthenticationRequiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReauthenticationRequiredError'
  }
}

export class CodexRefreshTransportError extends Error {
  readonly transportClass?: CodexRefreshTransportClass

  constructor(message: string, transportClass?: CodexRefreshTransportClass) {
    super(message)
    this.name = 'CodexRefreshTransportError'
    this.transportClass = transportClass
  }
}

export class RefreshAlreadyInFlightError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefreshAlreadyInFlightError'
  }
}

export type CodexRefreshOptions = Readonly<{
  lifecycle?: CodexCredentialLifecycle
}>

export type CodexRefreshLifecycleFailureCode =
  | 'missing'
  | 'malformed'
  | 'unreadable'
  | 'state_mismatch'
  | 'generation_mismatch'
  | 'profile_mismatch'

export class CodexRefreshLifecycleError extends Error {
  readonly code: CodexRefreshLifecycleFailureCode
  readonly accountId: string
  readonly expectedGeneration: number

  constructor(
    code: CodexRefreshLifecycleFailureCode,
    accountId: string,
    expectedGeneration: number,
  ) {
    super('Codex credential lifecycle does not authorize this refresh.')
    this.name = 'CodexRefreshLifecycleError'
    this.code = code
    this.accountId = accountId
    this.expectedGeneration = expectedGeneration
  }
}

const pendingRefreshesByCredential = new Map<
  string,
  Promise<RefreshAccountTokensResult>
>()

function refreshPendingKey(accountId: string, credentialGeneration: number): string {
  return `${accountId}\u0000${credentialGeneration}`
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

function readVault(vaultFilePath: string): Record<string, any> {
  if (!existsSync(vaultFilePath)) return {}
  try {
    return JSON.parse(readFileSync(vaultFilePath, 'utf-8')) as Record<string, any>
  } catch {
    return {}
  }
}

function readExistingVault(vaultFilePath: string): Record<string, any> {
  if (!existsSync(vaultFilePath)) {
    throw new Error('Codex vault profile no longer exists')
  }
  return JSON.parse(readFileSync(vaultFilePath, 'utf-8')) as Record<string, any>
}

function requireCredentialedLifecycle(
  lifecycle: Pick<CodexCredentialLifecycle, 'read'>,
  accountId: string,
  credentialGeneration: number,
): void {
  const result: CodexCredentialLifecycleReadResult = lifecycle.read(accountId)
  if (result.status !== 'valid') {
    throw new CodexRefreshLifecycleError(
      result.status === 'absent' ? 'missing' : result.status,
      accountId,
      credentialGeneration,
    )
  }
  if (result.record.state !== 'credentialed') {
    throw new CodexRefreshLifecycleError(
      'state_mismatch',
      accountId,
      credentialGeneration,
    )
  }
  if (result.record.credentialGeneration !== credentialGeneration) {
    throw new CodexRefreshLifecycleError(
      'generation_mismatch',
      accountId,
      credentialGeneration,
    )
  }
}

function requireLegacyLifecycleBootstrap(
  lifecycle: Pick<CodexCredentialLifecycle, 'read'>,
  accountId: string,
  credentialGeneration: number,
): void {
  if (credentialGeneration !== LEGACY_CODEX_CREDENTIAL_GENERATION) {
    requireCredentialedLifecycle(lifecycle, accountId, credentialGeneration)
    return
  }
  const result = lifecycle.read(accountId)
  if (result.status !== 'absent') {
    throw new CodexRefreshLifecycleError(
      result.status === 'valid'
        ? 'state_mismatch'
        : result.status === 'malformed'
          ? 'malformed'
          : 'unreadable',
      accountId,
      credentialGeneration,
    )
  }
}

function requireVaultCredentialGeneration(
  vault: Record<string, any>,
  accountId: string,
  credentialGeneration: number,
): void {
  const tokens = vault.tokens as Record<string, unknown> | undefined
  const storedAccountId =
    typeof tokens?.account_id === 'string' ? tokens.account_id : undefined
  if (storedAccountId !== accountId) {
    throw new CodexRefreshLifecycleError(
      'profile_mismatch',
      accountId,
      credentialGeneration,
    )
  }
  const storedGeneration = getCodexCredentialGenerationFromVaultTokens(tokens)
  if (storedGeneration === null || storedGeneration !== credentialGeneration) {
    throw new CodexRefreshLifecycleError(
      'profile_mismatch',
      accountId,
      credentialGeneration,
    )
  }
}

function markLifecycleReauthRequired(
  lifecycle: CodexCredentialLifecycle,
  permit: CodexCredentialLifecyclePermit,
  accountId: string,
  credentialGeneration: number,
): void {
  const result = lifecycle.markReauthRequired(permit, {
    expectedGeneration: credentialGeneration,
  })
  if (result.status !== 'applied') {
    const reason = result.status === 'superseded' ? result.reason : 'state_mismatch'
    throw new CodexRefreshLifecycleError(
      reason === 'generation_mismatch'
        ? 'generation_mismatch'
        : reason === 'missing'
          ? 'missing'
          : 'state_mismatch',
      accountId,
      credentialGeneration,
    )
  }
}

function emitIdentityMismatchDiagnostic(
  oldAccountId: string,
  newAccountId: string,
): void {
  emitAccountDiagnostic({
    code: 'account.identity_mismatch',
    severity: 'warning',
    provider: 'openai',
    pool: 'codex',
    recoverable: true,
    from_account_ref: oldAccountId,
    account_ref: newAccountId,
    reason: `refresh returned different account ${newAccountId}`,
  })
}

export function acquireCodexVaultFileLock(
  vaultFilePath: string,
  onCompromised: (error: Error) => void,
): Promise<() => Promise<void>> {
  return lock(vaultFilePath, {
    // Keep refresh and deletion on the same path-based lock after unlink.
    realpath: false,
    retries: {
      retries: 10,
      factor: 1.5,
      minTimeout: 250,
      maxTimeout: 2000,
      randomize: true,
    },
    stale: 120_000,
    update: 30_000,
    onCompromised,
  }).then(release => {
    let released = false
    return async () => {
      if (released) return
      released = true
      try {
        await release()
      } catch (error) {
        if (
          !(
            error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'ERELEASED'
          )
        ) {
          throw error
        }
      }
    }
  })
}

// ── Transport error classifier ─────────────────────────────────────────────

/**
 * Classify a fetch/network error so we can decide whether the OAuth request
 * was definitely never sent, possibly sent (ambiguous), or a hard failure.
 *
 * - `definitely_not_sent`: DNS/routing failure; the request never left the machine.
 * - `ambiguous`: timeout/socket; we cannot know if the server processed it.
 * - `fatal`: any other error (programming fault, auth error, etc.).
 */
export function classifyRefreshTransportError(err: any): 'definitely_not_sent' | 'ambiguous' | 'fatal' {
  const code: string = err?.code ?? ''
  const name: string = err?.name ?? ''
  const message: string = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()

  // Definite offline/DNS/routing failures — request never left the process.
  const definitelyNotSentCodes = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH']
  if (definitelyNotSentCodes.includes(code)) return 'definitely_not_sent'
  if (message.includes('dns') || message.includes('network unreachable') || message.includes('connection refused')) {
    return 'definitely_not_sent'
  }

  // Ambiguous transport errors — request may or may not have reached the server.
  const ambiguousCodes = ['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET']
  if (ambiguousCodes.includes(code)) return 'ambiguous'
  if (name === 'TimeoutError' || name === 'AbortError') return 'ambiguous'
  if (message.includes('timeout') || message.includes('socket')) return 'ambiguous'

  return 'fatal'
}

function isCredentialRefreshFailure(status: number, body: string): boolean {
  if (status === 401 || status === 403) return true
  return /\b(?:invalid_grant|invalid_token|expired_token)\b/i.test(body)
}

/**
 * Pull a specific OAuth error code out of the refresh-failure response body.
 * OpenAI's error shape has varied between a flat `{"error":"invalid_grant"}`
 * and a nested `{"error":{"code":"refresh_token_reused"}}` — try structured
 * parsing first so real reasons (e.g. refresh_token_reused/expired/invalidated)
 * surface instead of collapsing to a generic http_<status>, then fall back to
 * the known flat-string codes for bodies that aren't JSON at all.
 */
function extractOAuthErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown
    if (parsed && typeof parsed === 'object') {
      const error = (parsed as Record<string, unknown>).error
      if (typeof error === 'string' && error.length > 0) return error
      if (error && typeof error === 'object') {
        const code = (error as Record<string, unknown>).code
        if (typeof code === 'string' && code.length > 0) return code
      }
    }
  } catch {
    // Not JSON — fall through to substring matching below.
  }

  if (/invalid_grant/i.test(body)) return 'invalid_grant'
  if (/invalid_token/i.test(body)) return 'invalid_token'
  if (/expired_token/i.test(body)) return 'expired_token'
  return undefined
}

function getHttpRefreshTransportClass(status: number): CodexRefreshTransportClass {
  if (status === 429 || status >= 500 || status === 400) {
    return 'server_transient'
  }
  return 'server_fatal'
}

function writeUnknownRefreshState(
  vaultFilePath: string,
  vault: Record<string, any>,
  attemptId: string,
  refreshTokenHash: string,
  reason: string,
): void {
  const nextProbeAt =
    typeof vault.refresh?.next_probe_at === 'string'
      ? vault.refresh.next_probe_at
      : undefined
  const consecutiveFailures =
    typeof vault.refresh?.consecutive_failures === 'number' &&
    Number.isFinite(vault.refresh.consecutive_failures)
      ? vault.refresh.consecutive_failures
      : undefined
  vault.refresh = {
    state: 'unknown',
    attempt_id: attemptId,
    refresh_token_hash: refreshTokenHash,
    failed_at: new Date().toISOString(),
    reason,
    ...(nextProbeAt ? { next_probe_at: nextProbeAt } : {}),
    ...(consecutiveFailures !== undefined ? { consecutive_failures: consecutiveFailures } : {}),
  }
  vault.version = (vault.version ?? 0) + 1
  atomicWriteJson(vaultFilePath, vault)
}

// ── Token refresh ──────────────────────────────────────────────────────────

/**
 * Refresh a single account's OAuth tokens via the OpenAI auth endpoint.
 * On success: atomically writes updated vault JSON and updates the in-memory pool.
 * Credential failures advance the lifecycle; transport failures preserve it.
 */
export async function refreshAccountTokens(
  accountId: string,
  refreshToken: string,
  vaultFilePath: string,
  credentialGeneration: number,
  options: CodexRefreshOptions = {},
): Promise<RefreshAccountTokensResult> {
  if (
    !Number.isSafeInteger(credentialGeneration) ||
    credentialGeneration < LEGACY_CODEX_CREDENTIAL_GENERATION
  ) {
    throw new CodexRefreshLifecycleError(
      'generation_mismatch',
      accountId,
      credentialGeneration,
    )
  }

  const pendingKey = refreshPendingKey(accountId, credentialGeneration)
  const pending = pendingRefreshesByCredential.get(pendingKey)
  if (pending) {
    return pending
  }

  const lifecycle = options.lifecycle ?? codexCredentialLifecycle
  const refresh = refreshAccountTokensStateful(
    accountId,
    refreshToken,
    vaultFilePath,
    credentialGeneration,
    lifecycle,
  ).finally(() => {
    pendingRefreshesByCredential.delete(pendingKey)
  })
  pendingRefreshesByCredential.set(pendingKey, refresh)
  return refresh
}

const IN_FLIGHT_GRACE_MS = 60_000

async function refreshAccountTokensStateful(
  accountId: string,
  refreshToken: string,
  vaultFilePath: string,
  credentialGeneration: number,
  lifecycle: CodexCredentialLifecycle,
): Promise<RefreshAccountTokensResult> {
  const attemptId = randomUUID()
  const refreshTokenHash = hashToken(refreshToken)

  return lifecycle.withTransaction(
    accountId,
    { operationKind: 'refresh', operationId: attemptId },
    async permit => {
      let releaseLock: undefined | (() => Promise<void>)
      let lockCompromised = false

      try {
        if (credentialGeneration === LEGACY_CODEX_CREDENTIAL_GENERATION) {
          requireLegacyLifecycleBootstrap(
            lifecycle,
            accountId,
            credentialGeneration,
          )
        } else {
          requireCredentialedLifecycle(
            lifecycle,
            accountId,
            credentialGeneration,
          )
        }

        releaseLock = await acquireCodexVaultFileLock(
          vaultFilePath,
          err => {
            lockCompromised = true
            logForDebugging(
              `[codex-refresh] Lock compromised: ${err instanceof Error ? err.message : String(err)}`,
              { level: 'error' },
            )
          },
        )

        let vault = readExistingVault(vaultFilePath)
        let effectiveGeneration = credentialGeneration

        if (credentialGeneration === LEGACY_CODEX_CREDENTIAL_GENERATION) {
          if (
            vault.profile_state === 'signed_out' ||
            vault.profile_state === 'recovery_required'
          ) {
            throw new CodexRefreshLifecycleError(
              'state_mismatch',
              accountId,
              credentialGeneration,
            )
          }
          const storedGeneration = getCodexCredentialGenerationFromVaultTokens(
            vault.tokens as Record<string, unknown> | undefined,
          )
          if (storedGeneration !== LEGACY_CODEX_CREDENTIAL_GENERATION) {
            throw new CodexRefreshLifecycleError(
              'profile_mismatch',
              accountId,
              credentialGeneration,
            )
          }
          const tokens = vault.tokens as Record<string, unknown> | undefined
          if (
            !tokens ||
            typeof tokens.access_token !== 'string' ||
            typeof tokens.refresh_token !== 'string' ||
            tokens.account_id !== accountId
          ) {
            throw new CodexRefreshLifecycleError(
              'profile_mismatch',
              accountId,
              credentialGeneration,
            )
          }
          const taggedTokens = {
            ...tokens,
            credential_generation: 1,
          }
          vault.tokens = taggedTokens
          vault.version = (vault.version ?? 0) + 1
          if (lockCompromised) {
            throw new Error('Lock compromised; refusing to write vault')
          }
          atomicWriteJson(vaultFilePath, vault)

          const bootstrapped = lifecycle.legacyBootstrap(permit, {
            validatedUntaggedLegacyCredentials: true,
          })
          if (
            bootstrapped.status !== 'applied' ||
            bootstrapped.record.credentialGeneration !== 1
          ) {
            throw new CodexRefreshLifecycleError(
              'state_mismatch',
              accountId,
              credentialGeneration,
            )
          }
          effectiveGeneration = bootstrapped.record.credentialGeneration
        }

        requireCredentialedLifecycle(
          lifecycle,
          accountId,
          effectiveGeneration,
        )
        requireVaultCredentialGeneration(
          vault,
          accountId,
          effectiveGeneration,
        )

        // 1. Another process already saved a rotated token.
        if (vault.tokens?.refresh_token && vault.tokens.refresh_token !== refreshToken) {
          // Adopt the rotation only when the vault holds no terminal verdict for
          // THAT token. Step 2 below correlates against the token we were called
          // with, so without this check a caller carrying a stale token (the
          // quarantine probe passes its in-memory copy) hands back a revoked
          // rotation as healthy, with no network request.
          const rotatedHash = hashToken(String(vault.tokens.refresh_token))
          if (
            vault.refresh?.state === 'reauth_required' &&
            vault.refresh.refresh_token_hash === rotatedHash
          ) {
            if (lockCompromised) throw new Error('Lock compromised; refusing to write vault')
            const rotatedReason = vault.refresh.reason || 'refresh outcome is unknown'
            markLifecycleReauthRequired(
              lifecycle,
              permit,
              accountId,
              effectiveGeneration,
            )
            const rotatedDisplay = normalizeCodexAccountBlockReason(rotatedReason) ?? rotatedReason
            markAccountDead(accountId, rotatedDisplay)
            throw new ReauthenticationRequiredError(`Reauthentication required: ${rotatedDisplay}`)
          }
          const refreshed = refreshedVaultTokensResult(
            vault.tokens,
            accountId,
            vaultFilePath,
            'codex-refresh.refreshAccountTokens.concurrent-recovery',
            effectiveGeneration,
            lifecycle,
          )
          if (refreshed) {
            logForDebugging(`[codex-refresh] Token was updated by another process. Using new token...`)
            return refreshed
          }
        }

        // 2. A terminal previous verdict for this exact token still blocks. Unknown
        // transport outcomes intentionally fall through to a real re-probe.
        if (
          vault.refresh?.state === 'reauth_required' &&
          vault.refresh.refresh_token_hash === refreshTokenHash
        ) {
          if (lockCompromised) throw new Error('Lock compromised; refusing to write vault')
          const reason = vault.refresh.reason || 'refresh outcome is unknown'
          markLifecycleReauthRequired(
            lifecycle,
            permit,
            accountId,
            effectiveGeneration,
          )
          const displayReason = normalizeCodexAccountBlockReason(reason) ?? reason
          markAccountDead(accountId, displayReason)
          throw new ReauthenticationRequiredError(`Reauthentication required: ${displayReason}`)
        }

        // 3. Refresh already in flight — block regardless of whether hash matches.
        if (vault.refresh?.state === 'in_flight') {
          if (vault.refresh.refresh_token_hash !== refreshTokenHash) {
            // A different token is already being refreshed; do not overwrite.
            throw new RefreshAlreadyInFlightError('Token refresh for a different token is in progress.')
          }
          // Same hash: apply grace period / stale logic.
          const ageMs = Date.now() - Date.parse(vault.refresh.started_at || new Date(0).toISOString())
          if (ageMs > IN_FLIGHT_GRACE_MS) {
            if (lockCompromised) throw new Error('Lock compromised; refusing to write vault')
            requireCredentialedLifecycle(
              lifecycle,
              accountId,
              effectiveGeneration,
            )
            writeUnknownRefreshState(
              vaultFilePath,
              vault,
              vault.refresh.attempt_id,
              refreshTokenHash,
              'stale_in_flight',
            )
            const reason = 'Previous token refresh stalled and outcome is unknown.'
            markPoolAccountQuarantined(accountId, reason)
            throw new CodexRefreshTransportError(reason, 'ambiguous')
          }
          throw new RefreshAlreadyInFlightError('Token refresh is already in progress.')
        }

        // 4. Persist intent BEFORE sending the request.
        const nextProbeAt =
          typeof vault.refresh?.next_probe_at === 'string'
            ? vault.refresh.next_probe_at
            : undefined
        const consecutiveFailures =
          typeof vault.refresh?.consecutive_failures === 'number' &&
          Number.isFinite(vault.refresh.consecutive_failures)
            ? vault.refresh.consecutive_failures
            : undefined
        vault.refresh = {
          state: 'in_flight',
          attempt_id: attemptId,
          refresh_token_hash: refreshTokenHash,
          started_at: new Date().toISOString(),
          pid: process.pid,
          ...(nextProbeAt ? { next_probe_at: nextProbeAt } : {}),
          ...(consecutiveFailures !== undefined ? { consecutive_failures: consecutiveFailures } : {}),
        }
        vault.version = (vault.version ?? 0) + 1
        if (lockCompromised) throw new Error('Lock compromised; refusing to write vault')
        requireCredentialedLifecycle(
          lifecycle,
          accountId,
          effectiveGeneration,
        )
        atomicWriteJson(vaultFilePath, vault)

        // 5. Send network request
        let response: Response
        try {
          response = await globalThis.fetch(CODEX_TOKEN_URL, {
            method: 'POST',
            signal: AbortSignal.timeout(15_000),
            headers: {
              'Content-Type': 'application/json',
              originator: 'codex_cli_rs',
            },
            body: JSON.stringify({
              client_id: CODEX_CLIENT_ID,
              grant_type: 'refresh_token',
              refresh_token: refreshToken,
            }),
          })
        } catch (fetchErr: any) {
          if (lockCompromised) throw new Error('Lock compromised; refusing to write vault')
          const transport = classifyRefreshTransportError(fetchErr)
          const latest = readVault(vaultFilePath)
          const stillOwner = latest.refresh?.attempt_id === attemptId
          const detail = fetchErr instanceof Error ? fetchErr.message : String(fetchErr)
          if (transport === 'definitely_not_sent') {
            // Request definitely never reached the server — safe to reset to idle.
            if (stillOwner) {
              requireCredentialedLifecycle(
                lifecycle,
                accountId,
                effectiveGeneration,
              )
              requireVaultCredentialGeneration(
                latest,
                accountId,
                effectiveGeneration,
              )
              latest.refresh = { state: 'idle' }
              latest.version = (latest.version ?? 0) + 1
              atomicWriteJson(vaultFilePath, latest)
            }
            throw new CodexRefreshTransportError(
              `Token refresh could not reach the server: ${detail}`,
              'offline',
            )
          } else {
            // Outcome uncertain — mark unknown so a future probe can retry without
            // converting a network drop into a server-side auth verdict.
            if (stillOwner) {
              requireCredentialedLifecycle(
                lifecycle,
                accountId,
                effectiveGeneration,
              )
              requireVaultCredentialGeneration(
                latest,
                accountId,
                effectiveGeneration,
              )
              writeUnknownRefreshState(
                vaultFilePath,
                latest,
                attemptId,
                refreshTokenHash,
                detail || (transport === 'ambiguous' ? 'transport_ambiguous' : 'transport_fatal'),
              )
            }
            const reason = `Token refresh transport error (outcome unknown): ${detail}`
            markPoolAccountQuarantined(accountId, reason)
            throw new CodexRefreshTransportError(
              reason,
              transport === 'ambiguous' ? 'ambiguous' : 'server_fatal',
            )
          }
        }

        if (!response.ok) {
          if (lockCompromised) throw new Error('Lock compromised; refusing to write vault')
          const bodyText = await response.text().catch(() => '')
          const latest = readVault(vaultFilePath)
          if (isCredentialRefreshFailure(response.status, bodyText)) {
            // Another process may have already rotated this token out from under
            // us — a rotated-away refresh token legitimately 401s. Recover onto
            // the newer token instead of declaring the account dead.
            if (latest.tokens?.refresh_token && latest.tokens.refresh_token !== refreshToken) {
              const rotatedHash = hashToken(String(latest.tokens.refresh_token))
              if (
                latest.refresh?.state === 'reauth_required' &&
                latest.refresh.refresh_token_hash === rotatedHash
              ) {
                markLifecycleReauthRequired(
                  lifecycle,
                  permit,
                  accountId,
                  effectiveGeneration,
                )
                const rotatedReason = latest.refresh.reason || 'refresh outcome is unknown'
                const rotatedDisplay = normalizeCodexAccountBlockReason(rotatedReason) ?? rotatedReason
                markAccountDead(accountId, rotatedDisplay)
                throw new ReauthenticationRequiredError(`Reauthentication required: ${rotatedDisplay}`)
              }
              const refreshed = refreshedVaultTokensResult(
                latest.tokens,
                accountId,
                vaultFilePath,
                'codex-refresh.refreshAccountTokens.credential-failure-recovery',
                effectiveGeneration,
                lifecycle,
              )
              if (refreshed) {
                logForDebugging(`[codex-refresh] Credential failure but a newer token exists in the vault. Using new token...`)
                return refreshed
              }
            }
            const credentialReason = extractOAuthErrorCode(bodyText) ?? `http_${response.status}`
            if (latest.refresh?.attempt_id === attemptId) {
              requireVaultCredentialGeneration(
                latest,
                accountId,
                effectiveGeneration,
              )
              markLifecycleReauthRequired(
                lifecycle,
                permit,
                accountId,
                effectiveGeneration,
              )
              latest.refresh = {
                state: 'reauth_required',
                refresh_token_hash: refreshTokenHash,
                marked_at: new Date().toISOString(),
                reason: credentialReason,
              }
              atomicWriteJson(vaultFilePath, latest)
            }
            const reason = normalizeCodexAccountBlockReason(credentialReason) ?? `Token refresh failed: HTTP ${response.status}`
            markAccountDead(accountId, reason)
            throw new ReauthenticationRequiredError(reason)
          }

          const transportClass = getHttpRefreshTransportClass(response.status)
          const reason = `Token refresh failed: HTTP ${response.status}`
          if (latest.refresh?.attempt_id === attemptId) {
            requireCredentialedLifecycle(
              lifecycle,
              accountId,
              effectiveGeneration,
            )
            requireVaultCredentialGeneration(
              latest,
              accountId,
              effectiveGeneration,
            )
            writeUnknownRefreshState(
              vaultFilePath,
              latest,
              attemptId,
              refreshTokenHash,
              `http_${response.status}`,
            )
          }
          markPoolAccountQuarantined(accountId, reason)
          throw new CodexRefreshTransportError(reason, transportClass)
        }

        const data = (await response.json()) as Record<string, unknown>
        const newAccessToken = data.access_token as string | undefined
        const newRefreshToken = data.refresh_token as string | undefined
        const newIdToken = data.id_token as string | undefined
        const expiresAt = parseExpiresAt(data)

        if (!newAccessToken || !newRefreshToken) {
          const reason = 'Token refresh response missing required fields'
          markAccountDead(accountId, reason)
          throw new Error(reason)
        }

        const refreshedAccountId = extractCodexAccountId(newAccessToken)
        if (!refreshedAccountId) {
          const reason = 'Token refresh response missing account identity'
          markAccountDead(accountId, reason)
          throw new Error(reason)
        }

        if (lockCompromised) {
          throw new Error('Lock compromised; refusing to write vault')
        }

        const latest = readVault(vaultFilePath)
        if (latest.refresh?.attempt_id !== attemptId) {
          // Lost ownership — check if another process already wrote valid newer tokens.
          if (latest.tokens?.refresh_token && latest.tokens.refresh_token !== refreshToken) {
            const refreshed = refreshedVaultTokensResult(
              latest.tokens,
              accountId,
              vaultFilePath,
              'codex-refresh.refreshAccountTokens.lost-ownership-recovery',
              effectiveGeneration,
              lifecycle,
            )
            if (refreshed) return refreshed
          }
          throw new Error('Lost refresh attempt ownership; refusing to write tokens')
        }

        requireCredentialedLifecycle(
          lifecycle,
          accountId,
          effectiveGeneration,
        )
        requireVaultCredentialGeneration(
          latest,
          accountId,
          effectiveGeneration,
        )

        const sameAccount = refreshedAccountId === accountId

        // A refresh must never move credentials into a different profile. The
        // lifecycle record for the old account is the only durable outcome.
        if (!sameAccount) {
          logForDebugging(
            `[codex-profile] identity-mismatch writer=codex-refresh.refreshAccountTokens before_account=${accountId} after_account=${refreshedAccountId} file=${vaultFilePath.split('/').pop() ?? vaultFilePath} action=reauth-required`,
            { level: 'warn' },
          )
          markLifecycleReauthRequired(
            lifecycle,
            permit,
            accountId,
            effectiveGeneration,
          )
          latest.refresh = {
            state: 'reauth_required',
            refresh_token_hash: refreshTokenHash,
            marked_at: new Date().toISOString(),
            reason: 'identity_mismatch',
          }
          latest.version = (latest.version ?? 0) + 1
          atomicWriteJson(vaultFilePath, latest)
          markAccountDead(
            accountId,
            `Refresh returned different account ${refreshedAccountId}`,
            { rerollActive: false },
          )
          emitIdentityMismatchDiagnostic(accountId, refreshedAccountId)

          return {
            accountId,
            credentialGeneration: effectiveGeneration,
            status: 'identity_mismatch',
            refreshedAccountId,
          }
        }

        // Normal success
        const tokens = latest.tokens as Record<string, unknown>
        tokens.access_token = newAccessToken
        tokens.refresh_token = newRefreshToken
        tokens.account_id = refreshedAccountId
        tokens.expires_at = expiresAt
        if (newIdToken) tokens.id_token = newIdToken
        latest.tokens = tokens
        latest.last_refresh = new Date().toISOString()
        latest.refresh = { state: 'idle' }
        latest.version = (latest.version ?? 0) + 1

        requireCredentialedLifecycle(
          lifecycle,
          accountId,
          effectiveGeneration,
        )
        atomicWriteJson(vaultFilePath, latest)
        requireCredentialedLifecycle(
          lifecycle,
          accountId,
          effectiveGeneration,
        )

        appendAccount({
          accessToken: newAccessToken,
          refreshToken: newRefreshToken,
          idToken: newIdToken,
          expiresAt,
          accountId: refreshedAccountId,
          credentialGeneration: effectiveGeneration,
        }, {
          preserveCapped: true,
          writer: 'codex-refresh.refreshAccountTokens',
          source: 'vault',
          vaultFilePath,
        })

        logForDebugging(
          `[codex-profile] refresh-done writer=codex-refresh.refreshAccountTokens account=${refreshedAccountId} file=${vaultFilePath.split('/').pop() ?? vaultFilePath} metadata=preserved`,
        )

        return {
          accountId: refreshedAccountId,
          accessToken: newAccessToken,
          refreshToken: newRefreshToken,
          idToken: newIdToken || '',
          expiresAt,
          credentialGeneration: effectiveGeneration,
          status: 'refreshed',
        }
      } finally {
        if (releaseLock) {
          await releaseLock().catch(() => {})
        }
      }
    },
  )
}

// ── Touch-all ──────────────────────────────────────────────────────────────

/**
 * Refresh tokens for all unlocked vault accounts.
 * Skips locked accounts. Returns per-account results.
 */
export async function touchAll(
  options: { vaultPath?: string; lifecycle?: CodexCredentialLifecycle } = {},
): Promise<RefreshResult[]> {
  const vaultPath = options.vaultPath ?? getVaultPath()
  if (!vaultPath) return []
  const lifecycle = options.lifecycle ?? codexCredentialLifecycle

  const accountsDir = join(vaultPath, 'accounts')
  const locksDir = join(vaultPath, 'locks')
  if (!existsSync(accountsDir)) return []

  let files: string[]
  try {
    files = readdirSync(accountsDir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }

  const results: RefreshResult[] = []

  for (const file of files) {
    const filePath = join(accountsDir, file)
    let accountId = file.replace('.json', '')
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const data = JSON.parse(raw) as Record<string, unknown>
      const tokens = data.tokens as Record<string, unknown> | undefined
      const explicitProfileState = data.profile_state
      const accountFromFile =
        typeof data.account_id === 'string'
          ? data.account_id
          : typeof tokens?.account_id === 'string'
            ? tokens.account_id
            : undefined

      if (
        explicitProfileState === 'signed_out' ||
        explicitProfileState === 'recovery_required'
      ) {
        results.push({
          accountId: accountFromFile ?? file,
          status: 'skipped',
          detail:
            explicitProfileState === 'signed_out'
              ? 'Profile is signed out'
              : 'Profile is not credentialed',
        })
        continue
      }

      const lifecycleForFile = accountFromFile
        ? lifecycle.read(accountFromFile)
        : undefined
      if (
        lifecycleForFile?.status === 'valid' &&
        lifecycleForFile.record.state !== 'credentialed'
      ) {
        results.push({
          accountId: accountFromFile ?? file,
          status: 'skipped',
          detail:
            lifecycleForFile.record.state === 'signed_out'
              ? 'Profile is signed out'
              : 'Profile is not credentialed',
        })
        continue
      }

      if (!tokens?.access_token || !tokens.refresh_token || !tokens.account_id) {
        results.push({
          accountId: file,
          status: 'failed',
          detail: 'Missing required token fields',
        })
        continue
      }

      accountId = String(tokens.account_id)
      const lifecycleResult =
        accountFromFile === accountId
          ? lifecycleForFile
          : lifecycle.read(accountId)
      if (
        lifecycleResult?.status === 'valid' &&
        lifecycleResult.record.state !== 'credentialed'
      ) {
        results.push({
          accountId,
          status: 'skipped',
          detail:
            lifecycleResult.record.state === 'signed_out'
              ? 'Profile is signed out'
              : 'Profile is not credentialed',
        })
        continue
      }
      const credentialGeneration = getCodexCredentialGenerationFromVaultTokens(tokens)
      if (credentialGeneration === null) {
        results.push({
          accountId,
          status: 'failed',
          detail: 'Credential generation is invalid',
        })
        continue
      }
      const expiresAt =
        typeof tokens.expires_at === 'number' && Number.isFinite(tokens.expires_at)
          ? tokens.expires_at
          : 0
      if (!isWithinCodexRefreshSkew(expiresAt)) {
        results.push({
          accountId,
          status: 'skipped',
          detail: 'Access token is not within refresh skew',
        })
        continue
      }

      // Check lock
      if (isAccountLocked(locksDir, accountId)) {
        results.push({ accountId, status: 'locked', detail: 'Locked by another process' })
        continue
      }

      // Refresh
      const refreshed = await refreshAccountTokens(
        accountId,
        String(tokens.refresh_token),
        filePath,
        credentialGeneration,
        { lifecycle },
      )
      if (refreshed.status === 'identity_mismatch') {
        results.push({
          accountId,
          status: 'identity_mismatch',
          detail: `Refresh returned different account ${refreshed.refreshedAccountId}`,
          refreshedAccountId: refreshed.refreshedAccountId,
        })
      } else {
        results.push({ accountId, status: 'refreshed' })
      }
    } catch (err) {
      if (err instanceof CodexRefreshTransportError) {
        markPoolAccountQuarantined(
          accountId,
          'connection problem during token refresh; retrying',
        )
      }
      results.push({
        accountId,
        status: 'failed',
        detail: err instanceof Error ? err.message : String(err),
        ...(err instanceof CodexRefreshTransportError
          ? { transportClass: err.transportClass }
          : {}),
      })
    }
  }

  logForDebugging(
    `[codex-refresh] touch-all: ${results.filter((r) => r.status === 'refreshed').length} refreshed, ` +
      `${results.filter((r) => r.status === 'locked').length} locked, ` +
      `${results.filter((r) => r.status === 'failed').length} failed, ` +
      `${results.filter((r) => r.status === 'skipped').length} skipped`,
  )

  return results
}

// ── Periodic refresh timer ─────────────────────────────────────────────────

let refreshTimerId: ReturnType<typeof setInterval> | null = null

/**
 * Start a periodic timer that calls touchAll().
 * Interval from settings `codexTokenRefreshIntervalHours` (default 4).
 * No-op if already running. Set interval to 0 to disable.
 */
export function startPeriodicRefresh(): void {
  if (refreshTimerId !== null) return

  const settings = getInitialSettings()
  const hours = settings.codexTokenRefreshIntervalHours ?? DEFAULT_REFRESH_INTERVAL_HOURS
  if (hours <= 0) {
    logForDebugging('[codex-refresh] Periodic refresh disabled (interval = 0)')
    return
  }

  const intervalMs = hours * 60 * 60 * 1000
  refreshTimerId = setInterval(() => {
    void touchAll().catch(error => {
      logForDebugging(
        `[codex-refresh] Periodic refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        { level: 'error' },
      )
    })
  }, intervalMs)

  // Don't let the timer keep the process alive
  if (refreshTimerId && typeof refreshTimerId === 'object' && 'unref' in refreshTimerId) {
    refreshTimerId.unref()
  }

  registerCleanup(async () => stopPeriodicRefresh())

  logForDebugging(`[codex-refresh] Periodic refresh started (every ${hours}h)`)
}

/** Stop the periodic refresh timer. */
export function stopPeriodicRefresh(): void {
  if (refreshTimerId !== null) {
    clearInterval(refreshTimerId)
    refreshTimerId = null
    logForDebugging('[codex-refresh] Periodic refresh stopped')
  }
}

// ── Quarantine probe timer ──────────────────────────────────────────────────

let quarantineProbeTimerId: ReturnType<typeof setInterval> | null = null
let quarantineProbeInFlight = false

const QUARANTINE_PROBE_INTERVAL_MS = 1_000
const QUARANTINE_PROBE_BACKOFF_MS = [5_000, 10_000, 30_000, 60_000, 300_000] as const

export function startQuarantineProbe(): void {
  if (quarantineProbeTimerId !== null) return

  quarantineProbeTimerId = setInterval(() => {
    void runQuarantineProbeOnce().catch(error => {
      logForDebugging(
        `[codex-refresh] Quarantine probe failed: ${error instanceof Error ? error.message : String(error)}`,
        { level: 'error' },
      )
    })
  }, QUARANTINE_PROBE_INTERVAL_MS)

  if (
    quarantineProbeTimerId &&
    typeof quarantineProbeTimerId === 'object' &&
    'unref' in quarantineProbeTimerId
  ) {
    quarantineProbeTimerId.unref()
  }

  registerCleanup(async () => stopQuarantineProbe())
  logForDebugging('[codex-refresh] Quarantine probe started')
}

export function stopQuarantineProbe(): void {
  if (quarantineProbeTimerId !== null) {
    clearInterval(quarantineProbeTimerId)
    quarantineProbeTimerId = null
    logForDebugging('[codex-refresh] Quarantine probe stopped')
  }
}

export async function runQuarantineProbeOnce(
  options: CodexRefreshOptions = {},
): Promise<RefreshResult[]> {
  if (quarantineProbeInFlight) return []
  quarantineProbeInFlight = true

  try {
    const now = Date.now()
    const results: RefreshResult[] = []
    const lifecycle = options.lifecycle ?? codexCredentialLifecycle
    const accounts = getPoolStatus().accounts.filter(
      account =>
        account.status === 'quarantined' &&
        Boolean(account.vaultFilePath) &&
        Boolean(account.refreshToken),
    )

    for (const account of accounts) {
      const vaultFilePath = account.vaultFilePath!
      const vault = readVault(vaultFilePath)
      const lifecycleResult = lifecycle.read(account.accountId)
      const legacyBootstrapPending =
        account.credentialGeneration === LEGACY_CODEX_CREDENTIAL_GENERATION &&
        lifecycleResult.status === 'absent'
      if (
        !legacyBootstrapPending &&
        (
          account.credentialGeneration === LEGACY_CODEX_CREDENTIAL_GENERATION ||
          lifecycleResult.status !== 'valid' ||
          lifecycleResult.record.state !== 'credentialed' ||
          lifecycleResult.record.credentialGeneration !== account.credentialGeneration
        )
      ) {
        results.push({
          accountId: account.accountId,
          status: 'skipped',
          detail: 'Credential lifecycle no longer authorizes this probe',
        })
        continue
      }
      const refreshState = vault.refresh as Record<string, unknown> | undefined
      const nextProbeAt = typeof refreshState?.next_probe_at === 'string'
        ? Date.parse(refreshState.next_probe_at)
        : Number.NaN
      if (Number.isFinite(nextProbeAt) && nextProbeAt > now) {
        continue
      }

      try {
        if (!legacyBootstrapPending) {
          await persistNextQuarantineProbe(
            vaultFilePath,
            'quarantine probe in progress',
            account.accountId,
            account.credentialGeneration,
            { lifecycle },
          )
        }
        const refreshed = await refreshAccountTokens(
          account.accountId,
          account.refreshToken,
          vaultFilePath,
          account.credentialGeneration,
          { lifecycle },
        )
        if (refreshed.status === 'identity_mismatch') {
          results.push({
            accountId: account.accountId,
            status: 'identity_mismatch',
            refreshedAccountId: refreshed.refreshedAccountId,
          })
        } else {
          results.push({
            accountId: account.accountId,
            status: 'refreshed',
          })
        }
      } catch (err) {
        if (err instanceof CodexRefreshLifecycleError) {
          results.push({
            accountId: account.accountId,
            status: 'skipped',
            detail: 'Credential lifecycle no longer authorizes this probe',
          })
          continue
        }
        if (err instanceof ReauthenticationRequiredError) {
          results.push({
            accountId: account.accountId,
            status: 'failed',
            detail: err.message,
          })
          continue
        }

        const detail = err instanceof Error ? err.message : String(err)
        markPoolAccountQuarantined(account.accountId, detail)
        try {
          const currentLifecycle = lifecycle.read(account.accountId)
          const currentGeneration =
            currentLifecycle.status === 'valid'
              ? currentLifecycle.record.credentialGeneration
              : account.credentialGeneration
          await persistNextQuarantineProbe(
            vaultFilePath,
            detail,
            account.accountId,
            currentGeneration,
            { lifecycle },
          )
        } catch (persistenceError) {
          if (persistenceError instanceof CodexRefreshLifecycleError) {
            results.push({
              accountId: account.accountId,
              status: 'skipped',
              detail: 'Credential lifecycle no longer authorizes this probe',
              ...(err instanceof CodexRefreshTransportError
                ? { transportClass: err.transportClass }
                : {}),
            })
            continue
          }
          logForDebugging(
            `[codex-refresh] Could not persist quarantine probe failure: ${persistenceError instanceof Error ? persistenceError.message : String(persistenceError)}`,
            { level: 'error' },
          )
        }
        results.push({
          accountId: account.accountId,
          status: 'failed',
          detail,
          ...(err instanceof CodexRefreshTransportError
            ? { transportClass: err.transportClass }
            : {}),
        })
      }
    }

    return results
  } finally {
    quarantineProbeInFlight = false
  }
}

export async function persistNextQuarantineProbe(
  vaultFilePath: string,
  reason: string,
  accountId: string,
  credentialGeneration: number,
  options: CodexRefreshOptions = {},
): Promise<void> {
  const lifecycle = options.lifecycle ?? codexCredentialLifecycle
  return lifecycle.withTransaction(
    accountId,
    { operationKind: 'refresh' },
    async () => {
      requireCredentialedLifecycle(
        lifecycle,
        accountId,
        credentialGeneration,
      )
      let lockCompromised = false
      const release = await acquireCodexVaultFileLock(vaultFilePath, error => {
        lockCompromised = true
        logForDebugging(
          `[codex-refresh] Quarantine probe lock compromised: ${error.message}`,
          { level: 'error' },
        )
      })
      try {
        requireCredentialedLifecycle(
          lifecycle,
          accountId,
          credentialGeneration,
        )
        const vault = readExistingVault(vaultFilePath)
        if (
          vault.profile_state === 'signed_out' ||
          vault.profile_state === 'recovery_required'
        ) {
          throw new CodexRefreshLifecycleError(
            'state_mismatch',
            accountId,
            credentialGeneration,
          )
        }
        requireVaultCredentialGeneration(
          vault,
          accountId,
          credentialGeneration,
        )
        const refreshState = (vault.refresh ?? {}) as Record<string, unknown>
        if (refreshState.state === 'reauth_required') return

        const previousFailures =
          typeof refreshState.consecutive_failures === 'number' &&
          Number.isFinite(refreshState.consecutive_failures)
            ? refreshState.consecutive_failures
            : 0
        const existingNextProbeAt =
          typeof refreshState.next_probe_at === 'string'
            ? Date.parse(refreshState.next_probe_at)
            : Number.NaN
        const hasFutureReservation =
          Number.isFinite(existingNextProbeAt) && existingNextProbeAt > Date.now()
        const consecutiveFailures = hasFutureReservation
          ? previousFailures
          : previousFailures + 1
        const backoff =
          QUARANTINE_PROBE_BACKOFF_MS[
            Math.min(
              consecutiveFailures - 1,
              QUARANTINE_PROBE_BACKOFF_MS.length - 1,
            )
          ] ??
          QUARANTINE_PROBE_BACKOFF_MS[QUARANTINE_PROBE_BACKOFF_MS.length - 1]

        vault.refresh = {
          ...refreshState,
          state: 'unknown',
          failed_at: new Date().toISOString(),
          reason,
          consecutive_failures: consecutiveFailures,
          next_probe_at:
            hasFutureReservation &&
            typeof refreshState.next_probe_at === 'string'
              ? refreshState.next_probe_at
              : new Date(Date.now() + backoff).toISOString(),
        }
        vault.version = (vault.version ?? 0) + 1
        if (lockCompromised) {
          throw new Error('Lock compromised; refusing to write vault')
        }
        requireCredentialedLifecycle(
          lifecycle,
          accountId,
          credentialGeneration,
        )
        atomicWriteJson(vaultFilePath, vault)
      } finally {
        await release()
      }
    },
  )
}

/**
 * Vault writes go through the shared durable writer, the same one
 * codexAccountPool uses on these files, so both writers agree on temp naming,
 * fsync-before-rename and the best-effort directory fsync.
 */
function atomicWriteJson(filePath: string, data: unknown): void {
  writeFileAtomicDurableSync(filePath, JSON.stringify(data, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  })
}
