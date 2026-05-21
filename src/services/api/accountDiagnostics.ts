import { createHash, randomUUID } from 'crypto'
import { AsyncLocalStorage } from 'async_hooks'

import type {
  SDKAccountDiagnosticCode,
  SDKAccountDiagnosticMessage,
  SDKAccountDiagnosticProvider,
  SDKAccountDiagnosticSeverity,
} from '../../entrypoints/sdk/coreTypes.generated.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'

export const ACCOUNT_DIAGNOSTIC_MARKER = 'CAT_CODE_DIAGNOSTIC'

const ACCOUNT_DIAGNOSTIC_CODES = [
  'account.route.selected',
  'account.failover.succeeded',
  'account.transient_failure',
  'account.token_refresh.failed',
  'account.identity_mismatch',
  'account.manual_switch',
  'account.active.reroll',
  'account.lease.failover',
  'account.usage.cap',
  'account.usage.uncap',
  'account.retry.exhausted',
  'account.pool.unavailable',
  'quota.exhausted',
  'auth.missing',
  'model.provider_mismatch',
] as const satisfies readonly SDKAccountDiagnosticCode[]

const ACCOUNT_DIAGNOSTIC_SEVERITIES = [
  'info',
  'warning',
  'error',
] as const satisfies readonly SDKAccountDiagnosticSeverity[]

const ACCOUNT_DIAGNOSTIC_PROVIDERS = [
  'openai',
  'anthropic',
  'unknown',
] as const satisfies readonly SDKAccountDiagnosticProvider[]

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b/g
const API_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{10,}\b/g

const JSON_FIELD_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  {
    pattern: /("(?:email)"\s*:\s*")([^"]*)(")/gi,
    label: 'email',
  },
  {
    pattern: /("(?:account_id|accountId)"\s*:\s*")([^"]*)(")/gi,
    label: 'account-id',
  },
  {
    pattern: /("(?:alias|aliases)"\s*:\s*")([^"]*)(")/gi,
    label: 'alias',
  },
  {
    pattern: /("(?:access_token|accessToken)"\s*:\s*")([^"]*)(")/gi,
    label: 'access-token',
  },
  {
    pattern: /("(?:refresh_token|refreshToken)"\s*:\s*")([^"]*)(")/gi,
    label: 'refresh-token',
  },
  {
    pattern: /("(?:id_token|idToken)"\s*:\s*")([^"]*)(")/gi,
    label: 'id-token',
  },
  {
    pattern: /("(?:api_key|apiKey)"\s*:\s*")([^"]*)(")/gi,
    label: 'api-key',
  },
  {
    pattern: /("authorization"\s*:\s*")([^"]*)(")/gi,
    label: 'authorization',
  },
]

const KEY_VALUE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  {
    pattern: /(\b(?:email)\b\s*[=:]\s*"?)([^"\s,|}]+)("?)/gi,
    label: 'email',
  },
  {
    pattern:
      /(\b(?:account[_ -]?id|accountId)\b\s*[=:]\s*"?)([^"\s,|}]+)("?)/gi,
    label: 'account-id',
  },
  {
    pattern: /(\b(?:alias|aliases)\b\s*[=:]\s*"?)([^"\s,|}]+)("?)/gi,
    label: 'alias',
  },
  {
    pattern:
      /(\b(?:access[_ -]?token|accessToken)\b\s*[=:]\s*"?)([^"\s,|}]+)("?)/gi,
    label: 'access-token',
  },
  {
    pattern:
      /(\b(?:refresh[_ -]?token|refreshToken)\b\s*[=:]\s*"?)([^"\s,|}]+)("?)/gi,
    label: 'refresh-token',
  },
  {
    pattern: /(\b(?:id[_ -]?token|idToken)\b\s*[=:]\s*"?)([^"\s,|}]+)("?)/gi,
    label: 'id-token',
  },
  {
    pattern: /(\b(?:api[_ -]?key|apiKey)\b\s*[=:]\s*"?)([^"\s,|}]+)("?)/gi,
    label: 'api-key',
  },
  {
    pattern: /(\bAuthorization\b\s*:\s*Bearer\s+)([^\s,|}]+)("?)/gi,
    label: 'authorization',
  },
  {
    pattern: /(\bBearer\s+)([^\s,|}]+)("?)/gi,
    label: 'authorization',
  },
]

export type AccountDiagnosticEvent = {
  version?: 1
  code: SDKAccountDiagnosticCode
  severity: SDKAccountDiagnosticSeverity
  provider: SDKAccountDiagnosticProvider
  recoverable: boolean
  pool?: string
  requested_model?: string
  resolved_provider?: SDKAccountDiagnosticProvider
  resolved_model?: string
  counts?: Record<string, number>
  from_account_ref?: string
  account_ref?: string
  reason?: string
  user_message?: string
}

type AccountDiagnosticBody = Omit<
  SDKAccountDiagnosticMessage,
  'type' | 'subtype' | 'uuid' | 'session_id'
