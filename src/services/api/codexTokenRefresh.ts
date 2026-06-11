/**
 * Codex OAuth token refresh, touch-all orchestration, and periodic timer.
 *
 * Replaces the Python codex-nootp tool's token refresh functionality.
 * Refreshes tokens via POST to auth.openai.com/oauth/token.
 * Refresh tokens rotate — the old one becomes invalid after each use.
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'

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
}

type RefreshAccountTokensResult = {
  accessToken: string
  refreshToken: string
  idToken: string
  status: 'refreshed' | 'identity_mismatch'
  refreshedAccountId?: string
}

const pendingRefreshesByAccountId = new Map<
  string,
  Promise<RefreshAccountTokensResult>
>()

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

  const refresh = refreshAccountTokensImpl(
    accountId,
    refreshToken,
    vaultFilePath,
  ).finally(() => {
    pendingRefreshesByAccountId.delete(accountId)
  })
  pendingRefreshesByAccountId.set(accountId, refresh)
  return refresh
}

async function refreshAccountTokensImpl(
  accountId: string,
  refreshToken: string,
  vaultFilePath: string,
): Promise<RefreshAccountTokensResult> {
  logForDebugging(
    `[codex-profile] refresh-start writer=codex-refresh.refreshAccountTokens account=${accountId} file=${vaultFilePath.split('/').pop() ?? vaultFilePath}`,
  )
  const response = await globalThis.fetch(TOKEN_REFRESH_URL, {
    method: 'POST',
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

  if (!response.ok) {
    const body = await response.text()
    let errorCode = `HTTP ${response.status}`
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>
      errorCode = String(parsed.error || errorCode)
    } catch {}

    const knownErrors: Record<string, string> = {
      refresh_token_expired: 'Refresh token expired — re-login required',
      refresh_token_reused: 'Refresh token already rotated — vault may be stale',
      refresh_token_invalidated: 'Token invalidated server-side — re-login required',
    }
    const reason = knownErrors[errorCode] || `Token refresh failed: ${errorCode}`
    markAccountDead(accountId, reason)
    throw new Error(reason)
  }

  const data = (await response.json()) as Record<string, unknown>
  const newAccessToken = data.access_token as string | undefined
  const newRefreshToken = data.refresh_token as string | undefined
  const newIdToken = data.id_token as string | undefined

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

  const sameAccount = refreshedAccountId === accountId
  const expiresAt = parseExpiresAt(data)
  if (!sameAccount) {
    logForDebugging(
      `[codex-profile] identity-mismatch writer=codex-refresh.refreshAccountTokens before_account=${accountId} after_account=${refreshedAccountId} file=${vaultFilePath.split('/').pop() ?? vaultFilePath} action=save-as-new-profile`,
      { level: 'warn' },
    )
    // Snapshot whether the old account was active or held the main lease before
    // we mark it dead — markAccountDead may reroll activeIndex away from it.
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

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      idToken: newIdToken || '',
      status: 'identity_mismatch',
      refreshedAccountId,
    }
  }

  // Update vault file atomically
  const nowIso = new Date().toISOString()
  try {
    const existing = JSON.parse(readFileSync(vaultFilePath, 'utf-8')) as Record<string, unknown>
    const tokens = (existing.tokens || {}) as Record<string, unknown>
    tokens.access_token = newAccessToken
    tokens.refresh_token = newRefreshToken
    tokens.account_id = refreshedAccountId
    tokens.expires_at = expiresAt
    if (newIdToken) tokens.id_token = newIdToken
    existing.tokens = tokens
    existing.last_refresh = nowIso
    atomicWriteJson(vaultFilePath, existing)
  } catch (err) {
    logForDebugging(
      `[codex-refresh] Failed to update vault file for ${accountId}: ${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
    // Token was refreshed server-side even if we fail to persist — the old
    // refresh_token is now invalid. Mark dead so we don't try the stale token.
    const reason = 'Refresh succeeded but vault write failed'
    markAccountDead(accountId, reason)
    throw err
  }

  // Update in-memory pool
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
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
    idToken: newIdToken || '',
    status: 'refreshed',
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

      const accountId = String(tokens.account_id)

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
      const accountId = file.replace('.json', '')
      results.push({
        accountId,
        status: 'failed',
        detail: err instanceof Error ? err.message : String(err),
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

// ── Helpers ────────────────────────────────────────────────────────────────

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = dirname(filePath)
  const tmpPath = join(dir, `.${Date.now()}.${process.pid}.tmp`)
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
    renameSync(tmpPath, filePath)
  } catch (err) {
    try {
      unlinkSync(tmpPath)
    } catch {}
    throw err
  }
}
