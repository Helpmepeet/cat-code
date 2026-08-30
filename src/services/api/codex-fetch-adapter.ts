/**
 * Codex Fetch Adapter
 *
 * Intercepts fetch calls from the Anthropic SDK and routes them to
 * ChatGPT's Codex backend API, translating between Anthropic Messages API
 * format and OpenAI Responses API format.
 *
 * Supports:
 * - Text messages (user/assistant)
 * - System prompts → instructions
 * - Tool definitions (Anthropic input_schema → OpenAI parameters)
 * - Tool use (tool_use → function_call, tool_result → function_call_output)
 * - Streaming events translation
 *
 * Endpoint: https://chatgpt.com/backend-api/codex/responses
 */

import { APIConnectionError } from '@anthropic-ai/sdk'
import { createHash, randomUUID } from 'crypto'
import { logForDebugging, RECOVERED_TERMINAL_TEXT_PREFIX } from '../../utils/debug.js'
import { logEvent } from '../analytics/index.js'
import { getCurrentCodexLease } from './codexAccountLeaseManager.js'
import {
  CodexPartialStreamReplaySkippedError,
  extractConnectionErrorDetails,
  type CodexPartialStreamCause,
  type CodexPartialStreamFailureV1,
} from './errorUtils.js'
import {
  clearWebSocketSession,
  closeSocketPreservingState,
  streamTurnViaWebSocketLocked,
  registerStaleResponseIdCallback,
  registerSendPathLogger,
  registerOutputItemCanonicalizer,
  CodexWebSocketClosedBeforeCompletedError,
  CodexWebSocketIdleTimeoutError,
  CodexWebSocketServerError,
  CodexWebSocketUsageLimitError,
  CodexWebSocketAuthError,
} from './codex-websocket-transport.js'
import { notifyStaleResponseIdRetry } from './promptCacheBreakDetection.js'
import {
  recordCodexRequestStart,
  recordCodexSendPath,
  recordCodexStreamSurface,
} from '../../utils/sessionStorage.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../../tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { TOOL_SEARCH_TOOL_NAME } from '../../tools/ToolSearchTool/constants.js'
import {
  normalizeToolInput,
  normalizeToolInputForAPI,
  withSuppressedNormalizeSideEffects,
} from '../../utils/api.js'
import { getAllBaseTools } from '../../tools.js'
import { findToolByName } from '../../Tool.js'
import { safeParseJSON } from '../../utils/json.js'

const APPLY_PATCH_TOOL_NAME = 'Apply_patch'

// ── Session-level IDs for cache routing ───────────────────────────────
// OpenAI's ChatGPT backend uses these headers to route requests to the
// same backend node, which is required for prompt caching to work.
// See: https://github.com/openai/codex/issues/5556

// Fallback: a fresh UUID per process for paths that have no session context.
const CODEX_SESSION_ID = randomUUID()

// Phase 1: stable prompt_cache_key — set by the session bootstrap from the
// persisted Cat Code sessionId so that CLI restarts reuse the same key.
let codexPromptCacheKey: string | null = null

interface StickyFallbackEntry {
  until: number
  reason: string
}

const STICKY_HTTP_FALLBACK_TTL_MS = 60 * 1000
// Keyed by conversationId → (accountId → entry). Per-account, so a flag left by a
// failed account never forces a *different*, reassigned/healthy account onto HTTP
// (where cohort-gated models like gpt-5.6-luna 404). The wildcard sentinel serves
// account-agnostic callers/tests and matches any account.
// See docs/codex/2026-07-12-bug-luna-sticky-http-fallback-404.md.
const STICKY_WILDCARD_ACCOUNT = '\u0000any'
const stickyHttpFallback = new Map<string, Map<string, StickyFallbackEntry>>()

function stickyAccountKey(accountId?: string): string {
  return accountId ?? STICKY_WILDCARD_ACCOUNT
}
let nowForTest: (() => number) | null = null
const conversationIdsByCacheKey = new Map<string, string>()

function getCodexInitialOutputTimeoutMs(): number {
  return parseInt(process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS || '', 10) || 90_000
}

export function _setStickyFallbackNowForTest(fn: (() => number) | null): void {
  nowForTest = fn
}

function now(): number {
  return nowForTest ? nowForTest() : Date.now()
}

export function setCodexPromptCacheKey(sessionId: string): void {
  const changed = codexPromptCacheKey !== sessionId
  codexPromptCacheKey = sessionId
  // conversationIdsByCacheKey memoizes the derived conversation_id per
  // accountId:model and nothing else invalidates it, so leaving it in place
  // would keep sending the previous session's conversation_id after the key
  // moves. That makes both rebind paths real: /resume mid-session, and /clear
  // (regenerateSessionId -> onSessionSwitch -> setup.ts).
  if (changed) {
    conversationIdsByCacheKey.clear()
  }
  logForDebugging(`[codex-cache] prompt_cache_key set to session ${sessionId.slice(0, 8)}`)
}

// Kept exported so callers (switch-account, delete-account) don't break. The
// previous per-account routing map was removed in favor of a single
// conversation_id per CLI session (see the fetch adapter below).
export function resetCodexCacheContext(): void {
  stickyHttpFallback.clear()
  conversationIdsByCacheKey.clear()
}

function markStickyHttpFallback(
  conversationId: string,
  reason: string,
  accountId?: string,
): void {
  let byAccount = stickyHttpFallback.get(conversationId)
  if (!byAccount) {
    byAccount = new Map()
    stickyHttpFallback.set(conversationId, byAccount)
  }
  const key = stickyAccountKey(accountId)
  const existing = byAccount.get(key)
  // Same account, still valid: do not extend the TTL on remark. A different
  // account gets its own entry and never overwrites this one.
  if (existing && now() <= existing.until) {
    return
  }
  byAccount.set(key, { until: now() + STICKY_HTTP_FALLBACK_TTL_MS, reason })
  logForDebugging(
    `[codex-fetch] sticky_http_fallback conv=${conversationId.slice(0, 8)} ` +
    `reason=${reason} account=${accountId ? accountId.slice(0, 8) : 'any'} ` +
    `ttl_ms=${STICKY_HTTP_FALLBACK_TTL_MS}`,
    { level: 'warn' },
  )
}

function stickyEntryLive(
  byAccount: Map<string, StickyFallbackEntry>,
  key: string,
): boolean {
  const entry = byAccount.get(key)
  if (!entry) return false
  if (now() > entry.until) {
    byAccount.delete(key)
    return false
  }
  return true
}

function hasStickyHttpFallback(
  conversationId: string,
  accountId?: string,
): boolean {
  const byAccount = stickyHttpFallback.get(conversationId)
  if (!byAccount) return false
  // A wildcard flag (account-agnostic caller/test) applies to any account.
  if (stickyEntryLive(byAccount, STICKY_WILDCARD_ACCOUNT)) return true
  if (accountId !== undefined) {
    return stickyEntryLive(byAccount, stickyAccountKey(accountId))
  }
  // Account-agnostic query: is ANY account's flag for this conversation live?
  for (const key of [...byAccount.keys()]) {
    if (stickyEntryLive(byAccount, key)) return true
  }
  return false
}

function clearStickyHttpFallback(
  conversationId: string,
  accountId?: string,
): void {
  const byAccount = stickyHttpFallback.get(conversationId)
  if (!byAccount) return
  byAccount.delete(stickyAccountKey(accountId))
  if (byAccount.size === 0) {
    stickyHttpFallback.delete(conversationId)
  }
}