>

type StreamJsonAccountDiagnosticEmitterOptions = {
  emit: (message: SDKAccountDiagnosticMessage) => void | Promise<void>
  getSessionId: () => string
  createUuid?: () => string
}

const streamJsonEmitters: StreamJsonAccountDiagnosticEmitterOptions[] = []
type ScopedStreamJsonAccountDiagnosticEmitter =
  StreamJsonAccountDiagnosticEmitterOptions & {
    active: boolean
  }
const scopedStreamJsonEmitter =
  new AsyncLocalStorage<ScopedStreamJsonAccountDiagnosticEmitter>()

type EmitAccountDiagnosticOptions = {
  allowStderrFallback?: boolean
}

type InstallStreamJsonAccountDiagnosticHookOptions = {
  registerForCleanup?: boolean
}

function stableRedaction(label: string, value: string): string {
  const digest = createHash('sha256')
    .update(value.trim())
    .digest('hex')
    .slice(0, 10)
  return `[redacted-${label}:${digest}]`
}

function looksLikeSerializedAccountRecord(value: string): boolean {
  return (
    /"(?:account_id|accountId)"/i.test(value) &&
    /"(?:email|alias|access_token|refresh_token|id_token|accessToken|refreshToken|idToken)"/i.test(
      value,
    )
  )
}

function sanitizeText(value: string): string {
  if (value.length === 0) {
    return value
  }

  if (looksLikeSerializedAccountRecord(value)) {
    return stableRedaction('account-record', value)
  }

  let sanitized = value

  for (const { pattern, label } of JSON_FIELD_PATTERNS) {
    sanitized = sanitized.replace(
      pattern,
      (_match, prefix: string, rawValue: string, suffix: string) =>
        `${prefix}${stableRedaction(label, rawValue)}${suffix}`,
    )
  }

  for (const { pattern, label } of KEY_VALUE_PATTERNS) {
    sanitized = sanitized.replace(
      pattern,
      (_match, prefix: string, rawValue: string, suffix: string) =>
        `${prefix}${stableRedaction(label, rawValue)}${suffix}`,
    )
  }

  sanitized = sanitized.replace(EMAIL_PATTERN, match =>
    stableRedaction('email', match),
  )
  sanitized = sanitized.replace(UUID_PATTERN, match =>
    stableRedaction('account-id', match),
  )
  sanitized = sanitized.replace(JWT_PATTERN, match =>
    stableRedaction('id-token', match),
  )
  sanitized = sanitized.replace(API_KEY_PATTERN, match =>
    stableRedaction('api-key', match),
  )

  return sanitized
}

function sanitizeCounts(
  counts: AccountDiagnosticEvent['counts'],
): AccountDiagnosticBody['counts'] {
  if (!counts) {
    return undefined
  }

  const sanitizedCounts = Object.entries(counts).reduce<Record<string, number>>(
    (result, [key, value]) => {
      if (Number.isFinite(value)) {
        result[key] = value
      }
      return result
    },
    {},
  )

  return Object.keys(sanitizedCounts).length > 0 ? sanitizedCounts : undefined
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asOptionalProvider(
  value: unknown,
): SDKAccountDiagnosticProvider | undefined {
  return typeof value === 'string' && isProvider(value) ? value : undefined
}

function isCode(value: string): value is SDKAccountDiagnosticCode {
  return (ACCOUNT_DIAGNOSTIC_CODES as readonly string[]).includes(value)
}

function isSeverity(value: string): value is SDKAccountDiagnosticSeverity {
  return (ACCOUNT_DIAGNOSTIC_SEVERITIES as readonly string[]).includes(value)
}

function isProvider(value: string): value is SDKAccountDiagnosticProvider {
  return (ACCOUNT_DIAGNOSTIC_PROVIDERS as readonly string[]).includes(value)
}

function parseCounts(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  const counts: Record<string, number> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      counts[key] = entry
    }
  }

  return Object.keys(counts).length > 0 ? counts : undefined
}

function normalizeAccountDiagnosticEvent(value: unknown): AccountDiagnosticEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Account diagnostic payload must be an object')
  }

  const event = value as Record<string, unknown>
  const version = event.version === undefined ? 1 : event.version
  if (version !== 1) {
    throw new Error(`Unsupported account diagnostic version: ${String(version)}`)
  }

  if (typeof event.code !== 'string' || !isCode(event.code)) {
    throw new Error(`Invalid account diagnostic code: ${String(event.code)}`)
  }
  if (typeof event.severity !== 'string' || !isSeverity(event.severity)) {
    throw new Error(
      `Invalid account diagnostic severity: ${String(event.severity)}`,
    )
  }
  if (typeof event.provider !== 'string' || !isProvider(event.provider)) {
    throw new Error(
      `Invalid account diagnostic provider: ${String(event.provider)}`,
    )
  }
  if (typeof event.recoverable !== 'boolean') {
    throw new Error('Account diagnostic recoverable must be a boolean')
  }

  return {
    version: 1,
    code: event.code,
    severity: event.severity,
    provider: event.provider,
    recoverable: event.recoverable,
    pool: asOptionalString(event.pool),
    requested_model: asOptionalString(event.requested_model),
    resolved_provider: asOptionalProvider(event.resolved_provider),
    resolved_model: asOptionalString(event.resolved_model),
    counts: parseCounts(event.counts),
    from_account_ref: asOptionalString(event.from_account_ref),
    account_ref: asOptionalString(event.account_ref),
    reason: asOptionalString(event.reason),
    user_message: asOptionalString(event.user_message),
  }
}

