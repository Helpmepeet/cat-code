import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

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
  let scratchConfigDir: string
  let previousConfigDir: string | undefined

  beforeEach(async () => {
    // The raw-refresh lock + attempt ledger live under the config home
    // (accounts.ts DR-2 section). Isolate them per test so unit runs never
    // touch the real ~/.cat-code and never see a prior run's ledger state.
    // getClaudeConfigHomeDir memoizes KEYED on this env var, so a fresh value
    // takes effect immediately.
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    scratchConfigDir = mkdtempSync(join(tmpdir(), 'codex-core-accounts-test-'))
    process.env.CLAUDE_CONFIG_DIR = scratchConfigDir
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    realPoolModule = { ...require('../services/api/codexAccountPool.js') }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    realOAuthModule = { ...require('../services/oauth/codex-client.js') }
    resetCodexAccountPoolForTest()
    resetCodexLeaseManagerForTest()
    _resetAccountDiagnosticStreamJsonHookForTesting()
  })

  afterEach(async () => {
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    }
    rmSync(scratchConfigDir, { recursive: true, force: true })
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

  test('vault persist failure returns in-memory tokens and records unknown in the attempt ledger', async () => {
    await mock.module('../services/api/codexAccountPool.js', () => ({
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      ...(require('../services/api/codexAccountPool.js') as Record<string, unknown>),
      initAccountPool: async () => {},
      // null = write failure (the only case saveCodexTokenToVault returns null)
      saveCodexTokenToVault: () => null,
    }))
    await mock.module('../services/oauth/codex-client.js', () => ({
      refreshCodexToken: async () => ({
        accessToken: 'rotated-access',
        refreshToken: 'rotated-refresh',
        expiresAt: Date.now() + 3600_000,
        accountId: OLD_ACCOUNT_ID,
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
          vaultFilePath: '/fake/vault/does-not-exist.json',
          expiresAt: 0,
        }),
      ],
    })

    const { resolveCodexCoreAccount } = await import('./accounts.js')
    // The rotation succeeded server-side; the caller must still get the live
    // tokens even though disk could not be updated…
    const account = await resolveCodexCoreAccount('main')
    expect(account.accessToken).toBe('rotated-access')
    expect(account.refreshToken).toBe('rotated-refresh')

    // …and the durable ledger must warn the NEXT process that the on-disk
    // token may be burned (state=unknown → probe once, don't trust the store).
    const ledger = JSON.parse(
      readFileSync(join(scratchConfigDir, 'codex-raw-refresh.state.json'), 'utf-8'),
    ) as { accounts: Record<string, { state: string; reason?: string }> }
    expect(ledger.accounts[OLD_ACCOUNT_ID]?.state).toBe('unknown')
    expect(ledger.accounts[OLD_ACCOUNT_ID]?.reason).toBe('persist_failed')
  })

  test('a reauth_required ledger tombstone fails fast without spending the token', async () => {
    let refreshCalls = 0
    await mock.module('../services/api/codexAccountPool.js', () => ({
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      ...(require('../services/api/codexAccountPool.js') as Record<string, unknown>),
      initAccountPool: async () => {},
    }))
    await mock.module('../services/oauth/codex-client.js', () => ({
      refreshCodexToken: async () => {
        refreshCalls++
        throw new Error('must not be called: token chain is terminally dead')
      },
    }))

    seedCodexAccountPoolForTest({
      activeAccountId: OLD_ACCOUNT_ID,
      accounts: [
        buildPoolAccount({
          accountId: OLD_ACCOUNT_ID,
          refreshToken: 'burned-refresh',
          alias: 'main',
          source: 'vault',
          vaultFilePath: '/fake/vault/does-not-exist.json',
          expiresAt: 0,
        }),
      ],
    })

    // Simulate a prior process's terminal verdict for this exact token.
    const { createHash } = await import('crypto')
    const { writeFileSync } = await import('fs')
    writeFileSync(
      join(scratchConfigDir, 'codex-raw-refresh.state.json'),
      JSON.stringify({
        version: 1,
        accounts: {
          [OLD_ACCOUNT_ID]: {
            state: 'reauth_required',
            refreshTokenHash: createHash('sha256').update('burned-refresh').digest('hex'),
            attemptId: 'prior-attempt',
            updatedAt: new Date().toISOString(),
            reason: 'identity_mismatch',
            rotatedToAccountId: NEW_ACCOUNT_ID,
          },
        },
      }),
    )

    const { resolveCodexCoreAccount } = await import('./accounts.js')
    await expect(resolveCodexCoreAccount('main')).rejects.toThrow('Please re-login')
    expect(refreshCalls).toBe(0)
  })
})
