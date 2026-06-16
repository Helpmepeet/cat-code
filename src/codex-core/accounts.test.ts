import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import type { SDKAccountDiagnosticMessage } from '../entrypoints/sdk/coreTypes.generated.js'
import { getGlobalConfig } from '../utils/config.js'
import {
  _resetAccountDiagnosticStreamJsonHookForTesting,
  installStreamJsonAccountDiagnosticHook,
} from '../services/api/accountDiagnostics.js'
import {
  getPoolStatus,
  resetCodexAccountPoolForTest,
  seedCodexAccountPoolForTest,
  type PoolAccount,
} from '../services/api/codexAccountPool.js'
import {
  getCodexLeaseForOwner,
  resetCodexLeaseManagerForTest,
  seedCodexLeaseForTest,
} from '../services/api/codexAccountLeaseManager.js'

const OLD_ACCOUNT_ID = '78c15115-7a20-4568-9aec-cfa886dd71ae'
const NEW_ACCOUNT_ID = '80ef361d-5bdc-411f-8bd1-a8fe2a0f18b3'

function buildPoolAccount(
  overrides: Partial<PoolAccount> & Pick<PoolAccount, 'accountId'>,
): PoolAccount {
  return {
    accountId: overrides.accountId,
    accessToken: overrides.accessToken ?? `access-${overrides.accountId}`,
    refreshToken: overrides.refreshToken ?? `refresh-${overrides.accountId}`,
    expiresAt: overrides.expiresAt ?? 0,
    source: overrides.source ?? 'vault',
    status: overrides.status ?? 'healthy',
    lastUsedAt: overrides.lastUsedAt ?? 0,
    alias: overrides.alias,
    vaultFilePath: overrides.vaultFilePath,
  }
}