function stableConversationIdForCacheKey(cacheKey: string): string {
  const hash = createHash('sha256')
    .update(codexPromptCacheKey ?? CODEX_SESSION_ID)
    .update('\0')
    .update(cacheKey)
    .digest('hex')
  // Preserve UUID shape: the backend accepts a conventional UUID conversation
  // identity, while this UUIDv5-shaped value remains stable across restarts.
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${
    ['8', '9', 'a', 'b'][parseInt(hash[16]!, 16) & 0x3]!
  }${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

function getConversationIdForRequest(
  accountId: string,
  model: string,
  conversationIdOverride?: string,
): string {
  if (conversationIdOverride) {
    return conversationIdOverride
  }

  const cacheKey = `${accountId}:${model}`
  const existingConversationId = conversationIdsByCacheKey.get(cacheKey)
  if (existingConversationId) {
    return existingConversationId
  }

  const conversationId = stableConversationIdForCacheKey(cacheKey)
  conversationIdsByCacheKey.set(cacheKey, conversationId)
  return conversationId
}

export function _getConversationIdForRequestForTest(
  accountId: string,
  model: string,
  conversationIdOverride?: string,
): string {
  return getConversationIdForRequest(accountId, model, conversationIdOverride)
}

export function _markStickyHttpFallbackForTest(
  conversationId: string,
  reason: string,
  accountId?: string,
): void {
  markStickyHttpFallback(conversationId, reason, accountId)
}

export function _hasStickyHttpFallbackForTest(
  conversationId: string,
  accountId?: string,
): boolean {
  return hasStickyHttpFallback(conversationId, accountId)
}

/**
 * Maps a transport conversation ID back to the prompt-cache tracking key that
 * promptCacheBreakDetection keys `previousStateBySource` by (see getTrackingKey
 * there). The mapping must produce the *raw* tracking key, not a querySource:
 *   - Main thread: the conversation ID is a bare session UUID (no `/`) and the
 *     tracked state lives under `repl_main_thread`.
 *   - Subagents: the override is `${sessionId}/${agentId}` (claude.ts
 *     getCodexConversationIdOverride), and the state is keyed by the raw
 *     agentId — so we return the agentId segment, NOT `agent:${id}`.
 *   - Session-title side query: `side/title/<uuid>` is untracked
 *     (generate_session_title isn't a tracked prefix), so the lookup is a
 *     harmless no-op; we map it to its querySource for clarity.
 */
export function mapConversationIdToTrackingKey(conversationId: string): string {
  if (conversationId.startsWith('side/title/')) {
    return 'generate_session_title'
  }
  if (conversationId.includes('/')) {
    return conversationId.split('/')[1]
  }
  return 'repl_main_thread'
}

// Register the stale-response-id callback so promptCacheBreakDetection gets
// notified when the WS transport retries a turn after server evicts the chain.
registerStaleResponseIdCallback((conversationId: string) => {
  notifyStaleResponseIdRetry(mapConversationIdToTrackingKey(conversationId))
})

// Register the send-path logger so WS turn completions are recorded to the
// session JSONL. The WS transport can't resolve conversationId → identifiers on
// its own; we wrap the callback here where codexPromptCacheKey / accountId are
// accessible, and inject them into the entry before writing.
registerSendPathLogger((entry) => {
  recordCodexSendPath({
    ...entry,
    prompt_cache_key_prefix:
      entry.prompt_cache_key_prefix ??
      (codexPromptCacheKey ?? CODEX_SESSION_ID).slice(0, 8),
    session_id_prefix:
      entry.session_id_prefix ??
      (codexPromptCacheKey ?? CODEX_SESSION_ID).slice(0, 8),
  })
})


// ── Phase 4: rolling cache-stats window ───────────────────────────────

interface CacheStatEntry {
  ts: number
  accountId: string
  model: string
  inputTokens: number
  cachedTokens: number
  promptCacheKeyPrefix: string
  conversationIdPrefix: string
}

const CACHE_STAT_WINDOW = 20
const cacheStatWindow: CacheStatEntry[] = []

function recordCacheStat(entry: CacheStatEntry): void {
  cacheStatWindow.push(entry)
  if (cacheStatWindow.length > CACHE_STAT_WINDOW) {
    cacheStatWindow.shift()
  }
}

export function getCodexCacheStats(): {
  window: CacheStatEntry[]
  hitRatio: number
  medianCachedTokens: number
} {
  if (cacheStatWindow.length === 0) {
    return { window: [], hitRatio: 0, medianCachedTokens: 0 }
  }
  const totalInput = cacheStatWindow.reduce((s, e) => s + e.inputTokens, 0)
  const totalCached = cacheStatWindow.reduce((s, e) => s + e.cachedTokens, 0)
  const hitRatio = totalInput > 0 ? totalCached / totalInput : 0
  const sorted = [...cacheStatWindow].map(e => e.cachedTokens).sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const medianCachedTokens = sorted.length % 2 === 0
    ? Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2)
    : (sorted[mid] ?? 0)
  return { window: cacheStatWindow, hitRatio, medianCachedTokens }
}

// ── Pool-aware error ───────────────────────────────────────────────────

/**
 * Thrown when a Codex account hits a 429/cap error under pool-managed credentials.
 * Caught by withRetry to trigger instant failover to the next account.
 */
export class CodexAccountCapError extends Error {
  public readonly status = 429
  constructor(public readonly accountId: string) {
    super(`Codex account ${accountId} hit usage cap`)
    this.name = 'CodexAccountCapError'
  }
}

export class CodexAccountAuthError extends Error {
  public readonly status: 401 | 403

  constructor(
    public readonly accountId: string,
    status: 401 | 403,
  ) {
    super(`Codex account ${accountId} authentication failed (${status})`)
    this.name = 'CodexAccountAuthError'
    this.status = status
  }
}

type CodexResponseFailure = {
  code: string
  message: string
  type?: string
}

export class CodexResponseFailedError extends Error {
  constructor(public readonly failure: CodexResponseFailure) {
    super(`Codex response.failed (${failure.code}): ${failure.message}`)
    this.name = 'CodexResponseFailedError'
  }
}

const CODEX_ACCOUNT_LIMIT_ERROR_CODES = new Set([
  'usage_limit_reached',
  'rate_limit_exceeded',
  'quota_exceeded',
  'insufficient_quota',
  'usage_not_included',
])

// Structured auth-failure codes (mirrors CODEX_ACCOUNT_LIMIT_ERROR_CODES for the
// revoked-auth path). Substring text matching (codexErrorTextIndicatesRevokedAuth)
// missed `token_invalidated` — the server code emitted when a token is superseded
// by a re-login — so a 401 bypassed CodexAccountAuthError and all of withRetry's
// auth recovery. Structured-code match is authoritative; text stays as a fallback.
// The WS transport keeps its own local mirror (isAuthTokenRejection) because it
// cannot import this module (the adapter imports the transport). Keep in sync.
const CODEX_ACCOUNT_AUTH_ERROR_CODES = new Set([
  'token_invalidated',
  'token_expired',
  'token_revoked',
  'invalid_token',
])

/**
 * Text of a Codex message content part, or undefined when the part carries none.
 * Narrows on the part type: a `refusal` part is not assistant prose and must not
 * be emitted as if it were.
 */
function outputTextOfPart(part: unknown): string | undefined {
  if (!isRecord(part)) return undefined
  if (part.type !== 'output_text') return undefined
  return typeof part.text === 'string' && part.text.length > 0 ? part.text : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function codexFailureTextIndicatesUsageCap(text: string): boolean {
  const lower = text.toLowerCase()
  return (
    lower.includes('usage_limit') ||
    lower.includes('limit_reached') ||
    lower.includes('usage limit') ||
    lower.includes('usage cap') ||
    lower.includes('quota exhausted') ||
    lower.includes('quota exceeded')
  )
}

function codexErrorTextIndicatesUsageCap(status: number, body: string): boolean {
  if (status !== 429) {
    return false
  }
  return codexFailureTextIndicatesUsageCap(body)
}

function codexErrorTextIndicatesRevokedAuth(
  status: number,
  body: string,
): status is 401 | 403 {
  if (status !== 401 && status !== 403) {
    return false
  }
  const text = body.toLowerCase()
  return (
    (status === 401 && text.includes('unauthorized')) ||
    (status === 401 && text.includes('unauthenticated')) ||
    (status === 401 && text.includes('authentication failed')) ||
    text.includes('token_revoked') ||
    text.includes('oauth token has been revoked') ||
    text.includes('invalid_grant') ||
    text.includes('invalid token') ||
    text.includes('expired token')
  )
}

function codexHttpBodyIndicatesRevokedAuth(body: string): boolean {
  const parsed = safeParseJSON(body)
  if (!isRecord(parsed)) {
    return false
  }
  return codexResponseFailureIndicatesRevokedAuth(extractCodexResponseFailure(parsed))
}

function codexHttpAuthStatus(
  status: number,
  headers: Headers,
): 401 | 403 | undefined {
  // The edge can wrap an upstream auth rejection in a 5xx response.
  const upstreamStatus = headers.get('x-openai-authorization-error')?.trim()
  if (upstreamStatus === '401') return 401
  if (upstreamStatus === '403') return 403
  return status === 401 || status === 403 ? status : undefined
}

function codexHttpHeadersIndicateRevokedAuth(headers: Headers): boolean {
  const code = headers.get('x-openai-ide-error-code')?.trim().toLowerCase()
  return code !== undefined && CODEX_ACCOUNT_AUTH_ERROR_CODES.has(code)
}

function classifyCodexHttpAccountError(
  status: number,
  body: string,
  headers: Headers,
  accountId: string,
): CodexAccountCapError | CodexAccountAuthError | null {
  if (codexErrorTextIndicatesUsageCap(status, body)) {
    return new CodexAccountCapError(accountId)
  }
  const authStatus = codexHttpAuthStatus(status, headers)
  if (
    authStatus !== undefined &&
    (codexHttpHeadersIndicateRevokedAuth(headers) ||
      codexHttpBodyIndicatesRevokedAuth(body) ||
      codexErrorTextIndicatesRevokedAuth(authStatus, body))
  ) {
    return new CodexAccountAuthError(accountId, authStatus)
  }
  return null
}

function extractCodexResponseFailure(
  event: Record<string, unknown>,
): CodexResponseFailure {
  const response = isRecord(event.response) ? event.response : undefined
  const responseError = isRecord(response?.error) ? response.error : undefined
  const topLevelError = isRecord(event.error) ? event.error : undefined
  const error = responseError ?? topLevelError

  const code =
    readNonEmptyString(error?.code) ??
    readNonEmptyString(response?.code) ??
    'unknown_error'
  const message =
    readNonEmptyString(error?.message) ??
    readNonEmptyString(response?.message) ??
    'Codex response failed'
  const type =
    readNonEmptyString(error?.type) ??
    readNonEmptyString(response?.type)

  return {
    code,
    message,
    ...(type ? { type } : {}),
  }
}

function codexResponseFailureIndicatesAccountCap(
  failure: CodexResponseFailure,
): boolean {
  const code = failure.code.toLowerCase()
  if (CODEX_ACCOUNT_LIMIT_ERROR_CODES.has(code)) {
    return true
  }
  return codexFailureTextIndicatesUsageCap(failure.message)
}

function codexResponseFailureIndicatesRevokedAuth(
  failure: CodexResponseFailure,
): boolean {
  return CODEX_ACCOUNT_AUTH_ERROR_CODES.has(failure.code.toLowerCase())
}

function createCodexResponseFailedError(
  event: Record<string, unknown>,
  requestCacheMetadata?: CodexRequestCacheMetadata,
  emittedVisibleOutput = false,
): Error {
  const failure = extractCodexResponseFailure(event)
  const isAccountCap =
    !emittedVisibleOutput && codexResponseFailureIndicatesAccountCap(failure)
  // A structured revoked-auth response.failed must drive withRetry's auth
  // recovery just like the HTTP path. Guarded by !emittedVisibleOutput for the
  // same reason as cap: after visible output the turn cannot be replayed.
  const isAccountAuth =
    !emittedVisibleOutput && codexResponseFailureIndicatesRevokedAuth(failure)
  if (requestCacheMetadata) {
    if (isAccountCap || isAccountAuth) {
      // Item 3 rule 4: a cap/auth failure means withRetry fails over to another
      // account. `sessions` is keyed by conversationId only, so the preserved
      // baseline was chained under the OLD account — drop it entirely so the
      // new account's first request is a clean full send.
      clearWebSocketSession(requestCacheMetadata.conversationId)
    } else {
      // Item 3 rule 3: a genuine (non-cap) response.failed left the previous
      // GOOD baseline intact (state only commits on response.completed). Kill
      // the socket so its late events cannot bleed into the next turn, but keep
      // the baseline so the next turn continues instead of paying a full send.
      closeSocketPreservingState(requestCacheMetadata.conversationId)
    }
  }
  if (isAccountCap && requestCacheMetadata) {
    return new CodexAccountCapError(requestCacheMetadata.accountId)
  }
  if (isAccountAuth && requestCacheMetadata) {
    return new CodexAccountAuthError(requestCacheMetadata.accountId, 401)
  }
  return new CodexResponseFailedError(failure)
}

function createRetryableCodexHttpError(status: number, body: string): APIConnectionError {
  return new APIConnectionError({
    message: `Codex API error (${status}): ${body}`,
  })
}

// ── Available Codex models ──────────────────────────────────────────
export const CODEX_MODELS = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', description: 'Frontier model for complex professional work' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', description: 'Balanced agentic coding model (preview)' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', description: 'Fast and affordable agentic coding model (preview)' },
  { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', description: 'Frontier agentic coding model' },
  { id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex', description: 'Codex coding model' },
  { id: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini', description: 'Fast Codex model' },
  { id: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max', description: 'Max Codex model' },
  { id: 'gpt-5.2', label: 'GPT-5.2', description: 'GPT-5.2' },
] as const

export const DEFAULT_CODEX_MODEL = 'gpt-5.6-terra'

/**
 * Maps Claude model names to corresponding Codex model names.
 *
 * Reached whenever a Claude model string is served by the Codex path, which is
 * the normal case on a Codex session rather than an exotic one:
 * `getProviderForModel` (`utils/model/providers.ts:67`) forces a provider only
 * for `gpt-*`, so every other id falls through to the SESSION provider.
 *
 * The ladder is by TIER, and the two fallbacks are deliberately not the same
 * value as the top rung. A caller naming `opus` is asking for the most capable
 * model and gets the Codex frontier; a caller naming nothing is almost always a
 * cheap auxiliary call, so it stays mid tier and must not be "consistently"
 * pointed at Sol.
 *
 * @param claudeModel - The Claude model name to map
 * @returns The corresponding Codex model ID
 */
export function mapClaudeModelToCodex(claudeModel: string | null): string {
  if (!claudeModel) return DEFAULT_CODEX_MODEL
  if (isCodexModel(claudeModel)) return claudeModel
  const lower = claudeModel.toLowerCase()
  if (lower.includes('opus')) return 'gpt-5.6-sol'
  if (lower.includes('haiku') || lower.includes('sonnet')) return 'gpt-5.6-luna'
  return DEFAULT_CODEX_MODEL
}

/**
 * Checks if a given model string is a valid Codex model.
 * @param model - The model string to check
 * @returns True if the model is a Codex model, false otherwise
 */
export function isCodexModel(model: string): boolean {
  return CODEX_MODELS.some(m => m.id === model)
}

// ── JWT helpers ─────────────────────────────────────────────────────

const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

/**
 * Extracts the account ID from a Codex JWT token.
 * @param token - The JWT token to extract the account ID from
 * @returns The account ID
 * @throws Error if the token is invalid or account ID cannot be extracted
 */
function extractAccountId(token: string): string {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) throw new Error('Invalid token')
    const payload = JSON.parse(atob(parts[1]))
    const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id
    if (!accountId) throw new Error('No account ID in token')
    return accountId
  } catch {
    throw new Error('Failed to extract account ID from Codex token')
  }
}

// ── Types ───────────────────────────────────────────────────────────

interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown> | string
  tool_use_id?: string
  content?: string | AnthropicContentBlock[]
  [key: string]: unknown
}

interface AnthropicMessage {
  role: string
  content: string | AnthropicContentBlock[]
}

interface AnthropicTool {
  type?: string
  name: string
  description?: string
  input_schema?: Record<string, unknown>
  strict?: boolean
  openai_tool_type?: 'function' | 'custom'
  openai_tool_format?: {
    type: 'grammar'
    syntax: 'lark'
    definition: string
  }
  allowed_domains?: string[]
  blocked_domains?: string[]
}

interface OpenAIInstructionAssemblyPayload {
  instructions: string
  inputMessages: AnthropicMessage[]
  developerContext?: string
}

// ── Tool translation: Anthropic → Codex ─────────────────────────────

const OPENAI_WEB_SEARCH_SOURCES_INCLUDE = 'web_search_call.action.sources'

function isAnthropicHostedWebSearchTool(tool: AnthropicTool): boolean {
  return tool.type === 'web_search_20250305' && tool.name === 'web_search'
}

function translateHostedWebSearchTool(
  tool: AnthropicTool,
): Record<string, unknown> {
  if (Array.isArray(tool.blocked_domains) && tool.blocked_domains.length > 0) {
    throw new Error(
      'OpenAI hosted web_search does not support blocked_domains; use allowed_domains',
    )
  }

  const translated: Record<string, unknown> = {
    type: 'web_search',
    external_web_access: true,
  }

  if (Array.isArray(tool.allowed_domains) && tool.allowed_domains.length > 0) {
    translated.filters = { allowed_domains: tool.allowed_domains }
  }

  return translated
}

function addCodexInclude(
  codexBody: Record<string, unknown>,
  value: string,
): void {
  const current = Array.isArray(codexBody.include)
    ? codexBody.include.filter((item): item is string => typeof item === 'string')
    : []
  if (!current.includes(value)) {
    current.push(value)
  }
  codexBody.include = current
}

function translateToolChoice(
  anthropicChoice: unknown,
  anthropicTools: AnthropicTool[],
): unknown {
  if (anthropicChoice == null) return 'auto'
  if (typeof anthropicChoice === 'string') return anthropicChoice

  if (typeof anthropicChoice !== 'object') return 'auto'
  const choice = anthropicChoice as Record<string, unknown>
  const type = typeof choice.type === 'string' ? choice.type : null

  if (type === 'auto') return 'auto'
  if (type === 'none') return 'none'
  if (type === 'any') return 'required'
  if (type === 'tool' && typeof choice.name === 'string') {
    if (choice.name === SYNTHETIC_OUTPUT_TOOL_NAME) {
      return 'auto'
    }
    const target = anthropicTools.find(t => t.name === choice.name)
    if (target && isAnthropicHostedWebSearchTool(target)) {
      return { type: 'web_search' }
    }
    return { type: 'function', name: choice.name }
  }
  return 'auto'
}

/**
 * Translates Anthropic tool definitions to Codex format.
 * @param anthropicTools - Array of Anthropic tool definitions
 * @returns Array of Codex-compatible tool objects
 */
function translateTools(anthropicTools: AnthropicTool[]): Array<Record<string, unknown>> {
  return anthropicTools
    .filter(tool => tool.name !== SYNTHETIC_OUTPUT_TOOL_NAME)
    .map(tool => {
      if (isAnthropicHostedWebSearchTool(tool)) {
        return translateHostedWebSearchTool(tool)
      }

      if (tool.openai_tool_type === 'custom' && tool.openai_tool_format) {
        return {
          type: 'custom',
          name: tool.name,
          description: tool.description || '',
          format: tool.openai_tool_format,
        }
      }

      return {
        type: 'function',
        name: tool.name,
        description: tool.description || '',
        parameters: tool.input_schema || { type: 'object', properties: {} },
        strict: tool.strict ?? null,
      }
    })
}

// ── Codex output-item canonicalization ──────────────────────────────
//
// The WebSocket transport only sends an incremental delta when the freshly
// translated input[] byte-matches the server-recorded output items from the
// previous turn (see reconcileCanonicalDelta / responseItemsEqual). For that to
// hold, the shape we RECORD at response time (from raw server output items) must
// be identical to the shape we REPLAY on the next turn (from the transcript via
// translateMessages). canonicalizeCodexItem() defines that single shape; it is
// applied on the record side (normalizeCompletedOutputItem in the transport) and
// mirrored exactly by the replay branches in translateMessages below.

/**
 * Recomputes the canonical wire form of a recorded function_call's `arguments`
 * so it byte-matches what translateMessages will emit on replay.
 *
 * On replay, the transcript holds `normalizeToolInput(raw)` (applied once at
 * decode, messages.ts) and the send path applies `normalizeToolInputForAPI` on
 * top (messages.ts), then translateMessages emits `JSON.stringify(block.input)`.
 * To match, the record side composes the same two passes over the raw server
 * arguments — exactly once, with side effects suppressed (the decode-time pass
 * already fired them). Unknown tools (no registry entry) use a deterministic
 * re-stringify, while malformed/null arguments mirror decode's conservative
 * empty-object fallback.
 */
function canonicalizeToolArgumentsForRecord(
  toolName: string,
  rawArguments: unknown,
): string {
  const rawString =
    typeof rawArguments === 'string' ? rawArguments : JSON.stringify(rawArguments ?? {})
  const parsed = safeParseJSON(rawString)
  if (parsed === null) {
    // Decode maps both malformed JSON and JSON null to {}, and replay emits
    // JSON.stringify(block.input || {}). Mirror that conservative fallback so
    // malformed provider output forces neither canonical drift nor raw replay.
    return '{}'
  }
  if (typeof parsed !== 'object') {
    // Replay also replaces falsy primitive inputs with {}. Truthy primitives
    // are re-stringified as-is (they are unusual but deterministic).
    return JSON.stringify(parsed || {})
  }

  const tool = findToolByName(getAllBaseTools(), toolName)
  if (!tool) {
    // Unknown/MCP tool: normalizeToolInput is a no-op for these on replay too,
    // so a deterministic re-stringify is the canonical form on both sides.
    return JSON.stringify(parsed)
  }

  try {
    return withSuppressedNormalizeSideEffects(() => {
      const decoded = normalizeToolInput(
        tool,
        parsed as Record<string, unknown>,
      )
      const forApi = normalizeToolInputForAPI(tool, decoded)
      return JSON.stringify(forApi)
    })
  } catch {
    // Normalization threw (e.g. schema mismatch on a partial arg set): fall back
    // to a deterministic re-stringify so record and replay still agree on shape
    // for the common (no-mutation) case.
    return JSON.stringify(parsed)
  }
}

/**
 * Canonicalizes the structured JSON arm of Apply_patch custom-tool input.
 * Decode stores valid JSON objects structurally and replay compacts them with
 * JSON.stringify; doing the same at record time removes whitespace drift. Raw
 * non-JSON patch envelopes must remain byte-identical for executable handoff.
 */
function canonicalizeCustomToolInputForRecord(
  toolName: unknown,
  rawInput: unknown,
): unknown {
  if (toolName !== APPLY_PATCH_TOOL_NAME || typeof rawInput !== 'string') {
    return rawInput
  }

  // Raw patch envelopes are the expected/common case, so do not report their
  // intentional non-JSON syntax as a parse failure.
  const parsed = safeParseJSON(rawInput, false)
  return parsed && typeof parsed === 'object'
    ? JSON.stringify(parsed)
    : rawInput
}

/**
 * Produces the one canonical shape for a Codex response output item, dropping
 * volatile/unknown fields (e.g. `logprobs` on output_text parts — codex-rs
 * protocol types have no such field and the server tolerates its absence). Used
 * at record time by the transport; the translateMessages replay branches emit
 * the same shapes so responseItemsEqual passes on unchanged history.
 */
export function canonicalizeCodexItem(
  item: Record<string, unknown>,
): Record<string, unknown> {
  if (item.type === 'message') {
    const parts = Array.isArray(item.content) ? item.content : []
    return {
      type: 'message',
      role: item.role,
      content: parts.map(part => {
        const p = part as Record<string, unknown>
        // Canonical content part: drop logprobs and any other unknown fields.
        return {
          type: 'output_text',
          text: p.text,
          annotations: Array.isArray(p.annotations) ? p.annotations : [],
        }
      }),
      status: 'completed',
    }
  }

  if (item.type === 'function_call') {
    return {
      type: 'function_call',
      call_id: item.call_id,
      name: item.name,
      arguments: canonicalizeToolArgumentsForRecord(
        typeof item.name === 'string' ? item.name : '',
        item.arguments,
      ),
    }
  }

  if (item.type === 'custom_tool_call') {
    return {
      type: 'custom_tool_call',
      call_id: item.call_id,
      name: item.name,
      input: canonicalizeCustomToolInputForRecord(item.name, item.input),
    }
  }

  if (item.type === 'reasoning') {
    return {
      type: 'reasoning',
      summary: [],
      encrypted_content: item.encrypted_content,
    }
  }

  // web_search_call and any future item kinds have no replay branch in
  // translateMessages; preserve them verbatim (a full send on the next turn is
  // the accepted residual).
  return JSON.parse(JSON.stringify(item))
}

// Register the canonicalizer with the transport so normalizeCompletedOutputItem
// runs the exact same record-side canonicalization as the replay path here.
registerOutputItemCanonicalizer(canonicalizeCodexItem)

/**
 * Recovers the raw custom_tool_call `input` string for an Apply_patch tool_use
 * so replay matches the server-recorded custom_tool_call baseline.
 *
 * The transcript stores Apply_patch input as a union (see FilePatchTool/types.ts
 * and messages.ts's unparseable-envelope wrap):
 *   - `{ input: "<raw envelope text>" }`  — the common case; recover raw.
 *   - a bare string                       — already the raw envelope.
 *   - `{ ops: [...] }`                     — the valid-JSON structured arm; the
 *     server recorded the raw JSON string it received, so re-serialize it.
 */
function recoverApplyPatchInput(input: unknown): string {
  if (typeof input === 'string') {
    return input
  }
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>
    if (typeof obj.input === 'string') {
      return obj.input
    }
    // `{ ops: [...] }` arm (or any other object shape): the custom_tool_call
    // input the server saw was the serialized JSON, so serialize deterministically.
    return JSON.stringify(input)
  }
  return ''
}

// ── Record-time tool-result truncation (gpt models only) ─────────────
//
// Nothing prunes gpt history before autocompact (~229k) on this build, so
// cat-code re-bills the full, untrimmed history on every cache miss. Codex CLI
// middle-truncates every function/custom tool output to Tokens(10,000) ×1.2 at
// record time (truncate_function_output_payload); gpt models were trained in
// that environment. We mirror it at WIRE time inside translateMessages — the
// single choke point every Codex request (fetch + WS, main + subagent + side
// queries) passes through, and the ONLY translation path an openai request
// takes. The transcript on disk stays full: a mid-session switch back to a
// Claude model sees untruncated history and `--resume` is byte-stable.
//
// The truncated form is a PURE function of content (no timestamps, no counters):
// identical across turns, so it does not break prompt-cache prefix stability and
// does not fight Item 1's length-based incremental reconcile.

// codex parity: Tokens(10,000) policy × 1.2 serialization allowance,
// char-approximated at 4 bytes/token. Picked ONCE — changing it later is a
// one-time cache break for every live conversation.
const CODEX_TOOL_OUTPUT_TOKEN_BUDGET = 10_000
const CODEX_TOOL_OUTPUT_SERIALIZATION_MULTIPLIER = 1.2
const CODEX_APPROX_CHARS_PER_TOKEN = 4
export const CODEX_TOOL_OUTPUT_MAX_CHARS = Math.floor(
  CODEX_TOOL_OUTPUT_TOKEN_BUDGET *
    CODEX_TOOL_OUTPUT_SERIALIZATION_MULTIPLIER *
    CODEX_APPROX_CHARS_PER_TOKEN,
) // 48,000 chars

/**
 * Middle-truncate an over-budget tool-result string to ~10k tokens, mirroring
 * codex's truncate_function_output_payload: keep a head and a tail, drop the
 * middle, splice in a deterministic marker. The marker tells the model the
 * middle was elided and how to retrieve it — re-Read the file with offset/limit,
 * or re-run the Bash/Grep command more narrowly (readFileState marks a file
 * fully-read regardless of wire truncation, and Edit fails closed since
 * old_string matches disk, so the model must be told explicitly).
 *
 * Pure function of `text`: no timestamps/counters, so the output is byte-
 * identical across turns for the same input.
 */
export function truncateCodexToolOutputText(text: string): string {
  if (text.length <= CODEX_TOOL_OUTPUT_MAX_CHARS) {
    return text
  }
  const omitted = text.length - CODEX_TOOL_OUTPUT_MAX_CHARS
  const marker =
    `\n\n[... ${omitted} characters truncated to fit the model's tool-output ` +
    `budget; full output was preserved on disk but is not in this request. To ` +
    `see the elided middle, re-Read the file with an offset/limit around the ` +
    `region you need, or re-run the originating Bash/Grep command scoped more ` +
    `narrowly ...]\n\n`
  // Reserve room for the marker inside the budget so the truncated payload never
  // exceeds CODEX_TOOL_OUTPUT_MAX_CHARS. Split the remainder head-heavy (2/3
  // head, 1/3 tail): the head carries the framing/most-relevant lines, the tail
  // preserves the end (e.g. a final error or summary line).
  const usable = Math.max(0, CODEX_TOOL_OUTPUT_MAX_CHARS - marker.length)
  const headLen = Math.floor((usable * 2) / 3)
  const tailLen = usable - headLen
  const head = text.slice(0, headLen)
  const tail = tailLen > 0 ? text.slice(text.length - tailLen) : ''
  return head + marker + tail
}

/**
 * Apply record-time truncation to a translated function_call_output `output`.
 *
 * Exemptions (returned unchanged):
 *  - ToolSearch results (schema-bearing; truncating them can drop deferred-tool
 *    definitions mid-payload and break tool loading — codex likewise exempts its
 *    ToolSearchOutput variant),
 *  - results whose originating tool can't be identified (`toolName` undefined):
 *    the openai path doesn't run ensureToolResultPairing (unlike messagesForAPI
 *    in claude.ts), so a resumed/teleported transcript can carry an ORPHANED
 *    tool_result whose tool_use isn't in this message set. Fail safe there
 *    rather than risk truncating an orphaned schema-bearing ToolSearch payload;
 *    the giant-Read case we target is always paired (its tool_use is present),
 *    so this costs nothing on the hot path,
 *  - any output containing an image (`input_image`) part — never truncate an
 *    image or its accompanying multimodal array,
 *  - outputs already under the cap.
 *
 * Truncates:
 *  - a plain string output (the common giant-Read case — Read returns its text
 *    as a bare string), and
 *  - a text-only array output (single/multiple `input_text` parts, no image):
 *    the concatenated text collapses to one truncated `input_text` part.
 */
function applyCodexToolOutputTruncation(
  output: string | Array<Record<string, unknown>>,
  toolName: string | undefined,
): string | Array<Record<string, unknown>> {
  if (toolName === undefined || toolName === TOOL_SEARCH_TOOL_NAME) {
    return output
  }
  if (typeof output === 'string') {
    return truncateCodexToolOutputText(output)
  }
  if (!Array.isArray(output)) {
    return output
  }
  // Any image present → never truncate (multimodal preserved verbatim).
  const hasImage = output.some(part => part.type === 'input_image')
  if (hasImage) {
    return output
  }
  const combined = output
    .map(part => (typeof part.text === 'string' ? part.text : ''))
    .join('')
  if (combined.length <= CODEX_TOOL_OUTPUT_MAX_CHARS) {
    return output
  }
  return [{ type: 'input_text', text: truncateCodexToolOutputText(combined) }]
}

// ── Message translation: Anthropic → Codex input ────────────────────

/**
 * Translates Anthropic message format to Codex input format.
 * Handles text content, tool results, and image attachments.
 * @param anthropicMessages - Array of messages in Anthropic format
 * @returns Array of Codex-compatible input objects
 */
function translateMessages(
  anthropicMessages: AnthropicMessage[],
): Array<Record<string, unknown>> {
  const codexInput: Array<Record<string, unknown>> = []
  // Track pending function_call call_ids so tool_result blocks reuse the
  // originating Codex call_id instead of inventing Claude-style positional state.
  let toolCallCounter = 0
  const pendingToolCallIds = new Set<string>()
  // Track call_ids for tool_use blocks we skipped (e.g. StructuredOutput) so
  // we can also drop their paired tool_result blocks — otherwise the Codex
  // request would contain orphaned function_call_output items.
  const skippedToolCallIds = new Set<string>()
  // Map each call_id to the tool that produced it. tool_use blocks always
  // precede their paired tool_result in the transcript, so by the time a
  // function_call_output is emitted its originating tool name is known. Used to
  // exempt schema-bearing ToolSearch results from wire-time truncation.
  const toolNameByCallId = new Map<string, string>()

  const resolveToolResultCallId = (block: AnthropicContentBlock): string => {
    if (typeof block.tool_use_id === 'string' && block.tool_use_id.length > 0) {
      pendingToolCallIds.delete(block.tool_use_id)
      return block.tool_use_id
    }

    if (pendingToolCallIds.size === 1) {
      const solePendingCallId = pendingToolCallIds.values().next().value as string
      pendingToolCallIds.delete(solePendingCallId)
      logForDebugging(
        `[codex-fetch] Reusing sole pending call_id ${solePendingCallId} for tool_result without tool_use_id`,
      )
      return solePendingCallId
    }

    const reason =
      pendingToolCallIds.size === 0
        ? 'no pending function_call remains in the translated request'
        : `${pendingToolCallIds.size} pending function_call items remain in the translated request`
    throw new Error(
      `Codex request translation cannot pair tool_result without tool_use_id: ${reason}`,
    )
  }

  const translateToolResultOutput = (
    content: AnthropicContentBlock['content'],
  ): string | Array<Record<string, unknown>> => {
    if (typeof content === 'string') {
      return content
    }

    if (!Array.isArray(content)) {
      return ''
    }

    const outputItems: Array<Record<string, unknown>> = []
    for (const part of content) {
      if (part.type === 'text') {
        outputItems.push({
          type: 'input_text',
          text: part.text,
        })
      } else if (
        part.type === 'image' &&
        typeof part.source === 'object' &&
        part.source !== null &&
        (part.source as Record<string, unknown>).type === 'base64'
      ) {
        outputItems.push({
          type: 'input_image',
          image_url: `data:${(part.source as Record<string, string>).media_type};base64,${(part.source as Record<string, string>).data}`,
        })
      }
    }

    return outputItems.length > 0 ? outputItems : ''
  }

  for (const rawMsg of anthropicMessages) {
    // Unwrap Cat Code internal message wrapper { type, message: { role, content }, ... }
    const msg: AnthropicMessage =
      'message' in rawMsg && rawMsg.message != null
        ? (rawMsg.message as AnthropicMessage)
        : rawMsg
    if (typeof msg.content === 'string') {
      codexInput.push({ role: msg.role, content: msg.content })
      continue
    }

    if (!Array.isArray(msg.content)) continue

    if (msg.role === 'user') {
      const contentArr: Array<Record<string, unknown>> = []
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          // Drop tool_result blocks whose originating tool_use was skipped.
          if (
            typeof block.tool_use_id === 'string' &&
            skippedToolCallIds.has(block.tool_use_id)
          ) {
            continue
          }
          const callId = resolveToolResultCallId(block)
          const output = applyCodexToolOutputTruncation(
            translateToolResultOutput(block.content),
            toolNameByCallId.get(callId),
          )
          codexInput.push({
            type: 'function_call_output',
            call_id: callId,
            output,
          })
        } else if (block.type === 'text' && typeof block.text === 'string') {
          contentArr.push({ type: 'input_text', text: block.text })
        } else if (
          block.type === 'image' &&
          typeof block.source === 'object' &&
          block.source !== null &&
          (block.source as any).type === 'base64'
        ) {
          contentArr.push({
            type: 'input_image',
            image_url: `data:${(block.source as any).media_type};base64,${(block.source as any).data}`,
          })
        }
      }
      if (contentArr.length > 0) {
        if (contentArr.length === 1 && contentArr[0].type === 'input_text') {
          codexInput.push({ role: 'user', content: contentArr[0].text })
        } else {
          codexInput.push({ role: 'user', content: contentArr })
        }
      }
    } else {
      // Process assistant or tool blocks
      for (const block of msg.content) {
        if (
          msg.role === 'assistant' &&
          block.type === 'thinking' &&
          typeof (block as unknown as { signature?: unknown }).signature === 'string' &&
          (block as unknown as { signature: string }).signature.length > 0
        ) {
          // Round-trip reasoning: the streaming decoder smuggles upstream's
          // encrypted reasoning blob through Anthropic's native
          // thinking.signature field. Emit it back as a Codex reasoning item
          // with empty summary/content so the server's KV-cache prefix
          // matches what it saw last turn.
          codexInput.push({
            type: 'reasoning',
            summary: [],
            encrypted_content: (block as unknown as { signature: string }).signature,
          })
          logForDebugging(
            `[codex-cache] replay reasoning item sig_len=${(block as unknown as { signature: string }).signature.length}`,
          )
        } else if (block.type === 'text' && typeof block.text === 'string') {
          if (msg.role === 'assistant') {
            codexInput.push({
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: block.text, annotations: [] }],
              status: 'completed',
            })
          }
        } else if (block.type === 'tool_use') {
          const callId = block.id || `call_${toolCallCounter++}`
          // StructuredOutput is a cat-code–internal tool that is never registered
          // on the Codex path. Strip it from history so OpenAI models don't see
          // the schema and attempt to call it.
          if (block.name === SYNTHETIC_OUTPUT_TOOL_NAME) {
            skippedToolCallIds.add(callId)
            continue
          }
          pendingToolCallIds.add(callId)
          if (typeof block.name === 'string' && block.name.length > 0) {
            toolNameByCallId.set(callId, block.name)
          }
          if (block.name === APPLY_PATCH_TOOL_NAME) {
            // The server ALWAYS records Apply_patch as a custom_tool_call (it is
            // a custom lark-grammar tool). Emit custom_tool_call unconditionally
            // so replay matches the recorded baseline (previously this only fired
            // when block.input was still a string, causing type_mismatch since
            // the transcript stores it wrapped/parsed).
            codexInput.push({
              type: 'custom_tool_call',
              call_id: callId,
              name: block.name || '',
              input: recoverApplyPatchInput(block.input),
            })
          } else {
            // Deterministic re-serialization on replay; the record side runs the
            // same normalize pipeline (canonicalizeToolArgumentsForRecord) so the
            // two agree byte-for-byte on unchanged history.
            codexInput.push({
              type: 'function_call',
              call_id: callId,
              name: block.name || '',
              arguments: JSON.stringify(block.input || {}),
            })
          }
        }
      }
    }
  }

  return codexInput
}

