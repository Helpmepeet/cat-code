import { readFileSync } from 'fs'

import { afterEach, describe, expect, test } from 'bun:test'

import { SDKAccountDiagnosticMessageSchema } from '../../entrypoints/sdk/coreSchemas.js'
import type { SDKAccountDiagnosticMessage } from '../../entrypoints/sdk/coreTypes.generated.js'
import type { AccountDiagnosticEvent } from './accountDiagnostics.js'
import {
  ACCOUNT_DIAGNOSTIC_MARKER,
  _resetAccountDiagnosticStreamJsonHookForTesting,
  buildAccountDiagnosticMessage,
  emitAccountDiagnostic,
  formatAccountDiagnosticStderrLine,
  hasAccountDiagnosticSink,
  installStreamJsonAccountDiagnosticHook,
  withStreamJsonAccountDiagnosticHook,
} from './accountDiagnostics.js'

const email = 'person@example.com'
const accountId = '123e4567-e89b-12d3-a456-426614174000'
const alias = 'prod-primary'
const accessToken = 'access_token=tok_live_secret_123456789'
const refreshToken = 'refresh_token=refresh_live_secret_987654321'
const idToken = 'id_token=eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjM0In0.signature'
const apiKey = 'api_key=sk-live-secret-abcdef123456'
const authorization = 'Authorization: Bearer bearer-secret-token-123456'
const rawAccountFile = JSON.stringify({
  account_id: accountId,
  email,
  alias,
  access_token: 'tok_live_secret_123456789',
  refresh_token: 'refresh_live_secret_987654321',
  id_token: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjM0In0.signature',
})

const rawDiagnostic = {
  code: 'account.transient_failure' as const,
  severity: 'error' as const,
  provider: 'openai' as const,
  recoverable: true,
  account_ref: `alias=${alias} email=${email} account_id=${accountId}`,
  reason: [accessToken, refreshToken, idToken, apiKey, authorization].join(' | '),
  user_message: rawAccountFile,
}

