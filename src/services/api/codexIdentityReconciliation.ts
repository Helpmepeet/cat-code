import {
  appendAccount,
  getPoolStatus,
  markAccountDead,
  saveCodexTokenToVault,
  setActiveAccountPersisted,
  type PoolAccount,
} from './codexAccountPool.js'
import {
  getCodexLeaseForOwner,
  reassignCodexLeaseToActiveAccount,
} from './codexAccountLeaseManager.js'
import { emitAccountDiagnostic } from './accountDiagnostics.js'

function countPoolStatuses(): Record<string, number> {
  const accounts = getPoolStatus().accounts
  const counts: Record<string, number> = { total: accounts.length }
  for (const account of accounts) {
    counts[account.status] = (counts[account.status] ?? 0) + 1
  }
  return counts
}

export type CodexIdentityMismatchTokens = {
  accessToken: string
  refreshToken: string
  idToken?: string
  expiresAt: number
}

export type CodexIdentityMismatchVaultSave = {
  filePath?: string
  expectedPreviousAccountId?: string
  preserveExistingMetadata?: boolean
}

export type CodexIdentityMismatchReconciliationOptions = {
  oldAccountId: string
  newAccountId: string
  tokens: CodexIdentityMismatchTokens
  writer: string
  source: PoolAccount['source']
  vaultFilePath?: string
  saveNewVault?: CodexIdentityMismatchVaultSave
}

export function reconcileCodexIdentityMismatch({
  oldAccountId,
  newAccountId,
  tokens,
  writer,
  source,
  vaultFilePath,
  saveNewVault,
}: CodexIdentityMismatchReconciliationOptions): {
  savedVaultFilePath?: string
  activatedReplacement: boolean
} {
  const poolBefore = getPoolStatus()
  const wasActive =
    poolBefore.activeIndex >= 0 &&
    poolBefore.accounts[poolBefore.activeIndex]?.accountId === oldAccountId
  const mainLease = getCodexLeaseForOwner('main-thread')
  const wasMain = mainLease?.accountId === oldAccountId
  const activateReplacement = wasActive || wasMain

  markAccountDead(
    oldAccountId,
    `Refresh returned different account ${newAccountId}`,
    { rerollActive: false },
  )

  const saved = saveNewVault
    ? saveCodexTokenToVault(
        {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          accountId: newAccountId,
          idToken: tokens.idToken,
          expiresAt: tokens.expiresAt,
        },
        {
          writer,
          expectedPreviousAccountId: saveNewVault.expectedPreviousAccountId,
          filePath: saveNewVault.filePath,
          preserveExistingMetadata: saveNewVault.preserveExistingMetadata,
        },
      )
    : null

  const savedVaultFilePath = saved?.filePath ?? vaultFilePath
  appendAccount(
    {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
      expiresAt: tokens.expiresAt,
      accountId: newAccountId,
    },
    {
      preserveCapped: true,
      writer,
      source: saveNewVault ? (saved ? 'vault' : 'config') : source,
      vaultFilePath: savedVaultFilePath,
      activate: activateReplacement,
    },
  )

  if (activateReplacement) {
    setActiveAccountPersisted(newAccountId)
    reassignCodexLeaseToActiveAccount('main-thread')
  }

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

  return {
    ...(savedVaultFilePath ? { savedVaultFilePath } : {}),
    activatedReplacement: activateReplacement,
  }
}
