import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { APIConnectionError, APIError } from '@anthropic-ai/sdk'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  accountRecoveryTestConfigDir,
  resetAccountRecoveryTestConfig,
} from './accountRecoveryDiagnostics.test-setup.js'

const { setSessionProvider } = await import('../../bootstrap/state.js')
const {
  _resetAccountDiagnosticStreamJsonHookForTesting,
  installStreamJsonAccountDiagnosticHook,
} = await import('./accountDiagnostics.js')
const {
  getActiveClaudeAccount,
  resetClaudeAccountPoolForTest,
  seedClaudeAccountPoolForTest,
} = await import('./claudeAccountPool.js')
type ClaudePoolAccount = import('./claudeAccountPool.js').ClaudePoolAccount
const {
  CodexAccountAuthError,
  CodexAccountCapError,
  CodexResponseFailedError,
  createCodexFetch,
  resetCodexCacheContext,
} = await import('./codex-fetch-adapter.js')
const { createCodexCredentialHandle } = await import('./codexCredentialUse.js')
const {
  codexCredentialLifecycle,
  createCodexCredentialLifecycle,
} = await import('./codexCredentialLifecycle.js')
type CodexCredentialLifecycle = import('./codexCredentialLifecycle.js').CodexCredentialLifecycle
const {
  getCodexLeaseForOwner,
  resetCodexLeaseManagerForTest,
  seedCodexLeaseForTest,
} = await import('./codexAccountLeaseManager.js')
const {
  getPoolStatus,
  resetCodexAccountPoolForTest,
  seedCodexAccountPoolForTest,
} = await import('./codexAccountPool.js')
type PoolAccount = import('./codexAccountPool.js').PoolAccount
const { getAnthropicClient } = await import('./client.js')
const { getClaudeAIOAuthTokens } = await import('../../utils/auth.js')
const { _resetKeepAliveForTesting } = await import('../../utils/proxy.js')
const {
  CannotRetryError,
  CodexAccountUnavailableError,
  _resetCodexNetworkOutageDelaysForTest,
  _setCodexNetworkOutageDelaysForTest,
  withRetry,
} = await import('./withRetry.js')

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
    // Default well outside the refresh skew so token resolution does not fire an
    // incidental refresh-on-use (network + ledger writes); tests that exercise
    // refresh set a near-expiry expiresAt explicitly.
    expiresAt: overrides.expiresAt ?? Date.now() + 60 * 60_000,
    source: overrides.source ?? 'config',
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
  const accountRecoveryLifecycle = createCodexCredentialLifecycle({
    directory: join(accountRecoveryTestConfigDir, 'codex-credential-lifecycle'),
  })

  beforeEach(() => {
    resetAccountRecoveryTestConfig()
    expect(codexCredentialLifecycle.getPaths('account-one').directory).toBe(
      join(accountRecoveryTestConfigDir, 'codex-credential-lifecycle'),
    )
    expect(accountRecoveryLifecycle.read('account-one')).toEqual({
      status: 'absent',
    })
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

  test('does not retry or fail over a wrapped deterministic response.failed', async () => {
    let attempts = 0
    let thrown: unknown
    try {
      for await (const _message of withRetry(
        async () => ({}) as never,
        async () => {
          attempts += 1
          throw new APIConnectionError({
            cause: new CodexResponseFailedError({
              code: 'invalid_request_error',
              message: 'tool schema is invalid',
            }),
          })
        },
        {
          maxRetries: 3,
          model: 'gpt-5.6-luna',
          thinkingConfig: { type: 'disabled' },
          isCodexRequest: true,
        } as Parameters<typeof withRetry>[2],
      )) {
        // The failure is terminal before a retry message can be yielded.
      }
    } catch (error) {
      thrown = error
    }

    expect(attempts).toBe(1)
    expect(thrown).toBeInstanceOf(CannotRetryError)
    expect((thrown as CannotRetryError).originalError).toBeInstanceOf(
      CodexResponseFailedError,
    )
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
    _resetKeepAliveForTesting()
    _resetCodexNetworkOutageDelaysForTest()
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
          throw new APIConnectionError({
            cause: new CodexAccountCapError('account-one'),
          })
        }
        return getCodexLeaseForOwner('subagent-cap')?.accountId
      },
      {
        model: 'gpt-5.6-luna',
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
          model: 'gpt-5.6-luna',
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

    // App traffic threads the pool-authoritative resolver into the adapter, so a
    // per-request token carries source: 'pool' — that is what enables HTTP
    // credential-error classification (matching getAnthropicClient()).
    const token = buildCodexToken('account-one')
    const lifecycle = {
      read(accountId: string) {
        return {
          status: 'valid' as const,
          record: {
            version: 1 as const,
            accountId,
            credentialGeneration: 1,
            state: 'credentialed' as const,
            operationId: 'diagnostic-test',
            operationKind: 'login' as const,
            changedAt: '2026-09-12T00:00:00.000Z',
          },
        }
      },
      async withTransaction<T>(
        _accountId: string,
        _options: unknown,
        callback: (permit: never) => T | Promise<T>,
      ): Promise<T> {
        return callback({} as never)
      },
    } as unknown as CodexCredentialLifecycle
    await expect(
      createCodexFetch(createCodexCredentialHandle({
        accountId: 'account-one',
        accessToken: token,
        refreshToken: 'refresh-account-one',
        expiresAt: Date.now() + 60 * 60_000,
        credentialGeneration: 1,
        credentialSource: 'config',
      }), undefined, {
        resolveTokensForRequest: async () => ({
          accessToken: token,
          refreshToken: 'refresh-account-one',
          expiresAt: Date.now() + 60 * 60_000,
          accountId: 'account-one',
          credentialGeneration: 1,
          credentialSource: 'config',
          credentialPath: '/test/account-recovery-config.json',
          source: 'pool',
        }),
        credentialUse: { lifecycle },
      })(
        'https://api.anthropic.com/v1/messages',
        {
          method: 'POST',
          body: JSON.stringify({
            model: 'gpt-5.6-luna',
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
            expires_at: Date.now() + 60 * 60_000,
            credential_generation: 1,
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
          credentialGeneration: 1,
        }),
        buildPoolAccount({
          accountId: 'account-two',
          alias: 'backup',
          credentialGeneration: 1,
        }),
      ],
    })
    seedCodexLeaseForTest({
      ownerId: 'subagent-auth',
      ownerType: 'subagent',
      ownerLabel: 'Subagent Auth',
      accountId: 'account-one',
    })

    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      if (url.includes('/oauth/token')) {
        return new Response(
          JSON.stringify({ error: 'invalid_grant' }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      }

      const requestAccountId = new Headers(init?.headers).get('chatgpt-account-id')
      if (requestAccountId === 'account-one') {
        return new Response('', {
          status: 502,
          headers: {
            'x-openai-authorization-error': '401',
            'x-openai-ide-error-code': 'token_invalidated',
          },
        })
      }
      if (requestAccountId === 'account-two') {
        return new Response(
          [
            'event: response.output_text.delta',
            `data: ${JSON.stringify({
              type: 'response.output_text.delta',
              delta: 'recovered',
            })}`,
            '',
            'event: response.completed',
            `data: ${JSON.stringify({
              type: 'response.completed',
              response: {
                usage: {
                  input_tokens: 4,
                  output_tokens: 1,
                  input_tokens_details: { cached_tokens: 0 },
                },
              },
            })}`,
            '',
          ].join('\n'),
          {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          },
        )
      }
      throw new Error(`Unexpected account route: ${requestAccountId ?? 'none'}`)
    }) as typeof globalThis.fetch

    const lifecycle = {
      read(accountId: string) {
        return {
          status: 'valid' as const,
          record: {
            version: 1 as const,
            accountId,
            credentialGeneration: 1,
            state: 'credentialed' as const,
            operationId: 'auth-failover-test',
            operationKind: 'login' as const,
            changedAt: '2026-09-12T00:00:00.000Z',
          },
        }
      },
      async withTransaction<T>(
        _accountId: string,
        _options: unknown,
        callback: (permit: never) => T | Promise<T>,
      ): Promise<T> {
        return callback({} as never)
      },
    } as unknown as CodexCredentialLifecycle
    let attempts = 0
    try {
      for await (const _message of withRetry(
        () =>
          getAnthropicClient({
            maxRetries: 0,
            model: 'gpt-5.6-luna',
            provider: 'openai',
            codexLeaseOwnerId: 'subagent-auth',
            codexLeaseOwnerType: 'subagent',
            codexConversationIdOverride: 'conv_auth_recovery_sdk',
            codexCredentialUse: { lifecycle },
          }),
        async client => {
          attempts += 1
          await client.beta.messages.create({
            model: 'gpt-5.6-luna',
            max_tokens: 16,
            stream: true,
            messages: [{ role: 'user', content: 'probe' }],
            _openaiInstructionAssembly: {
              instructions: 'probe',
              inputMessages: [],
            },
          } as never).withResponse()
          return getCodexLeaseForOwner('subagent-auth')?.accountId
        },
        {
          model: 'gpt-5.6-luna',
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
    expect(codes).not.toContain('account.transient_failure')
  })

  test('binds Codex auth recovery to the request account after the lease has moved off it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-auth-lease-moved-'))
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
      activeAccountId: 'account-two',
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
    // The owner's lease has already moved to account-two (a concurrent failover)
    // by the time the delayed 401 from account-one lands. Recovery must condemn
    // account-one (the request account), NOT the account the lease now holds.
    seedCodexLeaseForTest({
      ownerId: 'subagent-lease-moved',
      ownerType: 'subagent',
      ownerLabel: 'Subagent Lease Moved',
      accountId: 'account-two',
    })

    // Force the account-one forced refresh to fail so recovery reaches dead-mark.
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({ error: 'invalid_grant' }),
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
          return getCodexLeaseForOwner('subagent-lease-moved')?.accountId
        },
        {
          model: 'gpt-5.6-luna',
          thinkingConfig: { type: 'disabled' },
          ownerId: 'subagent-lease-moved',
          isCodexRequest: true,
        } as Parameters<typeof withRetry>[2],
      )) {
        // consume retry messages
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }

    expect(attempts).toBe(2)
    // The failed request account is condemned...
    expect(
      getPoolStatus().accounts.find(account => account.accountId === 'account-one')
        ?.status,
    ).toBe('dead')
    // ...and the account the lease moved to is left untouched (the fix).
    expect(
      getPoolStatus().accounts.find(account => account.accountId === 'account-two')
        ?.status,
    ).toBe('healthy')
    // The lease is not failed over again — the retry runs on its current account.
    expect(getCodexLeaseForOwner('subagent-lease-moved')?.accountId).toBe(
      'account-two',
    )
    const codes = diagnostics.map(diagnostic => diagnostic.code)
    expect(codes).not.toContain('quota.exhausted')
    expect(codes).not.toContain('account.failover.succeeded')
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
        model: 'gpt-5.6-luna',
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

  test('yields an api_retry system message before retrying a Codex connection-error failover', async () => {
    seedCodexAccountPoolForTest({
      activeAccountId: 'account-one',
      accounts: [
        buildPoolAccount({ accountId: 'account-one', alias: 'main' }),
        buildPoolAccount({ accountId: 'account-two', alias: 'backup' }),
      ],
    })
    seedCodexLeaseForTest({
      ownerId: 'subagent-backoff',
      ownerType: 'subagent',
      ownerLabel: 'Subagent Backoff',
      accountId: 'account-one',
    })

    let attempts = 0
    const yields: Array<unknown> = []
    for await (const message of withRetry(
      async () => ({}) as never,
      async () => {
        attempts += 1
        if (attempts <= 2) {
          throw new APIConnectionError({ message: 'Connection error.' })
        }
        return getCodexLeaseForOwner('subagent-backoff')?.accountId
      },
      {
        maxRetries: 2,
        model: 'gpt-5.6-luna',
        thinkingConfig: { type: 'disabled' },
        ownerId: 'subagent-backoff',
        isCodexRequest: true,
      } as Parameters<typeof withRetry>[2],
    )) {
      yields.push(message)
    }

    expect(attempts).toBe(3)
    // The failover path must surface a retry message so the UI sees the wait
    // instead of a silent reconnect attempt.
    const apiErrorYields = yields.filter(
      message =>
        (message as { type?: string; subtype?: string }).type === 'system' &&
        (message as { subtype?: string }).subtype === 'api_error',
    )
    expect(apiErrorYields.length).toBeGreaterThanOrEqual(1)
    expect(
      (apiErrorYields[0] as { retryInMs: number }).retryInMs,
    ).toBeGreaterThan(0)
  })

  test('treats repeated APIConnectionError across distinct Codex accounts as a network outage', async () => {
    _setCodexNetworkOutageDelaysForTest(10, 20)
    try {
      seedCodexAccountPoolForTest({
        activeAccountId: 'account-one',
        accounts: [
          buildPoolAccount({ accountId: 'account-one', alias: 'main' }),
          buildPoolAccount({ accountId: 'account-two', alias: 'backup' }),
        ],
      })
      seedCodexLeaseForTest({
        ownerId: 'subagent-outage',
        ownerType: 'subagent',
        ownerLabel: 'Subagent Outage',
        accountId: 'account-one',
      })

      let attempts = 0
      // Attempt 1: lease=account-one fails → normal retry (attempt < 2)
      // Attempt 2: lease=account-one fails → failover-block: set={one}, size=1, normal lease failover to account-two
      // Attempt 3: lease=account-two fails → failover-block: set={one,two}, size=2, NETWORK OUTAGE path
      // Attempt 4: lease=account-two succeeds
      for await (const _message of withRetry(
        async () => ({}) as never,
        async () => {
          attempts += 1
          if (attempts <= 3) {
            throw new APIConnectionError({ message: 'Connection error.' })
          }
          return getCodexLeaseForOwner('subagent-outage')?.accountId
        },
        {
          maxRetries: 4,
          model: 'gpt-5.6-luna',
          thinkingConfig: { type: 'disabled' },
          ownerId: 'subagent-outage',
          isCodexRequest: true,
        } as Parameters<typeof withRetry>[2],
      )) {
        // consume retry messages
      }

      expect(attempts).toBe(4)
      // Both accounts that hit the connection error stay healthy — this isn't
      // an account problem.
      for (const accountId of ['account-one', 'account-two']) {
        expect(
          getPoolStatus().accounts.find(account => account.accountId === accountId)
            ?.status,
        ).toBe('healthy')
      }
      const outageReasons = diagnostics
        .filter(diagnostic => diagnostic.code === 'account.transient_failure')
        .map(diagnostic => diagnostic.reason as string | undefined)
      expect(
        outageReasons.some(reason =>
          reason?.includes('suspected network outage'),
        ),
      ).toBe(true)
    } finally {
      _resetCodexNetworkOutageDelaysForTest()
    }
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
        model: 'gpt-5.6-luna',
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
      model: 'gpt-5.6-luna',
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
        model: 'gpt-5.6-luna',
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
    // The emitted diagnostic and the durable classification are two
    // projections of one verdict; a dead pool needs repair, not a resume.
    expect((thrown as CodexAccountUnavailableError).terminalCode).toBe(
      'account_recovery',
    )
  })

  test('a network failure during token refresh persists transient_network, not account_recovery', async () => {
    // The auth path already decides a non-auth refresh failure is a connection
    // problem and quarantines the account for retry rather than dead-marking
    // it. The durable classification must agree: calling this `account_recovery`
    // sends the user to repair credentials that were never rejected.
    const dir = mkdtempSync(join(tmpdir(), 'codex-refresh-network-'))
    const accountsDir = join(dir, 'accounts')
    mkdirSync(accountsDir, { recursive: true })
    const accountPath = join(accountsDir, 'account-one.json')
    writeFileSync(
      accountPath,
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
          vaultFilePath: accountPath,
          refreshToken: 'refresh-account-one',
        }),
        // Dead: leaves nothing to rotate to, so the auth path goes terminal.
        buildPoolAccount({ accountId: 'account-two', status: 'dead' }),
      ],
    })

    globalThis.fetch = (async input => {
      const url = String(input)
      if (url.includes('/oauth/token')) {
        // Backend outage, NOT a credential rejection.
        return new Response('upstream unavailable', { status: 503 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof globalThis.fetch

    let thrown: unknown
    try {
      for await (const _message of withRetry(
        async () => ({}) as never,
        async () => {
          throw new CodexAccountAuthError('account-one')
        },
        {
          maxRetries: 0,
          model: 'gpt-5.6-luna',
          thinkingConfig: { type: 'disabled' },
          isCodexRequest: true,
        } as Parameters<typeof withRetry>[2],
      )) {
        // unreachable
      }
    } catch (error) {
      thrown = error
    }

    rmSync(dir, { recursive: true, force: true })

    // Precondition: the refresh failure was treated as a connection problem.
    expect(
      getPoolStatus().accounts.find(
        account => account.accountId === 'account-one',
      )?.status,
    ).toBe('quarantined')

    expect(thrown).toBeInstanceOf(CannotRetryError)
    expect((thrown as CannotRetryError).deferredTerminalFailure).toMatchObject({
      version: 1,
      provider: 'openai',
      code: 'transient_network',
    })
  })

  test('a Codex-unavailable client failure persists the pool verdict, not transient_network', async () => {
    // client.ts already knows why no account can serve the request and says so
    // in the diagnostic. Throwing a bare APIConnectionError let withRetry
    // re-infer `transient_network` from the error class, so the diagnostic and
    // the durable envelope disagreed about wait-for-reset vs needs-repair.
    seedCodexAccountPoolForTest({
      activeAccountId: 'account-one',
      accounts: [
        buildPoolAccount({
          accountId: 'account-one',
          status: 'capped',
          statusReason: 'usage_cap',
          cappedAt: Date.now(),
        }),
        buildPoolAccount({
          accountId: 'account-two',
          status: 'capped',
          statusReason: 'usage_cap',
          cappedAt: Date.now(),
        }),
      ],
    })

    let thrown: unknown
    try {
      for await (const _message of withRetry(
        () =>
          getAnthropicClient({
            maxRetries: 0,
            model: 'gpt-5.6-luna',
            provider: 'openai',
          }),
        async () => ({}) as never,
        {
          maxRetries: 0,
          model: 'gpt-5.6-luna',
          thinkingConfig: { type: 'disabled' },
          isCodexRequest: true,
        } as Parameters<typeof withRetry>[2],
      )) {
        // unreachable — the client never resolves
      }
    } catch (error) {
      thrown = error
    }

    expect(diagnostics.map(diagnostic => diagnostic.code)).toContain(
      'quota.exhausted',
    )
    expect(thrown).toBeInstanceOf(CannotRetryError)
    expect((thrown as CannotRetryError).deferredTerminalFailure).toMatchObject({
      version: 1,
      provider: 'openai',
      code: 'quota_exhausted',
    })
  })

  test('a half-dead pool capping its last live account reports needs-repair, not wait-for-reset', async () => {
    // One account is dead (auth), the other returns 429. The pool is NOT fully
    // capped, so re-authenticating the dead account restores service; waiting
    // for a quota reset never would. The diagnostic and the durable envelope
    // must both say so.
    seedCodexAccountPoolForTest({
      activeAccountId: 'account-one',
      accounts: [
        buildPoolAccount({ accountId: 'account-one', alias: 'main' }),
        buildPoolAccount({
          accountId: 'account-two',
          alias: 'backup',
          status: 'dead',
          lastError: 'credentials rejected',
        }),
      ],
    })

    let thrown: unknown
    try {
      for await (const _message of withRetry(
        async () => ({}) as never,
        async () => {
          throw new CodexAccountCapError('account-one')
        },
        {
          maxRetries: 0,
          model: 'gpt-5.6-luna',
          thinkingConfig: { type: 'disabled' },
          isCodexRequest: true,
        } as Parameters<typeof withRetry>[2],
      )) {
        // unreachable
      }
    } catch (error) {
      thrown = error
    }

    // Precondition: the 429 capped the live account and nothing rotated.
    expect(
      getPoolStatus().accounts.find(
        account => account.accountId === 'account-one',
      )?.status,
    ).toBe('capped')

    const codes = diagnostics.map(diagnostic => diagnostic.code)
    expect(codes).toContain('account.pool.unavailable')
    expect(codes).not.toContain('quota.exhausted')
    expect(thrown).toBeInstanceOf(CannotRetryError)
    expect((thrown as CannotRetryError).deferredTerminalFailure).toMatchObject({
      version: 1,
      provider: 'openai',
      code: 'account_recovery',
    })
  })
})