describe('codex-core/accounts identity mismatch reconciliation', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let realPoolModule: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let realOAuthModule: any

  beforeEach(async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    realPoolModule = { ...require('../services/api/codexAccountPool.js') }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    realOAuthModule = { ...require('../services/oauth/codex-client.js') }
    resetCodexAccountPoolForTest()
    resetCodexLeaseManagerForTest()
    _resetAccountDiagnosticStreamJsonHookForTesting()
  })

  afterEach(async () => {
    // Restore the real modules so subsequent test files see unmodified exports.
    await mock.module('../services/api/codexAccountPool.js', () => ({
      ...realPoolModule,
    }))
    await mock.module('../services/oauth/codex-client.js', () => ({
      ...realOAuthModule,
    }))
    mock.restore()
    resetCodexLeaseManagerForTest()
    _resetAccountDiagnosticStreamJsonHookForTesting()
  })

  test('identity mismatch marks old pool account dead, appends replacement, writes vault once, emits diagnostic', async () => {
    const saveCalls: Array<Record<string, unknown>> = []
    let realPool: Record<string, unknown>

    await mock.module('../services/api/codexAccountPool.js', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      realPool = require('../services/api/codexAccountPool.js') as Record<string, unknown>
      return {
        ...realPool,
        initAccountPool: async () => {},
        saveCodexTokenToVault: (tokens: Record<string, unknown>, options: Record<string, unknown> = {}) => {
          saveCalls.push({ tokens, options })
          return {
            filePath: `/fake/vault/${String(tokens.accountId)}.json`,
            existed: false,
            metadataAction: 'created',
            accountChanged: false,
          }
        },
      }
    })

    await mock.module('../services/oauth/codex-client.js', () => ({
      refreshCodexToken: async () => ({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresAt: Date.now() + 3600_000,
        accountId: NEW_ACCOUNT_ID,
      }),
    }))

    seedCodexAccountPoolForTest({
      activeAccountId: OLD_ACCOUNT_ID,
      accounts: [
        buildPoolAccount({
          accountId: OLD_ACCOUNT_ID,
          refreshToken: 'old-refresh',
          alias: 'main',
          source: 'vault',
          vaultFilePath: '/fake/vault/old.json',
          expiresAt: 0,
        }),
      ],
    })

    const emitted: SDKAccountDiagnosticMessage[] = []
    installStreamJsonAccountDiagnosticHook({
      emit: msg => {
        emitted.push(msg)
      },
      getSessionId: () => 'test-session',
    })

    const { resolveCodexCoreAccount } = await import('./accounts.js')
    const account = await resolveCodexCoreAccount('main')
    expect(account.accountId).toBe(NEW_ACCOUNT_ID)

    const pool = getPoolStatus()
    const oldPoolAcct = pool.accounts.find(a => a.accountId === OLD_ACCOUNT_ID)
    const newPoolAcct = pool.accounts.find(a => a.accountId === NEW_ACCOUNT_ID)
    expect(oldPoolAcct?.status).toBe('dead')
    expect(newPoolAcct).toBeDefined()
    expect(newPoolAcct?.accessToken).toBe('new-access')
    // Real future expiry, not Date.now().
    expect((newPoolAcct?.expiresAt ?? 0)).toBeGreaterThan(Date.now() + 60_000)

    // Single vault write — the refresh path already wrote the new vault file.
    expect(saveCalls).toHaveLength(1)
    expect((saveCalls[0]?.tokens as Record<string, unknown>).accountId).toBe(NEW_ACCOUNT_ID)

    const codes = emitted.map(m => m.code)
    expect(codes).toContain('account.identity_mismatch')
  })

  test('active main identity mismatch activates replacement instead of backup account', async () => {
    const saveCalls: Array<Record<string, unknown>> = []
    let realPool: Record<string, unknown>

    await mock.module('../services/api/codexAccountPool.js', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      realPool = require('../services/api/codexAccountPool.js') as Record<string, unknown>
      return {
        ...realPool,
        initAccountPool: async () => {},
        saveCodexTokenToVault: (tokens: Record<string, unknown>, options: Record<string, unknown> = {}) => {
          saveCalls.push({ tokens, options })
          return {
            filePath: `/fake/vault/${String(tokens.accountId)}.json`,
            existed: false,
            metadataAction: 'created',
            accountChanged: false,
          }
        },
      }
    })

    await mock.module('../services/oauth/codex-client.js', () => ({
      refreshCodexToken: async () => ({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresAt: Date.now() + 3600_000,
        accountId: NEW_ACCOUNT_ID,
      }),
    }))

    seedCodexAccountPoolForTest({
      activeAccountId: OLD_ACCOUNT_ID,
      accounts: [
        buildPoolAccount({
          accountId: OLD_ACCOUNT_ID,
          refreshToken: 'old-refresh',
          alias: 'main',
          source: 'vault',
          vaultFilePath: '/fake/vault/old.json',
          expiresAt: 0,
        }),
        buildPoolAccount({
          accountId: '11111111-aaaa-bbbb-cccc-222222222222',
          alias: 'backup',
          source: 'vault',
          vaultFilePath: '/fake/vault/backup.json',
          expiresAt: Date.now() + 3600_000,
        }),
      ],
    })
    seedCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'Main thread',
      accountId: OLD_ACCOUNT_ID,
      strategy: 'follow-main',
    })

    const emitted: SDKAccountDiagnosticMessage[] = []
    installStreamJsonAccountDiagnosticHook({
      emit: msg => {
        emitted.push(msg)
      },
      getSessionId: () => 'core-active-identity-mismatch-session',
    })

    const { resolveCodexCoreAccount } = await import('./accounts.js')
    const account = await resolveCodexCoreAccount('main')
    expect(account.accountId).toBe(NEW_ACCOUNT_ID)

    const pool = getPoolStatus()
    const active = pool.accounts[pool.activeIndex]
    expect(active?.accountId).toBe(NEW_ACCOUNT_ID)
    expect(getCodexLeaseForOwner('main-thread')?.accountId).toBe(NEW_ACCOUNT_ID)
    expect(getGlobalConfig().activeCodexAccountId).toBe(NEW_ACCOUNT_ID)
    expect(emitted.map(message => message.code)).not.toContain('account.active.reroll')
    expect(saveCalls).toHaveLength(1)
  })

  test('dead account resolution does not expose raw refresh state reason', async () => {
    await mock.module('../services/api/codexAccountPool.js', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return {
        ...(require('../services/api/codexAccountPool.js') as Record<string, unknown>),
        initAccountPool: async () => {},
      }
    })

    seedCodexAccountPoolForTest({
      activeAccountId: OLD_ACCOUNT_ID,
      accounts: [
        {
          ...buildPoolAccount({
            accountId: OLD_ACCOUNT_ID,
            alias: 'raw401',
            status: 'dead',
          }),
          statusReason: 'auth_dead',
          lastError: 'http_401',
        },
      ],
    })

    const { resolveCodexCoreAccount } = await import('./accounts.js')

    await expect(resolveCodexCoreAccount('raw401')).rejects.toThrow(
      'Codex account "raw401" cannot be used: Token refresh failed: HTTP 401',
    )
    await expect(resolveCodexCoreAccount('raw401')).rejects.not.toThrow('http_401')
  })
})
