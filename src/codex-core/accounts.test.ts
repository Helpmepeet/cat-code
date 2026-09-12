import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { SDKAccountDiagnosticMessage } from '../entrypoints/sdk/coreTypes.generated.js'
import {
  clearCodexOAuthTokens,
  getCodexOAuthTokens,
  saveCodexOAuthTokens,
} from '../utils/auth.js'
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
import {
  createCodexCredentialLifecycle,
  type CodexCredentialLifecycle,
} from '../services/api/codexCredentialLifecycle.js'

const OLD_ACCOUNT_ID = '78c15115-7a20-4568-9aec-cfa886dd71ae'
const NEW_ACCOUNT_ID = '80ef361d-5bdc-411f-8bd1-a8fe2a0f18b3'

async function establishCredentialedLifecycle(
  lifecycle: CodexCredentialLifecycle,
  accountId: string,
): Promise<void> {
  await establishCredentialedLifecycleAtGeneration(lifecycle, accountId, 1)
}

async function establishCredentialedLifecycleAtGeneration(
  lifecycle: CodexCredentialLifecycle,
  accountId: string,
  generation: number,
): Promise<void> {
  for (let currentGeneration = 1; currentGeneration <= generation; currentGeneration++) {
    await lifecycle.withTransaction(
      accountId,
      {
        operationKind: 'login',
        operationId: `test-login-${accountId}-${currentGeneration}`,
      },
      permit => {
        const prepared = lifecycle.prepareLogin(permit)
        if (
          prepared.status !== 'applied' ||
          prepared.record.credentialGeneration !== currentGeneration
        ) {
          throw new Error('test lifecycle prepare failed')
        }
        const committed = lifecycle.commitLogin(permit, {
          expectedGeneration: prepared.record.credentialGeneration,
        })
        if (committed.status !== 'applied') {
          throw new Error('test lifecycle commit failed')
        }
      },
    )
  }
}

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
    credentialGeneration: overrides.credentialGeneration ?? 0,
    credentialGenerationState:
      overrides.credentialGenerationState ??
      (overrides.credentialGeneration === undefined ||
      overrides.credentialGeneration === 0
        ? 'legacy_unbound'
        : 'lifecycle_bound'),
    alias: overrides.alias,
    vaultFilePath: overrides.vaultFilePath,
  }
}

