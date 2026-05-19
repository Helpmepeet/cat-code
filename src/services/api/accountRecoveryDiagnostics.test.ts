import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { APIConnectionError, APIError } from '@anthropic-ai/sdk'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { setSessionProvider } from '../../bootstrap/state.js'
import {
  _resetAccountDiagnosticStreamJsonHookForTesting,
  installStreamJsonAccountDiagnosticHook,
} from './accountDiagnostics.js'
import {
  getActiveClaudeAccount,
  resetClaudeAccountPoolForTest,
  seedClaudeAccountPoolForTest,
  type ClaudePoolAccount,
} from './claudeAccountPool.js'
import {
  CodexAccountAuthError,
  CodexAccountCapError,
  createCodexFetch,
  resetCodexCacheContext,
} from './codex-fetch-adapter.js'
import {
  getCodexLeaseForOwner,
  resetCodexLeaseManagerForTest,
  seedCodexLeaseForTest,
} from './codexAccountLeaseManager.js'
import {
  getPoolStatus,
  resetCodexAccountPoolForTest,
  seedCodexAccountPoolForTest,
  type PoolAccount,
} from './codexAccountPool.js'
import { getAnthropicClient } from './client.js'
import { getClaudeAIOAuthTokens } from '../../utils/auth.js'
import { CannotRetryError, withRetry } from './withRetry.js'

function buildCodexToken(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
    'base64url',
  )
  const payload = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': {
        chatgpt_account_id: accountId,
      },
    }),
  ).toString('base64url')
  return `${header}.${payload}.signature`
}

