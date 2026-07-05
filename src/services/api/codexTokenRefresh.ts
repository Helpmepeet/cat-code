/**
 * Codex OAuth token refresh, touch-all orchestration, and periodic timer.
 *
 * Replaces the Python codex-nootp tool's token refresh functionality.
 * Refreshes tokens via POST to auth.openai.com/oauth/token.
 * Refresh tokens rotate — the old one becomes invalid after each use.
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, existsSync, openSync, closeSync, fsyncSync } from 'fs'
import { join, dirname, basename } from 'path'
import { createHash, randomUUID } from 'crypto'
import { lock } from 'proper-lockfile'

import { logForDebugging } from '../../utils/debug.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { extractCodexAccountId } from '../oauth/codex-client.js'
import {
  appendAccount,
  getPoolStatus,
  getVaultPath,
  isAccountLocked,
  markAccountDead,
  markPoolAccountQuarantined,
  normalizeCodexAccountBlockReason,
  saveCodexTokenToVault,
  setActiveAccountPersisted,
} from './codexAccountPool.js'
import { getCodexLeaseForOwner, reassignCodexLeaseToActiveAccount } from './codexAccountLeaseManager.js'
import { emitAccountDiagnostic } from './accountDiagnostics.js'

// ── Constants ──────────────────────────────────────────────────────────────

const TOKEN_REFRESH_URL = 'https://auth.openai.com/oauth/token'
const TOKEN_REFRESH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const DEFAULT_REFRESH_INTERVAL_HOURS = 4
// Fallback expiry when the OAuth response omits expires_in. Chosen to match the
// typical 1h token TTL so the next request still refreshes before expiry.
const DEFAULT_TOKEN_EXPIRY_MS = 60 * 60 * 1000

function countPoolStatuses(): Record<string, number> {
  const accounts = getPoolStatus().accounts
  const counts: Record<string, number> = { total: accounts.length }
  for (const account of accounts) {
    counts[account.status] = (counts[account.status] ?? 0) + 1
  }
  return counts
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
    counts: countPoolStatuses(),
  })
}

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
  status: 'refreshed' | 'locked' | 'failed' | 'identity_mismatch'
  detail?: string
  refreshedAccountId?: string
  transportClass?: CodexRefreshTransportClass
}

type RefreshAccountTokensResult = {
  accountId: string
  accessToken: string
  refreshToken: string
  idToken: string
  expiresAt: number
  status: 'refreshed' | 'identity_mismatch'
  refreshedAccountId?: string
}

function refreshedVaultTokensResult(
  tokens: Record<string, unknown> | undefined,
  accountId: string,
  vaultFilePath: string,
  writer: string,
): RefreshAccountTokensResult | undefined {
  const accessToken = tokens?.access_token as string | undefined
  const refreshToken = tokens?.refresh_token as string | undefined
  if (!accessToken || !refreshToken) return undefined

  const vaultAccountId = (tokens?.account_id as string | undefined) ?? accountId
  const expiresAt = (tokens?.expires_at as number | undefined) ?? Date.now() + DEFAULT_TOKEN_EXPIRY_MS
  appendAccount(
    {
      accessToken,
      refreshToken,
      idToken: tokens?.id_token as string | undefined,
      expiresAt,
      accountId: vaultAccountId,
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

const pendingRefreshesByAccountId = new Map<
  string,
  Promise<RefreshAccountTokensResult>
>()

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
 * On failure: marks the account dead with a descriptive error.
 */
export async function refreshAccountTokens(
  accountId: string,
  refreshToken: string,
  vaultFilePath: string,
): Promise<RefreshAccountTokensResult> {
  const pending = pendingRefreshesByAccountId.get(accountId)
  if (pending) {
    return pending
  }

  const refresh = refreshAccountTokensStateful(accountId, refreshToken, vaultFilePath).finally(() => {
    pendingRefreshesByAccountId.delete(accountId)
  })
  pendingRefreshesByAccountId.set(accountId, refresh)
  return refresh
}

const IN_FLIGHT_GRACE_MS = 60_000

