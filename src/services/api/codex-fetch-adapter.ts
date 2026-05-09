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
import { createHash } from 'crypto'
import { randomUUID } from 'crypto'
import { logForDebugging } from '../../utils/debug.js'
import { getCodexOAuthTokens } from '../../utils/auth.js'
import { logEvent } from '../analytics/index.js'
import { getActiveAccount, getPoolStatus, isPoolActive } from './codexAccountPool.js'
import { getCurrentCodexLease } from './codexAccountLeaseManager.js'
import { extractConnectionErrorDetails } from './errorUtils.js'
import {
  clearWebSocketSession,
  schedulePrewarm,
  streamTurnViaWebSocketLocked,
  registerStaleResponseIdCallback,
  registerSendPathLogger,
  CodexWebSocketClosedBeforeCompletedError,
  CodexWebSocketIdleTimeoutError,
  CodexWebSocketUsageLimitError,
} from './codex-websocket-transport.js'
import { notifyStaleResponseIdRetry } from './promptCacheBreakDetection.js'
import {
  recordCodexSendPath,
  recordCodexStreamSurface,
} from '../../utils/sessionStorage.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../../tools/SyntheticOutputTool/SyntheticOutputTool.js'

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
const stickyHttpFallback = new Map<string, StickyFallbackEntry>()
let nowForTest: (() => number) | null = null
const conversationIdsByCacheKey = new Map<string, string>()

export function _setStickyFallbackNowForTest(fn: (() => number) | null): void {
  nowForTest = fn
}

function now(): number {
  return nowForTest ? nowForTest() : Date.now()
}

export function setCodexPromptCacheKey(sessionId: string): void {
  codexPromptCacheKey = sessionId
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
): void {
  if (stickyHttpFallback.has(conversationId)) {
    return
  }
  const until = now() + STICKY_HTTP_FALLBACK_TTL_MS
  stickyHttpFallback.set(conversationId, { until, reason })
  logForDebugging(
    `[codex-fetch] sticky_http_fallback conv=${conversationId.slice(0, 8)} ` +
    `reason=${reason} ttl_ms=${STICKY_HTTP_FALLBACK_TTL_MS}`,
    { level: 'warn' },
  )
}

function hasStickyHttpFallback(conversationId: string): boolean {
  const entry = stickyHttpFallback.get(conversationId)
  if (!entry) return false
  if (now() > entry.until) {
    stickyHttpFallback.delete(conversationId)
    logForDebugging(
      `[codex-fetch] sticky_http_fallback expired conv=${conversationId.slice(0, 8)} ` +
      `reason=${entry.reason}`,
    )
    return false
  }
  return true
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

  const conversationId =
    conversationIdsByCacheKey.size === 0
      ? (codexPromptCacheKey ?? CODEX_SESSION_ID)
      : randomUUID()
  conversationIdsByCacheKey.set(cacheKey, conversationId)
  return conversationId
}

export function _markStickyHttpFallbackForTest(
  conversationId: string,
  reason: string,
): void {
  markStickyHttpFallback(conversationId, reason)
}

export function _hasStickyHttpFallbackForTest(conversationId: string): boolean {
  return hasStickyHttpFallback(conversationId)
}