// ── Full request translation ────────────────────────────────────────

/**
 * Translates a complete Anthropic API request body to Codex format.
 * @param anthropicBody - The Anthropic request body to translate
 * @returns Object containing the translated Codex body and model
 */
export function translateToCodexBody(anthropicBody: Record<string, unknown>): {
  codexBody: Record<string, unknown>
  codexModel: string
} {
  const openAIAssembly = anthropicBody._openaiInstructionAssembly as
    | OpenAIInstructionAssemblyPayload
    | undefined
  const claudeModel = anthropicBody.model as string
  const anthropicTools = (anthropicBody.tools || []) as AnthropicTool[]

  if (!openAIAssembly) {
    throw new Error(
      'OpenAI request missing provider-native instruction assembly payload',
    )
  }

  const codexModel = mapClaudeModelToCodex(claudeModel)
  const instructions = openAIAssembly.instructions

  // Convert messages
  const input = translateMessages(openAIAssembly.inputMessages)
  if (openAIAssembly.developerContext) {
    input.unshift({
      type: 'message',
      role: 'developer',
      content: [
        {
          type: 'input_text',
          text: openAIAssembly.developerContext,
        },
      ],
    })
  }

  // prompt_cache_key is overwritten at the call site with the conversation_id
  // (see the fetch adapter below) to match upstream openai/codex semantics.
  const codexBody: Record<string, unknown> = {
    model: codexModel,
    store: false,
    stream: true,
    instructions,
    input,
    tool_choice: translateToolChoice(
      anthropicBody.tool_choice,
      anthropicTools,
    ),
    parallel_tool_calls: true,
  }

  const speed = anthropicBody.speed as 'standard' | 'fast' | null | undefined
  if (speed === 'fast') {
    codexBody.service_tier = 'priority'
    logForDebugging(`[codex-cache] service_tier=priority (fast mode)`)
  }

  // Add tools if present
  const translatedTools = anthropicTools.length > 0
    ? translateTools(anthropicTools)
    : []
  const hasHostedWebSearch = translatedTools.some(tool => tool.type === 'web_search')

  if (translatedTools.length > 0) {
    codexBody.tools = translatedTools
  }

  const outputConfig = anthropicBody.output_config as
    | {
        effort?: string
        format?: {
          type?: string
          schema?: Record<string, unknown>
        }
      }
    | undefined

  // Translate Anthropic structured outputs to the OpenAI Responses API shape
  // so GPT/Codex models receive a native schema contract instead of relying on
  // Claude-style prose instructions.
  if (
    outputConfig?.format?.type === 'json_schema' &&
    outputConfig.format.schema &&
    typeof outputConfig.format.schema === 'object'
  ) {
    codexBody.text = {
      format: {
        type: 'json_schema',
        name: 'cat_code_output',
        schema: outputConfig.format.schema,
        strict: true,
      },
    }
  }

  // Translate effort → Codex reasoning.effort.
  // claude.ts:configureEffortParams writes the user's /effort choice into
  // output_config.effort. Codex accepts model-specific reasoning levels.
  // Mapping:
  //   low|medium|high|xhigh → pass through
  //   minimal            → model-specific no/low-reasoning value
  //   max|ultra          → pass through for GPT-5.6 models that support them
  //   anything else/undef→ omit (Codex server default kicks in, typically high)
  //
  // Reasoning summaries: ask the server for human-readable summary output.
  // Default is 'auto'; user can override via reasoningSummaryDetail setting.
  // Setting 'none' suppresses summaries (saves output tokens).
  //
  // Thinking-disabled override: callers like streamCompactSummary pass
  // `thinking: { type: 'disabled' }` to signal "this is a pure-output task, do
  // not spend reasoning tokens". On Anthropic that short-circuits extended
  // thinking; the equivalent on Codex is the model's minimal reasoning effort.
  // Without this override the signal is silently dropped and the server defaults
  // to high effort — which made GPT-5.4 compaction take 5+ minutes.
  const thinking = anthropicBody.thinking as
    | { type?: string }
    | false
    | undefined
  const thinkingDisabled =
    thinking === false ||
    (typeof thinking === 'object' && thinking?.type === 'disabled')
  const rawEffort = outputConfig?.effort
  const codexEffort = thinkingDisabled
    ? mapEffortToCodex('minimal', codexModel)
    : mapEffortToCodex(rawEffort, codexModel)
  if (codexEffort) {
    const summaryDetail = thinkingDisabled
      ? 'none'
      : getReasoningSummaryDetail()
    const reasoningField: Record<string, string> = { effort: codexEffort }
    if (summaryDetail !== 'none') {
      reasoningField.summary = summaryDetail
    }
    codexBody.reasoning = reasoningField
    // Upstream openai/codex sends include=['reasoning.encrypted_content']
    // whenever reasoning is set (codex-rs/core/src/client.rs:833). Without
    // this the server never returns encrypted reasoning blobs, the next turn's
    // input[] cannot replay them, and the server's KV-cache of the prior turn
    // stops matching our prefix — so the cache ceiling gets pinned to the
    // `instructions` block alone. Requesting encrypted reasoning lets us
    // round-trip it as an opaque `thinking.signature` and grow the cached
    // prefix with the real conversation.
    addCodexInclude(codexBody, 'reasoning.encrypted_content')
  }

  if (hasHostedWebSearch) {
    addCodexInclude(codexBody, OPENAI_WEB_SEARCH_SOURCES_INCLUDE)
  }

  return { codexBody, codexModel }
}