describe('codex-core/accounts raw refresh lifecycle fencing', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let realPoolModule: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let realOAuthModule: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let realAuthModule: any
  let scratchConfigDir: string
  let previousConfigDir: string | undefined

  function lifecycleForTest(): CodexCredentialLifecycle {
    return createCodexCredentialLifecycle({
      directory: join(scratchConfigDir, 'codex-credential-lifecycle'),
    })
  }

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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    realAuthModule = { ...require('../utils/auth.js') }
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
    clearCodexOAuthTokens()
    rmSync(scratchConfigDir, { recursive: true, force: true })
    // Restore the real modules so subsequent test files see unmodified exports.
    await mock.module('../services/api/codexAccountPool.js', () => ({
      ...realPoolModule,
    }))
    await mock.module('../services/oauth/codex-client.js', () => ({
      ...realOAuthModule,
    }))
    await mock.module('../utils/auth.js', () => ({
      ...realAuthModule,
    }))
    mock.restore()
    resetCodexLeaseManagerForTest()
    _resetAccountDiagnosticStreamJsonHookForTesting()
  })

  test('identity mismatch marks old account reauth-required without persisting or installing replacement', async () => {
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
          credentialGeneration: 1,
          refreshToken: 'old-refresh',
          alias: 'main',
          source: 'vault',
          vaultFilePath: '/fake/vault/old.json',
          expiresAt: 0,
        }),
      ],
    })
    const lifecycle = lifecycleForTest()
    await establishCredentialedLifecycle(lifecycle, OLD_ACCOUNT_ID)

    const emitted: SDKAccountDiagnosticMessage[] = []
    installStreamJsonAccountDiagnosticHook({
      emit: msg => {
        emitted.push(msg)
      },
      getSessionId: () => 'test-session',
    })

    const { maybeRefreshAccount } = await import('./accounts.js')
    await expect(
      maybeRefreshAccount(
        {
          accountId: OLD_ACCOUNT_ID,
          accessToken: 'old-access',
          refreshToken: 'old-refresh',
          expiresAt: 0,
          credentialGeneration: 1,
          profile: 'main',
          source: 'vault',
          alias: 'main',
          vaultFilePath: '/fake/vault/old.json',
        },
        { lifecycle },
      ),
    ).rejects.toMatchObject({ code: 'auth' })

    const pool = getPoolStatus()
    const oldPoolAcct = pool.accounts.find(a => a.accountId === OLD_ACCOUNT_ID)
    const newPoolAcct = pool.accounts.find(a => a.accountId === NEW_ACCOUNT_ID)
    expect(oldPoolAcct?.status).toBe('dead')
    expect(newPoolAcct).toBeUndefined()

    expect(saveCalls).toHaveLength(0)
    expect(lifecycle.read(OLD_ACCOUNT_ID)).toMatchObject({
      status: 'valid',
      record: {
        state: 'reauth_required',
        credentialGeneration: 2,
      },
    })

    const codes = emitted.map(m => m.code)
    expect(codes).toContain('account.identity_mismatch')
  })

  test('active main identity mismatch leaves the old account in place for explicit login', async () => {
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
          credentialGeneration: 1,
          refreshToken: 'old-refresh',
          alias: 'main',
          source: 'vault',
          vaultFilePath: '/fake/vault/old.json',
          expiresAt: 0,
        }),
        buildPoolAccount({
          accountId: '11111111-aaaa-bbbb-cccc-222222222222',
          credentialGeneration: 2,
          alias: 'backup',
          source: 'vault',
          vaultFilePath: '/fake/vault/backup.json',
          expiresAt: Date.now() + 3600_000,
        }),
      ],
    })
    const lifecycle = lifecycleForTest()
    await establishCredentialedLifecycle(lifecycle, OLD_ACCOUNT_ID)
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

    const { maybeRefreshAccount } = await import('./accounts.js')
    await expect(
      maybeRefreshAccount(
        {
          accountId: OLD_ACCOUNT_ID,
          accessToken: 'old-access',
          refreshToken: 'old-refresh',
          expiresAt: 0,
          credentialGeneration: 1,
          profile: 'main',
          source: 'vault',
          alias: 'main',
          vaultFilePath: '/fake/vault/old.json',
        },
        { lifecycle },
      ),
    ).rejects.toMatchObject({ code: 'auth' })

    const pool = getPoolStatus()
    const active = pool.accounts[pool.activeIndex]
    expect(active?.accountId).toBe(OLD_ACCOUNT_ID)
    expect(getCodexLeaseForOwner('main-thread')?.accountId).toBe(OLD_ACCOUNT_ID)
    expect(emitted.map(message => message.code)).not.toContain('account.active.reroll')
    expect(saveCalls).toHaveLength(0)
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
      'Codex account "raw401": Needs re-login',
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
          credentialGeneration: 1,
          accessToken: 'old-access',
          refreshToken: 'old-refresh',
          alias: 'main',
          source: 'vault',
          vaultFilePath: '/fake/vault/does-not-exist.json',
          expiresAt: 0,
        }),
      ],
    })
    const lifecycle = lifecycleForTest()
    await establishCredentialedLifecycle(lifecycle, OLD_ACCOUNT_ID)

    const { maybeRefreshAccount } = await import('./accounts.js')
    // The rotation succeeded server-side; the caller must still get the live
    // tokens even though disk could not be updated…
    const account = await maybeRefreshAccount(
      {
        accountId: OLD_ACCOUNT_ID,
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: 0,
        credentialGeneration: 1,
        profile: 'main',
        source: 'vault',
        alias: 'main',
        vaultFilePath: '/fake/vault/does-not-exist.json',
      },
      { lifecycle },
    )
    expect(account.accessToken).toBe('rotated-access')
    expect(account.refreshToken).toBe('rotated-refresh')

    // …and the durable ledger must warn the NEXT process that the on-disk
    // token may be burned (state=unknown → probe once, don't trust the store).
    const ledger = JSON.parse(
      readFileSync(join(scratchConfigDir, 'codex-raw-refresh.state.json'), 'utf-8'),
    ) as {
      accounts: Record<string, {
        state: string
        reason?: string
        credentialGeneration?: number
      }>
    }
    expect(ledger.accounts[OLD_ACCOUNT_ID]?.state).toBe('unknown')
    expect(ledger.accounts[OLD_ACCOUNT_ID]?.reason).toBe('persist_failed')
    expect(ledger.accounts[OLD_ACCOUNT_ID]?.credentialGeneration).toBe(1)
    expect(getPoolStatus().accounts[0]?.accessToken).toBe('old-access')
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
          credentialGeneration: 1,
          refreshToken: 'burned-refresh',
          alias: 'main',
          source: 'vault',
          vaultFilePath: '/fake/vault/does-not-exist.json',
          expiresAt: 0,
        }),
      ],
    })
    const lifecycle = lifecycleForTest()
    await establishCredentialedLifecycle(lifecycle, OLD_ACCOUNT_ID)

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
            credentialGeneration: 1,
            refreshTokenHash: createHash('sha256').update('burned-refresh').digest('hex'),
            attemptId: 'prior-attempt',
            updatedAt: new Date().toISOString(),
            reason: 'identity_mismatch',
            rotatedToAccountId: NEW_ACCOUNT_ID,
          },
        },
      }),
    )

    const { maybeRefreshAccount } = await import('./accounts.js')
    await expect(
      maybeRefreshAccount(
        {
          accountId: OLD_ACCOUNT_ID,
          accessToken: 'old-access',
          refreshToken: 'burned-refresh',
          expiresAt: 0,
          credentialGeneration: 1,
          profile: 'main',
          source: 'vault',
          alias: 'main',
          vaultFilePath: '/fake/vault/does-not-exist.json',
        },
        { lifecycle },
      ),
    ).rejects.toMatchObject({ code: 'auth' })
    expect(refreshCalls).toBe(0)
  })

  test('refreshPoolAccountForRedeem writes a raw-branch rotation back to the in-memory pool', async () => {
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
          credentialGeneration: 1,
          accessToken: 'stale-access',
          refreshToken: 'stale-refresh',
          alias: 'main',
          source: 'config',
          expiresAt: 0, // forces the near-expiry refresh through the raw branch
        }),
      ],
    })
    saveCodexOAuthTokens({
      accessToken: 'stale-access',
      refreshToken: 'stale-refresh',
      expiresAt: 0,
      accountId: OLD_ACCOUNT_ID,
      credentialGeneration: 1,
    })
    const lifecycle = lifecycleForTest()
    await establishCredentialedLifecycle(lifecycle, OLD_ACCOUNT_ID)

    const { refreshPoolAccountForRedeem } = await import('./accounts.js')
    const poolAccount = getPoolStatus().accounts.find(a => a.accountId === OLD_ACCOUNT_ID)!
    const outcome = await refreshPoolAccountForRedeem(poolAccount)

    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.accessToken).toBe('rotated-access')
    }
    // The raw refresh branch installs the rotation while its lifecycle
    // transaction is held, so the pool already carries the fresh token.
    const after = getPoolStatus().accounts.find(a => a.accountId === OLD_ACCOUNT_ID)
    expect(after?.accessToken).toBe('rotated-access')
    expect(after?.refreshToken).toBe('rotated-refresh')
    expect(after?.credentialGeneration).toBe(1)
  })

  test('force refreshes a locally-fresh config/no-vault account (post-401 recovery caveat) while the normal path stays gated', async () => {
    let refreshCalls = 0
    await mock.module('../services/oauth/codex-client.js', () => ({
      refreshCodexToken: async (refreshToken: string) => {
        refreshCalls += 1
        expect(refreshToken).toBe('config-refresh-old')
        return {
          accessToken: 'config-access-new',
          refreshToken: 'config-refresh-new',
          expiresAt: Date.now() + 3600_000,
          accountId: OLD_ACCOUNT_ID,
        }
      },
    }))

    const { maybeRefreshAccount } = await import('./accounts.js')
    const { getCodexOAuthTokens } = await import('../utils/auth.js')

    const freshConfigAccount = {
      accountId: OLD_ACCOUNT_ID,
      accessToken: 'config-access-old',
      refreshToken: 'config-refresh-old',
      // Locally fresh — an hour out, far outside the refresh skew. The normal
      // refresh-on-use path must NOT touch it; a post-401 forced refresh
      // (withRetry) must, because a 401 can be a server-side revoke on a token
      // that is still locally valid.
      expiresAt: Date.now() + 3600_000,
      credentialGeneration: 0,
      profile: 'main',
      source: 'config' as const,
    }
    saveCodexOAuthTokens({
      accessToken: 'config-access-old',
      refreshToken: 'config-refresh-old',
      expiresAt: freshConfigAccount.expiresAt,
      accountId: OLD_ACCOUNT_ID,
      credentialGeneration: 0,
    })

    // Gate preserved: the normal path no-ops on a fresh token.
    const unchanged = await maybeRefreshAccount(freshConfigAccount)
    expect(unchanged.accessToken).toBe('config-access-old')
    expect(refreshCalls).toBe(0)

    // Forced: bypasses the expiry gate and routes the config/no-vault account
    // through the raw refresh stack (the caveat: this path previously got no
    // proper refresh on post-401 recovery at all — withRetry only handled
    // vault accounts).
    const refreshed = await maybeRefreshAccount(freshConfigAccount, { force: true })
    expect(refreshCalls).toBe(1)
    expect(refreshed.accountId).toBe(OLD_ACCOUNT_ID)
    expect(refreshed.accessToken).toBe('config-access-new')
    expect(refreshed.refreshToken).toBe('config-refresh-new')
    expect(refreshed.source).toBe('config')
    expect(refreshed.credentialGeneration).toBe(1)

    // The rotation reached the config store (the raw branch's persist target).
    const stored = getCodexOAuthTokens()
    expect(stored?.accessToken).toBe('config-access-new')
    expect(stored?.refreshToken).toBe('config-refresh-new')
    expect(stored?.credentialGeneration).toBe(1)
  })

  test('single-flight shares same-generation work but not different generations', async () => {
    let refreshCalls = 0
    await mock.module('../services/oauth/codex-client.js', () => ({
      refreshCodexToken: async (refreshToken: string) => {
        refreshCalls++
        await Bun.sleep(20)
        return {
          accessToken: `access-${refreshToken}`,
          refreshToken: `next-${refreshToken}`,
          expiresAt: Date.now() + 3600_000,
          accountId: OLD_ACCOUNT_ID,
        }
      },
    }))

    const { maybeRefreshAccount } = await import('./accounts.js')
    const generationOneLifecycle = lifecycleForTest()
    await establishCredentialedLifecycle(generationOneLifecycle, OLD_ACCOUNT_ID)
    saveCodexOAuthTokens({
      accessToken: 'access-generation-one',
      refreshToken: 'refresh-generation-one',
      expiresAt: Date.now() + 1_000,
      accountId: OLD_ACCOUNT_ID,
      credentialGeneration: 1,
    })
    const generationOne = {
      accountId: OLD_ACCOUNT_ID,
      accessToken: 'access-generation-one',
      refreshToken: 'refresh-generation-one',
      expiresAt: 0,
      credentialGeneration: 1,
      profile: 'main',
      source: 'config' as const,
    }

    const sameGeneration = await Promise.all([
      maybeRefreshAccount(generationOne, {
        force: true,
        lifecycle: generationOneLifecycle,
      }),
      maybeRefreshAccount({ ...generationOne, profile: 'backup' }, {
        force: true,
        lifecycle: generationOneLifecycle,
      }),
    ])
    expect(refreshCalls).toBe(1)
    expect(sameGeneration[0]?.refreshToken).toBe('next-refresh-generation-one')
    expect(sameGeneration[1]?.profile).toBe('backup')

    const generationTwoLifecycle = createCodexCredentialLifecycle({
      directory: join(scratchConfigDir, 'codex-credential-lifecycle-generation-two'),
    })
    await establishCredentialedLifecycleAtGeneration(
      generationTwoLifecycle,
      OLD_ACCOUNT_ID,
      2,
    )
    const generationTwo = {
      ...generationOne,
      refreshToken: 'refresh-generation-two',
      credentialGeneration: 2,
    }
    const differentGeneration = await maybeRefreshAccount(generationTwo, {
      force: true,
      lifecycle: generationTwoLifecycle,
    })
    expect(refreshCalls).toBe(2)
    expect(differentGeneration.credentialGeneration).toBe(2)
  })

  test('positive-generation raw refresh requires an exact credentialed lifecycle', async () => {
    let refreshCalls = 0
    await mock.module('../services/oauth/codex-client.js', () => ({
      refreshCodexToken: async () => {
        refreshCalls++
        return {
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
          expiresAt: Date.now() + 3600_000,
          accountId: OLD_ACCOUNT_ID,
        }
      },
    }))

    const { maybeRefreshAccount } = await import('./accounts.js')
    const account = {
      accountId: OLD_ACCOUNT_ID,
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: 0,
      credentialGeneration: 1,
      profile: 'main',
      source: 'config' as const,
    }
    saveCodexOAuthTokens({
      ...account,
      expiresAt: Date.now() + 1_000,
      credentialGeneration: 1,
    })

    const signedOutLifecycle = lifecycleForTest()
    await establishCredentialedLifecycle(signedOutLifecycle, OLD_ACCOUNT_ID)
    await signedOutLifecycle.withTransaction(
      OLD_ACCOUNT_ID,
      { operationKind: 'sign_out', operationId: 'test-sign-out' },
      permit => {
        const result = signedOutLifecycle.signOut(permit, {
          expectedGeneration: 1,
        })
        if (result.status !== 'applied') {
          throw new Error('test sign-out failed')
        }
      },
    )
    await expect(
      maybeRefreshAccount(account, {
        force: true,
        lifecycle: signedOutLifecycle,
      }),
    ).rejects.toMatchObject({ code: 'auth' })
    expect(refreshCalls).toBe(0)

    const mismatchedLifecycle = createCodexCredentialLifecycle({
      directory: join(scratchConfigDir, 'codex-credential-lifecycle-mismatch'),
    })
    await establishCredentialedLifecycleAtGeneration(
      mismatchedLifecycle,
      OLD_ACCOUNT_ID,
      2,
    )
    await expect(
      maybeRefreshAccount(account, {
        force: true,
        lifecycle: mismatchedLifecycle,
      }),
    ).rejects.toMatchObject({ code: 'auth' })
    expect(refreshCalls).toBe(0)

    const malformedLifecycle = createCodexCredentialLifecycle({
      directory: join(scratchConfigDir, 'codex-credential-lifecycle-malformed'),
    })
    mkdirSync(malformedLifecycle.getPaths(OLD_ACCOUNT_ID).directory, {
      recursive: true,
    })
    writeFileSync(
      malformedLifecycle.getPaths(OLD_ACCOUNT_ID).recordPath,
      '{ malformed',
    )
    await expect(
      maybeRefreshAccount(account, {
        force: true,
        lifecycle: malformedLifecycle,
      }),
    ).rejects.toMatchObject({ code: 'auth' })
    expect(refreshCalls).toBe(0)
    expect(getCodexOAuthTokens()?.refreshToken).toBe('old-refresh')
  })

  test('legacy config credentials bind generation one before lifecycle commit', async () => {
    let refreshCalls = 0
    let lifecycleAtNetwork: unknown
    const lifecycle = lifecycleForTest()
    await mock.module('../services/oauth/codex-client.js', () => ({
      refreshCodexToken: async () => {
        refreshCalls++
        lifecycleAtNetwork = lifecycle.read(OLD_ACCOUNT_ID)
        expect(getCodexOAuthTokens()?.credentialGeneration).toBe(1)
        return {
          accessToken: 'legacy-access-new',
          refreshToken: 'legacy-refresh-new',
          expiresAt: Date.now() + 3600_000,
          accountId: OLD_ACCOUNT_ID,
        }
      },
    }))
    saveCodexOAuthTokens({
      accessToken: 'legacy-access',
      refreshToken: 'legacy-refresh',
      expiresAt: Date.now() + 1_000,
      accountId: OLD_ACCOUNT_ID,
      credentialGeneration: 0,
    })

    const { maybeRefreshAccount } = await import('./accounts.js')
    const refreshed = await maybeRefreshAccount(
      {
        accountId: OLD_ACCOUNT_ID,
        accessToken: 'legacy-access',
        refreshToken: 'legacy-refresh',
        expiresAt: 0,
        credentialGeneration: 0,
        profile: 'main',
        source: 'config',
      },
      { force: true, lifecycle },
    )

    expect(refreshCalls).toBe(1)
    expect(lifecycleAtNetwork).toMatchObject({
      status: 'valid',
      record: {
        state: 'credentialed',
        credentialGeneration: 1,
      },
    })
    expect(refreshed.credentialGeneration).toBe(1)
    expect(getCodexOAuthTokens()).toMatchObject({
      accountId: OLD_ACCOUNT_ID,
      refreshToken: 'legacy-refresh-new',
      credentialGeneration: 1,
    })
    expect(lifecycle.read(OLD_ACCOUNT_ID)).toMatchObject({
      status: 'valid',
      record: {
        state: 'credentialed',
        credentialGeneration: 1,
      },
    })
  })

  test('a lifecycle-superseded caller cannot adopt a newer raw credential', async () => {
    let refreshCalls = 0
    await mock.module('../services/oauth/codex-client.js', () => ({
      refreshCodexToken: async () => {
        refreshCalls++
        throw new Error('must not send a superseded refresh')
      },
    }))
    const lifecycle = lifecycleForTest()
    await establishCredentialedLifecycleAtGeneration(
      lifecycle,
      OLD_ACCOUNT_ID,
      2,
    )
    saveCodexOAuthTokens({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: Date.now() + 3600_000,
      accountId: OLD_ACCOUNT_ID,
      credentialGeneration: 2,
    })

    const { maybeRefreshAccount } = await import('./accounts.js')
    await expect(
      maybeRefreshAccount(
        {
          accountId: OLD_ACCOUNT_ID,
          accessToken: 'old-access',
          refreshToken: 'old-refresh',
          expiresAt: 0,
          credentialGeneration: 1,
          profile: 'main',
          source: 'config',
        },
        { force: true, lifecycle },
      ),
    ).rejects.toMatchObject({ code: 'auth' })
    expect(refreshCalls).toBe(0)
    expect(getCodexOAuthTokens()?.refreshToken).toBe('new-refresh')
  })

  test('refresh holds lifecycle lock until persistence and pool installation finish', async () => {
    let resolveNetwork: (() => void) | undefined
    let refreshStarted: (() => void) | undefined
    const networkStarted = new Promise<void>(resolve => {
      refreshStarted = resolve
    })
    await mock.module('../services/oauth/codex-client.js', () => ({
      refreshCodexToken: async () => {
        refreshStarted?.()
        await new Promise<void>(resolve => {
          resolveNetwork = resolve
        })
        return {
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
          expiresAt: Date.now() + 3600_000,
          accountId: OLD_ACCOUNT_ID,
        }
      },
    }))
    const lifecycle = lifecycleForTest()
    await establishCredentialedLifecycle(lifecycle, OLD_ACCOUNT_ID)
    saveCodexOAuthTokens({
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: Date.now() + 1_000,
      accountId: OLD_ACCOUNT_ID,
      credentialGeneration: 1,
    })
    const { maybeRefreshAccount } = await import('./accounts.js')
    const refresh = maybeRefreshAccount(
      {
        accountId: OLD_ACCOUNT_ID,
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: 0,
        credentialGeneration: 1,
        profile: 'main',
        source: 'config',
      },
      { force: true, lifecycle },
    )
    await networkStarted

    let signOutResolved = false
    const signOut = lifecycle.withTransaction(
      OLD_ACCOUNT_ID,
      { operationKind: 'sign_out', operationId: 'wait-for-refresh-sign-out' },
      permit => {
        const result = lifecycle.signOut(permit, { expectedGeneration: 1 })
        if (result.status !== 'applied') {
          throw new Error('test sign-out failed')
        }
        signOutResolved = true
      },
    )
    await Bun.sleep(20)
    expect(signOutResolved).toBe(false)

    resolveNetwork?.()
    const refreshed = await refresh
    await signOut
    expect(refreshed.credentialGeneration).toBe(1)
    expect(signOutResolved).toBe(true)
    expect(lifecycle.read(OLD_ACCOUNT_ID)).toMatchObject({
      status: 'valid',
      record: { state: 'signed_out', credentialGeneration: 2 },
    })
  })

  test('a sign-out holding lifecycle first prevents raw network work', async () => {
    let refreshCalls = 0
    let releaseSignOut: (() => void) | undefined
    const signOutHeld = new Promise<void>(resolve => {
      releaseSignOut = resolve
    })
    await mock.module('../services/oauth/codex-client.js', () => ({
      refreshCodexToken: async () => {
        refreshCalls++
        throw new Error('must not refresh after sign-out')
      },
    }))
    const lifecycle = lifecycleForTest()
    await establishCredentialedLifecycle(lifecycle, OLD_ACCOUNT_ID)
    saveCodexOAuthTokens({
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: Date.now() + 1_000,
      accountId: OLD_ACCOUNT_ID,
      credentialGeneration: 1,
    })
    const signOut = lifecycle.withTransaction(
      OLD_ACCOUNT_ID,
      { operationKind: 'sign_out', operationId: 'held-sign-out' },
      async permit => {
        const result = lifecycle.signOut(permit, { expectedGeneration: 1 })
        if (result.status !== 'applied') {
          throw new Error('test sign-out failed')
        }
        await signOutHeld
      },
    )
    await Bun.sleep(10)

    const { maybeRefreshAccount } = await import('./accounts.js')
    const refresh = maybeRefreshAccount(
      {
        accountId: OLD_ACCOUNT_ID,
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: 0,
        credentialGeneration: 1,
        profile: 'main',
        source: 'config',
      },
      { force: true, lifecycle },
    )
    await Bun.sleep(20)
    expect(refreshCalls).toBe(0)
    releaseSignOut?.()
    await signOut
    await expect(refresh).rejects.toMatchObject({ code: 'auth' })
    expect(refreshCalls).toBe(0)
  })

  test('signed-out and deleted config cannot be resurrected by an old raw caller', async () => {
    let refreshCalls = 0
    await mock.module('../services/oauth/codex-client.js', () => ({
      refreshCodexToken: async () => {
        refreshCalls++
        throw new Error('must not refresh deleted credentials')
      },
    }))
    const lifecycle = lifecycleForTest()
    await establishCredentialedLifecycle(lifecycle, OLD_ACCOUNT_ID)
    saveCodexOAuthTokens({
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: Date.now() + 1_000,
      accountId: OLD_ACCOUNT_ID,
      credentialGeneration: 1,
    })
    await lifecycle.withTransaction(
      OLD_ACCOUNT_ID,
      { operationKind: 'sign_out', operationId: 'delete-after-sign-out' },
      permit => {
        const result = lifecycle.signOut(permit, { expectedGeneration: 1 })
        if (result.status !== 'applied') {
          throw new Error('test sign-out failed')
        }
      },
    )
    clearCodexOAuthTokens()

    const { maybeRefreshAccount } = await import('./accounts.js')
    await expect(
      maybeRefreshAccount(
        {
          accountId: OLD_ACCOUNT_ID,
          accessToken: 'old-access',
          refreshToken: 'old-refresh',
          expiresAt: 0,
          credentialGeneration: 1,
          profile: 'main',
          source: 'config',
        },
        { force: true, lifecycle },
      ),
    ).rejects.toMatchObject({ code: 'auth' })
    expect(refreshCalls).toBe(0)
    expect(getCodexOAuthTokens()).toBeNull()
  })

  test('config write failure records unknown and does not install rotated credentials', async () => {
    let refreshCalls = 0
    saveCodexOAuthTokens({
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: Date.now() + 1_000,
      accountId: OLD_ACCOUNT_ID,
      credentialGeneration: 1,
    })
    await mock.module('../utils/auth.js', () => ({
      ...realAuthModule,
      saveCodexOAuthTokens: () => false,
    }))
    await mock.module('../services/oauth/codex-client.js', () => ({
      refreshCodexToken: async () => {
        refreshCalls++
        return {
          accessToken: 'rotated-access',
          refreshToken: 'rotated-refresh',
          expiresAt: Date.now() + 3600_000,
          accountId: OLD_ACCOUNT_ID,
        }
      },
    }))
    const lifecycle = lifecycleForTest()
    await establishCredentialedLifecycle(lifecycle, OLD_ACCOUNT_ID)
    seedCodexAccountPoolForTest({
      activeAccountId: OLD_ACCOUNT_ID,
      accounts: [
        buildPoolAccount({
          accountId: OLD_ACCOUNT_ID,
          accessToken: 'old-access',
          refreshToken: 'old-refresh',
          expiresAt: 0,
          credentialGeneration: 1,
          source: 'config',
          alias: 'main',
        }),
      ],
    })

    const { maybeRefreshAccount } = await import('./accounts.js')
    const refreshed = await maybeRefreshAccount(
      {
        accountId: OLD_ACCOUNT_ID,
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: 0,
        credentialGeneration: 1,
        profile: 'main',
        source: 'config',
        alias: 'main',
      },
      { force: true, lifecycle },
    )
    expect(refreshCalls).toBe(1)
    expect(refreshed.refreshToken).toBe('rotated-refresh')
    expect(getCodexOAuthTokens()?.refreshToken).toBe('old-refresh')
    expect(getPoolStatus().accounts[0]?.refreshToken).toBe('old-refresh')
    const ledger = JSON.parse(
      readFileSync(join(scratchConfigDir, 'codex-raw-refresh.state.json'), 'utf-8'),
    ) as {
      accounts: Record<string, {
        state: string
        reason?: string
        credentialGeneration?: number
      }>
    }
    expect(ledger.accounts[OLD_ACCOUNT_ID]).toMatchObject({
      state: 'unknown',
      reason: 'persist_failed',
      credentialGeneration: 1,
    })
  })
})