const goldenDiagnosticInputs = [
  {
    code: 'account.route.selected',
    severity: 'info',
    provider: 'openai',
    recoverable: true,
    pool: `codex#1 alias=${alias} email=${email}`,
    requested_model: 'gpt-5.4',
    resolved_provider: 'openai',
    resolved_model: 'gpt-5.4',
    account_ref: `alias=${alias} email=${email} account_id=${accountId}`,
    counts: { healthy: 1, capped: 2, total: 3 },
    reason: `selected ${accessToken}`,
  },
  {
    code: 'account.failover.succeeded',
    severity: 'info',
    provider: 'openai',
    recoverable: true,
    counts: { healthy: 1, dead: 1, total: 2 },
    account_ref: `alias=${alias} email=${email} account_id=${accountId}`,
    reason: `switched after ${refreshToken}`,
  },
  {
    code: 'account.transient_failure',
    severity: 'warning',
    provider: 'openai',
    recoverable: true,
    account_ref: `alias=${alias} email=${email} account_id=${accountId}`,
    reason: `Connection reset; ${authorization}`,
  },
  {
    code: 'account.token_refresh.failed',
    severity: 'warning',
    provider: 'anthropic',
    recoverable: true,
    requested_model: 'claude-sonnet-4-6',
    resolved_provider: 'anthropic',
    resolved_model: 'claude-sonnet-4-6',
    account_ref: `email=${email} account_id=${accountId}`,
    reason: `oauth refresh failed: ${idToken}`,
    user_message: rawAccountFile,
  },
  {
    code: 'account.identity_mismatch',
    severity: 'warning',
    provider: 'openai',
    recoverable: true,
    pool: 'codex',
    requested_model: 'gpt-5.4',
    resolved_provider: 'openai',
    resolved_model: 'gpt-5.4',
    counts: { healthy: 2, dead: 1, total: 3 },
    from_account_ref: `alias=old-${alias} email=${email} account_id=${accountId}`,
    account_ref: `alias=new-${alias} email=${email} account_id=223e4567-e89b-12d3-a456-426614174000`,
    reason: `refresh returned different account 223e4567-e89b-12d3-a456-426614174000`,
  },
  {
    code: 'account.manual_switch',
    severity: 'info',
    provider: 'openai',
    recoverable: true,
    pool: 'codex',
    requested_model: 'gpt-5.4',
    resolved_provider: 'openai',
    resolved_model: 'gpt-5.4',
    account_ref: `alias=${alias} email=${email} account_id=${accountId}`,
    reason: 'manual switch succeeded',
  },
  {
    code: 'account.active.reroll',
    severity: 'warning',
    provider: 'openai',
    recoverable: true,
    pool: 'codex',
    counts: { healthy: 2, dead: 1, total: 3 },
    from_account_ref: `alias=old-${alias} email=${email} account_id=${accountId}`,
    account_ref: `alias=new-${alias} email=${email} account_id=223e4567-e89b-12d3-a456-426614174000`,
    reason: `markAccountDead rerolled active account after ${authorization}`,
  },
  {
    code: 'account.lease.failover',
    severity: 'info',
    provider: 'openai',
    recoverable: true,
    pool: 'codex',
    from_account_ref: `alias=old-${alias} email=${email} account_id=${accountId}`,
    account_ref: `alias=new-${alias} email=${email} account_id=323e4567-e89b-12d3-a456-426614174000`,
    reason: `lease reassigned after ${refreshToken}`,
  },
  {
    code: 'account.usage.cap',
    severity: 'warning',
    provider: 'openai',
    recoverable: true,
    pool: 'codex',
    counts: { healthy: 1, capped: 1, total: 2 },
    account_ref: `alias=${alias} email=${email} account_id=${accountId}`,
    reason: `usage cap observed from ${authorization}`,
  },
  {
    code: 'account.usage.uncap',
    severity: 'info',
    provider: 'openai',
    recoverable: true,
    pool: 'codex',
    counts: { healthy: 2, total: 2 },
    account_ref: `alias=${alias} email=${email} account_id=${accountId}`,
    reason: `usage cap cleared after ${refreshToken}`,
  },
  {
    code: 'account.usage.warning',
    severity: 'warning',
    provider: 'openai',
    recoverable: true,
    counts: { healthy: 1, capped: 0, dead: 0, locked: 0, total: 1 },
    account_ref: 'codex#1',
    reason: `near cap for alias=${alias} email=${email} account_id=${accountId} ${accessToken}`,
  },
  {
    code: 'account.retry.exhausted',
    severity: 'error',
    provider: 'openai',
    recoverable: false,
    pool: 'codex',
    requested_model: 'gpt-5.4',
    resolved_provider: 'openai',
    resolved_model: 'gpt-5.4',
    counts: { healthy: 3, total: 3 },
    account_ref: `alias=${alias} email=${email} account_id=${accountId}`,
    reason: `retry chain exhausted after attempts=2: ${apiKey}`,
  },
  {
    code: 'account.pool.unavailable',
    severity: 'error',
    provider: 'openai',
    recoverable: false,
    pool: `codex alias=${alias}`,
    requested_model: 'gpt-5.4',
    resolved_provider: 'openai',
    resolved_model: 'gpt-5.4',
    counts: { dead: 2, total: 2 },
    reason: `no healthy account_id=${accountId}`,
  },
  {
    code: 'quota.exhausted',
    severity: 'error',
    provider: 'openai',
    recoverable: false,
    pool: 'codex',
    requested_model: 'gpt-5.4',
    resolved_provider: 'openai',
    resolved_model: 'gpt-5.4',
    counts: { capped: 4, total: 4 },
    reason: `all accounts capped for alias=${alias}`,
  },
  {
    code: 'auth.missing',
    severity: 'error',
    provider: 'anthropic',
    recoverable: false,
    pool: `claude#2 email=${email}`,
    requested_model: 'claude-sonnet-4-6',
    resolved_provider: 'anthropic',
    resolved_model: 'claude-sonnet-4-6',
    reason: authorization,
    user_message: rawAccountFile,
  },
  {
    code: 'model.provider_mismatch',
    severity: 'warning',
    provider: 'anthropic',
    recoverable: true,
    requested_model: 'gpt-5.4',
    resolved_provider: 'anthropic',
    resolved_model: 'claude-sonnet-4-6',
    reason: `request provider resolved to anthropic using ${apiKey}`,
  },
] as const satisfies readonly AccountDiagnosticEvent[]

const goldenDiagnosticFixtures = (
  JSON.parse(
    readFileSync(
      new URL('./cat-code-account-diagnostics.golden.json', import.meta.url),
      'utf-8',
    ),
  ) as unknown[]
).map(fixture =>
  SDKAccountDiagnosticMessageSchema().parse(fixture),
) as SDKAccountDiagnosticMessage[]

