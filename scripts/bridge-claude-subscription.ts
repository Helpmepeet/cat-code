#!/usr/bin/env bun

import Anthropic from '@anthropic-ai/sdk'
import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { getSessionId } from '../src/bootstrap/state.js'
import {
  CLAUDE_AI_OAUTH_SCOPES,
  OAUTH_BETA_HEADER,
  getOauthConfig,
} from '../src/constants/oauth.js'
import {
  getAttributionHeader,
  getCLISyspromptPrefix,
} from '../src/constants/system.js'
import { getAPIMetadata } from '../src/services/api/claude.js'
import {
  getClaudePoolStatus,
  initClaudeAccountPool,
} from '../src/services/api/claudeAccountPool.js'
import { enableConfigs } from '../src/utils/config.js'
import { computeFingerprint } from '../src/utils/fingerprint.js'
import { getUserAgent } from '../src/utils/http.js'

if (typeof MACRO === 'undefined') {
  ;(globalThis as { MACRO?: Record<string, string | undefined> }).MACRO = {
    VERSION: '2.1.87-dev',
    BUILD_TIME: new Date().toISOString(),
    PACKAGE_URL: 'claude-code-source-snapshot',
    NATIVE_PACKAGE_URL: undefined,
    FEEDBACK_CHANNEL: 'github',
    ISSUES_EXPLAINER:
      'This reconstructed source snapshot does not include Anthropic internal issue routing.',
    VERSION_CHANGELOG: 'https://github.com/paoloanzn/claude-code',
  }
}

process.env.USER_TYPE ??= 'external'
process.env.CLAUDE_CODE_ENTRYPOINT ??= 'cli'
enableConfigs()

type BridgeInput = {
  model?: string
  messages: { role: 'user'; content: string }[]
  maxTokens?: number
  effort?: string
  workerSlot?: number
  requestTimeoutMs?: number
  streamReasoning?: boolean
}

type BridgeSuccess = {
  ok: true
  text: string
  usage: Anthropic.Beta.Messages.BetaUsage | null
}

type BridgeError = {
  ok: false
  code: string
  message: string
}

type BridgeOutput = BridgeSuccess | BridgeError

type ClaudeVaultAccount = {
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  scopes: string[]
  subscriptionType: string | null
  rateLimitTier: string | null
  accountUuid: string
  emailAddress: string
  vaultFilePath: string
}

type TokenRefreshResponse = {
  access_token: string
  refresh_token?: string | null
  expires_in: number
  scope?: string
}

type RetryConfig = {
  maxAttempts: number
  initialDelayMs: number
  maxDelayMs: number
}

const DEFAULT_MAX_TOKENS = Math.max(
  1024,
  Number.parseInt(
    process.env.CLAUDE_SUBSCRIPTION_DEFAULT_MAX_TOKENS ?? '12000',
    10,
  ) || 12000,
)
const CACHEABLE_USER_PREFIX_SEPARATOR = '\n\n'
const MIN_CACHEABLE_USER_PREFIX_CHARS = parseMinCacheableUserPrefixChars()

function parseMinCacheableUserPrefixChars(): number {
  const parsed = Number.parseInt(
    process.env.CLAUDE_SUBSCRIPTION_MIN_CACHEABLE_USER_PREFIX_CHARS ?? '',
    10,
  )
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 8192
}

function writeOutput(payload: BridgeOutput): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

function readInput(): BridgeInput | null {
  let inputText: string
  try {
    inputText = readFileSync(0, 'utf8')
  } catch (error) {
    writeOutput({
      ok: false,
      code: 'read_stdin_failed',
      message: `Unable to read stdin: ${error instanceof Error ? error.message : 'unknown error'}`,
    })
    return null
  }

  if (!inputText.trim()) {
    writeOutput({
      ok: false,
      code: 'invalid_input',
      message: 'Expected JSON on stdin with { "model": "...", "messages": [...] }',
    })
    return null
  }

  try {
    return JSON.parse(inputText) as BridgeInput
  } catch (error) {
    writeOutput({
      ok: false,
      code: 'invalid_json',
      message: `Invalid JSON: ${error instanceof Error ? error.message : 'unknown error'}`,
    })
    return null
  }
}