async function refreshAccountTokensStateful(
  accountId: string,
  refreshToken: string,
  vaultFilePath: string,
): Promise<RefreshAccountTokensResult> {
  let releaseLock: undefined | (() => Promise<void>)
  let lockCompromised = false

  const attemptId = randomUUID()
  const refreshTokenHash = hashToken(refreshToken)

  try {
    releaseLock = await lock(vaultFilePath, {
      retries: {
        retries: 10,
        factor: 1.5,
        minTimeout: 250,
        maxTimeout: 2000,
        randomize: true,
      },
      stale: 120_000,
      update: 30_000,
      onCompromised: (err) => {
        lockCompromised = true
        logForDebugging(`[codex-refresh] Lock compromised: ${err instanceof Error ? err.message : String(err)}`, { level: 'error' })
      },
    })

    let vault = readVault(vaultFilePath)

    // 1. Another process already saved a rotated token.
    if (vault.tokens?.refresh_token && vault.tokens.refresh_token !== refreshToken) {
      const refreshed = refreshedVaultTokensResult(
        vault.tokens,
        accountId,
        vaultFilePath,
        'codex-refresh.refreshAccountTokens.concurrent-recovery',
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
      const reason = vault.refresh.reason || 'refresh outcome is unknown'
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
    atomicWriteJson(vaultFilePath, vault)

    // 5. Send network request
    let response: Response
    try {
      response = await globalThis.fetch(TOKEN_REFRESH_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: {
          'Content-Type': 'application/json',
          originator: 'codex_cli_rs',
        },
        body: JSON.stringify({
          client_id: TOKEN_REFRESH_CLIENT_ID,
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
          const refreshed = refreshedVaultTokensResult(
            latest.tokens,
            accountId,
            vaultFilePath,
            'codex-refresh.refreshAccountTokens.credential-failure-recovery',
          )
          if (refreshed) {
            logForDebugging(`[codex-refresh] Credential failure but a newer token exists in the vault. Using new token...`)
            return refreshed
          }
        }
        const credentialReason = extractOAuthErrorCode(bodyText) ?? `http_${response.status}`
        if (latest.refresh?.attempt_id === attemptId) {
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
        )
        if (refreshed) return refreshed
      }
      throw new Error('Lost refresh attempt ownership; refusing to write tokens')
    }

    const sameAccount = refreshedAccountId === accountId

    // Identity mismatch handling
    if (!sameAccount) {
      logForDebugging(
        `[codex-profile] identity-mismatch writer=codex-refresh.refreshAccountTokens before_account=${accountId} after_account=${refreshedAccountId} file=${vaultFilePath.split('/').pop() ?? vaultFilePath} action=save-as-new-profile`,
        { level: 'warn' },
      )
      const poolBefore = getPoolStatus()
      const wasActive =
        poolBefore.activeIndex >= 0 &&
        poolBefore.accounts[poolBefore.activeIndex]?.accountId === accountId
      const mainLease = getCodexLeaseForOwner('main-thread')
      const wasMain = mainLease?.accountId === accountId
      const wasActiveOrMain = wasActive || wasMain

      markAccountDead(
        accountId,
        `Refresh returned different account ${refreshedAccountId}`,
        { rerollActive: false },
      )
      const saved = saveCodexTokenToVault(
        {
          accessToken: newAccessToken,
          refreshToken: newRefreshToken,
          accountId: refreshedAccountId,
          idToken: newIdToken,
          expiresAt,
        },
        {
          writer: 'codex-refresh.refreshAccountTokens.identity-mismatch',
          expectedPreviousAccountId: accountId,
          filePath: join(dirname(vaultFilePath), `${refreshedAccountId}.json`),
          preserveExistingMetadata: false,
        },
      )
      appendAccount(
        {
          accessToken: newAccessToken,
          refreshToken: newRefreshToken,
          idToken: newIdToken,
          expiresAt,
          accountId: refreshedAccountId,
        },
        {
          preserveCapped: true,
          writer: 'codex-refresh.refreshAccountTokens.identity-mismatch',
          source: saved ? 'vault' : 'config',
          vaultFilePath: saved?.filePath,
          activate: wasActiveOrMain,
        },
      )

      if (wasActiveOrMain) {
        setActiveAccountPersisted(refreshedAccountId)
        reassignCodexLeaseToActiveAccount('main-thread')
      }

      emitIdentityMismatchDiagnostic(accountId, refreshedAccountId)

      // Fix 7: Mark old vault reauth_required rather than idle on identity mismatch.
      latest.refresh = {
        state: 'reauth_required',
        refresh_token_hash: refreshTokenHash,
        marked_at: new Date().toISOString(),
        reason: 'identity_mismatch',
      }
      latest.version = (latest.version ?? 0) + 1
      atomicWriteJson(vaultFilePath, latest)

      return {
        accountId: refreshedAccountId,
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
        idToken: newIdToken || '',
        expiresAt,
        status: 'identity_mismatch',
        refreshedAccountId,
      }
    }

    // Normal success
    const tokens = (latest.tokens || {}) as Record<string, unknown>
    tokens.access_token = newAccessToken
    tokens.refresh_token = newRefreshToken
    tokens.account_id = refreshedAccountId
    tokens.expires_at = expiresAt
    if (newIdToken) tokens.id_token = newIdToken
    latest.tokens = tokens
    latest.last_refresh = new Date().toISOString()
    latest.refresh = { state: 'idle' }
    latest.version = (latest.version ?? 0) + 1

    atomicWriteJson(vaultFilePath, latest)

    appendAccount({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      idToken: newIdToken,
      expiresAt,
      accountId: refreshedAccountId,
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
      status: 'refreshed',
    }

  } finally {
    if (releaseLock) {
      await releaseLock().catch(() => {})
    }
  }
}

// ── Touch-all ──────────────────────────────────────────────────────────────

/**
 * Refresh tokens for all unlocked vault accounts.
 * Skips locked accounts. Returns per-account results.
 */
export async function touchAll(): Promise<RefreshResult[]> {
  const vaultPath = getVaultPath()
  if (!vaultPath) return []

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

      if (!tokens?.access_token || !tokens.refresh_token || !tokens.account_id) {
        results.push({
          accountId: file,
          status: 'failed',
          detail: 'Missing required token fields',
        })
        continue
      }

      accountId = String(tokens.account_id)

      // Check lock
      if (isAccountLocked(locksDir, accountId)) {
        results.push({ accountId, status: 'locked', detail: 'Locked by another process' })
        continue
      }

      // Refresh
      const refreshed = await refreshAccountTokens(accountId, String(tokens.refresh_token), filePath)
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
      `${results.filter((r) => r.status === 'failed').length} failed`,
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
    void touchAll()
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
    void runQuarantineProbeOnce()
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

export async function runQuarantineProbeOnce(): Promise<RefreshResult[]> {
  if (quarantineProbeInFlight) return []
  quarantineProbeInFlight = true

  try {
    const now = Date.now()
    const results: RefreshResult[] = []
    const accounts = getPoolStatus().accounts.filter(
      account =>
        account.status === 'quarantined' &&
        Boolean(account.vaultFilePath) &&
        Boolean(account.refreshToken),
    )

    for (const account of accounts) {
      const vaultFilePath = account.vaultFilePath!
      const vault = readVault(vaultFilePath)
      const refreshState = vault.refresh as Record<string, unknown> | undefined
      const nextProbeAt = typeof refreshState?.next_probe_at === 'string'
        ? Date.parse(refreshState.next_probe_at)
        : Number.NaN
      if (Number.isFinite(nextProbeAt) && nextProbeAt > now) {
        continue
      }

      try {
        persistNextQuarantineProbe(vaultFilePath, 'quarantine probe in progress')
        const refreshed = await refreshAccountTokens(
          account.accountId,
          account.refreshToken,
          vaultFilePath,
        )
        results.push({
          accountId: account.accountId,
          status: refreshed.status === 'identity_mismatch' ? 'identity_mismatch' : 'refreshed',
          ...(refreshed.refreshedAccountId
            ? { refreshedAccountId: refreshed.refreshedAccountId }
            : {}),
        })
      } catch (err) {
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
        persistNextQuarantineProbe(vaultFilePath, detail)
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

function persistNextQuarantineProbe(vaultFilePath: string, reason: string): void {
  const vault = readVault(vaultFilePath)
  const refreshState = (vault.refresh ?? {}) as Record<string, unknown>
  if (refreshState.state === 'reauth_required') return

  const previousFailures =
    typeof refreshState.consecutive_failures === 'number' &&
    Number.isFinite(refreshState.consecutive_failures)
      ? refreshState.consecutive_failures
      : 0
  const existingNextProbeAt = typeof refreshState.next_probe_at === 'string'
    ? Date.parse(refreshState.next_probe_at)
    : Number.NaN
  const hasFutureReservation =
    Number.isFinite(existingNextProbeAt) && existingNextProbeAt > Date.now()
  const consecutiveFailures = hasFutureReservation
    ? previousFailures
    : previousFailures + 1
  const backoff =
    QUARANTINE_PROBE_BACKOFF_MS[
      Math.min(consecutiveFailures - 1, QUARANTINE_PROBE_BACKOFF_MS.length - 1)
    ] ?? QUARANTINE_PROBE_BACKOFF_MS[QUARANTINE_PROBE_BACKOFF_MS.length - 1]

  vault.refresh = {
    ...refreshState,
    state: 'unknown',
    failed_at: new Date().toISOString(),
    reason,
    consecutive_failures: consecutiveFailures,
    next_probe_at: hasFutureReservation && typeof refreshState.next_probe_at === 'string'
      ? refreshState.next_probe_at
      : new Date(Date.now() + backoff).toISOString(),
  }
  vault.version = (vault.version ?? 0) + 1
  atomicWriteJson(vaultFilePath, vault)
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = dirname(filePath)
  const tmpPath = join(dir, `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`)
  const json = `${JSON.stringify(data, null, 2)}\n`

  // Fix 8: close fd before unlinking on the error path so the OS can release
  // the file handle on platforms that require it (Windows, some Linux configs).
  let fd: number | undefined
  try {
    fd = openSync(tmpPath, 'w', 0o600)
    writeFileSync(fd, json, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd) } catch {}
      fd = undefined
    }
    try { unlinkSync(tmpPath) } catch {}
    throw err
  } finally {
    // Emergency guard in case an unexpected error leaves fd open.
    if (fd !== undefined) {
      try { closeSync(fd) } catch {}
    }
  }

  renameSync(tmpPath, filePath)

  let dirFd: number | undefined
  try {
    dirFd = openSync(dir, 'r')
    fsyncSync(dirFd)
  } catch {
    // some OSes don't allow openSync(dir)
  } finally {
    if (dirFd !== undefined) closeSync(dirFd)
  }
}