const sensitiveValues = [
  email,
  accountId,
  alias,
  accessToken,
  refreshToken,
  idToken,
  apiKey,
  authorization,
  rawAccountFile,
]

const realStderrWrite = process.stderr.write

function diagnosticBodyFromFixture(fixture: SDKAccountDiagnosticMessage): Record<string, unknown> {
  const { type, subtype, uuid, session_id, ...body } = fixture
  expect(type).toBe('system')
  expect(subtype).toBe('cat_code_account_diagnostic')
  expect(uuid).toBeDefined()
  expect(session_id).toBeDefined()
  return body
}

function parseStderrDiagnosticBody(line: string): Record<string, unknown> {
  expect(line.startsWith(`${ACCOUNT_DIAGNOSTIC_MARKER} `)).toBe(true)
  return JSON.parse(line.slice(`${ACCOUNT_DIAGNOSTIC_MARKER} `.length).trim()) as Record<
    string,
    unknown
  >
}

describe('accountDiagnostics', () => {
  afterEach(() => {
    _resetAccountDiagnosticStreamJsonHookForTesting()
    process.stderr.write = realStderrWrite
  })

  test('sanitizes SDK messages and stderr fallback lines', () => {
    const message = buildAccountDiagnosticMessage(rawDiagnostic, {
      sessionId: 'session-account-diagnostic',
      uuid: '123e4567-e89b-12d3-a456-426614174001',
    })
    const serializedMessage = JSON.stringify(message)

    expect(SDKAccountDiagnosticMessageSchema().safeParse(message).success).toBe(
      true,
    )

    const stderrLine = formatAccountDiagnosticStderrLine(rawDiagnostic)
    expect(stderrLine.startsWith(`${ACCOUNT_DIAGNOSTIC_MARKER} `)).toBe(true)

    for (const sensitiveValue of sensitiveValues) {
      expect(serializedMessage).not.toContain(sensitiveValue)
      expect(stderrLine).not.toContain(sensitiveValue)
    }
  })

  test('emits every diagnostic code through the real emitter and matches the golden sanitized fixtures', () => {
    const emittedMessages: unknown[] = []
    installStreamJsonAccountDiagnosticHook({
      emit: message => {
        emittedMessages.push(message)
      },
      getSessionId: () => 'sess-cat-code-fixture',
      createUuid: () => `diag-fixture-${emittedMessages.length + 1}`,
    })

    for (const diagnostic of goldenDiagnosticInputs) {
      emitAccountDiagnostic(diagnostic)
    }

    const parsedMessages = emittedMessages.map(message =>
      SDKAccountDiagnosticMessageSchema().parse(message),
    )
    expect(parsedMessages).toEqual(goldenDiagnosticFixtures)
    expect(parsedMessages.map(message => message.code)).toEqual(
      goldenDiagnosticInputs.map(diagnostic => diagnostic.code),
    )

    const expectedStderrBodies = goldenDiagnosticFixtures.map(diagnosticBodyFromFixture)
    const actualStderrBodies = goldenDiagnosticInputs.map(diagnostic =>
      parseStderrDiagnosticBody(formatAccountDiagnosticStderrLine(diagnostic)),
    )
    expect(actualStderrBodies).toEqual(expectedStderrBodies)

    const serializedDiagnostics = JSON.stringify({
      parsedMessages,
      actualStderrBodies,
    })
    for (const sensitiveValue of sensitiveValues) {
      expect(serializedDiagnostics).not.toContain(sensitiveValue)
    }
  })

  test('limits account.usage.warning to aggregate counts and an opaque account ref', () => {
    const message = buildAccountDiagnosticMessage(
      {
        code: 'account.usage.warning',
        severity: 'warning',
        provider: 'openai',
        recoverable: true,
        pool: `codex alias=${alias}`,
        requested_model: 'gpt-5.4',
        resolved_provider: 'openai',
        resolved_model: 'gpt-5.4',
        counts: {
          total: 2,
          healthy: 1,
          capped: 1,
          dead: 0,
          locked: 0,
          ignoredNaN: Number.NaN,
        },
        from_account_ref: `alias=${alias} email=${email} account_id=${accountId}`,
        account_ref: 'codex#7',
        reason: `near cap for alias=${alias} email=${email} account_id=${accountId} ${accessToken}`,
        user_message: rawAccountFile,
      },
      {
        sessionId: 'usage-warning-session',
        uuid: 'usage-warning-diagnostic',
      },
    )

    expect(message).toEqual({
      type: 'system',
      subtype: 'cat_code_account_diagnostic',
      uuid: 'usage-warning-diagnostic',
      session_id: 'usage-warning-session',
      version: 1,
      code: 'account.usage.warning',
      severity: 'warning',
      provider: 'openai',
      recoverable: true,
      counts: {
        total: 2,
        healthy: 1,
        capped: 1,
        dead: 0,
        locked: 0,
      },
      account_ref: 'codex#7',
    })

    const serializedMessage = JSON.stringify(message)
    for (const sensitiveValue of sensitiveValues) {
      expect(serializedMessage).not.toContain(sensitiveValue)
    }
  })

  test('accepts and formats all Patch 5 diagnostic codes', () => {
    const patch5Diagnostics = [
      'account.manual_switch',
      'account.active.reroll',
      'account.lease.failover',
      'account.usage.cap',
      'account.usage.uncap',
      'account.retry.exhausted',
    ] as const

    for (const code of patch5Diagnostics) {
      const diagnostic: AccountDiagnosticEvent = {
        code,
        severity: code === 'account.retry.exhausted' ? 'error' : 'info',
        provider: 'openai',
        recoverable: code !== 'account.retry.exhausted',
        account_ref: `account_id=${accountId}`,
        reason: 'patch 5 validator coverage',
      }

      const message = buildAccountDiagnosticMessage(diagnostic, {
        sessionId: 'patch-5-session',
        uuid: `patch-5-${code}`,
      })
      expect(SDKAccountDiagnosticMessageSchema().safeParse(message).success).toBe(
        true,
      )
      expect(formatAccountDiagnosticStderrLine(diagnostic)).toContain(code)
    }
  })

  test('does not write raw stderr without an installed diagnostic sink by default', () => {
    const stderrChunks: string[] = []
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(
        typeof chunk === 'string'
          ? chunk
          : Buffer.from(chunk).toString('utf-8'),
      )
      return true
    }) as typeof process.stderr.write

    emitAccountDiagnostic(rawDiagnostic)

    expect(stderrChunks).toEqual([])
  })

  test('supports explicit stderr fallback for unrecoverable early diagnostics', () => {
    const stderrChunks: string[] = []
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(
        typeof chunk === 'string'
          ? chunk
          : Buffer.from(chunk).toString('utf-8'),
      )
      return true
    }) as typeof process.stderr.write

    emitAccountDiagnostic(rawDiagnostic, { allowStderrFallback: true })

    expect(stderrChunks.join('').startsWith(`${ACCOUNT_DIAGNOSTIC_MARKER} `)).toBe(true)
  })

  test('uses the latest installed sink and restores previous sinks when removed', () => {
    const firstSinkMessages: unknown[] = []
    const secondSinkMessages: unknown[] = []

    const removeFirstSink = installStreamJsonAccountDiagnosticHook({
      emit: message => {
        firstSinkMessages.push(message)
      },
      getSessionId: () => 'session-first-sink',
      createUuid: () => `first-sink-${firstSinkMessages.length + 1}`,
    })
    const removeSecondSink = installStreamJsonAccountDiagnosticHook({
      emit: message => {
        secondSinkMessages.push(message)
      },
      getSessionId: () => 'session-second-sink',
      createUuid: () => `second-sink-${secondSinkMessages.length + 1}`,
    })

    expect(hasAccountDiagnosticSink()).toBe(true)

    emitAccountDiagnostic(rawDiagnostic)

    expect(firstSinkMessages).toHaveLength(0)
    expect(secondSinkMessages).toHaveLength(1)

    removeSecondSink()
    emitAccountDiagnostic(rawDiagnostic)

    expect(firstSinkMessages).toHaveLength(1)
    expect(secondSinkMessages).toHaveLength(1)

    removeFirstSink()

    expect(hasAccountDiagnosticSink()).toBe(false)

    emitAccountDiagnostic(rawDiagnostic)

    expect(firstSinkMessages).toHaveLength(1)
    expect(secondSinkMessages).toHaveLength(1)
  })

  test('uses scoped sinks as the sole recipient and restores the global sink afterward', async () => {
    const globalSinkMessages: unknown[] = []
    const scopedSinkMessages: unknown[] = []

    installStreamJsonAccountDiagnosticHook({
      emit: message => {
        globalSinkMessages.push(message)
      },
      getSessionId: () => 'session-global-sink',
      createUuid: () => `global-sink-${globalSinkMessages.length + 1}`,
    })

    await withStreamJsonAccountDiagnosticHook(
      {
        emit: message => {
          scopedSinkMessages.push(message)
        },
        getSessionId: () => 'session-scoped-sink',
        createUuid: () => `scoped-sink-${scopedSinkMessages.length + 1}`,
      },
      async () => {
        emitAccountDiagnostic(rawDiagnostic)
      },
    )

    expect(globalSinkMessages).toHaveLength(0)
    expect(scopedSinkMessages).toHaveLength(1)

    emitAccountDiagnostic(rawDiagnostic)

    expect(globalSinkMessages).toHaveLength(1)
    expect(scopedSinkMessages).toHaveLength(1)
  })

  test('deactivates scoped sinks after synchronous callback throws', async () => {
    const globalSinkMessages: unknown[] = []
    const scopedSinkMessages: unknown[] = []
    let resolveLateDiagnostic: (() => void) | undefined
    const lateDiagnosticEmitted = new Promise<void>(resolve => {
      resolveLateDiagnostic = resolve
    })

    installStreamJsonAccountDiagnosticHook({
      emit: message => {
        globalSinkMessages.push(message)
      },
      getSessionId: () => 'session-global-sink',
      createUuid: () => `global-sink-${globalSinkMessages.length + 1}`,
    })

    expect(() =>
      withStreamJsonAccountDiagnosticHook(
        {
          emit: message => {
            scopedSinkMessages.push(message)
          },
          getSessionId: () => 'session-scoped-sink',
          createUuid: () => `scoped-sink-${scopedSinkMessages.length + 1}`,
        },
        () => {
          setTimeout(() => {
            emitAccountDiagnostic(rawDiagnostic)
            resolveLateDiagnostic?.()
          }, 0)
          throw new Error('sync failure')
        },
      ),
    ).toThrow('sync failure')

    await lateDiagnosticEmitted

    expect(globalSinkMessages).toHaveLength(1)
    expect(scopedSinkMessages).toHaveLength(0)
  })

  test('emits sanitized stream-json system messages through the internal hook', () => {
    const stderrChunks: string[] = []
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(
        typeof chunk === 'string'
          ? chunk
          : Buffer.from(chunk).toString('utf-8'),
      )
      return true
    }) as typeof process.stderr.write

    const emittedMessages: unknown[] = []
    installStreamJsonAccountDiagnosticHook({
      emit: message => {
        emittedMessages.push(message)
      },
      getSessionId: () => 'session-hook',
      createUuid: () => '123e4567-e89b-12d3-a456-426614174002',
    })

    emitAccountDiagnostic(rawDiagnostic)

    expect(emittedMessages).toHaveLength(1)

    const emitted = SDKAccountDiagnosticMessageSchema().parse(emittedMessages[0])
    const serializedEmitted = JSON.stringify(emitted)
    for (const sensitiveValue of sensitiveValues) {
      expect(serializedEmitted).not.toContain(sensitiveValue)
      expect(stderrChunks.join('')).not.toContain(sensitiveValue)
    }

    expect(stderrChunks).toEqual([])
  })

  test('leaves malformed and spoofed stderr marker lines on stderr without emitting SDK messages', () => {
    const stderrChunks: string[] = []
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(
        typeof chunk === 'string'
          ? chunk
          : Buffer.from(chunk).toString('utf-8'),
      )
      return true
    }) as typeof process.stderr.write

    const emittedMessages: unknown[] = []
    installStreamJsonAccountDiagnosticHook({
      emit: message => {
        emittedMessages.push(message)
      },
      getSessionId: () => 'session-hook',
      createUuid: () => '123e4567-e89b-12d3-a456-426614174003',
    })

    const spoofedLine = `${ACCOUNT_DIAGNOSTIC_MARKER} ${JSON.stringify({
      version: 1,
      code: 'account.route.selected',
      severity: 'info',
      provider: 'openai',
      recoverable: true,
    })}\n`
    const malformedLine = `${ACCOUNT_DIAGNOSTIC_MARKER} {not-json}\n`

    process.stderr.write(spoofedLine)
    process.stderr.write(malformedLine)

    expect(emittedMessages).toEqual([])
    expect(stderrChunks.join('')).toBe(spoofedLine + malformedLine)
  })
})