function parseScopes(raw: string | undefined): string[] {
  if (!raw) return [...CLAUDE_AI_OAUTH_SCOPES]
  return raw
    .split(/\s+/)
    .map(part => part.trim())
    .filter(Boolean)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getRetryConfig(): RetryConfig {
  const maxAttempts = Math.max(
    1,
    Number.parseInt(process.env.CLAUDE_SUBSCRIPTION_429_MAX_ATTEMPTS ?? '5', 10) || 5,
  )
  const initialDelayMs = Math.max(
    250,
    Number.parseInt(process.env.CLAUDE_SUBSCRIPTION_429_INITIAL_DELAY_MS ?? '2000', 10) || 2000,
  )
  const maxDelayMs = Math.max(
    initialDelayMs,
    Number.parseInt(process.env.CLAUDE_SUBSCRIPTION_429_MAX_DELAY_MS ?? '15000', 10) || 15000,
  )
  return { maxAttempts, initialDelayMs, maxDelayMs }
}

function isRateLimitError(error: unknown): boolean {
  if (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status?: unknown }).status === 429
  ) {
    return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('429') || message.includes('rate_limit_error')
}

function getRetryDelayMs(attempt: number, config: RetryConfig): number {
  const exponential = Math.min(
    config.maxDelayMs,
    config.initialDelayMs * 2 ** Math.max(0, attempt - 1),
  )
  const jitter = Math.floor(Math.random() * 1000)
  return exponential + jitter
}

function buildBetas(effort?: string): string[] | undefined {
  const betas: string[] = [OAUTH_BETA_HEADER]
  if (effort && effort.trim()) {
    betas.push('effort-2025-11-24')
  }
  return betas
}

function buildSystem(
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
): Anthropic.Beta.Messages.BetaTextBlockParam[] {
  const firstUserText = messageContentToText(
    messages.find(message => message.role === 'user')?.content ?? '',
  )
  const fingerprint = computeFingerprint(firstUserText, String(MACRO.VERSION))
  return [
    { type: 'text', text: getAttributionHeader(fingerprint) },
    {
      type: 'text',
      text: getCLISyspromptPrefix({
        isNonInteractive: true,
        hasAppendSystemPrompt: false,
      }),
    },
  ]
}

function messageContentToText(
  content: Anthropic.Beta.Messages.BetaMessageParam['content'],
): string {
  if (typeof content === 'string') {
    return content
  }

  return content
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('')
}

function getBridgeCacheControl(): Anthropic.Beta.Messages.BetaCacheControlEphemeral {
  return { type: 'ephemeral' }
}

export function buildUserContent(
  content: string,
  enablePromptCaching: boolean,
): string | Anthropic.Beta.Messages.BetaContentBlockParam[] {
  if (!enablePromptCaching) {
    return content
  }

  const separatorIndex = content.indexOf(CACHEABLE_USER_PREFIX_SEPARATOR)
  const prefixEnd = separatorIndex + CACHEABLE_USER_PREFIX_SEPARATOR.length
  if (
    separatorIndex <= 0 ||
    prefixEnd >= content.length ||
    prefixEnd < MIN_CACHEABLE_USER_PREFIX_CHARS
  ) {
    return content
  }

  return [
    {
      type: 'text',
      text: content.slice(0, prefixEnd),
      cache_control: getBridgeCacheControl(),
    },
    {
      type: 'text',
      text: content.slice(prefixEnd),
    },
  ]
}

function loadVaultAccounts(): ClaudeVaultAccount[] {
  const accountsDir = join(homedir(), 'claude-vault', 'accounts')
  let files: string[]
  try {
    files = readdirSync(accountsDir).filter(name => name.endsWith('.json')).sort()
  } catch {
    files = []
  }

  const results: ClaudeVaultAccount[] = []
  for (const file of files) {
    try {
      const path = join(accountsDir, file)
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>
      const tokens = raw.tokens ?? {}
      const profile = raw.profile ?? {}
      if (
        typeof tokens.access_token !== 'string' ||
        !tokens.access_token ||
        typeof profile.account_uuid !== 'string' ||
        !profile.account_uuid ||
        typeof profile.email_address !== 'string' ||
        !profile.email_address
      ) {
        continue
      }
      results.push({
        accessToken: tokens.access_token,
        refreshToken:
          typeof tokens.refresh_token === 'string' && tokens.refresh_token
            ? tokens.refresh_token
            : null,
        expiresAt:
          typeof tokens.expires_at === 'number' ? tokens.expires_at : null,
        scopes: Array.isArray(tokens.scopes)
          ? tokens.scopes.filter((value: unknown): value is string => typeof value === 'string')
          : [...CLAUDE_AI_OAUTH_SCOPES],
        subscriptionType:
          typeof tokens.subscription_type === 'string' ? tokens.subscription_type : null,
        rateLimitTier:
          typeof tokens.rate_limit_tier === 'string' ? tokens.rate_limit_tier : null,
        accountUuid: profile.account_uuid,
        emailAddress: profile.email_address,
        vaultFilePath: path,
      })
    } catch {
      continue
    }
  }

  if (results.length > 0) {
    return results
  }

  try {
    initClaudeAccountPool()
    return getClaudePoolStatus().accounts
      .filter(account => account.status === 'healthy')
      .map(account => ({
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        expiresAt: account.expiresAt,
        scopes: account.scopes ?? [...CLAUDE_AI_OAUTH_SCOPES],
        subscriptionType: account.subscriptionType ?? null,
        rateLimitTier: account.rateLimitTier ?? null,
        accountUuid: account.accountUuid,
        emailAddress: account.emailAddress,
        vaultFilePath:
          account.vaultFilePath ?? join(homedir(), 'claude-vault', 'accounts', `${account.accountUuid}.json`),
      }))
  } catch {
    return []
  }
}