// Register the stale-response-id callback so promptCacheBreakDetection gets
// notified when the WS transport retries a turn after server evicts the chain.
// Default/main-thread conversations do not include `/` and map to
// repl_main_thread. Explicit subagent overrides use a sessionId/agentId suffix
// and have their own short-lived detection contexts.
registerStaleResponseIdCallback((conversationId: string) => {
  // Map conversationId back to the querySource for detection state lookup.
  // Main thread uses the session UUID, subagents use sessionId/agentId, and
  // isolated side queries reserve side/<name>/... prefixes.
  let querySource = 'repl_main_thread'
  if (conversationId.startsWith('side/title/')) {
    querySource = 'generate_session_title'
  } else if (conversationId.includes('/')) {
    querySource = `agent:${conversationId.split('/')[1]}`
  }
  notifyStaleResponseIdRetry(querySource)
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
 * Thrown when a Codex account hits a 429/cap error and the account pool is active.
 * Caught by withRetry to trigger instant failover to the next account.
 */
export class CodexAccountCapError extends Error {
  public readonly status = 429
  constructor(public readonly accountId: string) {
    super(`Codex account ${accountId} hit usage cap`)
    this.name = 'CodexAccountCapError'
  }
}

// ── Available Codex models ──────────────────────────────────────────
export const CODEX_MODELS = [
  { id: 'gpt-5.5', label: 'GPT-5.5', description: 'Latest GPT' },
  { id: 'gpt-5.4', label: 'GPT-5.4', description: 'Previous GPT' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', description: 'Fast GPT-5.4 model' },
  { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', description: 'Optimized Codex coding model' },
  { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', description: 'Frontier agentic coding model' },
  { id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex', description: 'Codex coding model' },
  { id: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini', description: 'Fast Codex model' },
  { id: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max', description: 'Max Codex model' },
  { id: 'gpt-5.2', label: 'GPT-5.2', description: 'GPT-5.2' },
] as const

export const DEFAULT_CODEX_MODEL = 'gpt-5.5'

/**
 * Maps Claude model names to corresponding Codex model names.
 * @param claudeModel - The Claude model name to map
 * @returns The corresponding Codex model ID
 */
export function mapClaudeModelToCodex(claudeModel: string | null): string {
  if (!claudeModel) return DEFAULT_CODEX_MODEL
  if (isCodexModel(claudeModel)) return claudeModel
  const lower = claudeModel.toLowerCase()
  if (lower.includes('opus')) return 'gpt-5.5'
  if (lower.includes('haiku')) return 'gpt-5.4-mini'
  if (lower.includes('sonnet')) return 'gpt-5.3-codex'
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

registerStaleResponseIdCallback((conversationId) => {
  notifyStaleResponseIdRetry(conversationId)
})

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

// ── Tool result content serialization ───────────────────────────────

/**
 * Serializes Anthropic tool_result content (string, array of blocks, or absent)
 * into the Codex function_call_output `output` field. Handles multimodal
 * content (text + base64 images).
 */
function translateToolResultOutput(
  content: AnthropicContentBlock['content'],
): string | Array<Record<string, unknown>> {
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
          codexInput.push({
            type: 'function_call_output',
            call_id: callId,
            output: translateToolResultOutput(block.content),
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
          if (block.name === 'Apply_patch' && typeof block.input === 'string') {
            codexInput.push({
              type: 'custom_tool_call',
              call_id: callId,
              name: block.name || '',
              input: block.input,
            })
          } else {
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
  // output_config.effort. Codex accepts minimal|low|medium|high|xhigh on
  // reasoning.effort (model-dependent). Mapping:
  //   low|medium|high    → pass through
  //   max                → xhigh on codex variants, else high
  //   anything else/undef→ omit (Codex server default kicks in, typically high)
  //
  // Reasoning summaries: ask the server for human-readable summary output.
  // Default is 'auto'; user can override via reasoningSummaryDetail setting.
  // Setting 'none' suppresses summaries (saves output tokens).
  //
  // Thinking-disabled override: callers like streamCompactSummary pass
  // `thinking: { type: 'disabled' }` to signal "this is a pure-output task, do
  // not spend reasoning tokens". On Anthropic that short-circuits extended
  // thinking; the equivalent on Codex is reasoning.effort = "minimal". Without
  // this override the signal is silently dropped and the server defaults to
  // high effort — which made GPT-5.4 compaction take 5+ minutes.
  const thinking = anthropicBody.thinking as { type?: string } | undefined
  const thinkingDisabled = thinking?.type === 'disabled'
  const rawEffort = outputConfig?.effort
  const codexEffort = thinkingDisabled
    ? 'minimal'
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
  if (e === 'low' || e === 'medium' || e === 'high') return e
  if (e === 'minimal') return 'minimal'
  if (e === 'max') {
    // xhigh is supported by codex variants, GPT-5.5, and GPT-5.4.
    const model = codexModel.toLowerCase()
    return model.includes('codex') || model === 'gpt-5.5' || model === 'gpt-5.4'
      ? 'xhigh'
      : 'high'
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
 * Parses an HTTP SSE Response body into an async iterable of event objects.
 * Each yielded object is the parsed JSON from a `data: ...` SSE line.
 */
async function* httpSseToEvents(
  codexResponse: Response,
): AsyncGenerator<Record<string, unknown>> {
  const IDLE_TIMEOUT_MS =
    parseInt(process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS || '', 10) || 90_000

  const reader = codexResponse.body?.getReader()
  if (!reader) return

  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let idleTimeoutError: Error | null = null

  const resetIdleTimer = () => {
    if (idleTimer !== null) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimeoutError = new Error(`Codex stream idle timeout after ${IDLE_TIMEOUT_MS}ms`)
      logForDebugging(
        `[codex-fetch] Streaming idle timeout: no chunks received for ${IDLE_TIMEOUT_MS / 1000}s, aborting`,
        { level: 'error' },
      )
      reader.cancel(idleTimeoutError).catch(() => {})
      codexResponse.body?.cancel(idleTimeoutError).catch(() => {})
    }, IDLE_TIMEOUT_MS)
  }
  const clearIdleTimer = () => {
    if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null }
  }

  const decoder = new TextDecoder()
  let buffer = ''

  try {
    resetIdleTimer()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (idleTimeoutError) throw idleTimeoutError
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

  const noteVisibleOutput = () => {
    if (firstVisibleAtMs === null) {
      firstVisibleAtMs = Date.now()
    }
    emittedVisibleOutput = true
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
                // Close any open reasoning blocks before opening a text block.
                closeAllOpenReasoningBlocks()
                if (!currentTextBlockStarted) {
                  // Start a new text content block
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
                outputTokens += 1
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
                toolCall.args =
                  (event.arguments as string) ||
                  (event.input as string) ||
                  toolCall.args
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
                contentBlockIndex = emitOpenAIWebSearchCall(
                  controller,
                  encoder,
                  contentBlockIndex,
                  item,
                )
              } else if (item?.type === 'message') {
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
                  noteVisibleOutput()
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
            else if (
              eventType === 'response.web_search_call.in_progress' ||
              eventType === 'response.web_search_call.searching' ||
              eventType === 'response.web_search_call.completed'
            ) {
              // Handled via response.output_item.done.
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
      const replaySkippedAfterVisibleOutput =
        !usingHttpFallback &&
        emittedVisibleOutput &&
        isRecoverableCodexStreamError(normalizedError)

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
        logForDebugging(
          `[codex-fetch] replay_skipped_visible_output=true conv=${requestCacheMetadata?.conversationId.slice(0, 8) ?? 'none'} ` +
          `error_name=${normalizedError.name} had_tool_calls=${hadToolCalls} ` +
          `open_tool_calls=${openToolCallBlocks.size} open_text_block=${currentTextBlockStarted}`,
          { level: 'warn' },
        )
        controller.error(
          createPartialStreamReplaySkippedError(
            normalizedError,
            requestCacheMetadata,
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

/**
 * Translates a WebSocket event stream to Anthropic streaming format.
 */
export function translateCodexWsStreamToAnthropic(
  wsEvents: AsyncIterable<Record<string, unknown>>,
  codexModel: string,
  requestCacheMetadata?: CodexRequestCacheMetadata,
  httpFallback?: HttpFallbackEventsFactory,
  transportContext?: CodexStreamTransportContext,
): Response {
  return buildAnthropicStreamResponse(
    wsEvents,
    codexModel,
    requestCacheMetadata,
    httpFallback,
    transportContext,
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
  const uncachedInputTokens = inputTokens - cachedInputTokens
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

  if (error instanceof CodexWebSocketIdleTimeoutError) {
    if (requestCacheMetadata) {
      markStickyHttpFallback(requestCacheMetadata.conversationId, 'idle_timeout')
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
      )
    }
    logForDebugging(
      `[codex-adapter] ws_error_classified class=closed_before_completed retryable=false ` +
      `close_code=${error.closeCode ?? 'n/a'} close_reason=${error.closeReason} msg="${error.message}"`,
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
    error.message.startsWith('WebSocket error during stream')
  )
}

function createPartialStreamReplaySkippedError(
  error: Error,
  requestCacheMetadata?: CodexRequestCacheMetadata,
): Error {
  const conversationSuffix = requestCacheMetadata
    ? ` Conversation ${requestCacheMetadata.conversationId.slice(0, 8)} will use HTTP fallback on the next turn.`
    : ''
  const wrapped = new Error(
    `Stream interrupted after visible output started; the turn was not replayed to avoid duplicate output or tool calls.${conversationSuffix} ` +
    `Original error: ${error.message}`,
  )
  wrapped.name = 'CodexPartialStreamReplaySkippedError'
  return wrapped
}

async function primeCodexEvents(
  events: AsyncIterable<Record<string, unknown>>,
): Promise<AsyncIterable<Record<string, unknown>>> {
  const iterator = events[Symbol.asyncIterator]()
  const first = await iterator.next()
  if (first.done) {
    throw new Error('Codex stream ended before first event')
  }

  return {
    async *[Symbol.asyncIterator]() {
      yield first.value
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

function normalizeInitialWebSocketError(
  error: unknown,
  accountId: string,
  conversationId?: string,
): Error {
  if (error instanceof CodexWebSocketUsageLimitError) {
    logForDebugging(
      `[codex-adapter] initial_ws_error_classified class=CodexAccountCapError ` +
      `retryable=true account=${accountId.slice(0, 8)} ` +
      `original_msg="${error.message}"`,
      { level: 'warn' },
    )
    return new CodexAccountCapError(accountId)
  }

  if (error instanceof Error) {
    if (conversationId) {
      const reason =
        error instanceof CodexWebSocketIdleTimeoutError
          ? 'initial_idle_timeout'
          : error instanceof CodexWebSocketClosedBeforeCompletedError
            ? 'initial_closed_before_completed'
            : 'initial_ws_unavailable'
      markStickyHttpFallback(conversationId, reason)
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

/**
 * Creates a fetch function that intercepts Anthropic API calls and routes them to Codex.
 * @param accessToken - The Codex access token for authentication
 * @returns A fetch function that translates Anthropic requests to Codex format
 */
function getPoolAccountForCurrentLease() {
  const currentLease = getCurrentCodexLease()
  if (!currentLease) {
    return getActiveAccount()
  }

  return (
    getPoolStatus().accounts.find(
      (account) => account.accountId === currentLease.accountId,
    ) ?? null
  )
}

export function createCodexFetch(
  accessToken: string,
  conversationIdOverride?: string,
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

    // Get current token — pool-aware when multi-account is active.
    // Re-derive both the token and account ID per request so that lease-local
    // failover or account changes are picked up without sharing cache state.
    const currentLease = getCurrentCodexLease()
    const poolAcct =
      currentLease && isPoolActive() ? getPoolAccountForCurrentLease() : null
    const currentToken = poolAcct?.accessToken || accessToken
    const currentAccountId = poolAcct?.accountId ?? extractAccountId(currentToken)

    // Translate to Codex format
    const { codexBody, codexModel } = translateToCodexBody(anthropicBody)

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
        if ((codexResponse.status === 429 || codexResponse.status === 401) && isPoolActive()) {
          throw new CodexAccountCapError(currentAccountId)
        }
        const errorText = await codexResponse.text()
        throw new Error(`Codex API error (${codexResponse.status}): ${errorText}`)
      }
      return {
        events: httpSseToEvents(codexResponse),
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

    if (!hasStickyHttpFallback(conversationId)) {
      try {
        schedulePrewarm(conversationId, codexBody, authHeaders)
        const wsRequestStartedAtMs = Date.now()
        const wsEvents = await primeCodexEvents(
          streamTurnViaWebSocketLocked(
            conversationId,
            codexBody,
            authHeaders,
            fullInput.length,
          ),
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
        )
      } catch (wsError) {
        clearWebSocketSession(conversationId)
        const normalized = normalizeInitialWebSocketError(
          wsError,
          currentAccountId,
          conversationId,
        )
        // Usage-cap errors must propagate so withRetry can trigger pool failover.
        // All other WS errors fall through to the HTTP path below.
        if (normalized instanceof CodexAccountCapError) {
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

    // ── HTTP fallback ─────────────────────────────────────────────────
    const { response: codexResponse, transportContext } = await performHttpRequest()

    if (!codexResponse.ok) {
      if ((codexResponse.status === 429 || codexResponse.status === 401) && isPoolActive()) {
        throw new CodexAccountCapError(currentAccountId)
      }

      const errorText = await codexResponse.text()
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

    return translateCodexStreamToAnthropic(
      codexResponse,
      codexModel,
      requestCacheMetadata,
      transportContext,
    )
  }
}