/**
 * Maps a Claude-style effort level to a Codex reasoning.effort value.
 * Returns undefined when no reasoning field should be set (server default).
 */
export function mapEffortToCodex(
  effort: string | undefined,
  codexModel: string,
): string | undefined {
  if (!effort) return undefined
  const e = effort.toLowerCase()
  if (e === 'low' || e === 'medium' || e === 'high' || e === 'xhigh') return e
  if (e === 'minimal') {
    const model = codexModel.toLowerCase()
    // Cat Code's `minimal` means disabled thinking. GPT-5.6 models expose
    // `none`, which preserves the former GPT-5.4 Mini low-latency path.
    if (model === 'gpt-5.6-sol' || model === 'gpt-5.6-terra' || model === 'gpt-5.6-luna') return 'none'
    return 'minimal'
  }
  if (e === 'max') {
    const model = codexModel.toLowerCase()
    return model === 'gpt-5.6-sol' || model === 'gpt-5.6-terra' || model === 'gpt-5.6-luna'
      ? 'max'
      : model.includes('codex')
        ? 'xhigh'
        : 'high'
  }
  if (e === 'ultra') {
    const model = codexModel.toLowerCase()
    return model === 'gpt-5.6-sol' || model === 'gpt-5.6-terra'
      ? 'ultra'
      : undefined
  }
  return undefined
}

/**
 * Reads the user's reasoning-summary preference from settings.
 * Returns 'auto' when unset (matches Codex CLI's default behavior).
 */
function getReasoningSummaryDetail(): 'auto' | 'concise' | 'detailed' | 'none' {
  try {
    const settings = getInitialSettings() as Record<string, unknown>
    const v = settings?.reasoningSummaryDetail
    if (v === 'auto' || v === 'concise' || v === 'detailed' || v === 'none') {
      return v
    }
  } catch {
    // Defensive: if settings are unavailable for any reason, fall through.
  }
  return 'auto'
}

// ── Response translation: Codex SSE → Anthropic SSE ─────────────────

interface OpenToolCallBlock {
  callId: string
  name: string
  args: string
  index: number
  itemId?: string
  outputIndex?: number
}

interface CodexRequestCacheMetadata {
  ownerId?: string
  accountId: string
  model: string
  cacheContextKey: string
  conversationId: string
}

type CodexStreamTransport = 'websocket' | 'http'

type CodexStreamTransportContext = {
  transport: CodexStreamTransport
  requestStartedAtMs: number
  responseHeadersAtMs?: number
}

type HttpFallbackResult = {
  events: AsyncIterable<Record<string, unknown>>
  transportContext?: CodexStreamTransportContext
}

type HttpFallbackEventsFactory = () => Promise<HttpFallbackResult>

type AnthropicSseMaterializedMessage = {
  id: string
  type: 'message'
  role: 'assistant'
  content: AnthropicContentBlock[]
  model: string
  stop_reason: string | null
  stop_sequence: string | null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  }
}

/**
 * Formats data as Server-Sent Events (SSE) format.
 * @param event - The event type
 * @param data - The data payload
 * @returns Formatted SSE string
 */
