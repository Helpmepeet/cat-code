import {
  appendAccount,
  initAccountPool,
  getPoolStatus,
  markAccountDead,
  saveCodexTokenToVault,
  setActiveAccountPersisted,
  type PoolAccount,
} from '../services/api/codexAccountPool.js'
import { getCodexLeaseForOwner, reassignCodexLeaseToActiveAccount } from '../services/api/codexAccountLeaseManager.js'
import { refreshCodexToken } from '../services/oauth/codex-client.js'
import { getCodexOAuthTokens, saveCodexOAuthTokens } from '../utils/auth.js'
import { logForDebugging } from '../utils/debug.js'
import { emitAccountDiagnostic } from '../services/api/accountDiagnostics.js'
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

function countCodexPoolStatuses(): Record<string, number> {
  const accounts = getPoolStatus().accounts
  const counts: Record<string, number> = { total: accounts.length }
  for (const account of accounts) {
    counts[account.status] = (counts[account.status] ?? 0) + 1
  }
  return counts
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
        expiresAt: refreshed.expiresAt,
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
      // Live pool reconciliation: mark the old account dead and append the
      // refreshed identity so subsequent selection does not keep returning
      // the stale account record. The vault was already written above; do not
      // write it a second time here.
      const poolBefore = getPoolStatus()
      const wasActive =
        poolBefore.activeIndex >= 0 &&
        poolBefore.accounts[poolBefore.activeIndex]?.accountId === account.accountId
      const mainLease = getCodexLeaseForOwner('main-thread')
      const wasMain = mainLease?.accountId === account.accountId

      markAccountDead(
        account.accountId,
        `Refresh returned different account ${refreshed.accountId}`,
        { rerollActive: false },
      )
      appendAccount(
        {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          idToken: refreshed.idToken || undefined,
          expiresAt: refreshed.expiresAt,
          accountId: refreshed.accountId,
        },
        {
          preserveCapped: true,
          writer: 'codex-core.maybeRefreshAccount.identity-mismatch',
          source: account.source === 'config' ? 'config' : 'vault',
          vaultFilePath: savedVaultPath,
          activate: wasActive || wasMain,
        },
      )
      if (wasActive || wasMain) {
        setActiveAccountPersisted(refreshed.accountId)
        reassignCodexLeaseToActiveAccount('main-thread')
      }
      emitAccountDiagnostic({
        code: 'account.identity_mismatch',
        severity: 'warning',
        provider: 'openai',
        pool: 'codex',
        recoverable: true,
        from_account_ref: account.accountId,
        account_ref: refreshed.accountId,
        reason: `refresh returned different account ${refreshed.accountId}`,
        counts: countCodexPoolStatuses(),
      })
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