export function buildAccountDiagnosticBody(
  value: AccountDiagnosticEvent | Record<string, unknown>,
): AccountDiagnosticBody {
  const event = normalizeAccountDiagnosticEvent(value)

  return {
    version: 1,
    code: event.code,
    severity: event.severity,
    provider: event.provider,
    recoverable: event.recoverable,
    pool: event.pool ? sanitizeText(event.pool) : undefined,
    requested_model: event.requested_model
      ? sanitizeText(event.requested_model)
      : undefined,
    resolved_provider: event.resolved_provider,
    resolved_model: event.resolved_model
      ? sanitizeText(event.resolved_model)
      : undefined,
    counts: sanitizeCounts(event.counts),
    from_account_ref: event.from_account_ref
      ? stableRedaction('account-ref', event.from_account_ref)
      : undefined,
    account_ref: event.account_ref
      ? stableRedaction('account-ref', event.account_ref)
      : undefined,
    reason: event.reason ? sanitizeText(event.reason) : undefined,
    user_message: event.user_message ? sanitizeText(event.user_message) : undefined,
  }
}

export function buildAccountDiagnosticMessage(
  value: AccountDiagnosticEvent | Record<string, unknown>,
  options: { sessionId: string; uuid?: string },
): SDKAccountDiagnosticMessage {
  return {
    type: 'system',
    subtype: 'cat_code_account_diagnostic',
    uuid: options.uuid ?? randomUUID(),
    session_id: options.sessionId,
    ...buildAccountDiagnosticBody(value),
  }
}

export function formatAccountDiagnosticStderrLine(
  value: AccountDiagnosticEvent | Record<string, unknown>,
): string {
  return `${ACCOUNT_DIAGNOSTIC_MARKER} ${JSON.stringify(buildAccountDiagnosticBody(value))}\n`
}

export function hasAccountDiagnosticSink(): boolean {
  return getActiveScopedStreamJsonEmitter() !== undefined || streamJsonEmitters.length > 0
}

export function emitAccountDiagnostic(
  value: AccountDiagnosticEvent | Record<string, unknown>,
  options: EmitAccountDiagnosticOptions = {},
): void {
  const emitter =
    getActiveScopedStreamJsonEmitter() ??
    streamJsonEmitters[streamJsonEmitters.length - 1]

  if (!emitter) {
    if (options.allowStderrFallback === true) {
      process.stderr.write(formatAccountDiagnosticStderrLine(value))
    }
    return
  }

  const message = buildAccountDiagnosticMessage(value, {
    sessionId: emitter.getSessionId(),
    uuid: emitter.createUuid?.() ?? randomUUID(),
  })
  void emitter.emit(message)
}

export function installStreamJsonAccountDiagnosticHook(
  options: StreamJsonAccountDiagnosticEmitterOptions,
  installOptions: InstallStreamJsonAccountDiagnosticHookOptions = {},
): () => void {
  streamJsonEmitters.push(options)

  const removeHook = (): void => {
    const index = streamJsonEmitters.lastIndexOf(options)
    if (index >= 0) {
      streamJsonEmitters.splice(index, 1)
    }
  }

  if (installOptions.registerForCleanup !== false) {
    registerCleanup(async () => {
      removeHook()
    })
  }

  return removeHook
}

export function withStreamJsonAccountDiagnosticHook<T>(
  options: StreamJsonAccountDiagnosticEmitterOptions,
  callback: () => T,
): T {
  const scopedOptions = { ...options, active: true }
  let result: T
  try {
    result = scopedStreamJsonEmitter.run(scopedOptions, callback)
  } catch (error) {
    scopedOptions.active = false
    throw error
  }
  if (result instanceof Promise) {
    return result.finally(() => {
      scopedOptions.active = false
    }) as T
  }
  scopedOptions.active = false
  return result
}

export function _resetAccountDiagnosticStreamJsonHookForTesting(): void {
  streamJsonEmitters.length = 0
}

function getActiveScopedStreamJsonEmitter():
  | StreamJsonAccountDiagnosticEmitterOptions
  | undefined {
  const emitter = scopedStreamJsonEmitter.getStore()
  return emitter?.active ? emitter : undefined
}