function formatSSE(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`
}

/**
 * The HTTP-path idle timeout is recognised downstream by message prefix: it is
 * a plain Error, and classifying it as a transient transport interruption is
 * what makes an HTTP-fallback stall recoverable rather than terminal.
 */
const CODEX_HTTP_IDLE_TIMEOUT_PREFIX = 'Codex stream idle timeout after '

/**
 * Parses an HTTP SSE Response body into an async iterable of event objects.
 * Each yielded object is the parsed JSON from a `data: ...` SSE line.
 */
async function* httpSseToEvents(
  codexResponse: Response,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const IDLE_TIMEOUT_MS =
    parseInt(process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS || '', 10) || 90_000

  const reader = codexResponse.body?.getReader()
  if (!reader) return

  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let streamError: Error | null = null

  const cancelReader = (error: Error) => {
    streamError = error
    reader.cancel(error).catch(() => {})
  }

  const abortReader = () => {
    const reason = signal?.reason
    cancelReader(reason instanceof Error ? reason : new Error('Codex stream aborted'))
  }

  const resetIdleTimer = () => {
    if (idleTimer !== null) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      const idleTimeoutError = new Error(`${CODEX_HTTP_IDLE_TIMEOUT_PREFIX}${IDLE_TIMEOUT_MS}ms`)
      logForDebugging(
        `[codex-fetch] Streaming idle timeout: no chunks received for ${IDLE_TIMEOUT_MS / 1000}s, aborting`,
        { level: 'error' },
      )
      cancelReader(idleTimeoutError)
    }, IDLE_TIMEOUT_MS)
  }
  const clearIdleTimer = () => {
    if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null }
  }

  const decoder = new TextDecoder()
  let buffer = ''

  try {
    if (signal?.aborted) abortReader()
    signal?.addEventListener('abort', abortReader, { once: true })
    resetIdleTimer()
    while (true) {
      const { done, value } = await reader.read()
      if (streamError) throw streamError
      if (done) break
      resetIdleTimer()

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('event: ')) continue
        if (!trimmed.startsWith('data: ')) continue
        const dataStr = trimmed.slice(6)
        if (dataStr === '[DONE]') continue

        let event: Record<string, unknown>
        try { event = JSON.parse(dataStr) } catch { continue }
        yield event
      }
    }
  } finally {
    clearIdleTimer()
    signal?.removeEventListener('abort', abortReader)
  }
}

/**
 * Core event processor: consumes an async iterable of Codex event objects and
 * writes Anthropic SSE into the given ReadableStream controller.
 * Shared by both HTTP and WebSocket transports.
 */
async function processCodexEvents(
  events: AsyncIterable<Record<string, unknown>>,
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  codexModel: string,
  requestCacheMetadata?: CodexRequestCacheMetadata,
  httpFallback?: HttpFallbackEventsFactory,
  transportContext?: CodexStreamTransportContext,
): Promise<void> {
  const messageId = `msg_codex_${Date.now()}`
  const defaultStartMs = Date.now()

  let contentBlockIndex = 0
  let outputTokens = 0
  let inputTokens = 0
  let cachedInputTokens = 0
  let emittedVisibleOutput = false
  let sawUserVisibleOutput = false
  let currentEvents = events
  let usingHttpFallback = false
  let transport: CodexStreamTransport = transportContext?.transport ?? 'http'
  let responseHeadersAtMs: number | undefined = transportContext?.responseHeadersAtMs
  const streamStartedAtMs = transportContext?.requestStartedAtMs ?? defaultStartMs
  let fallbackErrorName: string | undefined
  let streamSurfaceRecorded = false
  let firstRawEventAtMs: number | null = null
  let firstReasoningDeltaAtMs: number | null = null
  let firstReasoningDoneAtMs: number | null = null
  let firstTextDeltaAtMs: number | null = null
  let firstVisibleAtMs: number | null = null
  let completedAtMs: number | null = null
  let rawEventCount = 0
  const rawEventTypes: Record<string, number> = {}
  let hadToolCalls = false
  let hadHostedWebSearch = false

  const noteVisibleOutput = (options?: { userVisible?: boolean }) => {
    if (firstVisibleAtMs === null) {
      firstVisibleAtMs = Date.now()
    }
    emittedVisibleOutput = true
    // `emittedVisibleOutput` means a frame left the adapter, which is what the
    // cap/auth guards and the stream-surface record want. It is NOT the same
    // question as "did the user see anything": the encrypted-reasoning carrier
    // below emits an EMPTY thinking block purely to ferry a cache blob. Gating
    // the replay refusal on that would strand a turn with a blank screen, so
    // the refusal reads this flag instead.
    if (options?.userVisible !== false) {
      sawUserVisibleOutput = true
    }
  }

  const relativeMs = (timestampMs: number | null | undefined): number | undefined => {
    if (timestampMs == null) return undefined
    return timestampMs - streamStartedAtMs
  }

  const recordStreamSurface = (
    options: {
      completed: boolean
      errorName?: string
    },
  ) => {
    if (streamSurfaceRecorded) {
      return
    }
    streamSurfaceRecorded = true
    recordCodexStreamSurface({
      transport,
      transport_path: usingHttpFallback ? 'websocket_then_http' : transport,
      conversation_id_prefix: requestCacheMetadata?.conversationId.slice(0, 8) ?? null,
      account_id_prefix: requestCacheMetadata?.accountId.slice(0, 8) ?? null,
      model: codexModel,
      response_headers_ms: relativeMs(responseHeadersAtMs),
      first_raw_event_ms: relativeMs(firstRawEventAtMs),
      first_reasoning_delta_ms: relativeMs(firstReasoningDeltaAtMs),
      first_reasoning_done_ms: relativeMs(firstReasoningDoneAtMs),
      first_text_delta_ms: relativeMs(firstTextDeltaAtMs),
      first_visible_ms: relativeMs(firstVisibleAtMs),
      completed_ms: relativeMs(completedAtMs),
      input_tokens: inputTokens || undefined,
      cached_tokens: cachedInputTokens || undefined,
      output_tokens: outputTokens || undefined,
      raw_event_count: rawEventCount,
      raw_event_types: rawEventTypes,
      had_visible_output: emittedVisibleOutput,
      had_tool_calls: hadToolCalls,
      completed: options.completed,
      error_name: options.errorName,
      fallback_error_name: fallbackErrorName,
    })
  }

  const enqueueSse = (
    event: string,
    payload: Record<string, unknown>,
    options?: {
      visible?: boolean
    },
  ) => {
    if (options?.visible) {
      noteVisibleOutput()
    }
    controller.enqueue(encoder.encode(formatSSE(event, JSON.stringify(payload))))
  }

  // Emit Anthropic message_start
  enqueueSse('message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model: codexModel,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  })
  enqueueSse('ping', { type: 'ping' })

  let currentTextBlockStarted = false
  let syntheticToolCallCounter = 0
  const openToolCallBlocks = new Map<string, OpenToolCallBlock>()
  const toolCallIdsByItemId = new Map<string, string>()
  const toolCallIdsByOutputIndex = new Map<number, string>()

  const readString = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value : undefined

  const readNumber = (value: unknown): number | undefined =>
    typeof value === 'number' ? value : undefined

  const resolveOpenToolCall = (
    event: Record<string, unknown>,
    item?: Record<string, unknown>,
  ): OpenToolCallBlock | undefined => {
    const directCallId =
      readString(event.call_id) ||
      readString(event.item_call_id) ||
      readString(item?.call_id)
    if (directCallId && openToolCallBlocks.has(directCallId)) {
      return openToolCallBlocks.get(directCallId)
    }

    const itemId = readString(event.item_id) || readString(item?.id)
    if (itemId) {
      const mappedCallId = toolCallIdsByItemId.get(itemId)
      if (mappedCallId) {
        return openToolCallBlocks.get(mappedCallId)
      }
    }

    const outputIndex =
      readNumber(event.output_index) ?? readNumber(item?.output_index)
    if (outputIndex !== undefined) {
      const mappedCallId = toolCallIdsByOutputIndex.get(outputIndex)
      if (mappedCallId) {
        return openToolCallBlocks.get(mappedCallId)
      }
    }

    if (openToolCallBlocks.size === 1) {
      return openToolCallBlocks.values().next().value
    }

    return undefined
  }

  const closeOpenToolCall = (toolCall: OpenToolCallBlock) => {
    closeToolCallBlock(controller, encoder, toolCall.index)
    openToolCallBlocks.delete(toolCall.callId)
    if (toolCall.itemId) toolCallIdsByItemId.delete(toolCall.itemId)
    if (toolCall.outputIndex !== undefined) toolCallIdsByOutputIndex.delete(toolCall.outputIndex)
  }

  // ── Reasoning block state ────────────────────────────────────────────
  // Codex emits two flavors of human-readable reasoning content:
  //   1. summary: streamed via response.reasoning_summary_text.delta
  //      (with summary_index). Multiple parts may arrive per reasoning item;
  //      we merge them into one Anthropic `thinking` block, separated by "\n\n".
  //   2. raw: streamed via response.reasoning_text.delta (with content_index).
  //      Only emitted by the server for accounts/models entitled to receive it.
  //
  // We surface each as a separate Anthropic `thinking` block tagged with
  // `reasoning_kind` ('summary' | 'raw'). claude.ts copies that field onto
  // the stored content block so the UI can render them differently.
  //
  // The encrypted_content blob (cache continuity state) is attached as a
  // signature_delta on whichever reasoning block is open at output_item.done
  // time — preferring the summary block so the raw block (when present)
  // stays unsigned. If neither was opened, we synthesize an empty thinking
  // block to carry the signature, preserving today's cache-replay path.
  type ReasoningBlockState = {
    index: number
    kind: 'summary' | 'raw'
    parts: number // for summary: number of summary_index buckets seen
    started: boolean
  }
  let openSummaryBlock: ReasoningBlockState | null = null
  let openRawBlock: ReasoningBlockState | null = null
  let summaryDeltaCount = 0
  let rawDeltaCount = 0

  const noteFirstReasoningDelta = (atMs: number) => {
    if (firstReasoningDeltaAtMs === null) firstReasoningDeltaAtMs = atMs
  }

  const openReasoningBlock = (kind: 'summary' | 'raw'): ReasoningBlockState => {
    // If a text block is open, close it so the thinking block slots in
    // at the correct ordinal position in content[].
    if (currentTextBlockStarted) {
      controller.enqueue(
        encoder.encode(
          formatSSE('content_block_stop', JSON.stringify({
            type: 'content_block_stop',
            index: contentBlockIndex,
          })),
        ),
      )
      contentBlockIndex++
      currentTextBlockStarted = false
    }
    const index = contentBlockIndex
    contentBlockIndex++
    const block: ReasoningBlockState = { index, kind, parts: 0, started: true }
    noteVisibleOutput()
    controller.enqueue(
      encoder.encode(
        formatSSE('content_block_start', JSON.stringify({
          type: 'content_block_start',
          index,
          content_block: {
            type: 'thinking',
            thinking: '',
            // Non-standard field — claude.ts:2160 copies it through onto the
            // stored content block. Anthropic SDK ignores unknown keys.
            reasoning_kind: kind,
          },
        })),
      ),
    )
    return block
  }

  const appendReasoningDelta = (
    block: ReasoningBlockState,
    delta: string,
  ) => {
    if (typeof delta !== 'string' || delta.length === 0) return
    controller.enqueue(
      encoder.encode(
        formatSSE('content_block_delta', JSON.stringify({
          type: 'content_block_delta',
          index: block.index,
          delta: { type: 'thinking_delta', thinking: delta },
        })),
      ),
    )
  }

  const closeReasoningBlock = (block: ReasoningBlockState) => {
    controller.enqueue(
      encoder.encode(
        formatSSE('content_block_stop', JSON.stringify({
          type: 'content_block_stop',
          index: block.index,
        })),
      ),
    )
  }

  const closeAllOpenReasoningBlocks = () => {
    if (openRawBlock) {
      closeReasoningBlock(openRawBlock)
      openRawBlock = null
    }
    if (openSummaryBlock) {
      closeReasoningBlock(openSummaryBlock)
      openSummaryBlock = null
    }
  }

  // Assistant text used to reach the transcript only through
  // response.output_text.delta. The server may instead deliver a message's text
  // whole in terminal events (response.output_text.done,
  // response.content_part.done, or a populated item.content on
  // response.output_item.done) with no deltas at all, at which
  // point the text was silently discarded: the turn still reported
  // response.completed, so nothing surfaced the loss. See
  // docs/reports/2026-08-28-codex-adapter-terminal-text-drop.md.
  // Keyed per content part rather than per response because a multi-part message
  // can stream one part and deliver another whole.
  //
  // item_id is preferred over output_index because it is the identity the delta,
  // output_text.done, and output_item.done events all carry for the same item.
  // Absent values get sentinels rather than collapsing to 0: aliasing "no index"
  // with "index 0" lets one part suppress another part's recovery, which is the
  // silent loss this whole path exists to prevent.
  const textPartsEmitted = new Set<string>()
  const textPartKey = (
    itemRef: string | number | undefined,
    contentIndex: number | undefined,
  ): string => `${itemRef ?? 'noitem'}:${contentIndex ?? 'nopart'}`

  // One identity per item, resolved the same way from every event kind.
  // Deriving it from whichever optional field a given event happens to carry
  // made the four emitters disagree: a delta without item_id and an
  // output_text.done with one keyed the same part differently and emitted its
  // text twice. output_index is the field all four carry, so it wins; the map
  // recovers an identity for an event that has only item_id. Mirrors the
  // dual-lookup resolveOpenToolCall already uses for tool calls below.
  const outputIndexByItemId = new Map<string, number>()
  const resolveItemRef = (
    itemId: string | undefined,
    outputIndex: number | undefined,
  ): string | number | undefined => {
    if (itemId !== undefined && outputIndex !== undefined) {
      outputIndexByItemId.set(itemId, outputIndex)
    }
    if (outputIndex !== undefined) return outputIndex
    if (itemId !== undefined) return outputIndexByItemId.get(itemId) ?? itemId
    return undefined
  }
  const eventTextPartKey = (event: Record<string, unknown>): string =>
    textPartKey(
      resolveItemRef(readString(event.item_id), readNumber(event.output_index)),
      readNumber(event.content_index),
    )

  // Appends into the open text block when one exists so recovered text merges
  // with streamed text exactly as consecutive deltas would. The block is closed
  // by the same paths that close a delta-fed one.
  const emitAssistantText = (text: string) => {
    closeAllOpenReasoningBlocks()
    if (!currentTextBlockStarted) {
      noteVisibleOutput()
      controller.enqueue(
        encoder.encode(
          formatSSE('content_block_start', JSON.stringify({
            type: 'content_block_start',
            index: contentBlockIndex,
            content_block: { type: 'text', text: '' },
          })),
        ),
      )
      currentTextBlockStarted = true
    }
    noteVisibleOutput()
    controller.enqueue(
      encoder.encode(
        formatSSE('content_block_delta', JSON.stringify({
          type: 'content_block_delta',
          index: contentBlockIndex,
          delta: { type: 'text_delta', text },
        })),
      ),
    )
  }

  stream_loop: while (true) {
    try {
      for await (const event of currentEvents) {
            const eventType = event.type as string
            const eventObservedAtMs = Date.now()
            rawEventCount += 1
            rawEventTypes[eventType] = (rawEventTypes[eventType] ?? 0) + 1
            if (firstRawEventAtMs === null) {
              firstRawEventAtMs = eventObservedAtMs
            }
            if (
              eventType === 'response.output_text.delta' &&
              firstTextDeltaAtMs === null
            ) {
              firstTextDeltaAtMs = eventObservedAtMs
            }

            // ── Text output events ──────────────────────────────
            if (eventType === 'response.output_item.added') {
              const item = event.item as Record<string, unknown>
              if (item?.type === 'reasoning') {
                // Reasoning items are tracked via reasoning_summary_*.delta
                // and reasoning_text.delta events; nothing to do on add.
              } else if (item?.type === 'message') {
                // Close any open reasoning blocks so message text slots in
                // at the correct ordinal position.
                closeAllOpenReasoningBlocks()
              } else if (item?.type === 'web_search_call') {
                // Earliest structural sighting; see the in-flight arm below.
                hadHostedWebSearch = true
              } else if (
                item?.type === 'function_call' ||
                item?.type === 'custom_tool_call'
              ) {
                // Close any open reasoning blocks before tool blocks so
                // ordinal positions in content[] line up.
                closeAllOpenReasoningBlocks()
                if (currentTextBlockStarted) {
                  emittedVisibleOutput = true
                  controller.enqueue(
                    encoder.encode(
                      formatSSE('content_block_stop', JSON.stringify({
                        type: 'content_block_stop',
                        index: contentBlockIndex,
                      })),
                    ),
                  )
                  contentBlockIndex++
                  currentTextBlockStarted = false
                }

                const callId =
                  readString(item.call_id) ||
                  `toolu_synthetic_${Date.now()}_${syntheticToolCallCounter++}`
                const outputIndex = readNumber(event.output_index)
                const itemId = readString(item.id)
                const isCustomToolCall = item.type === 'custom_tool_call'
                const toolCall: OpenToolCallBlock = {
                  callId,
                  name: readString(item.name) || '',
                  args: isCustomToolCall
                    ? (typeof item.input === 'string' ? item.input : '')
                    : (typeof item.arguments === 'string' ? item.arguments : ''),
                  index: contentBlockIndex,
                  ...(itemId ? { itemId } : {}),
                  ...(outputIndex !== undefined ? { outputIndex } : {}),
                }

                openToolCallBlocks.set(callId, toolCall)
                if (itemId) {
                  toolCallIdsByItemId.set(itemId, callId)
                }
                if (outputIndex !== undefined) {
                  toolCallIdsByOutputIndex.set(outputIndex, callId)
                }
                hadToolCalls = true

                noteVisibleOutput()
                controller.enqueue(
                  encoder.encode(
                    formatSSE('content_block_start', JSON.stringify({
                      type: 'content_block_start',
                      index: contentBlockIndex,
                      content_block: {
                        type: 'tool_use',
                        id: callId,
                        name: toolCall.name,
                        input: isCustomToolCall ? '' : {},
                      },
                    })),
                  ),
                )

                contentBlockIndex++
              }
            }

            // Text deltas
            else if (eventType === 'response.output_text.delta') {
              const text = event.delta as string
              if (typeof text === 'string' && text.length > 0) {
                textPartsEmitted.add(eventTextPartKey(event))
                emitAssistantText(text)
                outputTokens += 1
              }
            }

            // Terminal text for one content part. Only recovers when that part
            // produced no delta; a delta-fed part already emitted its text and
            // re-emitting here would duplicate it.
            else if (eventType === 'response.output_text.done') {
              const partKey = eventTextPartKey(event)
              const text = readString(event.text)
              if (!textPartsEmitted.has(partKey) && text) {
                textPartsEmitted.add(partKey)
                logForDebugging(
                  `${RECOVERED_TERMINAL_TEXT_PREFIX} source=output_text.done ` +
                  `part=${partKey} chars=${text.length}`,
                  { level: 'warn' },
                )
                emitAssistantText(text)
              }
            }

            // Last of the three terminal sources. It arrives after
            // output_text.done and before output_item.done, and carries the
            // same item_id/content_index, so a part already emitted by a delta
            // or by output_text.done is skipped on the shared key and this
            // fires only for a server that carries the text here alone.
            else if (eventType === 'response.content_part.done') {
              const partKey = eventTextPartKey(event)
              const text = outputTextOfPart(event.part)
              if (!textPartsEmitted.has(partKey) && text) {
                textPartsEmitted.add(partKey)
                logForDebugging(
                  `${RECOVERED_TERMINAL_TEXT_PREFIX} source=content_part.done ` +
                  `part=${partKey} chars=${text.length}`,
                  { level: 'warn' },
                )
                emitAssistantText(text)
              }
            }

            // ── Reasoning summary events ────────────────────────
            // response.reasoning_summary_part.added: a new summary "part"
            // begins. We merge multiple parts into one Anthropic thinking
            // block, separating with "\n\n" so the user sees them as
            // paragraphs. summary_index is provided by Codex but we don't
            // need to track it strictly — text just appends in arrival order.
            else if (eventType === 'response.reasoning_summary_part.added') {
              if (!openSummaryBlock) {
                openSummaryBlock = openReasoningBlock('summary')
              } else if (openSummaryBlock.parts > 0) {
                appendReasoningDelta(openSummaryBlock, '\n\n')
              }
              openSummaryBlock.parts += 1
              noteFirstReasoningDelta(eventObservedAtMs)
            }
            // response.reasoning_summary_text.delta: text fragment for the
            // current summary part.
            else if (eventType === 'response.reasoning_summary_text.delta') {
              if (!openSummaryBlock) {
                // Some servers may emit summary_text.delta without a prior
                // part.added (single-part summaries). Open lazily.
                openSummaryBlock = openReasoningBlock('summary')
                openSummaryBlock.parts = 1
              }
              const delta = event.delta as string
              appendReasoningDelta(openSummaryBlock, delta)
              summaryDeltaCount += 1
              noteFirstReasoningDelta(eventObservedAtMs)
            }
            // response.reasoning_text.delta: raw provider reasoning trace.
            // Only emitted when the model+account are entitled to receive it.
            else if (eventType === 'response.reasoning_text.delta') {
              if (!openRawBlock) {
                openRawBlock = openReasoningBlock('raw')
              }
              const delta = event.delta as string
              appendReasoningDelta(openRawBlock, delta)
              rawDeltaCount += 1
              noteFirstReasoningDelta(eventObservedAtMs)
            }

            // ── Tool call argument deltas ───────────────────────
            else if (
              eventType === 'response.function_call_arguments.delta' ||
              eventType === 'response.custom_tool_call_input.delta'
            ) {
              const argDelta = event.delta as string
              const toolCall = resolveOpenToolCall(event)
              if (typeof argDelta === 'string' && toolCall) {
                toolCall.args += argDelta
                noteVisibleOutput()
                controller.enqueue(
                  encoder.encode(
                    formatSSE('content_block_delta', JSON.stringify({
                      type: 'content_block_delta',
                      index: toolCall.index,
                      delta: {
                        type: 'input_json_delta',
                        partial_json: argDelta,
                      },
                    })),
                  ),
                )
              }
            }

            // Tool call arguments complete
            else if (
              eventType === 'response.function_call_arguments.done' ||
              eventType === 'response.custom_tool_call_input.done'
            ) {
              const toolCall = resolveOpenToolCall(event)
              if (toolCall) {
                const finalArgs =
                  (event.arguments as string) ||
                  (event.input as string) ||
                  toolCall.args
                if (
                  finalArgs.startsWith(toolCall.args) &&
                  finalArgs.length > toolCall.args.length
                ) {
                  const argDelta = finalArgs.slice(toolCall.args.length)
                  noteVisibleOutput()
                  controller.enqueue(
                    encoder.encode(
                      formatSSE('content_block_delta', JSON.stringify({
                        type: 'content_block_delta',
                        index: toolCall.index,
                        delta: {
                          type: 'input_json_delta',
                          partial_json: argDelta,
                        },
                      })),
                    ),
                  )
                }
                toolCall.args = finalArgs
              }
            }

            // Output item done — close blocks
            else if (eventType === 'response.output_item.done') {
              const item = event.item as Record<string, unknown>
              if (
                item?.type === 'function_call' ||
                item?.type === 'custom_tool_call'
              ) {
                const toolCall = resolveOpenToolCall(event, item)
                if (toolCall) {
                  closeOpenToolCall(toolCall)
                }
              } else if (item?.type === 'web_search_call') {
                closeAllOpenReasoningBlocks()
                if (currentTextBlockStarted) {
                  noteVisibleOutput()
                  controller.enqueue(
                    encoder.encode(
                      formatSSE('content_block_stop', JSON.stringify({
                        type: 'content_block_stop',
                        index: contentBlockIndex,
                      })),
                    ),
                  )
                  contentBlockIndex++
                  currentTextBlockStarted = false
                }

                noteVisibleOutput()
                hadHostedWebSearch = true
                contentBlockIndex = emitOpenAIWebSearchCall(
                  controller,
                  encoder,
                  contentBlockIndex,
                  item,
                )
              } else if (item?.type === 'message') {
                // Last chance to recover text: the completed item carries the
                // authoritative content, and some responses deliver a populated
                // message here without ever emitting output_text.done for it.
                const itemRef = resolveItemRef(
                  readString(item.id),
                  readNumber(event.output_index),
                )
                const parts = Array.isArray(item.content) ? item.content : []
                for (const [contentIndex, part] of parts.entries()) {
                  const partKey = textPartKey(itemRef, contentIndex)
                  if (textPartsEmitted.has(partKey)) continue
                  const text = outputTextOfPart(part)
                  if (!text) continue
                  textPartsEmitted.add(partKey)
                  logForDebugging(
                    `${RECOVERED_TERMINAL_TEXT_PREFIX} source=output_item.done ` +
                    `part=${partKey} chars=${text.length}`,
                    { level: 'warn' },
                  )
                  emitAssistantText(text)
                }
                // A message whose parts carry no renderable text still ends the
                // turn with an empty assistant message and completed:true, which
                // is the signature this whole path exists to make legible. A
                // refusal-only message is the known case: it must not be emitted
                // as assistant prose, but it must not vanish without a trace
                // either. Logged, never rendered.
                if (!currentTextBlockStarted && parts.length > 0) {
                  const partTypes = parts
                    .map(part => (isRecord(part) ? readString(part.type) ?? 'unknown' : 'unknown'))
                    .join(',')
                  logForDebugging(
                    `${RECOVERED_TERMINAL_TEXT_PREFIX} source=output_item.done ` +
                    `part=${textPartKey(itemRef, undefined)} chars=0 dropped_parts=${partTypes}`,
                    { level: 'warn' },
                  )
                }
                if (currentTextBlockStarted) {
                  noteVisibleOutput()
                  controller.enqueue(
                    encoder.encode(
                      formatSSE('content_block_stop', JSON.stringify({
                        type: 'content_block_stop',
                        index: contentBlockIndex,
                      })),
                    ),
                  )
                  contentBlockIndex++
                  currentTextBlockStarted = false
                }
              } else if (item?.type === 'reasoning') {
                if (firstReasoningDoneAtMs === null) {
                  firstReasoningDoneAtMs = eventObservedAtMs
                }
                // Upstream openai/codex stores reasoning items (with their
                // encrypted_content blob) in conversation history and replays
                // them on the next turn. Without the replay, the server's
                // KV-cache prefix diverges from ours after turn 1 — caching
                // gets pinned to the `instructions` block alone.
                // We smuggle the encrypted blob through as an Anthropic
                // thinking block's `signature` field (the native round-trip
                // channel for opaque reasoning state). When a visible
                // summary/raw block is present, the signature attaches to
                // that block. When neither is present (server returned only
                // encrypted reasoning), we synthesize an empty thinking block
                // to carry the signature, preserving cache continuity.
                const encrypted = readString(item.encrypted_content)
                logForDebugging(
                  `[codex-cache] stream reasoning item encrypted=${encrypted ? encrypted.length + 'B' : 'ABSENT'} ` +
                    `summary_deltas=${summaryDeltaCount} raw_deltas=${rawDeltaCount}`,
                )
                // Prefer attaching to the summary block if present; fall back
                // to raw; else synthesize. We attach the signature *before*
                // closing the block so signature_delta lands on the right
                // index.
                const targetBlock = openSummaryBlock ?? openRawBlock
                if (encrypted && targetBlock) {
                  controller.enqueue(
                    encoder.encode(
                      formatSSE('content_block_delta', JSON.stringify({
                        type: 'content_block_delta',
                        index: targetBlock.index,
                        delta: { type: 'signature_delta', signature: encrypted },
                      })),
                    ),
                  )
                }
                // Close all open reasoning blocks now that the reasoning
                // item is done.
                closeAllOpenReasoningBlocks()

                if (encrypted && !targetBlock) {
                  // No visible reasoning was emitted; synthesize a hidden
                  // thinking block to carry the signature for cache replay.
                  if (currentTextBlockStarted) {
                    controller.enqueue(
                      encoder.encode(
                        formatSSE('content_block_stop', JSON.stringify({
                          type: 'content_block_stop',
                          index: contentBlockIndex,
                        })),
                      ),
                    )
                    contentBlockIndex++
                    currentTextBlockStarted = false
                  }
                  noteVisibleOutput({ userVisible: false })
                  controller.enqueue(
                    encoder.encode(
                      formatSSE('content_block_start', JSON.stringify({
                        type: 'content_block_start',
                        index: contentBlockIndex,
                        content_block: {
                          type: 'thinking',
                          thinking: '',
                          signature: encrypted,
                        },
                      })),
                    ),
                  )
                  noteVisibleOutput({ userVisible: false })
                  controller.enqueue(
                    encoder.encode(
                      formatSSE('content_block_stop', JSON.stringify({
                        type: 'content_block_stop',
                        index: contentBlockIndex,
                      })),
                    ),
                  )
                  contentBlockIndex++
                }
              }
            }

            // Response completed — extract usage
            else if (eventType === 'response.completed') {
              const response = event.response as Record<string, unknown>
              const usage = response?.usage as Record<string, unknown> | undefined
              if (usage) {
                outputTokens = (usage.output_tokens as number) || outputTokens
                inputTokens = (usage.input_tokens as number) || inputTokens
                const inputDetails = (usage.input_tokens_details ?? usage.prompt_tokens_details) as Record<string, number> | undefined
                cachedInputTokens = inputDetails?.cached_tokens || 0
              }
              completedAtMs = eventObservedAtMs
            }
            else if (eventType === 'response.failed') {
              throw createCodexResponseFailedError(
                event,
                requestCacheMetadata,
                emittedVisibleOutput,
              )
            }
            else if (
              eventType === 'response.web_search_call.in_progress' ||
              eventType === 'response.web_search_call.searching' ||
              eventType === 'response.web_search_call.completed'
            ) {
              // Block emission is handled via response.output_item.done, but the
              // recovery flag has to be set at the EARLIEST sighting, the way
              // `hadToolCalls` is. A stream that dies mid-search would otherwise
              // report no hosted search at all and be judged continuable in
              // exactly the state the flag exists to refuse.
              hadHostedWebSearch = true
            }
      }
      break stream_loop
    } catch (err) {
      const normalizedError = normalizeCodexStreamError(err, requestCacheMetadata)
      const canFallbackToHttp =
        !usingHttpFallback &&
        !emittedVisibleOutput &&
        !!httpFallback &&
        isRecoverableCodexStreamError(normalizedError)
      // Every post-visible failure blocks replay, whichever transport carried
      // it and whatever ended it. The gate used to be websocket-only and
      // transient-only, which left a post-visible HTTP disconnect and a
      // post-visible `response.failed` falling through to the provider-neutral
      // non-streaming fallback — a replay of a request whose output the user
      // had already read, and whose surfaced tool call could run twice.
      const replaySkippedAfterVisibleOutput =
        sawUserVisibleOutput && !isCodexStreamAbortError(normalizedError)

      if (canFallbackToHttp) {
        logForDebugging(
          `[codex-fetch] switching active stream to HTTP fallback conv=${requestCacheMetadata?.conversationId.slice(0, 8) ?? 'none'} ` +
          `error_name=${normalizedError.name}`,
          { level: 'warn' },
        )
        try {
          const fallback = await httpFallback()
          usingHttpFallback = true
          fallbackErrorName = normalizedError.name
          currentEvents = fallback.events
          if (fallback.transportContext) {
            const fallbackTransportContext = fallback.transportContext
            transport = fallbackTransportContext.transport
            responseHeadersAtMs = fallbackTransportContext.responseHeadersAtMs
          }
        } catch (fallbackError) {
          const fallbackName =
            fallbackError instanceof Error ? fallbackError.name : 'CodexHttpFallbackError'
          controller.error(
            fallbackError instanceof Error
              ? fallbackError
              : new Error(String(fallbackError)),
          )
          recordStreamSurface({
            completed: false,
            errorName: fallbackName,
          })
          return
        }
        continue stream_loop
      }

      if (replaySkippedAfterVisibleOutput) {
        const classification = classifyPostVisibleCodexFailure(
          normalizedError,
          usingHttpFallback,
          transport,
        )
        // Seal the partial response before surfacing the failure. `claude.ts`
        // only materializes a content block as an assistant message when it
        // sees `content_block_stop`, so an open block dies with the stream and
        // the text the user already watched arrive would be absent from the
        // continuation's context — which is how a continuation ends up
        // rewriting it. Tool-call blocks are deliberately left open: a
        // half-streamed call must never be handed on looking complete.
        const hadOpenReasoningBlock =
          openSummaryBlock !== null || openRawBlock !== null
        closeAllOpenReasoningBlocks()
        let sealedPartialText = false
        if (currentTextBlockStarted) {
          controller.enqueue(
            encoder.encode(
              formatSSE('content_block_stop', JSON.stringify({
                type: 'content_block_stop',
                index: contentBlockIndex,
              })),
            ),
          )
          contentBlockIndex++
          currentTextBlockStarted = false
          sealedPartialText = true
        }
        // Drain BEFORE the payload is built. `controller.error()` resets the
        // queue, so until the reader has pulled it the seal is not delivered,
        // and a payload claiming `sealedPartialText` for a chunk that never
        // arrived would send the continuation an instruction to continue from
        // a response that is not in its context. Unknown state fails closed.
        const sealDelivered =
          sealedPartialText || hadOpenReasoningBlock
            ? await drainControllerQueue(controller)
            : true
        const sealedPartialTextDelivered = sealedPartialText && sealDelivered
        const failure: CodexPartialStreamFailureV1 = {
          version: 1,
          code: 'partial_stream_replay_skipped',
          provider: 'openai',
          transport: classification.transport,
          cause: classification.cause,
          sealedPartialText: sealedPartialTextDelivered,
          hadClientToolCall: hadToolCalls,
          openClientToolCalls: openToolCallBlocks.size,
          hadHostedWebSearch,
          automaticContinuationEligible:
            classification.transient &&
            !hadToolCalls &&
            openToolCallBlocks.size === 0 &&
            !hadHostedWebSearch &&
            // A text block we could not confirm delivery of is lost text; a
            // continuation would regenerate it, which is the duplication this
            // whole path exists to prevent.
            (!sealedPartialText || sealedPartialTextDelivered),
        }
        logForDebugging(
          `[codex-fetch] replay_skipped_visible_output=true conv=${requestCacheMetadata?.conversationId.slice(0, 8) ?? 'none'} ` +
          `error_name=${normalizedError.name} transport=${failure.transport} cause=${failure.cause} ` +
          `had_tool_calls=${hadToolCalls} open_tool_calls=${openToolCallBlocks.size} ` +
          `sealed_partial_text=${sealedPartialTextDelivered} hosted_web_search=${hadHostedWebSearch} ` +
          `eligible=${failure.automaticContinuationEligible}`,
          { level: 'warn' },
        )
        // Metadata is booleans and counts only (LogEventMetadata admits no
        // strings); transport and cause stay in the debug line above.
        logEvent('tengu_codex_partial_stream_detected', {
          websocket: failure.transport === 'websocket',
          idle_timeout: failure.cause === 'idle_timeout',
          provider_failure: failure.cause === 'provider_failure',
          sealed_partial_text: sealedPartialTextDelivered,
          had_client_tool_call: hadToolCalls,
          open_client_tool_calls: openToolCallBlocks.size,
          hosted_web_search: hadHostedWebSearch,
          eligible: failure.automaticContinuationEligible,
        })
        controller.error(
          createPartialStreamReplaySkippedError(
            normalizedError,
            failure,
            requestCacheMetadata,
            classification.transport === 'websocket' &&
              classification.transient,
          ),
        )
        recordStreamSurface({
          completed: false,
          errorName: normalizedError.name,
        })
        return
      }

      controller.error(normalizedError)
      recordStreamSurface({
        completed: false,
        errorName: normalizedError.name,
      })
      return
    }
  }

  // Close any remaining open blocks
  if (currentTextBlockStarted) {
    controller.enqueue(
      encoder.encode(
        formatSSE('content_block_stop', JSON.stringify({
          type: 'content_block_stop',
          index: contentBlockIndex,
        })),
      ),
    )
  }
  for (const toolCall of openToolCallBlocks.values()) {
    closeToolCallBlock(controller, encoder, toolCall.index)
  }

  finishStream(
    controller,
    encoder,
    outputTokens,
    inputTokens,
    cachedInputTokens,
    hadToolCalls,
    requestCacheMetadata,
  )
  recordStreamSurface({ completed: true })
}

function closeToolCallBlock(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  index: number,
) {
  controller.enqueue(
    encoder.encode(
      formatSSE('content_block_stop', JSON.stringify({
        type: 'content_block_stop',
        index,
      })),
    ),
  )
}

function readWebSearchAction(
  item: Record<string, unknown>,
): {
  input: Record<string, unknown>
  sources: Array<{ title: string; url: string }>
} {
  const action = item.action as Record<string, unknown> | undefined
  const actionType = typeof action?.type === 'string' ? action.type : 'other'
  const query =
    typeof action?.query === 'string'
      ? action.query
      : Array.isArray(action?.queries)
        ? action.queries.filter((q): q is string => typeof q === 'string').join('; ')
        : typeof action?.url === 'string'
          ? action.url
          : ''

  const sources = Array.isArray(action?.sources)
    ? action.sources.flatMap(source => {
        if (typeof source !== 'object' || source === null) return []
        const record = source as Record<string, unknown>
        const url = typeof record.url === 'string' ? record.url : ''
        if (!url) return []
        const title = typeof record.title === 'string' && record.title.length > 0
          ? record.title
          : url
        return [{ title, url }]
      })
    : []

  const input: Record<string, unknown> = { type: actionType }
  if (query) input.query = query
  if (Array.isArray(action?.queries)) input.queries = action.queries
  if (typeof action?.url === 'string') input.url = action.url
  if (typeof action?.pattern === 'string') input.pattern = action.pattern

  return { input, sources }
}

function emitOpenAIWebSearchCall(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  index: number,
  item: Record<string, unknown>,
): number {
  const id = typeof item.id === 'string' && item.id.length > 0
    ? item.id
    : `ws_${Date.now()}`
  const { input, sources } = readWebSearchAction(item)

  controller.enqueue(
    encoder.encode(
      formatSSE('content_block_start', JSON.stringify({
        type: 'content_block_start',
        index,
        content_block: {
          type: 'server_tool_use',
          id,
          name: 'web_search',
          input: {},
        },
      })),
    ),
  )
  controller.enqueue(
    encoder.encode(
      formatSSE('content_block_delta', JSON.stringify({
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(input),
        },
      })),
    ),
  )
  controller.enqueue(
    encoder.encode(
      formatSSE('content_block_stop', JSON.stringify({
        type: 'content_block_stop',
        index,
      })),
    ),
  )

  const resultIndex = index + 1
  controller.enqueue(
    encoder.encode(
      formatSSE('content_block_start', JSON.stringify({
        type: 'content_block_start',
        index: resultIndex,
        content_block: {
          type: 'web_search_tool_result',
          tool_use_id: id,
          content: sources,
        },
      })),
    ),
  )
  controller.enqueue(
    encoder.encode(
      formatSSE('content_block_stop', JSON.stringify({
        type: 'content_block_stop',
        index: resultIndex,
      })),
    ),
  )

  return resultIndex + 1
}

function emitTextBlock(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  index: number,
  text: string,
) {
  controller.enqueue(
    encoder.encode(
      formatSSE('content_block_start', JSON.stringify({
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      })),
    ),
  )
  controller.enqueue(
    encoder.encode(
      formatSSE('content_block_delta', JSON.stringify({
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text },
      })),
    ),
  )
  controller.enqueue(
    encoder.encode(
      formatSSE('content_block_stop', JSON.stringify({
        type: 'content_block_stop',
        index,
      })),
    ),
  )
}

/**
 * Wraps an AsyncIterable<event> source in a streaming Anthropic HTTP Response.
 */
function buildAnthropicStreamResponse(
  events: AsyncIterable<Record<string, unknown>>,
  codexModel: string,
  requestCacheMetadata?: CodexRequestCacheMetadata,
  httpFallback?: HttpFallbackEventsFactory,
  transportContext?: CodexStreamTransportContext,
  cancelSource?: (reason?: unknown) => void,
): Response {
  const messageId = `msg_codex_${Date.now()}`
  const encoder = new TextEncoder()
  const readable = new ReadableStream({
    async start(controller) {
      await processCodexEvents(
        events,
        controller,
        encoder,
        codexModel,
        requestCacheMetadata,
        httpFallback,
        transportContext,
      )
    },
    cancel(reason) {
      cancelSource?.(reason)
    },
  })
  return new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'x-request-id': messageId,
    },
  })
}

/**
 * Translates a Codex HTTP SSE Response to Anthropic streaming format.
 */
export async function translateCodexStreamToAnthropic(
  codexResponse: Response,
  codexModel: string,
  requestCacheMetadata?: CodexRequestCacheMetadata,
  transportContext?: CodexStreamTransportContext,
): Promise<Response> {
  return buildAnthropicStreamResponse(
    httpSseToEvents(codexResponse),
    codexModel,
    requestCacheMetadata,
    undefined,
    transportContext,
  )
}

function parseAnthropicSseBlocks(
  sseBody: string,
): Array<{ event?: string, data: Record<string, unknown> }> {
  const blocks: Array<{ event?: string, data: Record<string, unknown> }> = []
  for (const block of sseBody.split(/\n\n+/)) {
    let event: string | undefined
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) {
        event = line.slice(7)
      } else if (line.startsWith('data: ')) {
        dataLines.push(line.slice(6))
      }
    }
    if (dataLines.length === 0) continue
    const dataText = dataLines.join('\n')
    if (dataText === '[DONE]') continue
    try {
      blocks.push({ event, data: JSON.parse(dataText) })
    } catch {
      continue
    }
  }
  return blocks
}

function materializeAnthropicMessageFromSse(
  sseBody: string,
  codexModel: string,
): AnthropicSseMaterializedMessage {
  let message: AnthropicSseMaterializedMessage | null = null
  const content: AnthropicContentBlock[] = []
  const inputJsonDeltasByIndex = new Map<number, string>()

  for (const { data } of parseAnthropicSseBlocks(sseBody)) {
    const type = data.type
    if (type === 'message_start') {
      const startedMessage = data.message as
        | Partial<AnthropicSseMaterializedMessage>
        | undefined
      message = {
        id: typeof startedMessage?.id === 'string' ? startedMessage.id : '',
        type: 'message',
        role: 'assistant',
        content,
        model: typeof startedMessage?.model === 'string'
          ? startedMessage.model
          : codexModel,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }
    } else if (type === 'content_block_start') {
      const index = typeof data.index === 'number' ? data.index : content.length
      const block = data.content_block as AnthropicContentBlock | undefined
      if (block) {
        content[index] = { ...block }
      }
    } else if (type === 'content_block_delta') {
      const index = typeof data.index === 'number' ? data.index : content.length - 1
      const block = content[index]
      const delta = data.delta as Record<string, unknown> | undefined
      if (!block || !delta) continue

      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        block.text = `${block.text ?? ''}${delta.text}`
      } else if (
        delta.type === 'thinking_delta' &&
        typeof delta.thinking === 'string'
      ) {
        block.thinking = `${block.thinking ?? ''}${delta.thinking}`
      } else if (
        delta.type === 'signature_delta' &&
        typeof delta.signature === 'string'
      ) {
        block.signature = delta.signature
      } else if (
        delta.type === 'input_json_delta' &&
        typeof delta.partial_json === 'string'
      ) {
        if (typeof block.input === 'string') {
          block.input = `${block.input}${delta.partial_json}`
        } else {
          inputJsonDeltasByIndex.set(
            index,
            `${inputJsonDeltasByIndex.get(index) ?? ''}${delta.partial_json}`,
          )
        }
      }
    } else if (type === 'message_delta' && message) {
      const delta = data.delta as Record<string, unknown> | undefined
      if (typeof delta?.stop_reason === 'string') {
        message.stop_reason = delta.stop_reason
      }
      if (typeof delta?.stop_sequence === 'string' || delta?.stop_sequence === null) {
        message.stop_sequence = delta.stop_sequence
      }
      const usage = data.usage as Partial<AnthropicSseMaterializedMessage['usage']> | undefined
      if (usage) {
        message.usage = {
          ...message.usage,
          ...usage,
        }
      }
    } else if (type === 'message_stop' && message) {
      const usage = data.usage as Partial<AnthropicSseMaterializedMessage['usage']> | undefined
      if (usage) {
        message.usage = {
          ...message.usage,
          ...usage,
        }
      }
    }
  }

  if (!message || !message.id || message.content.length === 0) {
    throw new Error(
      'Codex non-streaming fallback produced an empty or invalid assistant message',
    )
  }

  message.content = message.content.filter(Boolean)
  for (const [index, inputJson] of inputJsonDeltasByIndex) {
    if (inputJson.length === 0) continue
    const block = message.content[index]
    if (!block || typeof block.input === 'string') continue
    try {
      const parsed = JSON.parse(inputJson)
      block.input =
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? parsed
          : {}
    } catch {
      throw new Error(
        'Codex non-streaming fallback produced invalid tool input JSON',
      )
    }
  }
  return message
}

async function* observeCodexResponseId(
  events: AsyncIterable<Record<string, unknown>>,
  onResponseId: (id: string) => void,
): AsyncGenerator<Record<string, unknown>> {
  for await (const event of events) {
    const response = event.response as Record<string, unknown> | undefined
    if (typeof response?.id === 'string' && response.id.length > 0) {
      onResponseId(response.id)
    }
    yield event
  }
}

function responseFailedErrorForInitialEvent(
  event: Record<string, unknown>,
  requestCacheMetadata?: CodexRequestCacheMetadata,
): Error | null {
  if (event.type !== 'response.failed') {
    return null
  }
  return createCodexResponseFailedError(event, requestCacheMetadata, false)
}

function codexEventBeginsVisibleOutput(event: Record<string, unknown>): boolean {
  const eventType = event.type
  if (
    eventType === 'response.output_text.delta' ||
    eventType === 'response.reasoning_summary_text.delta' ||
    eventType === 'response.reasoning_text.delta' ||
    eventType === 'response.function_call_arguments.delta' ||
    eventType === 'response.custom_tool_call_input.delta'
  ) {
    return typeof event.delta === 'string' && event.delta.length > 0
  }

  if (eventType === 'response.reasoning_summary_part.added') {
    return true
  }

  if (eventType === 'response.output_item.added') {
    const item = isRecord(event.item) ? event.item : undefined
    return item?.type === 'function_call' || item?.type === 'custom_tool_call'
  }

  // Terminal text counts as visible output now that it is recovered. Without
  // this a delta-less response stays buffered until response.completed, which
  // both delays it and collapses its timing diagnostics into a single tick.
  if (eventType === 'response.output_text.done') {
    return typeof event.text === 'string' && event.text.length > 0
  }

  if (eventType === 'response.content_part.done') {
    return outputTextOfPart(event.part) !== undefined
  }

  if (eventType === 'response.output_item.done') {
    const item = isRecord(event.item) ? event.item : undefined
    if (item?.type === 'web_search_call' || item?.type === 'reasoning') {
      return true
    }
    if (item?.type === 'message') {
      const parts = Array.isArray(item.content) ? item.content : []
      return parts.some(part => outputTextOfPart(part) !== undefined)
    }
    return false
  }

  return false
}

async function translateCodexStreamToAnthropicMessage(
  codexResponse: Response,
  codexModel: string,
  requestCacheMetadata?: CodexRequestCacheMetadata,
  transportContext?: CodexStreamTransportContext,
): Promise<Response> {
  let codexResponseId: string | undefined
  const anthropicStreamResponse = buildAnthropicStreamResponse(
    observeCodexResponseId(httpSseToEvents(codexResponse), id => {
      codexResponseId = id
    }),
    codexModel,
    requestCacheMetadata,
    undefined,
    transportContext,
  )
  const sseBody = await anthropicStreamResponse.text()
  const message = materializeAnthropicMessageFromSse(sseBody, codexModel)
  if (codexResponseId) {
    message.id = codexResponseId
  }

  return new Response(JSON.stringify(message), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'x-request-id': message.id,
    },
  })
}

/**
 * Translates a WebSocket event stream to Anthropic streaming format.
 */
export function translateCodexWsStreamToAnthropic(
  wsEvents: AsyncIterable<Record<string, unknown>>,
  codexModel: string,
  requestCacheMetadata?: CodexRequestCacheMetadata,
  httpFallback?: HttpFallbackEventsFactory,
  transportContext?: CodexStreamTransportContext,
  cancelSource?: (reason?: unknown) => void,
): Response {
  return buildAnthropicStreamResponse(
    wsEvents,
    codexModel,
    requestCacheMetadata,
    httpFallback,
    transportContext,
    cancelSource,
  )
}

function finishStream(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  outputTokens: number,
  inputTokens: number,
  cachedInputTokens: number,
  hadToolCalls: boolean,
  requestCacheMetadata?: CodexRequestCacheMetadata,
) {
  const stopReason = hadToolCalls ? 'tool_use' : 'end_turn'

  if (inputTokens > 0) {
    const cacheRatio = cachedInputTokens / inputTokens
    const pct = (cacheRatio * 100).toFixed(1)
    const label =
      cachedInputTokens === 0 ? 'COLD' :
      cacheRatio >= 0.8 ? 'WARM' : 'PARTIAL'
    const level = cachedInputTokens === 0 ? 'warn' : 'info'
    logForDebugging(
      `[codex-cache] ${label} cached=${cachedInputTokens}/${inputTokens} (${pct}%) output=${outputTokens}`,
      { level },
    )
  } else {
    logForDebugging(`[codex-cache] response had no token counts (inputTokens=0)`, { level: 'warn' })
  }

  if (requestCacheMetadata) {
    logEvent('tengu_codex_cache_request', {
      hasOwner: requestCacheMetadata.ownerId !== undefined,
      inputTokens,
      cachedInputTokens,
      outputTokens,
    })
    logForDebugging(
      `[codex-cache] owner=${requestCacheMetadata.ownerId ?? 'none'} account=${requestCacheMetadata.accountId.slice(0, 12)} model=${requestCacheMetadata.model} key=${requestCacheMetadata.cacheContextKey} conversation=${requestCacheMetadata.conversationId} cached=${cachedInputTokens} input=${inputTokens}`,
    )
    recordCacheStat({
      ts: Date.now(),
      accountId: requestCacheMetadata.accountId,
      model: requestCacheMetadata.model,
      inputTokens,
      cachedTokens: cachedInputTokens,
      promptCacheKeyPrefix: (codexPromptCacheKey ?? CODEX_SESSION_ID).slice(0, 8),
      conversationIdPrefix: requestCacheMetadata.conversationId.slice(0, 8),
    })
  }

  // Downstream cache-rate math must use getCacheHitRate() from
  // src/utils/tokens.ts. The emitted usage is Anthropic-exclusive,
  // so cacheRead/input naively computes an invalid rate >100%.
  // OpenAI input_tokens is inclusive of cached_tokens; Anthropic's is exclusive.
  // Subtract to avoid double-counting in downstream context usage.
  // Clamped: a malformed payload reporting cached_tokens > input_tokens would
  // otherwise emit negative input_tokens into downstream context accounting.
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens)
  controller.enqueue(
    encoder.encode(
      formatSSE(
        'message_delta',
        JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: {
            output_tokens: outputTokens,
            input_tokens: uncachedInputTokens,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: cachedInputTokens,
          },
        }),
      ),
    ),
  )
  controller.enqueue(
    encoder.encode(
      formatSSE(
        'message_stop',
        JSON.stringify({
          type: 'message_stop',
          'amazon-bedrock-invocationMetrics': {
            inputTokenCount: inputTokens,
            outputTokenCount: outputTokens,
            invocationLatency: 0,
            firstByteLatency: 0,
          },
          usage: {
            input_tokens: uncachedInputTokens,
            output_tokens: outputTokens,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: cachedInputTokens,
          },
        }),
      ),
    ),
  )
  controller.close()
}

function normalizeCodexStreamError(
  error: unknown,
  requestCacheMetadata?: CodexRequestCacheMetadata,
): Error {
  if (error instanceof CodexWebSocketUsageLimitError && requestCacheMetadata) {
    // Report 3.3 instrumentation: upgraded to typed account-cap class, which
    // flows into the failover path in withRetry. This is the "good" branch.
    logForDebugging(
      `[codex-adapter] ws_error_classified class=CodexAccountCapError ` +
      `retryable=true account=${requestCacheMetadata.accountId.slice(0, 8)} ` +
      `original_msg="${error.message}"`,
      { level: 'warn' },
    )
    return new CodexAccountCapError(requestCacheMetadata.accountId)
  }

  if (error instanceof CodexWebSocketAuthError && requestCacheMetadata) {
    // Revoked/superseded token over WS → typed auth class so withRetry runs
    // forced-refresh + vault-recovery + lease failover (parity with HTTP path).
    logForDebugging(
      `[codex-adapter] ws_error_classified class=CodexAccountAuthError ` +
      `retryable=true account=${requestCacheMetadata.accountId.slice(0, 8)} ` +
      `original_msg="${error.message}"`,
      { level: 'warn' },
    )
    return new CodexAccountAuthError(requestCacheMetadata.accountId, 401)
  }

  if (error instanceof CodexWebSocketIdleTimeoutError) {
    if (requestCacheMetadata) {
      markStickyHttpFallback(
        requestCacheMetadata.conversationId,
        'idle_timeout',
        requestCacheMetadata.accountId,
      )
    }
    logForDebugging(
      `[codex-adapter] ws_error_classified class=idle_timeout retryable=false ` +
      `timeout_ms=${error.timeoutMs} msg="${error.message}"`,
      { level: 'warn' },
    )
    return error
  }

  if (error instanceof CodexWebSocketClosedBeforeCompletedError) {
    if (requestCacheMetadata) {
      markStickyHttpFallback(
        requestCacheMetadata.conversationId,
        'closed_before_completed',
        requestCacheMetadata.accountId,
      )
    }
    logForDebugging(
      `[codex-adapter] ws_error_classified class=closed_before_completed retryable=false ` +
      `close_code=${error.closeCode ?? 'n/a'} close_reason=${error.closeReason} msg="${error.message}"`,
      { level: 'warn' },
    )
    return error
  }

  if (error instanceof CodexWebSocketServerError) {
    const transient = isTransientCodexWebSocketServerError(error)
    if (requestCacheMetadata && transient) {
      markStickyHttpFallback(
        requestCacheMetadata.conversationId,
        'server_error',
        requestCacheMetadata.accountId,
      )
    }
    logForDebugging(
      `[codex-adapter] ws_error_classified class=server_error transient=${transient} ` +
      `code=${error.code || 'unknown'} msg="${error.message}"`,
      { level: 'warn' },
    )
    return error
  }

  if (error instanceof Error) {
    if (
      requestCacheMetadata &&
      error.message.startsWith('WebSocket error during stream')
    ) {
      markStickyHttpFallback(
        requestCacheMetadata.conversationId,
        'stream_transport_error',
        requestCacheMetadata.accountId,
      )
    }
    // Any remaining Error subclass reaching this branch is still unclassified
    // transport/application failure after streaming began.
    logForDebugging(
      `[codex-adapter] ws_error_classified class=generic retryable=false ` +
      `error_name=${error.name} msg="${error.message}"`,
      { level: 'warn' },
    )
    return error
  }

  logForDebugging(
    `[codex-adapter] ws_error_classified class=unknown retryable=false ` +
    `value=${String(error)}`,
    { level: 'warn' },
  )
  return new Error(String(error))
}

function isRecoverableCodexStreamError(error: Error): boolean {
  return (
    error instanceof CodexWebSocketIdleTimeoutError ||
    error instanceof CodexWebSocketClosedBeforeCompletedError ||
    (error instanceof CodexWebSocketServerError &&
      isTransientCodexWebSocketServerError(error)) ||
    error.message.startsWith('WebSocket error during stream')
  )
}

function isTransientCodexWebSocketServerError(
  error: CodexWebSocketServerError,
): boolean {
  const code = error.code.toLowerCase()
  return (
    code === 'server_error' ||
    code === 'internal_server_error' ||
    code === 'overloaded_error' ||
    code === 'service_unavailable' ||
    error.message.toLowerCase().includes('servers are currently overloaded')
  )
}

const CODEX_STREAM_ABORT_ERROR_NAMES = new Set(['AbortError', 'APIUserAbortError'])

/**
 * A cancelled turn is not an interrupted one. It must stay an abort so the
 * user-abort branch in `claude.ts` fires and the engine records an
 * interruption instead of attempting recovery.
 */
function isCodexStreamAbortError(error: Error): boolean {
  return CODEX_STREAM_ABORT_ERROR_NAMES.has(error.name)
}

/**
 * Classifies a failure that arrived AFTER visible output escaped. Every such
 * failure blocks a same-request replay; only a transient transport
 * interruption may additionally authorize a continuation. A structured
 * `response.failed`, an auth or quota rejection, and anything unclassified all
 * stay terminal — recovering from those is the provider's failover job, not
 * this one's.
 */
function classifyPostVisibleCodexFailure(
  error: Error,
  usingHttpFallback: boolean,
  streamTransport: CodexStreamTransport,
): { transport: CodexStreamTransport; cause: CodexPartialStreamCause; transient: boolean } {
  if (error instanceof CodexWebSocketIdleTimeoutError) {
    return { transport: 'websocket', cause: 'idle_timeout', transient: true }
  }
  if (error instanceof CodexWebSocketClosedBeforeCompletedError) {
    return { transport: 'websocket', cause: 'closed', transient: true }
  }
  if (error instanceof CodexWebSocketServerError) {
    return {
      transport: 'websocket',
      cause: 'stream_error',
      transient: isTransientCodexWebSocketServerError(error),
    }
  }
  if (error.message.startsWith('WebSocket error during stream')) {
    return { transport: 'websocket', cause: 'stream_error', transient: true }
  }
  const transport = usingHttpFallback ? 'http' : streamTransport
  if (error.message.startsWith(CODEX_HTTP_IDLE_TIMEOUT_PREFIX)) {
    return { transport: 'http', cause: 'idle_timeout', transient: true }
  }
  if (error instanceof CodexResponseFailedError) {
    return { transport, cause: 'provider_failure', transient: false }
  }
  return { transport, cause: 'stream_error', transient: false }
}

function createPartialStreamReplaySkippedError(
  error: Error,
  failure: CodexPartialStreamFailureV1,
  requestCacheMetadata?: CodexRequestCacheMetadata,
  willUseHttpFallback = false,
): Error {
  const conversationSuffix = requestCacheMetadata && willUseHttpFallback
    ? ` Conversation ${requestCacheMetadata.conversationId.slice(0, 8)} will use HTTP fallback on the next turn.`
    : ''
  const wrapped = new CodexPartialStreamReplaySkippedError(
    `Stream interrupted after visible output started; the turn was not replayed to avoid duplicate output or tool calls.${conversationSuffix} ` +
    `Original error: ${error.message}`,
    failure,
  )
  // The original stays reachable on the chain. A quota cap or a revoked token
  // that lands after visible output is still a quota cap: it must not replay,
  // but it must also not be described to the user as a dropped connection.
  wrapped.cause = error
  return wrapped
}

/**
 * `ReadableStreamDefaultController.error()` resets the queue: anything the
 * reader has not pulled yet is discarded, not delivered. Measured in Bun — a
 * reader parked in `read()` receives the final chunk, a reader busy processing
 * the previous one loses it. The sealed `content_block_stop` is exactly that
 * final chunk, and losing it costs the partial response we sealed it to save,
 * so wait for the reader to drain before erroring. Bounded: a reader that has
 * stopped pulling entirely must not hold the failure open.
 */
async function drainControllerQueue(
  controller: ReadableStreamDefaultController,
): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const desiredSize = controller.desiredSize
    if (desiredSize === null || desiredSize > 0) {
      return true
    }
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  return false
}

async function primeCodexEvents(
  events: AsyncIterable<Record<string, unknown>>,
  requestCacheMetadata?: CodexRequestCacheMetadata,
  transport: CodexStreamTransport = 'http',
  cancelOnTimeout?: (error: Error) => void,
): Promise<AsyncIterable<Record<string, unknown>>> {
  const iterator = events[Symbol.asyncIterator]()
  const bufferedEvents: Array<Record<string, unknown>> = []
  const startedAtMs = Date.now()
  const timeoutMs = getCodexInitialOutputTimeoutMs()
  let lastEventType: string | null = null
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let timeoutError: APIConnectionError | null = null
  const conversationId = requestCacheMetadata?.conversationId.slice(0, 8) ?? 'unknown'
  const accountId = requestCacheMetadata?.accountId.slice(0, 8) ?? 'unknown'
  const initialOutputTimeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      const elapsedMs = Date.now() - startedAtMs
      const message =
        `Codex ${transport} stream produced no visible output before initial timeout ` +
        `(${elapsedMs}ms >= ${timeoutMs}ms, events=${bufferedEvents.length}, ` +
        `last_event=${lastEventType ?? 'none'}, conv=${conversationId}, account=${accountId})`
      timeoutError = new APIConnectionError({ message })
      logForDebugging(`[codex-fetch] initial_output_timeout ${message}`, {
        level: 'error',
      })
      cancelOnTimeout?.(timeoutError)
      reject(timeoutError)
    }, timeoutMs)
  })

  logForDebugging(
    `[codex-fetch] awaiting_initial_output transport=${transport} ` +
    `conv=${conversationId} account=${accountId} timeout_ms=${timeoutMs}`,
  )

  try {
    while (true) {
      const next = await Promise.race([iterator.next(), initialOutputTimeout])
      if (next.done) {
        if (bufferedEvents.length === 0) {
          throw new Error('Codex stream ended before first event')
        }
        break
      }

      lastEventType = typeof next.value.type === 'string' ? next.value.type : null

      const responseFailedError = responseFailedErrorForInitialEvent(
        next.value,
        requestCacheMetadata,
      )
      if (responseFailedError) {
        try {
          await iterator.return?.()
        } catch {
          // Preserve the response.failed error, matching the existing behavior.
        }
        throw responseFailedError
      }

      bufferedEvents.push(next.value)
      if (
        codexEventBeginsVisibleOutput(next.value) ||
        next.value.type === 'response.completed'
      ) {
        logForDebugging(
          `[codex-fetch] initial_output_ready transport=${transport} ` +
          `conv=${conversationId} account=${accountId} elapsed_ms=${Date.now() - startedAtMs} ` +
          `events=${bufferedEvents.length} trigger=${lastEventType ?? 'unknown'}`,
        )
        break
      }
    }
  } catch (error) {
    if (error === timeoutError) {
      void iterator.return?.().catch(() => undefined)
    }
    throw error
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId)
  }

  return {
    async *[Symbol.asyncIterator]() {
      for (const event of bufferedEvents) {
        yield event
      }
      while (true) {
        const next = await iterator.next()
        if (next.done) {
          return
        }
        yield next.value
      }
    },
  }
}

export function _primeCodexEventsForTest(
  events: AsyncIterable<Record<string, unknown>>,
  requestCacheMetadata?: CodexRequestCacheMetadata,
  transport: CodexStreamTransport = 'http',
): Promise<AsyncIterable<Record<string, unknown>>> {
  return primeCodexEvents(events, requestCacheMetadata, transport)
}

function normalizeInitialWebSocketError(
  error: unknown,
  accountId: string,
  conversationId?: string,
): Error {
  if (error instanceof CodexAccountCapError) {
    return error
  }

  if (error instanceof CodexResponseFailedError) {
    return error
  }

  if (error instanceof CodexWebSocketUsageLimitError) {
    logForDebugging(
      `[codex-adapter] initial_ws_error_classified class=CodexAccountCapError ` +
      `retryable=true account=${accountId.slice(0, 8)} ` +
      `original_msg="${error.message}"`,
      { level: 'warn' },
    )
    return new CodexAccountCapError(accountId)
  }

  if (error instanceof CodexWebSocketAuthError) {
    logForDebugging(
      `[codex-adapter] initial_ws_error_classified class=CodexAccountAuthError ` +
      `retryable=true account=${accountId.slice(0, 8)} ` +
      `original_msg="${error.message}"`,
      { level: 'warn' },
    )
    return new CodexAccountAuthError(accountId, 401)
  }

  if (error instanceof Error) {
    if (conversationId) {
      const reason =
        error instanceof CodexWebSocketIdleTimeoutError
          ? 'initial_idle_timeout'
          : error instanceof CodexWebSocketClosedBeforeCompletedError
            ? 'initial_closed_before_completed'
            : 'initial_ws_unavailable'
      markStickyHttpFallback(conversationId, reason, accountId)
    }
    // Report 3.3 instrumentation: pre-first-event failures become
    // APIConnectionError which withRetry treats as retryable. Good branch.
    logForDebugging(
      `[codex-adapter] initial_ws_error_classified class=APIConnectionError ` +
      `retryable=true error_name=${error.name} msg="${error.message}"`,
      { level: 'warn' },
    )
    return new APIConnectionError({
      message: error.message,
      cause: error,
    })
  }

  return new APIConnectionError({
    message: String(error),
  })
}

// ── Main fetch interceptor ──────────────────────────────────────────

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex/responses'

type CodexFetchResolvedTokens = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  accountId: string
  source?: 'pool' | 'config'
}

type CodexFetchOptions = {
  resolveTokensForRequest?: () => Promise<CodexFetchResolvedTokens | null>
}

/**
 * Creates a fetch function that intercepts Anthropic API calls and routes them to Codex.
 * @param accessToken - The Codex access token for authentication
 * @returns A fetch function that translates Anthropic requests to Codex format
 */
export function createCodexFetch(
  accessToken: string,
  conversationIdOverride?: string,
  options: CodexFetchOptions = {},
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)

    // Only intercept Anthropic API message calls
    if (!url.includes('/v1/messages')) {
      return globalThis.fetch(input, init)
    }

    // Parse the Anthropic request body
    let anthropicBody: Record<string, unknown>
    try {
      const bodyText =
        init?.body instanceof ReadableStream
          ? await new Response(init.body).text()
          : typeof init?.body === 'string'
            ? init.body
            : '{}'
      anthropicBody = JSON.parse(bodyText)
    } catch {
      anthropicBody = {}
    }

    // Get current token. App traffic passes the shared async resolver so
    // per-request re-derivation uses the same lease/selectability/refresh
    // semantics as initial client creation. Standalone core calls omit it and
    // keep using the explicit token resolved by codex-core/accounts.ts.
    const resolvedTokens = options.resolveTokensForRequest
      ? await options.resolveTokensForRequest()
      : null
    if (options.resolveTokensForRequest && !resolvedTokens?.accessToken) {
      throw new APIConnectionError({
        message: 'No healthy Codex account is available for this request.',
      })
    }
    const currentToken = resolvedTokens?.accessToken || accessToken
    const currentAccountId = resolvedTokens?.accountId ?? extractAccountId(currentToken)
    const poolManagedCredentials = resolvedTokens?.source === 'pool'

    // Translate to Codex format
    const { codexBody, codexModel } = translateToCodexBody(anthropicBody)
    const isStreamingAnthropicRequest = anthropicBody.stream === true

    // Upstream openai/codex (codex-rs/core/src/client.rs) uses a single plain
    // UUID as the conversation identity — it becomes prompt_cache_key, session_id,
    // and x-client-request-id unchanged. A UUID is 36 chars, well under the
    // server's 64-char limit. We match that exactly: use the session UUID directly.
    // Explicit overrides (used by subagents) keep their caller-provided identity.
    const conversationId = getConversationIdForRequest(
      currentAccountId,
      codexModel,
      conversationIdOverride,
    )
    const cacheContextKey = `${currentAccountId}:${codexModel}`

    codexBody.prompt_cache_key = conversationId

    // Pre-request cache diagnostic log
    const instructions = typeof codexBody.instructions === 'string' ? codexBody.instructions : ''
    const instructionsHash = createHash('sha1').update(instructions).digest('hex').slice(0, 8)
    const inputMessages = Array.isArray(codexBody.input) ? codexBody.input : []
    const effort = typeof (codexBody.reasoning as Record<string, unknown> | undefined)?.effort === 'string'
      ? (codexBody.reasoning as Record<string, unknown>).effort
      : 'none'
    logForDebugging(
      `[codex-cache] request account=${currentAccountId.slice(0, 12)} model=${codexModel} ` +
      `conv=${conversationId.slice(0, 8)} ` +
      `instructions=${instructions.length}B hash=${instructionsHash} ` +
      `messages=${inputMessages.length} effort=${effort}`,
    )

    const requestCacheMetadata: CodexRequestCacheMetadata = {
      ownerId: getCurrentCodexLease()?.ownerId,
      accountId: currentAccountId,
      model: codexModel,
      cacheContextKey,
      conversationId,
    }

    // Which transport this request dispatches on. Resolved once, here, so the
    // start marker below names the same transport the dispatch further down
    // actually takes; nothing between the two advances the sticky clock.
    const attemptsWebSocket =
      isStreamingAnthropicRequest &&
      !hasStickyHttpFallback(conversationId, currentAccountId)

    // Request-start marker. Everything else on this path
    // (`codex_send_path`/`codex_stream_surface`) is written when the stream
    // ends, so a request that never finishes is indistinguishable from one
    // that was never made — see `recordCodexRequestStart`. Log only: no
    // timeout, no abort, no watchdog is armed from here.
    recordCodexRequestStart({
      mode: attemptsWebSocket ? 'websocket' : 'http',
      conversation_id_prefix: conversationId.slice(0, 8),
      account_id_prefix: currentAccountId.slice(0, 8),
      model: codexModel,
    })

    // Auth headers used by both WebSocket and HTTP paths.
    const authHeaders: Record<string, string> = {
      Authorization: `Bearer ${currentToken}`,
      'chatgpt-account-id': currentAccountId,
      originator: 'codex_cli_rs',
      'conversation-id': conversationId,
    }

    const performHttpRequest = async (): Promise<{
      response: Response
      transportContext: CodexStreamTransportContext
    }> => {
      const requestStartedAtMs = Date.now()
      let codexResponse: Response
      try {
        codexResponse = await globalThis.fetch(CODEX_BASE_URL, {
          method: 'POST',
          signal: init?.signal,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            ...authHeaders,
            'conversation-id': conversationId,
            session_id: conversationId,
            'x-client-request-id': conversationId,
            'OpenAI-Beta': 'responses=experimental',
          },
          body: JSON.stringify(codexBody),
        })
      } catch (error) {
        const details = extractConnectionErrorDetails(error)
        const detailSuffix = details
          ? ` (${details.code}${details.isSSLError ? ', ssl' : ''}: ${details.message})`
          : error instanceof Error
            ? ` (${error.message})`
            : ''
        logForDebugging(
          `[codex-fetch] Request failed for account ${currentAccountId.slice(0, 12)} using model ${codexModel}${detailSuffix}`,
          { level: 'error' },
        )
        throw error
      }
      const responseHeadersAtMs = Date.now()

      // Capture response-side routing headers. These let us correlate cache
      // misses with backend node changes — a cf-ray or x-served-by change
      // between a warm and cold turn is strong evidence for cause C (routing).
      const routeHeaders: Record<string, string> = {}
      const routeHeaderNames = [
        'cf-ray', 'x-request-id', 'openai-processing-ms', 'openai-version',
        'x-served-by', 'x-envoy-upstream-service-time', 'x-cache',
        'cf-cache-status', 'openai-request-id',
      ]
      for (const name of routeHeaderNames) {
        const val = codexResponse.headers.get(name)
        if (val) routeHeaders[name] = val
      }
      // Any x-openai- or x-codex- header
      codexResponse.headers.forEach((val, name) => {
        if (name.startsWith('x-openai-') || name.startsWith('x-codex-')) {
          routeHeaders[name] = val
        }
      })
      const logParts = Object.entries(routeHeaders).map(([k, v]) => `${k}=${v}`).join(' ')
      logForDebugging(
        `[codex-cache] route conv=${conversationId.slice(0, 8)} resp_headers={${logParts || 'none'}}`,
      )

      // Cold-turn full dump (HTTP path, behind CODEX_CACHE_COLD_DIAG=1).
      // We don't have token counts yet at this point (they're in the stream),
      // so just log headers and request metadata.
      if (isEnvTruthy(process.env['CODEX_CACHE_COLD_DIAG'])) {
        logForDebugging(
          `[codex-cache] COLD_DIAG http_request conv=${conversationId.slice(0, 8)} ` +
          `account=${currentAccountId.slice(0, 12)} model=${codexModel} ` +
          `instructions_hash=${instructionsHash} effort=${effort} ` +
          `messages=${inputMessages.length} route_headers={${logParts || 'none'}}`,
          { level: 'warn' },
        )
      }

      return {
        response: codexResponse,
        transportContext: {
          transport: 'http',
          requestStartedAtMs,
          responseHeadersAtMs,
        },
      }
    }

    const httpFallbackEvents = async (): Promise<HttpFallbackResult> => {
      const { response: codexResponse, transportContext } = await performHttpRequest()
      if (!codexResponse.ok) {
        const errorText = await codexResponse.text()
        if (poolManagedCredentials) {
          const accountError = classifyCodexHttpAccountError(
            codexResponse.status,
            errorText,
            codexResponse.headers,
            currentAccountId,
          )
          if (accountError) {
            throw accountError
          }
        }
        throw createRetryableCodexHttpError(codexResponse.status, errorText)
      }
      const initialOutputAbortController = new AbortController()
      return {
        events: await primeCodexEvents(
          httpSseToEvents(codexResponse, initialOutputAbortController.signal),
          requestCacheMetadata,
          'http',
          error => initialOutputAbortController.abort(error),
        ),
        transportContext,
      }
    }

    // ── Try WebSocket transport first ─────────────────────────────────
    // WebSocket supports `previous_response_id` which lets the server chain
    // KV-cache across turns, growing cached tokens with conversation history
    // instead of being pinned to the instructions prefix (~13,824 tokens).
    const fullInput = Array.isArray(codexBody.input)
      ? (codexBody.input as Array<Record<string, unknown>>)
      : []

    if (isStreamingAnthropicRequest) {
      if (attemptsWebSocket) {
        try {
          // Item 3 rule 1: no per-request prewarm. It re-fired on every
          // session-clearing event and never warmed ahead of time (the real
          // request awaited it), so it just double-billed the prefix. The first
          // real WS call seeds the same prefix.
          const wsRequestStartedAtMs = Date.now()
          const wsAbortController = new AbortController()
          const requestSignal = init?.signal
          const forwardRequestAbort = () => {
            wsAbortController.abort(requestSignal?.reason)
          }
          if (requestSignal?.aborted) {
            forwardRequestAbort()
          } else {
            requestSignal?.addEventListener('abort', forwardRequestAbort, {
              once: true,
            })
          }
          const wsSource = streamTurnViaWebSocketLocked(
            conversationId,
            codexBody,
            authHeaders,
            fullInput.length,
            wsAbortController.signal,
          )
          const wsSourceWithAbortCleanup: AsyncIterable<Record<string, unknown>> = {
            async *[Symbol.asyncIterator]() {
              try {
                yield* wsSource
              } finally {
                requestSignal?.removeEventListener('abort', forwardRequestAbort)
              }
            },
          }
          const wsEvents = await primeCodexEvents(
            wsSourceWithAbortCleanup,
            requestCacheMetadata,
            'websocket',
          )
          logForDebugging(
            `[codex-cache] transport=websocket conv=${conversationId.slice(0, 8)} ` +
            `account=${currentAccountId.slice(0, 12)} model=${codexModel} ` +
            `instructions_hash=${instructionsHash} effort=${effort} messages=${inputMessages.length}`,
          )
          return translateCodexWsStreamToAnthropic(
            wsEvents,
            codexModel,
            requestCacheMetadata,
            httpFallbackEvents,
            {
              transport: 'websocket',
              requestStartedAtMs: wsRequestStartedAtMs,
            },
            reason => {
              const abortReason =
                reason instanceof Error
                  ? reason
                  : new DOMException('The operation was aborted.', 'AbortError')
              wsAbortController.abort(abortReason)
            },
          )
        } catch (wsError) {
          if (
            init?.signal?.aborted ||
            (wsError instanceof Error && wsError.name === 'AbortError')
          ) {
            closeSocketPreservingState(conversationId)
            throw wsError
          }
          const normalized = normalizeInitialWebSocketError(
            wsError,
            currentAccountId,
            conversationId,
          )
          // Item 3 rules 2a/4: distinguish rotation from transient failure.
          //   - Cap error → withRetry fails over to another account; the
          //     conversationId-keyed baseline was chained under THIS account, so
          //     drop it (full teardown) — the next account must start clean.
          //   - Everything else (idle timeout, closed-before-completed, generic
          //     transport error → HTTP fallback) is transient: the socket is
          //     already closed by the transport's failStream, and nothing was
          //     committed this turn, so KEEP the baseline. The turn replays over
          //     HTTP now and WS resumes from the preserved baseline after the
          //     sticky window, avoiding an unnecessary full send.
          if (
            normalized instanceof CodexAccountCapError ||
            normalized instanceof CodexAccountAuthError
          ) {
            // Cap/auth both fail over to another account; the conversationId-keyed
            // baseline was chained under THIS account, so drop it.
            clearWebSocketSession(conversationId)
          } else {
            closeSocketPreservingState(conversationId)
          }
          // Explicit upstream response failures must propagate. Cap/auth errors
          // let withRetry recover/fail over; non-cap failures preserve the
          // upstream error instead of replaying the turn over HTTP.
          if (
            normalized instanceof CodexAccountCapError ||
            normalized instanceof CodexAccountAuthError ||
            normalized instanceof CodexResponseFailedError
          ) {
            throw normalized
          }
          logForDebugging(
            `[codex-fetch] WS unavailable, falling back to HTTP: ${wsError instanceof Error ? wsError.message : String(wsError)}`,
            { level: 'warn' },
          )
        }
      } else {
        logForDebugging(
          `[codex-fetch] sticky HTTP fallback active conv=${conversationId.slice(0, 8)} account=${currentAccountId.slice(0, 12)}`,
          { level: 'warn' },
        )
      }
    }

    // ── HTTP fallback ─────────────────────────────────────────────────
    const { response: codexResponse, transportContext } = await performHttpRequest()

    if (!codexResponse.ok) {
      const errorText = await codexResponse.text()
      if (poolManagedCredentials) {
        const accountError = classifyCodexHttpAccountError(
          codexResponse.status,
          errorText,
          codexResponse.headers,
          currentAccountId,
        )
        if (accountError) {
          throw accountError
        }
      }
      // Model-not-found over HTTP is a transport-cohort limitation, not a terminal
      // error: the ChatGPT/Codex HTTP channel refuses some models (e.g. gpt-5.6-luna)
      // that the WebSocket channel serves. Only STREAMING requests have a WebSocket
      // path in this adapter, so only they can recover — clear this
      // (conversation, account) sticky flag and surface a retryable error so
      // withRetry re-attempts over WebSocket. Non-streaming requests have no WS path
      // here; throwing "retry over WS" for them would loop, so they fall through to
      // the plain 404 response below (unchanged behavior).
      // See docs/codex/2026-07-12-bug-luna-sticky-http-fallback-404.md.
      if (
        isStreamingAnthropicRequest &&
        codexResponse.status === 404 &&
        /model not found/i.test(errorText)
      ) {
        clearStickyHttpFallback(conversationId, currentAccountId)
        throw new APIConnectionError({
          message:
            `Codex HTTP channel does not serve model ${codexModel} ` +
            `(404 Model not found); retrying over WebSocket`,
        })
      }
      const errorBody = {
        type: 'error',
        error: {
          type: 'api_error',
          message: `Codex API error (${codexResponse.status}): ${errorText}`,
        },
      }
      return new Response(JSON.stringify(errorBody), {
        status: codexResponse.status,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (isStreamingAnthropicRequest) {
      const initialOutputAbortController = new AbortController()
      const events = await primeCodexEvents(
        httpSseToEvents(codexResponse, initialOutputAbortController.signal),
        requestCacheMetadata,
        'http',
        error => initialOutputAbortController.abort(error),
      )
      return buildAnthropicStreamResponse(
        events,
        codexModel,
        requestCacheMetadata,
        undefined,
        transportContext,
      )
    }

    return translateCodexStreamToAnthropicMessage(
      codexResponse,
      codexModel,
      requestCacheMetadata,
      transportContext,
    )
  }
}