async function refreshAccountIfNeeded(
  account: ClaudeVaultAccount,
): Promise<ClaudeVaultAccount> {
  const needsRefresh =
    account.expiresAt !== null && Date.now() + 5 * 60 * 1000 >= account.expiresAt
  if (!needsRefresh || !account.refreshToken) {
    return account
  }

  const response = await fetch(getOauthConfig().TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: account.refreshToken,
      client_id: getOauthConfig().CLIENT_ID,
      scope: (account.scopes.length > 0 ? account.scopes : [...CLAUDE_AI_OAUTH_SCOPES]).join(' '),
    }),
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`OAuth refresh failed (${response.status}): ${body}`)
  }

  const data = (await response.json()) as TokenRefreshResponse
  const refreshed: ClaudeVaultAccount = {
    ...account,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? account.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    scopes: parseScopes(data.scope),
  }

  const existing = JSON.parse(readFileSync(account.vaultFilePath, 'utf8')) as Record<string, any>
  existing.tokens = {
    ...(existing.tokens ?? {}),
    access_token: refreshed.accessToken,
    refresh_token: refreshed.refreshToken,
    expires_at: refreshed.expiresAt,
    scopes: refreshed.scopes,
    subscription_type: refreshed.subscriptionType,
    rate_limit_tier: refreshed.rateLimitTier,
  }
  existing.last_refresh = new Date().toISOString()
  writeFileSync(account.vaultFilePath, JSON.stringify(existing, null, 2) + '\n', 'utf8')

  return refreshed
}

async function resolveAccount(workerSlot: number): Promise<ClaudeVaultAccount> {
  const accounts = loadVaultAccounts()
  if (accounts.length === 0) {
    throw new Error('No Claude subscription accounts found in claude-vault')
  }
  const index = Math.abs(workerSlot) % accounts.length
  return await refreshAccountIfNeeded(accounts[index]!)
}

export function buildMessages(messages: BridgeInput['messages']): Anthropic.Beta.Messages.BetaMessageParam[] | null {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null
  }

  const normalized = messages
    .filter(msg => msg && msg.role === 'user' && typeof msg.content === 'string')
    .map((msg, index) => ({
      role: 'user' as const,
      content: buildUserContent(msg.content, index === 0),
    }))

  return normalized.length > 0 ? normalized : null
}

function extractText(
  content: Anthropic.Beta.Messages.BetaMessage['content'],
): string {
  return content
    .map(block => {
      if (block.type === 'text') return block.text
      if (block.type === 'thinking') return block.thinking
      if (block.type === 'redacted_thinking') return ''
      return ''
    })
    .filter(Boolean)
    .join('\n\n')
}

class StreamPrinter {
  private readonly prefix: string
  private buffer = ''

  constructor(prefix: string) {
    this.prefix = prefix
  }

  push(chunk: string): void {
    if (!chunk) return
    this.buffer += chunk
    while (true) {
      const newlineIndex = this.buffer.indexOf('\n')
      if (newlineIndex === -1) break
      const line = this.buffer.slice(0, newlineIndex)
      this.buffer = this.buffer.slice(newlineIndex + 1)
      if (line.trim()) {
        process.stderr.write(`${this.prefix}${line}\n`)
      }
    }
    while (this.buffer.length >= 200) {
      const slice = this.buffer.slice(0, 200)
      this.buffer = this.buffer.slice(200)
      if (slice.trim()) {
        process.stderr.write(`${this.prefix}${slice}\n`)
      }
    }
  }

