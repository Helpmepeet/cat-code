import { beforeEach, describe, expect, test } from 'bun:test'

import {
  getPoolStatus,
  resetCodexAccountPoolForTest,
  seedCodexAccountPoolForTest,
  type PoolAccount,
} from './codexAccountPool.js'
import { resetCodexLeaseManagerForTest } from './codexAccountLeaseManager.js'
import {
  _resetAccountDiagnosticStreamJsonHookForTesting,
  installStreamJsonAccountDiagnosticHook,
} from './accountDiagnostics.js'
import { reconcileCodexIdentityMismatch } from './codexIdentityReconciliation.js'

function buildPoolAccount(
  overrides: Partial<PoolAccount> & Pick<PoolAccount, 'accountId'>,
): PoolAccount {
  return {
    accountId: overrides.accountId,
    accessToken: overrides.accessToken ?? `access-${overrides.accountId}`,
    refreshToken: overrides.refreshToken ?? `refresh-${overrides.accountId}`,
    expiresAt: overrides.expiresAt ?? Date.now() + 60_000,
    source: overrides.source ?? 'vault',
    status: overrides.status ?? 'healthy',
    lastUsedAt: overrides.lastUsedAt ?? 0,
    alias: overrides.alias,
    vaultFilePath: overrides.vaultFilePath,
  }
}

describe('reconcileCodexIdentityMismatch', () => {
  beforeEach(() => {
    resetCodexAccountPoolForTest()
    resetCodexLeaseManagerForTest()
    _resetAccountDiagnosticStreamJsonHookForTesting()
  })

  test('marks the old account dead, appends the replacement without alias transfer, and emits a diagnostic', () => {
    const emitted: unknown[] = []
    installStreamJsonAccountDiagnosticHook({
      emit: message => {
        emitted.push(message)
      },
      getSessionId: () => 'identity-reconcile-session',
    })

    seedCodexAccountPoolForTest({
      activeAccountId: 'backup-account',
      accounts: [
        buildPoolAccount({
          accountId: 'old-account',
          alias: 'main',
          source: 'vault',
          vaultFilePath: '/tmp/old-account.json',
        }),
        buildPoolAccount({ accountId: 'backup-account', alias: 'backup' }),
      ],
    })

    const result = reconcileCodexIdentityMismatch({
      oldAccountId: 'old-account',
      newAccountId: 'new-account',
      tokens: {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresAt: Date.now() + 3600_000,
      },
      writer: 'test.identity-mismatch',
      source: 'vault',
      vaultFilePath: '/tmp/new-account.json',
    })

    expect(result.activatedReplacement).toBe(false)
    const pool = getPoolStatus()
    expect(pool.accounts.find(account => account.accountId === 'old-account')?.status).toBe('dead')
    const replacement = pool.accounts.find(account => account.accountId === 'new-account')
    expect(replacement).toMatchObject({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      source: 'vault',
      vaultFilePath: '/tmp/new-account.json',
    })
    expect(replacement?.alias).toBeUndefined()
    expect(pool.accounts[pool.activeIndex]?.accountId).toBe('backup-account')
    const diagnostic = emitted.find(
      message => (message as { code?: string }).code === 'account.identity_mismatch',
    ) as { code?: string; from_account_ref?: string; account_ref?: string } | undefined
    expect(diagnostic).toMatchObject({ code: 'account.identity_mismatch' })
    expect(diagnostic?.from_account_ref).toBeDefined()
    expect(diagnostic?.account_ref).toBeDefined()
    expect(diagnostic?.from_account_ref).not.toBe(diagnostic?.account_ref)
  })
})
