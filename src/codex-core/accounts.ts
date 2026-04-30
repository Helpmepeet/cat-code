import {
  initAccountPool,
  getPoolStatus,
  saveCodexTokenToVault,
  type PoolAccount,
} from '../services/api/codexAccountPool.js'
import { refreshCodexToken } from '../services/oauth/codex-client.js'
import { getCodexOAuthTokens, saveCodexOAuthTokens } from '../utils/auth.js'
import { logForDebugging } from '../utils/debug.js'
import { CodexCoreError } from './errors.js'

export type CodexCoreAccount = {
  accountId: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  profile: string
  source: PoolAccount['source'] | 'config'
  alias?: string
  vaultFilePath?: string
}

const TOKEN_REFRESH_SKEW_MS = 60_000

export async function resolveCodexCoreAccount(
  accountProfile: string,
): Promise<CodexCoreAccount> {
  const profile = accountProfile.trim()
  if (!profile) {
    throw new CodexCoreError('invalid_request', 'accountProfile is required')
  }

  await initAccountPool()

  const poolStatus = getPoolStatus()
  const match = findAccount(poolStatus.accounts, profile)
  if (match) {
    if (match.status === 'capped') {
      throw new CodexCoreError(
        'quota',
        `Codex account "${profile}" is capped or not eligible: ${match.lastError ?? match.accountId}`,
        { status: 429 },
      )
    }
    if (match.status === 'dead') {
      throw new CodexCoreError(
        'auth',
        `Codex account "${profile}" cannot be used: ${match.lastError ?? 'token is expired'}`,
        { status: 401 },
      )
    }
    return maybeRefreshAccount({
      accountId: match.accountId,
      accessToken: match.accessToken,
      refreshToken: match.refreshToken,
      expiresAt: match.expiresAt,
      profile,
      source: match.source,
      alias: match.alias,
      vaultFilePath: match.vaultFilePath,
    })
  }

  const configTokens = getCodexOAuthTokens()
  if (configTokens && matchesProfile(profile, configTokens.accountId, undefined)) {
    return maybeRefreshAccount({
      accountId: configTokens.accountId,
      accessToken: configTokens.accessToken,
      refreshToken: configTokens.refreshToken,
      expiresAt: configTokens.expiresAt,
      profile,
      source: 'config',
    })
  }

  throw new CodexCoreError(
    'account_not_found',
    `No Codex account/profile matched "${profile}". Use an account alias or account ID prefix.`,
  )
}

function findAccount(
  accounts: readonly PoolAccount[],
  profile: string,
): PoolAccount | undefined {
  const exact = accounts.find(account => matchesProfile(profile, account.accountId, account.alias, true))
  if (exact) return exact
  return accounts.find(account => matchesProfile(profile, account.accountId, account.alias))
}

function matchesProfile(
  profile: string,
  accountId: string,
  alias?: string,
  exact = false,
): boolean {
  const lower = profile.toLowerCase()
  const lowerId = accountId.toLowerCase()
  const lowerAlias = alias?.toLowerCase()
  if (exact) {
    return lower === lowerId || lower === lowerAlias
  }
  return lowerId.startsWith(lower) || lowerAlias?.startsWith(lower) === true
}

async function maybeRefreshAccount(
  account: CodexCoreAccount,
): Promise<CodexCoreAccount> {
  if (!account.refreshToken) {
    return account
  }
  if (account.expiresAt && account.expiresAt - Date.now() > TOKEN_REFRESH_SKEW_MS) {
    return account
  }

  try {
    logForDebugging(
      `[codex-profile] core-refresh-start writer=codex-core.maybeRefreshAccount profile=${account.profile} account=${account.accountId} source=${account.source} expires_at=${String(account.expiresAt)}`,
    )
    const refreshed = await refreshCodexToken(account.refreshToken)
    const sameAccount = refreshed.accountId === account.accountId
    let savedVaultPath = account.vaultFilePath
    const next = {
      accountId: refreshed.accountId,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
      profile: account.profile,
      source: account.source,
      alias: sameAccount ? account.alias : undefined,
      vaultFilePath: sameAccount ? account.vaultFilePath : undefined,
    }
    if (account.source === 'config') {
      saveCodexOAuthTokens(refreshed)
    } else {
      const saved = saveCodexTokenToVault({
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        accountId: refreshed.accountId,
        alias: sameAccount ? account.alias : undefined,
      }, {
        writer: 'codex-core.maybeRefreshAccount',
        expectedPreviousAccountId: account.accountId,
      })
      savedVaultPath = saved?.filePath
      next.vaultFilePath = sameAccount ? savedVaultPath : undefined
    }
    if (!sameAccount) {
      logForDebugging(
        `[codex-profile] identity-mismatch writer=codex-core.maybeRefreshAccount profile=${account.profile} before_account=${account.accountId} after_account=${refreshed.accountId} action=do-not-transfer-alias`,
        { level: 'warn' },
      )
    }
    logForDebugging(
      `[codex-profile] core-refresh-done writer=codex-core.maybeRefreshAccount profile=${account.profile} before_account=${account.accountId} after_account=${refreshed.accountId} result=${sameAccount ? 'same-account' : 'changed-account'}`,
    )
    return next
  } catch (error) {
    throw new CodexCoreError(
      'auth',
      `Failed to refresh Codex account "${account.profile}". Please re-login.`,
      { status: 401, cause: error },
    )
  }
}
