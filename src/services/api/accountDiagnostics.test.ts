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
  installStreamJsonAccountDiagnosticHook,
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