function buildPoolAccount(
  overrides: Partial<PoolAccount> & Pick<PoolAccount, 'accountId'>,
): PoolAccount {
  return {
    accountId: overrides.accountId,
    accessToken: overrides.accessToken ?? buildCodexToken(overrides.accountId),
    refreshToken: overrides.refreshToken ?? `refresh-${overrides.accountId}`,
    expiresAt: overrides.expiresAt ?? Date.now() + 60_000,
    source: overrides.source ?? 'config',
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

function buildClaudeAccount(
  overrides: Partial<ClaudePoolAccount> & Pick<ClaudePoolAccount, 'accountUuid' | 'emailAddress'>,
): ClaudePoolAccount {
  return {
    accountUuid: overrides.accountUuid,
    emailAddress: overrides.emailAddress,
    accessToken: overrides.accessToken ?? `claude-access-${overrides.accountUuid}`,
    refreshToken: overrides.refreshToken ?? '',
    expiresAt: overrides.expiresAt ?? Date.now() + 60_000,
    status: overrides.status ?? 'healthy',
    scopes: overrides.scopes,
    subscriptionType: overrides.subscriptionType,
    rateLimitTier: overrides.rateLimitTier,
    alias: overrides.alias,
    displayName: overrides.displayName,
    organizationUuid: overrides.organizationUuid,
    organizationName: overrides.organizationName,
    organizationRole: overrides.organizationRole,
    workspaceRole: overrides.workspaceRole,
    billingType: overrides.billingType,
    hasExtraUsageEnabled: overrides.hasExtraUsageEnabled,
    accountCreatedAt: overrides.accountCreatedAt,
    subscriptionCreatedAt: overrides.subscriptionCreatedAt,
    vaultFilePath: overrides.vaultFilePath,
  }
}

describe('account recovery diagnostics', () => {
  const originalFetch = globalThis.fetch
  const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
  let diagnostics: Array<Record<string, unknown>> = []
  const macroState = globalThis as typeof globalThis & { MACRO?: { VERSION: string } }

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'
    macroState.MACRO = { VERSION: 'test-version' }
    diagnostics = []
    resetCodexCacheContext()
    resetCodexAccountPoolForTest()
    resetCodexLeaseManagerForTest()
    resetClaudeAccountPoolForTest()
    getClaudeAIOAuthTokens.cache?.clear?.()
    setSessionProvider(null)
    installStreamJsonAccountDiagnosticHook({
      emit: message => {
        diagnostics.push(message as unknown as Record<string, unknown>)
      },
      getSessionId: () => 'account-recovery-test-session',
      createUuid: () => `diag-${diagnostics.length + 1}`,
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    _resetAccountDiagnosticStreamJsonHookForTesting()
    resetCodexCacheContext()
    resetCodexAccountPoolForTest()
    resetCodexLeaseManagerForTest()
    resetClaudeAccountPoolForTest()
    getClaudeAIOAuthTokens.cache?.clear?.()
    setSessionProvider(null)
    if (originalAnthropicApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
    }
    delete macroState.MACRO
  })

  test('retries a capped Codex account on a second account and emits failover success', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'account-one',
      accounts: [
        buildPoolAccount({ accountId: 'account-one', alias: 'main' }),
        buildPoolAccount({ accountId: 'account-two', alias: 'backup' }),
      ],
    })
    seedCodexLeaseForTest({
      ownerId: 'subagent-cap',
      ownerType: 'subagent',
      ownerLabel: 'Subagent Cap',
      accountId: 'account-one',
    })

    let attempts = 0
    for await (const _message of withRetry(
      async () => ({}) as never,
      async () => {
        attempts += 1
        if (attempts === 1) {
          throw new CodexAccountCapError('account-one')
        }
        return getCodexLeaseForOwner('subagent-cap')?.accountId
      },
      {
        model: 'gpt-5.4',
        thinkingConfig: { type: 'disabled' },
        ownerId: 'subagent-cap',
        isCodexRequest: true,
      } as Parameters<typeof withRetry>[2],
    )) {
      // consume retry messages
    }

    expect(attempts).toBe(2)
    expect(getCodexLeaseForOwner('subagent-cap')?.accountId).toBe('account-two')
    expect(diagnostics.map(diagnostic => diagnostic.code)).toContain(
      'account.failover.succeeded',
    )
  })

  test('emits quota.exhausted when every pooled Codex account is capped', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'account-one',
      accounts: [
        buildPoolAccount({ accountId: 'account-one', alias: 'main' }),
        buildPoolAccount({
          accountId: 'account-two',
          alias: 'backup',
          status: 'capped',
          lastError: 'Usage snapshot reported account exhaustion',
        }),
      ],
    })
    seedCodexLeaseForTest({
      ownerId: 'subagent-exhausted',
      ownerType: 'subagent',
      ownerLabel: 'Subagent Exhausted',
      accountId: 'account-one',
    })

    await expect(async () => {
      for await (const _message of withRetry(
        async () => ({}) as never,
        async () => {
          throw new CodexAccountCapError('account-one')
        },
        {
          model: 'gpt-5.4',
          thinkingConfig: { type: 'disabled' },
          ownerId: 'subagent-exhausted',
          isCodexRequest: true,
        } as Parameters<typeof withRetry>[2],
      )) {
        // unreachable
      }
    }).toThrow(CannotRetryError)

    expect(diagnostics.map(diagnostic => diagnostic.code)).toContain(
      'quota.exhausted',
    )
  })

  test('surfaces pooled Codex 401s as auth errors instead of usage caps', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'account-one',
      accounts: [
        buildPoolAccount({ accountId: 'account-one', alias: 'main' }),
        buildPoolAccount({ accountId: 'account-two', alias: 'backup' }),
      ],
    })

    globalThis.fetch = (async () => {
      return new Response('unauthorized', { status: 401 })
    }) as typeof globalThis.fetch

    await expect(
      createCodexFetch(buildCodexToken('account-one'))(
        'https://api.anthropic.com/v1/messages',
        {
          method: 'POST',
          body: JSON.stringify({
            stream: true,
            model: 'gpt-5.4',
            _openaiInstructionAssembly: {
              instructions: 'Be precise.',
              inputMessages: [],
            },
          }),
        },
      ),
    ).rejects.toBeInstanceOf(CodexAccountAuthError)
  })

  test('handles pooled Codex auth failure without emitting quota exhaustion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-auth-failover-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })
    const staleAccountPath = join(accountsDir, 'account-one.json')
    writeFileSync(
      staleAccountPath,
      JSON.stringify(
        {
          tokens: {
            access_token: buildCodexToken('account-one'),
            refresh_token: 'refresh-account-one',
            account_id: 'account-one',
          },
          alias: 'main',
        },
        null,
        2,
      ),
      'utf-8',
    )

    seedCodexAccountPoolForTest({
      activeAccountId: 'account-one',
      accounts: [
        buildPoolAccount({
          accountId: 'account-one',
          alias: 'main',
          source: 'vault',
          vaultFilePath: staleAccountPath,
          refreshToken: 'refresh-account-one',
        }),
        buildPoolAccount({ accountId: 'account-two', alias: 'backup' }),
      ],
    })
    seedCodexLeaseForTest({
      ownerId: 'subagent-auth',
      ownerType: 'subagent',
      ownerLabel: 'Subagent Auth',
      accountId: 'account-one',
    })

    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({ error: 'refresh_token_invalidated' }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }) as typeof globalThis.fetch

    let attempts = 0
    try {
      for await (const _message of withRetry(
        async () => ({}) as never,
        async () => {
          attempts += 1
          if (attempts === 1) {
            throw new CodexAccountAuthError('account-one', 401)
          }
          return getCodexLeaseForOwner('subagent-auth')?.accountId
        },
        {
          model: 'gpt-5.4',
          thinkingConfig: { type: 'disabled' },
          ownerId: 'subagent-auth',
          isCodexRequest: true,
        } as Parameters<typeof withRetry>[2],
      )) {
        // consume retry messages
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }

    expect(attempts).toBe(2)
    expect(getCodexLeaseForOwner('subagent-auth')?.accountId).toBe('account-two')
    expect(
      getPoolStatus().accounts.find(account => account.accountId === 'account-one')
        ?.status,
    ).toBe('dead')
    const codes = diagnostics.map(diagnostic => diagnostic.code)
    expect(
      codes.filter(code => code === 'account.token_refresh.failed'),
    ).toHaveLength(1)
    expect(codes).toContain('account.failover.succeeded')
    expect(codes).not.toContain('quota.exhausted')
  })

  test('recovers from transient Codex connection failover without capping the failed account', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'account-one',
      accounts: [
        buildPoolAccount({ accountId: 'account-one', alias: 'main' }),
        buildPoolAccount({ accountId: 'account-two', alias: 'backup' }),
      ],
    })
    seedCodexLeaseForTest({
      ownerId: 'subagent-transient',
      ownerType: 'subagent',
      ownerLabel: 'Subagent Transient',
      accountId: 'account-one',
    })

    let attempts = 0
    for await (const _message of withRetry(
      async () => ({}) as never,
      async () => {
        attempts += 1
        if (attempts <= 2) {
          throw new APIConnectionError({ message: 'Connection error.' })
        }
        return getCodexLeaseForOwner('subagent-transient')?.accountId
      },
      {
        maxRetries: 2,
        model: 'gpt-5.4',
        thinkingConfig: { type: 'disabled' },
        ownerId: 'subagent-transient',
        isCodexRequest: true,
      } as Parameters<typeof withRetry>[2],
    )) {
      // consume retry messages
    }

    expect(attempts).toBe(3)
    expect(getCodexLeaseForOwner('subagent-transient')?.accountId).toBe(
      'account-two',
    )
    expect(
      getPoolStatus().accounts.find(account => account.accountId === 'account-one')
        ?.status,
    ).toBe('healthy')
    const codes = diagnostics.map(diagnostic => diagnostic.code)
    expect(codes).toContain('account.transient_failure')
    expect(codes).toContain('account.failover.succeeded')
  })


  test('treats ambiguous Codex websocket rejection as transient instead of quota exhaustion', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'account-one',
      accounts: [
        buildPoolAccount({ accountId: 'account-one', alias: 'main' }),
        buildPoolAccount({ accountId: 'account-two', alias: 'backup' }),
      ],
    })
    seedCodexLeaseForTest({
      ownerId: 'subagent-ws-rejection',
      ownerType: 'subagent',
      ownerLabel: 'Subagent WS Rejection',
      accountId: 'account-one',
    })

    let attempts = 0
    for await (const _message of withRetry(
      async () => ({}) as never,
      async () => {
        attempts += 1
        if (attempts <= 2) {
          throw new APIConnectionError({
            message: 'websocket closed by server before response.completed (code=1000 reason=zero_events:none)',
          })
        }
        return getCodexLeaseForOwner('subagent-ws-rejection')?.accountId
      },
      {
        maxRetries: 2,
        model: 'gpt-5.4',
        thinkingConfig: { type: 'disabled' },
        ownerId: 'subagent-ws-rejection',
        isCodexRequest: true,
      } as Parameters<typeof withRetry>[2],
    )) {
      // consume retry messages
    }

    expect(attempts).toBe(3)
    expect(getCodexLeaseForOwner('subagent-ws-rejection')?.accountId).toBe(
      'account-two',
    )
    expect(
      getPoolStatus().accounts.find(account => account.accountId === 'account-one')
        ?.status,
    ).toBe('healthy')
    const codes = diagnostics.map(diagnostic => diagnostic.code)
    expect(codes).toContain('account.transient_failure')
    expect(codes).toContain('account.failover.succeeded')
    expect(codes).not.toContain('quota.exhausted')
  })

  test('fails over to a healthy Claude account through the real auth getter path without exposing alias or email', async () => {
    seedClaudeAccountPoolForTest({
      activeAccountUuid: 'claude-one',
      accounts: [
        buildClaudeAccount({
          accountUuid: 'claude-one',
          emailAddress: 'stale@example.com',
          alias: 'stale-main',
          refreshToken: '',
          scopes: ['user:inference'],
        }),
        buildClaudeAccount({
          accountUuid: 'claude-two',
          emailAddress: 'healthy@example.com',
          alias: 'healthy-backup',
          refreshToken: '',
          scopes: ['user:inference'],
        }),
      ],
    })
    getClaudeAIOAuthTokens.cache?.clear?.()

    let attempts = 0
    let retryAccessToken: string | null | undefined
    const authError = new APIError(
      401,
      { error: { type: 'authentication_error', message: 'Unauthorized' } },
      'Unauthorized',
      new Headers(),
    )
    for await (const _message of withRetry(
      () =>
        getAnthropicClient({
          maxRetries: 1,
          model: 'claude-sonnet-4-6',
          provider: 'firstParty',
        }),
      async () => {
        attempts += 1
        if (attempts === 1) {
          throw authError
        }
        retryAccessToken = getClaudeAIOAuthTokens()?.accessToken
        return retryAccessToken
      },
      {
        model: 'claude-sonnet-4-6',
        thinkingConfig: { type: 'disabled' },
        isClaudeOAuthRequest: true,
      } as Parameters<typeof withRetry>[2],
    )) {
      // consume retry messages
    }

    expect(attempts).toBe(2)
    expect(getActiveClaudeAccount()?.accountUuid).toBe('claude-two')
    expect(retryAccessToken).toBe('claude-access-claude-two')
    expect(diagnostics.map(diagnostic => diagnostic.code)).toContain(
      'account.failover.succeeded',
    )

    const serializedDiagnostics = JSON.stringify(diagnostics)
    expect(serializedDiagnostics).not.toContain('stale@example.com')
    expect(serializedDiagnostics).not.toContain('healthy@example.com')
    expect(serializedDiagnostics).not.toContain('stale-main')
    expect(serializedDiagnostics).not.toContain('healthy-backup')
  })

  test('does not fail over Claude pool for non-Claude-OAuth 401s', async () => {
    seedClaudeAccountPoolForTest({
      activeAccountUuid: 'claude-one',
      accounts: [
        buildClaudeAccount({
          accountUuid: 'claude-one',
          emailAddress: 'healthy-one@example.com',
          alias: 'healthy-one',
          refreshToken: '',
          scopes: ['user:inference'],
        }),
        buildClaudeAccount({
          accountUuid: 'claude-two',
          emailAddress: 'healthy-two@example.com',
          alias: 'healthy-two',
          refreshToken: '',
          scopes: ['user:inference'],
        }),
      ],
    })

    const authError = new APIError(
      401,
      { error: { type: 'authentication_error', message: 'Unauthorized' } },
      'Unauthorized',
      new Headers(),
    )

    await expect(async () => {
      for await (const _message of withRetry(
        async () => ({}) as never,
        async () => {
          throw authError
        },
        {
          maxRetries: 1,
          model: 'claude-sonnet-4-6',
          thinkingConfig: { type: 'disabled' },
        } as Parameters<typeof withRetry>[2],
      )) {
        // unreachable
      }
    }).toThrow(CannotRetryError)

    expect(getActiveClaudeAccount()?.accountUuid).toBe('claude-one')
    expect(
      diagnostics.map(diagnostic => diagnostic.code),
    ).not.toContain('account.failover.succeeded')
  })

  test('emits route-selected and provider-mismatch diagnostics for Codex-routed models', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'account-one',
      accounts: [
        buildPoolAccount({ accountId: 'account-one', alias: 'main' }),
        buildPoolAccount({ accountId: 'account-two', alias: 'backup' }),
      ],
    })

    await getAnthropicClient({
      maxRetries: 1,
      model: 'gpt-5.4',
      provider: 'firstParty',
    })

    const codes = diagnostics.map(diagnostic => diagnostic.code)
    expect(codes).toContain('model.provider_mismatch')
    expect(codes).toContain('account.route.selected')
  })

  test('emits account.pool.unavailable and removes switch-account prose when no healthy Codex account exists', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'account-one',
      accounts: [
        buildPoolAccount({
          accountId: 'account-one',
          status: 'dead',
          lastError: 'refresh failed',
        }),
        buildPoolAccount({
          accountId: 'account-two',
          status: 'dead',
          lastError: 'refresh failed',
        }),
      ],
    })

    let thrown: unknown
    try {
      await getAnthropicClient({
        maxRetries: 1,
        model: 'gpt-5.4',
        provider: 'openai',
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(APIConnectionError)
    expect((thrown as Error).message).not.toContain('/switch-account')
    expect(diagnostics.map(diagnostic => diagnostic.code)).toContain(
      'account.pool.unavailable',
    )
  })
})
