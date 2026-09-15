import { beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'

import { getGlobalConfig } from '../../utils/config.js'
import {
  acquireCodexVaultFileLock,
  persistNextQuarantineProbe,
  refreshAccountTokens as refreshAccountTokensImpl,
  runQuarantineProbeOnce,
  touchAll,
} from './codexTokenRefresh.js'
import {
  createCodexCredentialLifecycle,
  type CodexCredentialLifecycle,
} from './codexCredentialLifecycle.js'
import {
  getCodexAccountAvailability,
  getPoolStatus,
  resetCodexAccountPoolForTest,
  seedCodexAccountPoolForTest,
  type PoolAccount,
} from './codexAccountPool.js'
import {
  getCodexLeaseForOwner,
  resetCodexLeaseManagerForTest,
  seedCodexLeaseForTest,
} from './codexAccountLeaseManager.js'
import {
  _resetAccountDiagnosticStreamJsonHookForTesting,
  installStreamJsonAccountDiagnosticHook,
} from './accountDiagnostics.js'

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
    statusReason: overrides.statusReason,
    lastUsedAt: overrides.lastUsedAt ?? 0,
    credentialGeneration: overrides.credentialGeneration ?? 0,
    credentialGenerationState:
      overrides.credentialGenerationState ??
      (overrides.credentialGeneration === undefined ||
      overrides.credentialGeneration === 0
        ? 'legacy_unbound'
        : 'lifecycle_bound'),
    alias: overrides.alias,
    lastError: overrides.lastError,
    usagePrimary: overrides.usagePrimary,
    usageWeekly: overrides.usageWeekly,
    usageAllowed: overrides.usageAllowed,
    usageLimitReached: overrides.usageLimitReached,
    usageFetchedAt: overrides.usageFetchedAt,
    lastErrorAt: overrides.lastErrorAt,
    planType: overrides.planType,
    planExpiresAt: overrides.planExpiresAt,
    lastRefreshIso: overrides.lastRefreshIso,
    vaultFilePath: overrides.vaultFilePath,
  }
}

function createAccessToken(accountId?: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': accountId
        ? { chatgpt_account_id: accountId }
        : {},
    }),
  ).toString('base64url')
  return `${header}.${payload}.signature`
}

function createIdToken(auth: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': auth,
    }),
  ).toString('base64url')
  return `${header}.${payload}.signature`
}

function lifecycleForVault(vaultFilePath: string) {
  return createCodexCredentialLifecycle({
    directory: join(dirname(dirname(vaultFilePath)), 'lifecycle'),
  })
}

type TestRefreshAccountTokensResult = {
  accountId: string
  status: 'refreshed' | 'identity_mismatch'
  accessToken?: string
  refreshToken?: string
  idToken?: string
  expiresAt?: number
  credentialGeneration: number
  refreshedAccountId?: string
}

function refreshAccountTokens(
  accountId: string,
  refreshToken: string,
  vaultFilePath: string,
  credentialGeneration: number,
  lifecycle: CodexCredentialLifecycle = lifecycleForVault(vaultFilePath),
): Promise<TestRefreshAccountTokensResult> {
  return refreshAccountTokensImpl(
    accountId,
    refreshToken,
    vaultFilePath,
    credentialGeneration,
    { lifecycle },
  ) as Promise<TestRefreshAccountTokensResult>
}

async function establishCredentialedLifecycle(
  vaultFilePath: string,
  accountId: string,
): Promise<CodexCredentialLifecycle> {
  const lifecycle = lifecycleForVault(vaultFilePath)
  await lifecycle.withTransaction(
    accountId,
    { operationKind: 'login', operationId: `login-${accountId}` },
    permit => {
      const prepared = lifecycle.prepareLogin(permit)
      if (prepared.status !== 'applied') {
        throw new Error('failed to prepare test lifecycle')
      }
      const committed = lifecycle.commitLogin(permit, {
        expectedGeneration: prepared.record.credentialGeneration,
      })
      if (committed.status !== 'applied') {
        throw new Error('failed to commit test lifecycle')
      }
    },
  )
  return lifecycle
}

async function signOutCredentialedLifecycle(
  lifecycle: CodexCredentialLifecycle,
  accountId: string,
  credentialGeneration: number,
): Promise<void> {
  await lifecycle.withTransaction(
    accountId,
    { operationKind: 'sign_out', operationId: `sign-out-${accountId}` },
    permit => {
      const signedOut = lifecycle.signOut(permit, {
        expectedGeneration: credentialGeneration,
      })
      if (signedOut.status !== 'applied') {
        throw new Error('failed to sign out test lifecycle')
      }
    },
  )
}