  flush(): void {
    if (this.buffer.trim()) {
      process.stderr.write(`${this.prefix}${this.buffer}\n`)
    }
    this.buffer = ''
  }
}

async function runDirect(
  model: string,
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
  effort?: string,
  maxTokens?: number,
  workerSlot?: number,
  requestTimeoutMs?: number,
  streamReasoning?: boolean,
): Promise<BridgeOutput> {
  const account = await resolveAccount(workerSlot ?? 0)
  const client = new Anthropic({
    authToken: account.accessToken,
    baseURL: getOauthConfig().BASE_API_URL,
    defaultHeaders: {
      'x-app': 'cli',
      'User-Agent': getUserAgent(),
      'X-Claude-Code-Session-Id': getSessionId(),
    },
    maxRetries: 2,
    timeout: Math.max(1000, requestTimeoutMs ?? 600000),
    dangerouslyAllowBrowser: true,
  })
  const retryConfig = getRetryConfig()
  const betas = buildBetas(effort)
  const system = buildSystem(messages)
  const metadata = getAPIMetadata()
  const slotLabel = workerSlot ?? 0

  for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
    try {
      if (streamReasoning) {
        const stream = client.beta.messages.stream({
          model,
          max_tokens: maxTokens && maxTokens > 0 ? maxTokens : DEFAULT_MAX_TOKENS,
          messages,
          system,
          metadata,
          thinking: { type: 'adaptive' },
          output_config: effort && effort.trim() ? { effort: effort.trim() as any } : undefined,
          betas,
        })
        const thinkingPrinter = new StreamPrinter(
          `[bridge-claude-subscription][slot=${slotLabel}][thinking] `,
        )
        const textPrinter = new StreamPrinter(
          `[bridge-claude-subscription][slot=${slotLabel}][text] `,
        )
        stream.on('thinking', delta => {
          thinkingPrinter.push(delta)
        })
        stream.on('text', delta => {
          textPrinter.push(delta)
        })
        try {
          const response = await stream.finalMessage()
          thinkingPrinter.flush()
          textPrinter.flush()
          return {
            ok: true,
            text: extractText(response.content),
            usage: response.usage ?? null,
          }
        } finally {
          thinkingPrinter.flush()
          textPrinter.flush()
          stream.abort()
        }
      }

      const response = await client.beta.messages.create({
        model,
        max_tokens: maxTokens && maxTokens > 0 ? maxTokens : DEFAULT_MAX_TOKENS,
        messages,
        system,
        metadata,
        thinking: { type: 'adaptive' },
        output_config: effort && effort.trim() ? { effort: effort.trim() as any } : undefined,
        betas,
      })

      return {
        ok: true,
        text: extractText(response.content),
        usage: response.usage ?? null,
      }
    } catch (error) {
      if (!isRateLimitError(error) || attempt >= retryConfig.maxAttempts) {
        throw error
      }
      const delayMs = getRetryDelayMs(attempt, retryConfig)
      process.stderr.write(
        `[bridge-claude-subscription] rate limited slot=${workerSlot ?? 0} account=${account.accountUuid} attempt=${attempt}/${retryConfig.maxAttempts} waiting_ms=${delayMs}\n`,
      )
      await sleep(delayMs)
    }
  }

  throw new Error('Retry loop exhausted without result')
}

async function main() {
  const payload = readInput()
  if (!payload) {
    return
  }

  const messages = buildMessages(payload.messages)
  if (!messages) {
    writeOutput({
      ok: false,
      code: 'invalid_input',
      message:
        'Invalid payload: messages must be a non-empty array of { role: "user", content: "..." }',
    })
    return
  }

  try {
    const model = payload.model?.trim() || 'claude-sonnet-4-6'
    const result = await runDirect(
      model,
      messages,
      payload.effort,
      payload.maxTokens,
      payload.workerSlot,
      payload.requestTimeoutMs,
      payload.streamReasoning,
    )
    writeOutput(result)
  } catch (error) {
    writeOutput({
      ok: false,
      code: 'direct_api_error',
      message: error instanceof Error ? error.message : 'unknown error',
    })
  }
}

if (import.meta.main) {
  void main()
}
