import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { refreshAccountTokens } from './codexTokenRefresh.js'
import {
  getPoolStatus,
  resetCodexAccountPoolForTest,
  seedCodexAccountPoolForTest,
  type PoolAccount,
} from './codexAccountPool.js'

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
    turnsUsed: overrides.turnsUsed ?? 0,
    alias: overrides.alias,
    lastError: overrides.lastError,
    usagePrimary: overrides.usagePrimary,
    usageWeekly: overrides.usageWeekly,
    usageFetchedAt: overrides.usageFetchedAt,
    lastErrorAt: overrides.lastErrorAt,
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

describe('codexTokenRefresh identity handling', () => {
  beforeEach(() => {
    resetCodexAccountPoolForTest()
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
      const result = await refreshAccountTokens(oldAccountId, 'old-refresh', oldPath)
      expect(result.status).toBe('identity_mismatch')
      expect(result.refreshedAccountId).toBe(newAccountId)

      const oldWritten = JSON.parse(readFileSync(oldPath, 'utf-8')) as Record<string, unknown>
      const oldTokens = oldWritten.tokens as Record<string, unknown>
      expect(oldTokens.access_token).toBe('old-access-for-78c')
      expect(oldTokens.refresh_token).toBe('old-refresh')
      expect(oldWritten.alias).toBe('main')

      const newPath = join(accountsDir, `${newAccountId}.json`)
      const newWritten = JSON.parse(readFileSync(newPath, 'utf-8')) as Record<string, unknown>
      const newTokens = newWritten.tokens as Record<string, unknown>
      expect(newTokens.account_id).toBe(newAccountId)
      expect(newWritten.alias).toBeUndefined()

      const pool = getPoolStatus().accounts
      const oldPool = pool.find((a) => a.accountId === oldAccountId)
      const newPool = pool.find((a) => a.accountId === newAccountId)
      expect(oldPool?.status).toBe('dead')
      expect(newPool?.accessToken).toBe(createAccessToken(newAccountId))
      expect(newPool?.source).toBe('vault')
    } finally {
      globalThis.fetch = originalFetch
      rmSync(dir, { recursive: true, force: true })
    }
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
      const result = await refreshAccountTokens(accountId, 'old-refresh', oldPath)
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
      const first = refreshAccountTokens(accountId, 'old-refresh', oldPath)
      const second = refreshAccountTokens(accountId, 'old-refresh', oldPath)
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
      await expect(refreshAccountTokens(accountId, 'old-refresh', oldPath)).rejects.toThrow(
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
})