async function withVaultAccount<T>(
  accountId: string,
  vault: Record<string, unknown>,
  run: (filePath: string) => Promise<T>,
  poolOverrides: Partial<PoolAccount> = {},
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'codex-refresh-test-'))
  const accountsDir = join(dir, 'accounts')
  mkdirSync(accountsDir, { recursive: true })
  const filePath = join(accountsDir, `${accountId}.json`)
  writeFileSync(filePath, JSON.stringify(vault), 'utf-8')
  seedCodexAccountPoolForTest({
    activeAccountId: accountId,
    accounts: [
      buildPoolAccount({
        accountId,
        refreshToken: 'old-refresh',
        vaultFilePath: filePath,
        ...poolOverrides,
      }),
    ],
  })

  try {
    return await run(filePath)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('codexTokenRefresh identity handling', () => {
  beforeEach(() => {
    resetCodexAccountPoolForTest()
    resetCodexLeaseManagerForTest()
    _resetAccountDiagnosticStreamJsonHookForTesting()
  })

  test('refresh returns identity_mismatch and does not rewrite old profile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-refresh-test-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })

    const oldAccountId = '78c15115-7a20-4568-9aec-cfa886dd71ae'
    const newAccountId = '80ef361d-5bdc-411f-8bd1-a8fe2a0f18b3'
    const oldPath = join(accountsDir, `${oldAccountId}.json`)

    writeFileSync(
      oldPath,
      JSON.stringify(
        {
          tokens: {
            access_token: 'old-access-for-78c',
            refresh_token: 'old-refresh',
            account_id: oldAccountId,
          },
          alias: 'main',
          profile_note: 'keep-old-metadata',
          last_refresh: '2026-04-01T00:00:00.000Z',
        },
        null,
        2,
      ),
      'utf-8',
    )

    seedCodexAccountPoolForTest({
      activeAccountId: oldAccountId,
      accounts: [
        buildPoolAccount({
          accountId: oldAccountId,
          refreshToken: 'old-refresh',
          alias: 'main',
          source: 'vault',
          vaultFilePath: oldPath,
        }),
      ],
    })

    const originalFetch = globalThis.fetch
    const emitted: unknown[] = []
    installStreamJsonAccountDiagnosticHook({
      emit: message => {
        emitted.push(message)
      },
      getSessionId: () => 'identity-mismatch-session',
      createUuid: () => `identity-mismatch-${emitted.length + 1}`,
    })
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          access_token: createAccessToken(newAccountId),
          refresh_token: 'new-refresh-80e',
          id_token: 'id-token-80e',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as typeof globalThis.fetch

    try {
      const result = await refreshAccountTokens(oldAccountId, 'old-refresh', oldPath, 0)
      expect(result.status).toBe('identity_mismatch')
      expect(result.refreshedAccountId).toBe(newAccountId)

      const oldWritten = JSON.parse(readFileSync(oldPath, 'utf-8')) as Record<string, unknown>
      const oldTokens = oldWritten.tokens as Record<string, unknown>
      expect(oldTokens.access_token).toBe('old-access-for-78c')
      expect(oldTokens.refresh_token).toBe('old-refresh')
      expect(oldWritten.alias).toBe('main')

      const newPath = join(accountsDir, `${newAccountId}.json`)
      expect(existsSync(newPath)).toBe(false)

      const pool = getPoolStatus().accounts
      const oldPool = pool.find((a) => a.accountId === oldAccountId)
      const newPool = pool.find((a) => a.accountId === newAccountId)
      expect(oldPool?.status).toBe('dead')
      expect(newPool).toBeUndefined()

      const lifecycle = lifecycleForVault(oldPath)
      const lifecycleRecord = lifecycle.read(oldAccountId)
      expect(lifecycleRecord).toMatchObject({
        status: 'valid',
        record: {
          state: 'reauth_required',
          credentialGeneration: 2,
        },
      })

      const mismatch = emitted.find(
        message => (message as { code?: string }).code === 'account.identity_mismatch',
      )
      expect(mismatch).toMatchObject({
        code: 'account.identity_mismatch',
        from_account_ref: expect.any(String),
        account_ref: expect.any(String),
      })
      expect((mismatch as { from_account_ref?: string }).from_account_ref).not.toBe(
        (mismatch as { account_ref?: string }).account_ref,
      )
    } finally {
      globalThis.fetch = originalFetch
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('refresh updates plan metadata facts from a fresh id_token without restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-refresh-test-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })

    const accountId = '78c15115-7a20-4568-9aec-cfa886dd71ae'
    const filePath = join(accountsDir, `${accountId}.json`)
    writeFileSync(
      filePath,
      JSON.stringify({
        tokens: {
          access_token: 'old-access',
          refresh_token: 'old-refresh',
          account_id: accountId,
        },
        last_refresh: new Date().toISOString(),
      }),
      'utf-8',
    )

    seedCodexAccountPoolForTest({
      activeAccountId: accountId,
      accounts: [
        buildPoolAccount({
          accountId,
          refreshToken: 'old-refresh',
          vaultFilePath: filePath,
          planType: 'plus',
          planExpiresAt: '2020-01-01T00:00:00.000Z',
        }),
      ],
    })

    const freshIdToken = createIdToken({
      chatgpt_plan_type: 'plus',
      chatgpt_subscription_active_until: '2999-01-01T00:00:00.000Z',
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          access_token: createAccessToken(accountId),
          refresh_token: 'new-refresh',
          expires_in: 3600,
          id_token: freshIdToken,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof globalThis.fetch

    try {
      await refreshAccountTokens(accountId, 'old-refresh', filePath, 0)
    } finally {
      globalThis.fetch = originalFetch
      rmSync(dir, { recursive: true, force: true })
    }

    const account = getPoolStatus().accounts[0]!
    expect(account.planExpiresAt).toBe('2999-01-01T00:00:00.000Z')
    expect(getCodexAccountAvailability(account)).toEqual({ kind: 'available' })
  })

  test('refresh same account preserves metadata and updates token fields', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-refresh-test-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })

    const accountId = '78c15115-7a20-4568-9aec-cfa886dd71ae'
    const oldPath = join(accountsDir, `${accountId}.json`)

    writeFileSync(
      oldPath,
      JSON.stringify(
        {
          tokens: {
            access_token: 'old-access',
            refresh_token: 'old-refresh',
            account_id: accountId,
          },
          alias: 'main',
          profile_note: 'keep-me',
          last_refresh: '2026-04-01T00:00:00.000Z',
        },
        null,
        2,
      ),
      'utf-8',
    )

    seedCodexAccountPoolForTest({
      activeAccountId: accountId,
      accounts: [
        buildPoolAccount({
          accountId,
          refreshToken: 'old-refresh',
          alias: 'main',
          source: 'vault',
          vaultFilePath: oldPath,
        }),
      ],
    })

    const originalFetch = globalThis.fetch
    const refreshedAccessToken = createAccessToken(accountId)
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          access_token: refreshedAccessToken,
          refresh_token: 'new-refresh',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as typeof globalThis.fetch

    try {
      const result = await refreshAccountTokens(accountId, 'old-refresh', oldPath, 0)
      expect(result.status).toBe('refreshed')

      const written = JSON.parse(readFileSync(oldPath, 'utf-8')) as Record<string, unknown>
      const tokens = written.tokens as Record<string, unknown>
      expect(tokens.access_token).toBe(refreshedAccessToken)
      expect(tokens.refresh_token).toBe('new-refresh')
      expect(tokens.account_id).toBe(accountId)
      expect(written.alias).toBe('main')
      expect(written.profile_note).toBe('keep-me')
      expect(typeof written.last_refresh).toBe('string')
    } finally {
      globalThis.fetch = originalFetch
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('dedupes concurrent refreshes for the same account without emitting stderr diagnostics', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-refresh-test-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })

    const accountId = '78c15115-7a20-4568-9aec-cfa886dd71ae'
    const oldPath = join(accountsDir, `${accountId}.json`)

    writeFileSync(
      oldPath,
      JSON.stringify(
        {
          tokens: {
            access_token: 'old-access',
            refresh_token: 'old-refresh',
            account_id: accountId,
          },
          alias: 'main',
        },
        null,
        2,
      ),
      'utf-8',
    )

    seedCodexAccountPoolForTest({
      activeAccountId: accountId,
      accounts: [
        buildPoolAccount({
          accountId,
          refreshToken: 'old-refresh',
          alias: 'main',
          source: 'vault',
          vaultFilePath: oldPath,
        }),
      ],
    })

    const originalFetch = globalThis.fetch
    const originalStderrWrite = process.stderr.write
    const stderrChunks: string[] = []
    const refreshedAccessToken = createAccessToken(accountId)
    let fetchCount = 0
    let releaseFetch: (() => void) | undefined
    const fetchGate = new Promise<void>(resolve => {
      releaseFetch = resolve
    })

    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(
        typeof chunk === 'string'
          ? chunk
          : Buffer.from(chunk).toString('utf-8'),
      )
      return true
    }) as typeof process.stderr.write

    globalThis.fetch = (async () => {
      fetchCount += 1
      await fetchGate
      return new Response(
        JSON.stringify({
          access_token: refreshedAccessToken,
          refresh_token: 'new-refresh',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as typeof globalThis.fetch

    try {
      const first = refreshAccountTokens(accountId, 'old-refresh', oldPath, 0)
      const second = refreshAccountTokens(accountId, 'old-refresh', oldPath, 0)
      releaseFetch?.()
      const results = await Promise.all([first, second])

      expect(fetchCount).toBe(1)
      expect(results[0]?.status).toBe('refreshed')
      expect(results[1]).toEqual(results[0])
      expect(stderrChunks).toEqual([])
    } finally {
      globalThis.fetch = originalFetch
      process.stderr.write = originalStderrWrite
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('refresh without account identity fails safely', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-refresh-test-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })

    const accountId = '78c15115-7a20-4568-9aec-cfa886dd71ae'
    const oldPath = join(accountsDir, `${accountId}.json`)

    writeFileSync(
      oldPath,
      JSON.stringify(
        {
          tokens: {
            access_token: 'old-access',
            refresh_token: 'old-refresh',
            account_id: accountId,
          },
          alias: 'main',
          last_refresh: '2026-04-01T00:00:00.000Z',
        },
        null,
        2,
      ),
      'utf-8',
    )

    seedCodexAccountPoolForTest({
      activeAccountId: accountId,
      accounts: [
        buildPoolAccount({
          accountId,
          refreshToken: 'old-refresh',
          alias: 'main',
          source: 'vault',
          vaultFilePath: oldPath,
        }),
      ],
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          access_token: createAccessToken(undefined),
          refresh_token: 'new-refresh',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as typeof globalThis.fetch

    try {
      await expect(refreshAccountTokens(accountId, 'old-refresh', oldPath, 0)).rejects.toThrow(
        'Token refresh response missing account identity',
      )

      const written = JSON.parse(readFileSync(oldPath, 'utf-8')) as Record<string, unknown>
      const tokens = written.tokens as Record<string, unknown>
      expect(tokens.access_token).toBe('old-access')
      expect(tokens.refresh_token).toBe('old-refresh')

      const oldPool = getPoolStatus().accounts.find((a) => a.accountId === accountId)
      expect(oldPool?.status).toBe('dead')
      expect(oldPool?.lastError).toContain('missing account identity')
    } finally {
      globalThis.fetch = originalFetch
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('same-account refresh persists future expiresAt from expires_in', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-refresh-test-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })

    const accountId = '78c15115-7a20-4568-9aec-cfa886dd71ae'
    const oldPath = join(accountsDir, `${accountId}.json`)

    writeFileSync(
      oldPath,
      JSON.stringify(
        {
          tokens: {
            access_token: 'old-access',
            refresh_token: 'old-refresh',
            account_id: accountId,
          },
        },
        null,
        2,
      ),
      'utf-8',
    )

    seedCodexAccountPoolForTest({
      activeAccountId: accountId,
      accounts: [
        buildPoolAccount({
          accountId,
          refreshToken: 'old-refresh',
          source: 'vault',
          vaultFilePath: oldPath,
        }),
      ],
    })

    const originalFetch = globalThis.fetch
    const refreshedAccessToken = createAccessToken(accountId)
    const expiresInSeconds = 3600
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          access_token: refreshedAccessToken,
          refresh_token: 'new-refresh',
          expires_in: expiresInSeconds,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as typeof globalThis.fetch

    const before = Date.now()
    try {
      await refreshAccountTokens(accountId, 'old-refresh', oldPath, 0)
      const acct = getPoolStatus().accounts.find((a) => a.accountId === accountId)
      expect(acct).toBeDefined()
      // expiresAt must be a real future timestamp greater than now + skew.
      expect(acct!.expiresAt).toBeGreaterThan(before + 60_000)
      expect(acct!.expiresAt).toBeLessThanOrEqual(
        Date.now() + expiresInSeconds * 1000 + 1000,
      )

      const written = JSON.parse(readFileSync(oldPath, 'utf-8')) as Record<string, unknown>
      const tokens = written.tokens as Record<string, unknown>
      expect(typeof tokens.expires_at).toBe('number')
      expect(tokens.expires_at).toBeGreaterThan(before + 60_000)
    } finally {
      globalThis.fetch = originalFetch
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('identity mismatch on active+main lease account requires explicit login', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-refresh-test-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })

    const oldAccountId = '78c15115-7a20-4568-9aec-cfa886dd71ae'
    const newAccountId = '80ef361d-5bdc-411f-8bd1-a8fe2a0f18b3'
    const oldPath = join(accountsDir, `${oldAccountId}.json`)
    writeFileSync(
      oldPath,
      JSON.stringify({
        tokens: { access_token: 'old', refresh_token: 'old-refresh', account_id: oldAccountId },
      }),
      'utf-8',
    )

    seedCodexAccountPoolForTest({
      activeAccountId: oldAccountId,
      accounts: [
        buildPoolAccount({ accountId: oldAccountId, refreshToken: 'old-refresh', source: 'vault', vaultFilePath: oldPath }),
        buildPoolAccount({
          accountId: '11111111-aaaa-bbbb-cccc-222222222222',
          alias: 'backup',
          source: 'vault',
          vaultFilePath: join(accountsDir, 'backup.json'),
        }),
      ],
    })
    seedCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'main',
      accountId: oldAccountId,
    })

    const originalFetch = globalThis.fetch
    const emitted: unknown[] = []
    installStreamJsonAccountDiagnosticHook({
      emit: message => {
        emitted.push(message)
      },
      getSessionId: () => 'active-identity-mismatch-session',
      createUuid: () => `active-identity-mismatch-${emitted.length + 1}`,
    })
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          access_token: createAccessToken(newAccountId),
          refresh_token: 'new-refresh',
          expires_in: 1800,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as typeof globalThis.fetch

    try {
      await refreshAccountTokens(oldAccountId, 'old-refresh', oldPath, 0)
      const pool = getPoolStatus()
      const newIdx = pool.accounts.findIndex((a) => a.accountId === newAccountId)
      expect(newIdx).toBe(-1)
      expect(pool.activeIndex).toBe(
        pool.accounts.findIndex(a => a.accountId === oldAccountId),
      )

      const mainLease = getCodexLeaseForOwner('main-thread')
      expect(mainLease?.accountId).toBe(oldAccountId)
      expect(getGlobalConfig().activeCodexAccountId).toBe(oldAccountId)
      expect(emitted.map(message => (message as { code?: string }).code)).not.toContain(
        'account.active.reroll',
      )
    } finally {
      globalThis.fetch = originalFetch
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('identity mismatch on inactive non-main account does not steal active slot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-refresh-test-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })

    const oldAccountId = '78c15115-7a20-4568-9aec-cfa886dd71ae'
    const newAccountId = '80ef361d-5bdc-411f-8bd1-a8fe2a0f18b3'
    const activeAccountId = '11111111-aaaa-bbbb-cccc-222222222222'
    const oldPath = join(accountsDir, `${oldAccountId}.json`)
    writeFileSync(
      oldPath,
      JSON.stringify({
        tokens: { access_token: 'old', refresh_token: 'old-refresh', account_id: oldAccountId },
      }),
      'utf-8',
    )

    seedCodexAccountPoolForTest({
      activeAccountId,
      accounts: [
        buildPoolAccount({ accountId: activeAccountId, source: 'vault' }),
        buildPoolAccount({ accountId: oldAccountId, refreshToken: 'old-refresh', source: 'vault', vaultFilePath: oldPath }),
      ],
    })
    // Main lease lives on the activeAccountId; refreshing oldAccountId must
    // NOT move active or the main lease.
    seedCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'main',
      accountId: activeAccountId,
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          access_token: createAccessToken(newAccountId),
          refresh_token: 'new-refresh',
          expires_in: 1800,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as typeof globalThis.fetch

    try {
      await refreshAccountTokens(oldAccountId, 'old-refresh', oldPath, 0)
      const pool = getPoolStatus()
      const activeIdx = pool.accounts.findIndex((a) => a.accountId === activeAccountId)
      expect(pool.activeIndex).toBe(activeIdx)

      const mainLease = getCodexLeaseForOwner('main-thread')
      expect(mainLease?.accountId).toBe(activeAccountId)
    } finally {
      globalThis.fetch = originalFetch
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('codexTokenRefresh state machine and concurrency', () => {
  beforeEach(() => {
    resetCodexAccountPoolForTest()
    resetCodexLeaseManagerForTest()
  })

  test('a refresh waiter does not recreate a profile deleted under the shared vault lock', async () => {
    const accountId = 'deleted-while-waiting'
    await withVaultAccount(
      accountId,
      {
        tokens: {
          access_token: 'old-access',
          refresh_token: 'old-refresh',
          account_id: accountId,
        },
      },
      async filePath => {
        const releaseDeleteLock = await acquireCodexVaultFileLock(
          filePath,
          () => {},
        )
        const originalFetch = globalThis.fetch
        let fetchCalled = false
        globalThis.fetch = async () => {
          fetchCalled = true
          return new Response()
        }

        try {
          const refresh = refreshAccountTokens(
            accountId,
            'old-refresh',
            filePath,
            0,
          )
          unlinkSync(filePath)
          await releaseDeleteLock()

          await expect(refresh).rejects.toThrow(
            'Codex vault profile no longer exists',
          )
          expect(existsSync(filePath)).toBe(false)
          expect(fetchCalled).toBe(false)
        } finally {
          globalThis.fetch = originalFetch
          if (existsSync(`${filePath}.lock`)) {
            rmSync(`${filePath}.lock`, { recursive: true, force: true })
          }
        }
      },
    )
  })

  test('fetch transport failure quarantines token with unknown refresh outcome', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-refresh-test-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })
    const accountId = 'timeout-test'
    const filePath = join(accountsDir, `${accountId}.json`)

    writeFileSync(filePath, JSON.stringify({
      tokens: { access_token: 'old', refresh_token: 'old-refresh', account_id: accountId }
    }), 'utf-8')

    seedCodexAccountPoolForTest({
      activeAccountId: accountId,
      accounts: [buildPoolAccount({ accountId, refreshToken: 'old-refresh', vaultFilePath: filePath })]
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed')
    }

    try {
      await expect(refreshAccountTokens(accountId, 'old-refresh', filePath, 0)).rejects.toThrow('Token refresh transport error')

      const vault = JSON.parse(readFileSync(filePath, 'utf-8'))
      expect(vault.refresh.state).toBe('unknown')
      expect(vault.refresh.reason).toBe('fetch failed')

      let fetchCalled = false
      globalThis.fetch = async () => { fetchCalled = true; return new Response(JSON.stringify({
        access_token: createAccessToken(accountId),
        refresh_token: 'new-refresh',
      })) }
      await expect(refreshAccountTokens(accountId, 'old-refresh', filePath, 1)).resolves.toMatchObject({
        status: 'refreshed',
      })
      expect(fetchCalled).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('stale in_flight becomes unknown quarantine', async () => {
    const accountId = 'stale-test'
    const crypto = require('crypto')
    const hash = crypto.createHash('sha256').update('old-refresh').digest('hex')

    await withVaultAccount(accountId, {
      tokens: { access_token: 'old', refresh_token: 'old-refresh', account_id: accountId },
      refresh: {
        state: 'in_flight',
        attempt_id: 'old-attempt',
        refresh_token_hash: hash,
        started_at: new Date(Date.now() - 120_000).toISOString(),
        pid: 12345
      }
    }, async (filePath) => {
      const originalFetch = globalThis.fetch
      let fetchCalled = false
      globalThis.fetch = async () => { fetchCalled = true; return new Response() }

      try {
        await expect(refreshAccountTokens(accountId, 'old-refresh', filePath, 0)).rejects.toThrow('Previous token refresh stalled')
        expect(fetchCalled).toBe(false)
        const vault = JSON.parse(readFileSync(filePath, 'utf-8'))
        expect(vault.refresh.state).toBe('unknown')
        expect(vault.refresh.reason).toBe('stale_in_flight')
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })

  test('fresh in_flight blocks without changing state', async () => {
    const accountId = 'fresh-test'
    const crypto = require('crypto')
    const hash = crypto.createHash('sha256').update('old-refresh').digest('hex')

    await withVaultAccount(accountId, {
      tokens: { access_token: 'old', refresh_token: 'old-refresh', account_id: accountId },
      refresh: {
        state: 'in_flight',
        attempt_id: 'fresh-attempt',
        refresh_token_hash: hash,
        started_at: new Date().toISOString(),
        pid: 12345
      }
    }, async (filePath) => {
      const originalFetch = globalThis.fetch
      let fetchCalled = false
      globalThis.fetch = async () => { fetchCalled = true; return new Response() }

      try {
        await expect(refreshAccountTokens(accountId, 'old-refresh', filePath, 0)).rejects.toThrow('Token refresh is already in progress.')
        expect(fetchCalled).toBe(false)
        const vault = JSON.parse(readFileSync(filePath, 'utf-8'))
        expect(vault.refresh.state).toBe('in_flight')
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })

  test('newer token already saved returns new token', async () => {
    const accountId = 'newer-test'
    await withVaultAccount(accountId, {
      tokens: { access_token: 'newer-access', refresh_token: 'newer-refresh', account_id: accountId }
    }, async (filePath) => {
      const originalFetch = globalThis.fetch
      let fetchCalled = false
      globalThis.fetch = async () => { fetchCalled = true; return new Response() }

      try {
        const res = await refreshAccountTokens(accountId, 'old-refresh', filePath, 0)
        expect(res.status).toBe('refreshed')
        expect(res.accessToken).toBe('newer-access')
        expect(res.refreshToken).toBe('newer-refresh')
        expect(fetchCalled).toBe(false)
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })

  test('HTTP invalid_grant does not retry', async () => {
    const accountId = 'invalid-grant-test'
    await withVaultAccount(accountId, {
      tokens: { access_token: 'old', refresh_token: 'old-refresh', account_id: accountId }
    }, async (filePath) => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })

      try {
        await expect(refreshAccountTokens(accountId, 'old-refresh', filePath, 0)).rejects.toThrow('invalid_grant')

        const vault = JSON.parse(readFileSync(filePath, 'utf-8'))
        expect(vault.refresh.state).toBe('reauth_required')
        expect(vault.refresh.reason).toBe('invalid_grant')

        let fetchCalled = false
        globalThis.fetch = async () => { fetchCalled = true; return new Response() }
        await expect(refreshAccountTokens(accountId, 'old-refresh', filePath, 1)).rejects.toThrow(
          'Codex credential lifecycle does not authorize this refresh.',
        )
        expect(fetchCalled).toBe(false)
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })

  test('stored HTTP refresh failure is replayed as user-facing dead reason', async () => {
    const accountId = 'stored-http-failure-test'
    const crypto = require('crypto')
    const hash = crypto.createHash('sha256').update('old-refresh').digest('hex')

    await withVaultAccount(accountId, {
      tokens: { access_token: 'old', refresh_token: 'old-refresh', account_id: accountId },
      refresh: {
        state: 'reauth_required',
        refresh_token_hash: hash,
        marked_at: new Date().toISOString(),
        reason: 'http_401',
      },
    }, async (filePath) => {
      const originalFetch = globalThis.fetch
      let fetchCalled = false
      globalThis.fetch = async () => { fetchCalled = true; return new Response() }

      try {
        await expect(refreshAccountTokens(accountId, 'old-refresh', filePath, 0)).rejects.toThrow('Reauthentication required')
        expect(fetchCalled).toBe(false)
        const account = getPoolStatus().accounts.find((a) => a.accountId === accountId)
        expect(account?.status).toBe('dead')
        expect(account?.lastError).toBe('Token refresh failed: HTTP 401')
        expect(getCodexAccountAvailability(account!).reason).toBe('Token refresh failed: HTTP 401')
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })

  test('success commit requires ownership', async () => {
    const accountId = 'ownership-test'
    await withVaultAccount(accountId, {
      tokens: { access_token: 'old', refresh_token: 'old-refresh', account_id: accountId }
    }, async (filePath) => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = async () => {
        const vault = JSON.parse(readFileSync(filePath, 'utf-8'))
        vault.refresh = { ...vault.refresh, attempt_id: 'stolen-attempt' }
        vault.tokens.credential_generation = 1
        writeFileSync(filePath, JSON.stringify(vault), 'utf-8')

        return new Response(
          JSON.stringify({
            access_token: createAccessToken(accountId),
            refresh_token: 'new-refresh',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }

      try {
        await expect(refreshAccountTokens(accountId, 'old-refresh', filePath, 0)).rejects.toThrow('Lost refresh attempt ownership')
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })
})

// ── Security fix tests ─────────────────────────────────────────────────────

describe('codexTokenRefresh security fixes (confirmed bugs)', () => {
  beforeEach(() => {
    resetCodexAccountPoolForTest()
    resetCodexLeaseManagerForTest()
    _resetAccountDiagnosticStreamJsonHookForTesting()
  })

  // Fix 2: Concurrent-success recovery syncs appendAccount
  test('concurrent-success recovery calls appendAccount with vault tokens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-refresh-test-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })
    const accountId = 'concurrent-recovery-test'
    const filePath = join(accountsDir, `${accountId}.json`)

    const newAccessToken = createAccessToken(accountId)
    const newRefreshToken = 'newer-refresh-token'

    // Vault already has a rotated token (simulates another process having refreshed)
    writeFileSync(filePath, JSON.stringify({
      tokens: {
        access_token: newAccessToken,
        refresh_token: newRefreshToken,
        account_id: accountId,
        expires_at: Date.now() + 3_600_000,
      },
    }), 'utf-8')

    seedCodexAccountPoolForTest({
      activeAccountId: accountId,
      accounts: [buildPoolAccount({ accountId, refreshToken: 'old-refresh', vaultFilePath: filePath })],
    })

    const originalFetch = globalThis.fetch
    let fetchCalled = false
    globalThis.fetch = async () => { fetchCalled = true; return new Response() }

    try {
      const res = await refreshAccountTokens(accountId, 'old-refresh', filePath, 0)
      expect(res.status).toBe('refreshed')
      expect(res.accessToken).toBe(newAccessToken)
      expect(res.refreshToken).toBe(newRefreshToken)
      expect(fetchCalled).toBe(false)

      // The in-memory pool must have been synced with the vault tokens.
      const pool = getPoolStatus().accounts.find((a) => a.accountId === accountId)
      expect(pool?.accessToken).toBe(newAccessToken)
      expect(pool?.refreshToken).toBe(newRefreshToken)
    } finally {
      globalThis.fetch = originalFetch
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Fix 3: in_flight with a different token hash is blocked
  test('in_flight with a different refresh_token_hash throws RefreshAlreadyInFlightError', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-refresh-test-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })
    const accountId = 'diff-hash-inflight-test'
    const filePath = join(accountsDir, `${accountId}.json`)

    // Hash of a *different* refresh token than what we will pass.
    const { createHash } = await import('crypto')
    const differentHash = createHash('sha256').update('some-other-refresh-token').digest('hex')

    writeFileSync(filePath, JSON.stringify({
      tokens: { access_token: 'old', refresh_token: 'old-refresh', account_id: accountId },
      refresh: {
        state: 'in_flight',
        attempt_id: 'other-attempt',
        refresh_token_hash: differentHash,
        started_at: new Date().toISOString(),
        pid: 99999,
      },
    }), 'utf-8')

    seedCodexAccountPoolForTest({
      activeAccountId: accountId,
      accounts: [buildPoolAccount({ accountId, refreshToken: 'old-refresh', vaultFilePath: filePath })],
    })

    const originalFetch = globalThis.fetch
    let fetchCalled = false
    globalThis.fetch = async () => { fetchCalled = true; return new Response() }

    try {
      await expect(
        refreshAccountTokens(accountId, 'old-refresh', filePath, 0)
      ).rejects.toThrow('Token refresh for a different token is in progress.')
      expect(fetchCalled).toBe(false)

      // The existing in_flight state must NOT have been overwritten.
      const vault = JSON.parse(readFileSync(filePath, 'utf-8'))
      expect(vault.refresh.state).toBe('in_flight')
      expect(vault.refresh.attempt_id).toBe('other-attempt')
      expect(vault.refresh.refresh_token_hash).toBe(differentHash)
    } finally {
      globalThis.fetch = originalFetch
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Fix 4a: DNS / definitely-not-sent errors reset vault to idle, no markAccountDead
  test('DNS/offline error resets vault to idle and does not mark account dead', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-refresh-test-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })
    const accountId = 'dns-error-test'
    const filePath = join(accountsDir, `${accountId}.json`)

    writeFileSync(filePath, JSON.stringify({
      tokens: { access_token: 'old', refresh_token: 'old-refresh', account_id: accountId },
    }), 'utf-8')

    seedCodexAccountPoolForTest({
      activeAccountId: accountId,
      accounts: [buildPoolAccount({ accountId, refreshToken: 'old-refresh', vaultFilePath: filePath })],
    })

    const originalFetch = globalThis.fetch
    const dnsError = Object.assign(new Error('getaddrinfo ENOTFOUND auth.openai.com'), { code: 'ENOTFOUND' })
    globalThis.fetch = async () => { throw dnsError }

    try {
      await expect(refreshAccountTokens(accountId, 'old-refresh', filePath, 0)).rejects.toMatchObject({
        transportClass: 'offline',
      })

      const vault = JSON.parse(readFileSync(filePath, 'utf-8'))
      expect(vault.refresh.state).toBe('idle')

      // Account must NOT be marked dead — it was offline, not a bad credential.
      const poolAccount = getPoolStatus().accounts.find((a) => a.accountId === accountId)
      expect(poolAccount?.status).not.toBe('dead')
    } finally {
      globalThis.fetch = originalFetch
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Fix 4b: Ambiguous timeout error sets vault to unknown, no markAccountDead
  test('ambiguous timeout error sets vault state to unknown and does not mark account dead', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-refresh-test-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })
    const accountId = 'timeout-ambiguous-test'
    const filePath = join(accountsDir, `${accountId}.json`)

    writeFileSync(filePath, JSON.stringify({
      tokens: { access_token: 'old', refresh_token: 'old-refresh', account_id: accountId },
    }), 'utf-8')

    seedCodexAccountPoolForTest({
      activeAccountId: accountId,
      accounts: [buildPoolAccount({ accountId, refreshToken: 'old-refresh', vaultFilePath: filePath })],
    })

    const originalFetch = globalThis.fetch
    const timeoutError = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError', code: 'ETIMEDOUT' })
    globalThis.fetch = async () => { throw timeoutError }

    try {
      await expect(
        refreshAccountTokens(accountId, 'old-refresh', filePath, 0)
      ).rejects.toThrow('Token refresh transport error (outcome unknown)')

      const vault = JSON.parse(readFileSync(filePath, 'utf-8'))
      expect(vault.refresh.state).toBe('unknown')
      expect(vault.refresh.reason).toContain('timeout')

      // Account must NOT be immediately marked dead for ambiguous errors.
      const poolAccount = getPoolStatus().accounts.find((a) => a.accountId === accountId)
      expect(poolAccount?.status).not.toBe('dead')
    } finally {
      globalThis.fetch = originalFetch
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Fix 6: Lost ownership with valid newer vault tokens returns success and syncs pool
  test('lost ownership with valid newer vault tokens returns success and syncs pool', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-refresh-test-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })
    const accountId = 'lost-ownership-recovery-test'
    const filePath = join(accountsDir, `${accountId}.json`)

    const newerAccessToken = createAccessToken(accountId)
    const newerRefreshToken = 'newer-refresh-written-by-other-process'

    writeFileSync(filePath, JSON.stringify({
      tokens: { access_token: 'old', refresh_token: 'old-refresh', account_id: accountId },
    }), 'utf-8')

    seedCodexAccountPoolForTest({
      activeAccountId: accountId,
      accounts: [buildPoolAccount({ accountId, refreshToken: 'old-refresh', vaultFilePath: filePath })],
    })

    const originalFetch = globalThis.fetch
    // During fetch, another process "wins" and writes newer tokens, stealing the attempt_id.
    globalThis.fetch = async () => {
      const vault = JSON.parse(readFileSync(filePath, 'utf-8'))
      vault.refresh = { state: 'idle' }
      vault.tokens = {
        access_token: newerAccessToken,
        refresh_token: newerRefreshToken,
        account_id: accountId,
        credential_generation: 1,
        expires_at: Date.now() + 3_600_000,
      }
      writeFileSync(filePath, JSON.stringify(vault), 'utf-8')

      return new Response(
        JSON.stringify({
          access_token: createAccessToken(accountId),
          refresh_token: 'our-refresh-token',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }

    try {
      // Should succeed by falling back to the vault tokens, not throw.
      const res = await refreshAccountTokens(accountId, 'old-refresh', filePath, 0)
      expect(res.status).toBe('refreshed')
      expect(res.accessToken).toBe(newerAccessToken)
      expect(res.refreshToken).toBe(newerRefreshToken)

      // Pool must be synced.
      const poolAccount = getPoolStatus().accounts.find((a) => a.accountId === accountId)
      expect(poolAccount?.accessToken).toBe(newerAccessToken)
      expect(poolAccount?.refreshToken).toBe(newerRefreshToken)
    } finally {
      globalThis.fetch = originalFetch
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Fix 7: Identity mismatch marks old vault reauth_required, not idle
  test('identity mismatch marks old vault reauth_required rather than idle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-refresh-test-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })

    const oldAccountId = 'old-identity-fix7'
    const newAccountId = 'new-identity-fix7'
    const oldPath = join(accountsDir, `${oldAccountId}.json`)

    writeFileSync(oldPath, JSON.stringify({
      tokens: { access_token: 'old-access', refresh_token: 'old-refresh', account_id: oldAccountId },
    }), 'utf-8')

    seedCodexAccountPoolForTest({
      activeAccountId: oldAccountId,
      accounts: [buildPoolAccount({ accountId: oldAccountId, refreshToken: 'old-refresh', source: 'vault', vaultFilePath: oldPath })],
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          access_token: createAccessToken(newAccountId),
          refresh_token: 'new-refresh-fix7',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )

    try {
      const result = await refreshAccountTokens(oldAccountId, 'old-refresh', oldPath, 0)
      expect(result.status).toBe('identity_mismatch')

      const written = JSON.parse(readFileSync(oldPath, 'utf-8'))
      // Must be reauth_required, NOT idle.
      expect(written.refresh.state).toBe('reauth_required')
      expect(written.refresh.reason).toBe('identity_mismatch')
      expect(typeof written.refresh.marked_at).toBe('string')
      // Old tokens must be untouched.
      expect(written.tokens.access_token).toBe('old-access')
      expect(written.tokens.refresh_token).toBe('old-refresh')
    } finally {
      globalThis.fetch = originalFetch
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('quarantine probe persists next_probe_at before the network request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-refresh-test-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })
    const accountId = 'probe-reservation-test'
    const filePath = join(accountsDir, `${accountId}.json`)

    writeFileSync(filePath, JSON.stringify({
      tokens: {
        access_token: 'old-access',
        refresh_token: 'old-refresh',
        account_id: accountId,
        credential_generation: 1,
      },
      refresh: {
        state: 'unknown',
        attempt_id: 'previous-attempt',
        refresh_token_hash: 'previous-hash',
        failed_at: new Date(Date.now() - 60_000).toISOString(),
        reason: 'previous transport failure',
      },
    }), 'utf-8')

    seedCodexAccountPoolForTest({
      activeAccountId: accountId,
      accounts: [
        buildPoolAccount({
          accountId,
          accessToken: 'old-access',
          refreshToken: 'old-refresh',
          status: 'quarantined',
          statusReason: 'probe_pending_transport',
          lastError: 'connection problem; retrying',
          credentialGeneration: 1,
          vaultFilePath: filePath,
        }),
      ],
    })

    const originalFetch = globalThis.fetch
    let releaseFetch!: () => void
    let fetchStarted!: () => void
    const fetchStartedPromise = new Promise<void>(resolve => { fetchStarted = resolve })
    const releaseFetchPromise = new Promise<void>(resolve => { releaseFetch = resolve })
    globalThis.fetch = async () => {
      fetchStarted()
      await releaseFetchPromise
      throw Object.assign(new Error('simulated socket drop'), { code: 'ECONNRESET' })
    }

    try {
      const lifecycle = await establishCredentialedLifecycle(filePath, accountId)
      const probe = runQuarantineProbeOnce({ lifecycle })
      await fetchStartedPromise

      const during = JSON.parse(readFileSync(filePath, 'utf-8'))
      expect(during.refresh.state).toBe('in_flight')
      expect(typeof during.refresh.next_probe_at).toBe('string')
      expect(during.refresh.consecutive_failures).toBe(1)

      releaseFetch()
      await probe

      const after = JSON.parse(readFileSync(filePath, 'utf-8'))
      expect(after.refresh.state).toBe('unknown')
      expect(after.refresh.next_probe_at).toBe(during.refresh.next_probe_at)
      expect(after.refresh.consecutive_failures).toBe(1)
    } finally {
      releaseFetch?.()
      globalThis.fetch = originalFetch
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('desktop quarantine backoff preserves a concurrent terminal verdict', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-probe-contention-'))
    const vaultPath = join(dir, 'account.json')
    const readyPath = join(dir, 'terminal-ready')
    writeFileSync(
      vaultPath,
      JSON.stringify({
        version: 1,
        tokens: {
          access_token: 'synthetic-access',
          refresh_token: 'synthetic-refresh',
          account_id: 'synthetic-account',
          credential_generation: 1,
        },
        refresh: { state: 'unknown' },
      }),
      { mode: 0o600 },
    )
    const childPath = join(
      import.meta.dir,
      'codexTokenRefresh.probe.child.ts',
    )
    const lifecycleDirectory = join(dir, 'lifecycle')
    await establishCredentialedLifecycle(
      join(dir, 'accounts', 'synthetic-account.json'),
      'synthetic-account',
    )
    const children = ['terminal-verdict', 'desktop-probe'].map(role =>
      Bun.spawn({
        cmd: [process.execPath, childPath, role, vaultPath, readyPath],
        env: {
          ...process.env,
          PROBE_LIFECYCLE_DIRECTORY: lifecycleDirectory,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    )
    const recordedPids = children.map(child => child.pid)

    try {
      const exits = await Promise.race([
        Promise.all(children.map(child => child.exited)),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            for (const child of children) child.kill()
            reject(
              new Error(
                `timed out waiting for exact child PIDs ${recordedPids.join(', ')}`,
              ),
            )
          }, 10_000).unref()
        }),
      ])
      const [stdout, stderr] = await Promise.all([
        Promise.all(
          children.map(child => new Response(child.stdout).text()),
        ),
        Promise.all(
          children.map(child => new Response(child.stderr).text()),
        ),
      ])
      expect(exits, stderr.join('\n')).toEqual([0, 0])
      expect(
        stdout
          .map(value => (JSON.parse(value) as { pid: number }).pid)
          .sort(),
      ).toEqual(recordedPids.sort())
      const vault = JSON.parse(readFileSync(vaultPath, 'utf8'))
      expect(vault.refresh).toEqual({
        state: 'reauth_required',
        reason: 'terminal verdict',
        refresh_token_hash: 'synthetic',
      })
    } finally {
      await Promise.all(children.map(child => child.exited))
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('codexTokenRefresh touchAll refresh skew', () => {
  beforeEach(() => {
    resetCodexAccountPoolForTest()
  })

  test('skips accounts outside refresh skew and refreshes near-expiry accounts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-touch-all-test-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })

    const farAccountId = 'far-expiry-account'
    const nearAccountId = 'near-expiry-account'
    writeFileSync(
      join(accountsDir, `${farAccountId}.json`),
      JSON.stringify({
        tokens: {
          access_token: createAccessToken(farAccountId),
          refresh_token: 'far-refresh',
          account_id: farAccountId,
          expires_at: Date.now() + 5 * 60_000,
        },
      }),
      'utf-8',
    )
    writeFileSync(
      join(accountsDir, `${nearAccountId}.json`),
      JSON.stringify({
        tokens: {
          access_token: createAccessToken(nearAccountId),
          refresh_token: 'near-refresh',
          account_id: nearAccountId,
          expires_at: Date.now() + 30_000,
        },
      }),
      'utf-8',
    )

    const originalFetch = globalThis.fetch
    const refreshTokensSpent: string[] = []
    globalThis.fetch = Object.assign(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { refresh_token?: string }
        refreshTokensSpent.push(body.refresh_token ?? '')
        return new Response(
          JSON.stringify({
            access_token: createAccessToken(nearAccountId),
            refresh_token: 'near-refresh-rotated',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      },
      { preconnect: originalFetch.preconnect },
    )

    try {
      const results = await touchAll({
        vaultPath: dir,
        lifecycle: lifecycleForVault(join(accountsDir, `${nearAccountId}.json`)),
      })
      expect(results.find(result => result.accountId === farAccountId)?.status).toBe('skipped')
      expect(results.find(result => result.accountId === nearAccountId)?.status).toBe('refreshed')
      expect(refreshTokensSpent).toEqual(['near-refresh'])
    } finally {
      globalThis.fetch = originalFetch
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('refreshAccountTokens rotation adoption respects a terminal verdict', () => {
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

  beforeEach(() => {
    resetCodexAccountPoolForTest()
    resetCodexLeaseManagerForTest()
    _resetAccountDiagnosticStreamJsonHookForTesting()
  })

  // The quarantine probe calls in with its in-memory token, which can be older
  // than the profile on disk. Adopting the newer token without correlating it
  // against the stored verdict resurrects a revoked credential, with no network
  // request to catch the mistake.
  test('refuses a concurrently rotated token that is itself marked reauth_required', async () => {
    const accountId = 'rotation-verdict-account'
    const originalFetch = globalThis.fetch
    let networkCalls = 0
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      networkCalls++
      return originalFetch(...args)
    }) as typeof fetch

    try {
      await withVaultAccount(
        accountId,
        {
          tokens: {
            access_token: 'access',
            refresh_token: 'rotated-refresh',
            account_id: accountId,
            expires_at: Date.now() + 3600_000,
          },
          last_refresh: new Date().toISOString(),
          refresh: {
            state: 'reauth_required',
            refresh_token_hash: sha256('rotated-refresh'),
            marked_at: new Date().toISOString(),
            reason: 'http_401',
          },
        },
        async filePath => {
          // Caller still holds the pre-rotation token.
          await expect(
            refreshAccountTokens(accountId, 'old-refresh', filePath, 0),
          ).rejects.toThrow(/Reauthentication required/)

          const account = getPoolStatus().accounts.find(a => a.accountId === accountId)
          expect(account?.status).toBe('dead')
          expect(networkCalls).toBe(0)
        },
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('still adopts a concurrently rotated token that carries no verdict', async () => {
    const accountId = 'rotation-clean-account'
    await withVaultAccount(
      accountId,
      {
        tokens: {
          access_token: 'new-access',
          refresh_token: 'rotated-refresh',
          account_id: accountId,
          expires_at: Date.now() + 3600_000,
        },
        last_refresh: new Date().toISOString(),
        refresh: { state: 'idle' },
      },
      async filePath => {
        const result = await refreshAccountTokens(accountId, 'old-refresh', filePath, 0)
        expect(result.status).toBe('refreshed')
        expect(result.refreshToken).toBe('rotated-refresh')
      },
    )
  })
})

describe('codexTokenRefresh credential lifecycle fencing', () => {
  beforeEach(() => {
    resetCodexAccountPoolForTest()
    resetCodexLeaseManagerForTest()
    _resetAccountDiagnosticStreamJsonHookForTesting()
  })

  test('does not dedupe pending refreshes for different credential generations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-refresh-generation-test-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })
    const accountId = 'generation-dedup-account'
    const filePath = join(accountsDir, `${accountId}.json`)
    writeFileSync(filePath, JSON.stringify({
      tokens: {
        access_token: createAccessToken(accountId),
        refresh_token: 'old-refresh',
        account_id: accountId,
        credential_generation: 1,
      },
    }), 'utf-8')
    const lifecycle = await establishCredentialedLifecycle(filePath, accountId)
    seedCodexAccountPoolForTest({
      activeAccountId: accountId,
      accounts: [
        buildPoolAccount({
          accountId,
          accessToken: createAccessToken(accountId),
          refreshToken: 'old-refresh',
          credentialGeneration: 1,
          vaultFilePath: filePath,
        }),
      ],
    })

    const originalFetch = globalThis.fetch
    let fetchCount = 0
    let fetchStarted!: () => void
    let releaseFetch!: () => void
    const fetchStartedPromise = new Promise<void>(resolve => {
      fetchStarted = resolve
    })
    const fetchGate = new Promise<void>(resolve => {
      releaseFetch = resolve
    })
    globalThis.fetch = async () => {
      fetchCount += 1
      fetchStarted()
      await fetchGate
      return new Response(JSON.stringify({
        access_token: createAccessToken(accountId),
        refresh_token: 'rotated-refresh',
      }))
    }

    try {
      const first = refreshAccountTokens(
        accountId,
        'old-refresh',
        filePath,
        1,
        lifecycle,
      )
      await fetchStartedPromise
      const second = refreshAccountTokens(
        accountId,
        'old-refresh',
        filePath,
        2,
        lifecycle,
      )
      releaseFetch()

      await expect(first).resolves.toMatchObject({
        status: 'refreshed',
        credentialGeneration: 1,
      })
      await expect(second).rejects.toThrow(
        'Codex credential lifecycle does not authorize this refresh.',
      )
      expect(fetchCount).toBe(1)
    } finally {
      releaseFetch?.()
      globalThis.fetch = originalFetch
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a signed-out lifecycle wins before refresh and prevents the fetch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-refresh-signout-test-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })
    const accountId = 'signout-wins-account'
    const filePath = join(accountsDir, `${accountId}.json`)
    writeFileSync(filePath, JSON.stringify({
      tokens: {
        access_token: createAccessToken(accountId),
        refresh_token: 'old-refresh',
        account_id: accountId,
        credential_generation: 1,
      },
    }), 'utf-8')
    const lifecycle = await establishCredentialedLifecycle(filePath, accountId)
    const before = readFileSync(filePath, 'utf-8')
    await signOutCredentialedLifecycle(lifecycle, accountId, 1)

    const originalFetch = globalThis.fetch
    let fetchCount = 0
    globalThis.fetch = async () => {
      fetchCount += 1
      return new Response()
    }
    try {
      await expect(
        refreshAccountTokens(accountId, 'old-refresh', filePath, 1, lifecycle),
      ).rejects.toThrow(
        'Codex credential lifecycle does not authorize this refresh.',
      )
      expect(fetchCount).toBe(0)
      expect(readFileSync(filePath, 'utf-8')).toBe(before)
    } finally {
      globalThis.fetch = originalFetch
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('refresh holds the lifecycle permit until completion, then sign-out advances it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-refresh-lock-order-test-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })
    const accountId = 'refresh-lock-order-account'
    const filePath = join(accountsDir, `${accountId}.json`)
    writeFileSync(filePath, JSON.stringify({
      tokens: {
        access_token: createAccessToken(accountId),
        refresh_token: 'old-refresh',
        account_id: accountId,
        credential_generation: 1,
      },
    }), 'utf-8')
    const lifecycle = await establishCredentialedLifecycle(filePath, accountId)

    const originalFetch = globalThis.fetch
    let fetchStarted!: () => void
    let releaseFetch!: () => void
    const fetchStartedPromise = new Promise<void>(resolve => {
      fetchStarted = resolve
    })
    const fetchGate = new Promise<void>(resolve => {
      releaseFetch = resolve
    })
    globalThis.fetch = async () => {
      fetchStarted()
      await fetchGate
      return new Response(JSON.stringify({
        access_token: createAccessToken(accountId),
        refresh_token: 'rotated-refresh',
      }))
    }

    try {
      const refresh = refreshAccountTokens(
        accountId,
        'old-refresh',
        filePath,
        1,
        lifecycle,
      )
      await fetchStartedPromise
      const signOut = signOutCredentialedLifecycle(lifecycle, accountId, 1)
      releaseFetch()
      await expect(refresh).resolves.toMatchObject({
        status: 'refreshed',
        credentialGeneration: 1,
      })
      await signOut

      expect(lifecycle.read(accountId)).toMatchObject({
        status: 'valid',
        record: {
          state: 'signed_out',
          credentialGeneration: 2,
        },
      })
    } finally {
      releaseFetch?.()
      globalThis.fetch = originalFetch
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('positive generation mismatch prevents fetch, vault write, and pool install', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-refresh-generation-mismatch-test-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })
    const accountId = 'generation-mismatch-account'
    const filePath = join(accountsDir, `${accountId}.json`)
    writeFileSync(filePath, JSON.stringify({
      tokens: {
        access_token: createAccessToken(accountId),
        refresh_token: 'old-refresh',
        account_id: accountId,
        credential_generation: 1,
      },
    }), 'utf-8')
    const lifecycle = await establishCredentialedLifecycle(filePath, accountId)
    seedCodexAccountPoolForTest({
      activeAccountId: accountId,
      accounts: [
        buildPoolAccount({
          accountId,
          accessToken: 'old-access',
          refreshToken: 'old-refresh',
          credentialGeneration: 1,
          vaultFilePath: filePath,
        }),
      ],
    })
    const before = readFileSync(filePath, 'utf-8')
    const originalFetch = globalThis.fetch
    let fetchCount = 0
    globalThis.fetch = async () => {
      fetchCount += 1
      return new Response()
    }

    try {
      await expect(
        refreshAccountTokens(accountId, 'old-refresh', filePath, 2, lifecycle),
      ).rejects.toThrow(
        'Codex credential lifecycle does not authorize this refresh.',
      )
      expect(fetchCount).toBe(0)
      expect(readFileSync(filePath, 'utf-8')).toBe(before)
      expect(getPoolStatus().accounts[0]?.accessToken).toBe('old-access')
    } finally {
      globalThis.fetch = originalFetch
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('legacy generation-zero bootstrap tags the vault before network refresh', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-refresh-bootstrap-test-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })
    const accountId = 'legacy-bootstrap-account'
    const filePath = join(accountsDir, `${accountId}.json`)
    writeFileSync(filePath, JSON.stringify({
      tokens: {
        access_token: createAccessToken(accountId),
        refresh_token: 'old-refresh',
        account_id: accountId,
      },
    }), 'utf-8')
    const lifecycle = lifecycleForVault(filePath)
    seedCodexAccountPoolForTest({
      activeAccountId: accountId,
      accounts: [
        buildPoolAccount({
          accountId,
          refreshToken: 'old-refresh',
          credentialGeneration: 0,
          vaultFilePath: filePath,
        }),
      ],
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => {
      const during = JSON.parse(readFileSync(filePath, 'utf-8')) as {
        tokens?: { credential_generation?: number }
      }
      expect(during.tokens?.credential_generation).toBe(1)
      expect(lifecycle.read(accountId)).toMatchObject({
        status: 'valid',
        record: {
          state: 'credentialed',
          credentialGeneration: 1,
        },
      })
      return new Response(JSON.stringify({
        access_token: createAccessToken(accountId),
        refresh_token: 'rotated-refresh',
      }))
    }

    try {
      await expect(
        refreshAccountTokens(accountId, 'old-refresh', filePath, 0, lifecycle),
      ).resolves.toMatchObject({
        status: 'refreshed',
        credentialGeneration: 1,
      })
      const written = JSON.parse(readFileSync(filePath, 'utf-8'))
      expect(written.tokens.credential_generation).toBe(1)
      expect(getPoolStatus().accounts[0]?.credentialGeneration).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('same-identity rotation preserves the credential generation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-refresh-same-identity-test-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })
    const accountId = 'same-identity-generation-account'
    const filePath = join(accountsDir, `${accountId}.json`)
    writeFileSync(filePath, JSON.stringify({
      tokens: {
        access_token: createAccessToken(accountId),
        refresh_token: 'old-refresh',
        account_id: accountId,
        credential_generation: 1,
      },
    }), 'utf-8')
    const lifecycle = await establishCredentialedLifecycle(filePath, accountId)
    seedCodexAccountPoolForTest({
      activeAccountId: accountId,
      accounts: [
        buildPoolAccount({
          accountId,
          refreshToken: 'old-refresh',
          credentialGeneration: 1,
          vaultFilePath: filePath,
        }),
      ],
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify({
      access_token: createAccessToken(accountId),
      refresh_token: 'rotated-refresh',
    }))

    try {
      const result = await refreshAccountTokens(
        accountId,
        'old-refresh',
        filePath,
        1,
        lifecycle,
      )
      expect(result.status).toBe('refreshed')
      expect(result.credentialGeneration).toBe(1)
      expect(JSON.parse(readFileSync(filePath, 'utf-8')).tokens.credential_generation).toBe(1)
      expect(getPoolStatus().accounts[0]?.credentialGeneration).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('credential failure advances lifecycle to reauth_required', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-refresh-auth-failure-test-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })
    const accountId = 'auth-failure-generation-account'
    const filePath = join(accountsDir, `${accountId}.json`)
    writeFileSync(filePath, JSON.stringify({
      tokens: {
        access_token: createAccessToken(accountId),
        refresh_token: 'old-refresh',
        account_id: accountId,
        credential_generation: 1,
      },
    }), 'utf-8')
    const lifecycle = await establishCredentialedLifecycle(filePath, accountId)
    seedCodexAccountPoolForTest({
      activeAccountId: accountId,
      accounts: [
        buildPoolAccount({
          accountId,
          refreshToken: 'old-refresh',
          credentialGeneration: 1,
          vaultFilePath: filePath,
        }),
      ],
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })

    try {
      await expect(
        refreshAccountTokens(accountId, 'old-refresh', filePath, 1, lifecycle),
      ).rejects.toThrow('invalid_grant')
      expect(lifecycle.read(accountId)).toMatchObject({
        status: 'valid',
        record: {
          state: 'reauth_required',
          credentialGeneration: 2,
        },
      })
      const vault = JSON.parse(readFileSync(filePath, 'utf-8'))
      expect(vault.tokens.credential_generation).toBe(1)
      expect(getPoolStatus().accounts[0]?.status).toBe('dead')
    } finally {
      globalThis.fetch = originalFetch
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('transport failure preserves generation and quarantine state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-refresh-transport-generation-test-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })
    const accountId = 'transport-generation-account'
    const filePath = join(accountsDir, `${accountId}.json`)
    writeFileSync(filePath, JSON.stringify({
      tokens: {
        access_token: createAccessToken(accountId),
        refresh_token: 'old-refresh',
        account_id: accountId,
        credential_generation: 1,
      },
    }), 'utf-8')
    const lifecycle = await establishCredentialedLifecycle(filePath, accountId)
    seedCodexAccountPoolForTest({
      activeAccountId: accountId,
      accounts: [
        buildPoolAccount({
          accountId,
          refreshToken: 'old-refresh',
          credentialGeneration: 1,
          vaultFilePath: filePath,
        }),
      ],
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => {
      throw Object.assign(new Error('simulated socket drop'), {
        code: 'ECONNRESET',
      })
    }

    try {
      await expect(
        refreshAccountTokens(accountId, 'old-refresh', filePath, 1, lifecycle),
      ).rejects.toMatchObject({ transportClass: 'ambiguous' })
      expect(lifecycle.read(accountId)).toMatchObject({
        status: 'valid',
        record: {
          state: 'credentialed',
          credentialGeneration: 1,
        },
      })
      const vault = JSON.parse(readFileSync(filePath, 'utf-8'))
      expect(vault.tokens.credential_generation).toBe(1)
      expect(vault.refresh.state).toBe('unknown')
      expect(getPoolStatus().accounts[0]?.status).toBe('quarantined')
    } finally {
      globalThis.fetch = originalFetch
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('cross-identity refresh reauthenticates A without installing B', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-refresh-cross-identity-test-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })
    const accountId = 'cross-identity-old-account'
    const newAccountId = 'cross-identity-new-account'
    const filePath = join(accountsDir, `${accountId}.json`)
    const newPath = join(accountsDir, `${newAccountId}.json`)
    writeFileSync(filePath, JSON.stringify({
      tokens: {
        access_token: createAccessToken(accountId),
        refresh_token: 'old-refresh',
        account_id: accountId,
        credential_generation: 1,
      },
    }), 'utf-8')
    const lifecycle = await establishCredentialedLifecycle(filePath, accountId)
    seedCodexAccountPoolForTest({
      activeAccountId: accountId,
      accounts: [
        buildPoolAccount({
          accountId,
          refreshToken: 'old-refresh',
          credentialGeneration: 1,
          vaultFilePath: filePath,
        }),
      ],
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify({
      access_token: createAccessToken(newAccountId),
      refresh_token: 'new-refresh',
    }))

    try {
      const result = await refreshAccountTokens(
        accountId,
        'old-refresh',
        filePath,
        1,
        lifecycle,
      )
      expect(result).toMatchObject({
        status: 'identity_mismatch',
        accountId,
        refreshedAccountId: newAccountId,
        credentialGeneration: 1,
      })
      expect('accessToken' in result).toBe(false)
      expect(existsSync(newPath)).toBe(false)
      expect(getPoolStatus().accounts.some(a => a.accountId === newAccountId)).toBe(false)
      expect(lifecycle.read(accountId)).toMatchObject({
        status: 'valid',
        record: {
          state: 'reauth_required',
          credentialGeneration: 2,
        },
      })
      const oldVault = JSON.parse(readFileSync(filePath, 'utf-8'))
      expect(oldVault.tokens.account_id).toBe(accountId)
      expect(oldVault.tokens.refresh_token).toBe('old-refresh')
      expect(oldVault.refresh.reason).toBe('identity_mismatch')
    } finally {
      globalThis.fetch = originalFetch
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('touchAll skips signed-out metadata profiles without a missing-token failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-touch-signed-out-test-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })
    const accountId = 'signed-out-touch-account'
    const filePath = join(accountsDir, `${accountId}.json`)
    writeFileSync(filePath, JSON.stringify({
      account_id: accountId,
      profile_state: 'signed_out',
      alias: 'old-profile',
    }), 'utf-8')
    const originalFetch = globalThis.fetch
    let fetchCount = 0
    globalThis.fetch = async () => {
      fetchCount += 1
      return new Response()
    }

    try {
      const results = await touchAll({
        vaultPath: dir,
        lifecycle: lifecycleForVault(filePath),
      })
      expect(results).toEqual([
        {
          accountId,
          status: 'skipped',
          detail: 'Profile is signed out',
        },
      ])
      expect(fetchCount).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('quarantine bookkeeping refuses an old generation after sign-out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-quarantine-generation-test-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })
    const accountId = 'quarantine-old-generation-account'
    const filePath = join(accountsDir, `${accountId}.json`)
    writeFileSync(filePath, JSON.stringify({
      tokens: {
        access_token: createAccessToken(accountId),
        refresh_token: 'old-refresh',
        account_id: accountId,
        credential_generation: 1,
      },
      refresh: { state: 'unknown' },
    }), 'utf-8')
    const lifecycle = await establishCredentialedLifecycle(filePath, accountId)
    await signOutCredentialedLifecycle(lifecycle, accountId, 1)
    const before = readFileSync(filePath, 'utf-8')

    try {
      await expect(
        persistNextQuarantineProbe(
          filePath,
          'stale probe',
          accountId,
          1,
          { lifecycle },
        ),
      ).rejects.toThrow(
        'Codex credential lifecycle does not authorize this refresh.',
      )
      expect(readFileSync(filePath, 'utf-8')).toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('does not append after lifecycle changes before success persistence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-refresh-append-fence-test-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })
    const accountId = 'append-fence-account'
    const filePath = join(accountsDir, `${accountId}.json`)
    writeFileSync(filePath, JSON.stringify({
      tokens: {
        access_token: 'old-access',
        refresh_token: 'old-refresh',
        account_id: accountId,
        credential_generation: 1,
      },
    }), 'utf-8')
    const lifecycle = await establishCredentialedLifecycle(filePath, accountId)
    seedCodexAccountPoolForTest({
      activeAccountId: accountId,
      accounts: [
        buildPoolAccount({
          accountId,
          accessToken: 'old-access',
          refreshToken: 'old-refresh',
          credentialGeneration: 1,
          vaultFilePath: filePath,
        }),
      ],
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => {
      const current = lifecycle.read(accountId)
      if (current.status !== 'valid') {
        throw new Error('test lifecycle was not credentialed')
      }
      writeFileSync(
        lifecycle.getPaths(accountId).recordPath,
        JSON.stringify({
          ...current.record,
          state: 'signed_out',
          credentialGeneration: 2,
          operationId: 'test-sign-out',
          operationKind: 'sign_out',
          cleanup: 'pending',
          changedAt: new Date().toISOString(),
        }),
      )
      return new Response(JSON.stringify({
        access_token: createAccessToken(accountId),
        refresh_token: 'rotated-refresh',
      }))
    }

    try {
      await expect(
        refreshAccountTokens(accountId, 'old-refresh', filePath, 1, lifecycle),
      ).rejects.toThrow(
        'Codex credential lifecycle does not authorize this refresh.',
      )
      const vault = JSON.parse(readFileSync(filePath, 'utf-8'))
      expect(vault.tokens.access_token).toBe('old-access')
      expect(vault.tokens.refresh_token).toBe('old-refresh')
      expect(vault.refresh.state).toBe('in_flight')
      expect(getPoolStatus().accounts[0]?.accessToken).toBe('old-access')
    } finally {
      globalThis.fetch = originalFetch
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
