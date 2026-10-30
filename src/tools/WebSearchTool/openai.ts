import { APIConnectionError, APIError } from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import type { ToolUseContext } from '../../Tool.js'
import {
  resolveCodexOAuthTokensForLeaseOwner,
  type ResolvedCodexOAuthTokens,
} from '../../services/api/client.js'
import {
  CodexAccountAuthError,
  mapClaudeModelToCodex,
} from '../../services/api/codex-fetch-adapter.js'
import { registerCodexLease } from '../../services/api/codexAccountLeaseManager.js'
import { poolManagesCredentials } from '../../services/api/codexAccountPool.js'
import {
  startCodexCredentialSend,
  type CodexCredentialUseOptions,
} from '../../services/api/codexCredentialUse.js'
import { withRetry } from '../../services/api/withRetry.js'
import { AbortError } from '../../utils/errors.js'
import { getProxyFetchOptions } from '../../utils/proxy.js'
import type { WebSearchInput, WebSearchOutput, WebSearchResult } from './types.js'

const SEARCH_URL = 'https://chatgpt.com/backend-api/codex/alpha/search'
const TIMEOUT_MS = 45_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_SUMMARY_CHARACTERS = 40_000
const MAX_RESULT_CHARACTERS = 50_000
const FRESHNESS_DAYS = { day: 1, week: 7, month: 30, year: 365 } as const

type SearchContext = ToolUseContext & {
  codexCredentialUse?: CodexCredentialUseOptions
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function optionalText(value: unknown, maxCharacters: number): string | undefined {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, maxCharacters)
    : undefined
}

function resultUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8192) return undefined
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return undefined
    }
    return url.href
  } catch {
    return undefined
  }
}

function parseResponse(value: unknown, input: WebSearchInput): Omit<WebSearchOutput, 'durationSeconds'> {
  const response = object(value)
  if (!response || typeof response.output !== 'string' ||
    (response.results != null && !Array.isArray(response.results))) {
    throw new Error('OpenAI web search returned an invalid response.')
  }
  const results: WebSearchResult[] = []
  const seen = new Set<string>()
  const maxResults = Math.max(1, Math.min(input.max_results ?? 10, 100))
  let remaining = MAX_RESULT_CHARACTERS
  const addResult = (candidate: Record<string, unknown>) => {
    if (results.length >= maxResults || remaining <= 0) return
    const url = resultUrl(candidate.url)
    if (!url || seen.has(url)) return
    const title = optionalText(candidate.title, 512) ?? url
    if (title.length + url.length > remaining) return
    const snippet = optionalText(candidate.snippet ?? candidate.text, Math.min(2000, remaining - title.length - url.length))
    results.push({ title, url, ...(snippet ? { highlights: [snippet] } : {}) })
    seen.add(url)
    remaining -= title.length + url.length + (snippet?.length ?? 0)
  }
  if (Array.isArray(response.results)) {
    for (const candidate of response.results) {
      const item = object(candidate)
      if (item) addResult(item)
    }
  } else {
    // Older search responses have only plaintext source headings, not result DTOs.
    for (const match of response.output.matchAll(/^(.+?)\s+\((https?:\/\/[^\s)]+)\)\s*$/gm)) {
      addResult({ title: match[1], url: match[2] })
    }
    for (const match of response.output.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g)) {
      addResult({ title: match[1], url: match[2] })
    }
  }
  return {
    query: input.query.trim(),
    results,
    summary: response.output.slice(0, MAX_SUMMARY_CHARACTERS),
    provider: 'openai',
  }
}

async function readResponse(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw new Error('OpenAI web search response exceeded the size limit.')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('OpenAI web search returned an empty response.')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error('OpenAI web search response exceeded the size limit.')
      }
      chunks.push(chunk.value)
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'OpenAI web search response exceeded the size limit.') {
      throw error
    }
    throw new APIConnectionError({ message: 'OpenAI web search response could not be read.' })
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('OpenAI web search returned invalid JSON.')
  }
}

async function resolveAuth(context: ToolUseContext): Promise<ResolvedCodexOAuthTokens> {
  if (context.agentId && poolManagesCredentials()) {
    registerCodexLease({
      ownerId: context.agentId,
      ownerType: 'subagent',
      ownerLabel: `Subagent ${context.agentId}`,
    })
  }
  const auth = await resolveCodexOAuthTokensForLeaseOwner({
    codexLeaseOwnerId: context.agentId ?? 'main-thread',
    codexLeaseOwnerType: context.agentId ? 'subagent' : 'main',
  })
  if (!auth) throw new Error('OpenAI web search requires a usable ChatGPT account.')
  return auth
}

export async function searchOpenAI(
  input: WebSearchInput,
  context: ToolUseContext,
): Promise<WebSearchOutput> {
  const callerSignal = context.abortController.signal
  if (callerSignal.aborted) throw new AbortError('WebSearch was cancelled.')
  const timeout = new AbortController()
  const signal = AbortSignal.any([callerSignal, timeout.signal])
  const started = performance.now()
  const model = mapClaudeModelToCodex(context.options.mainLoopModel)
  const sessionId = randomUUID()
  const recency = input.freshness && input.freshness !== 'any'
    ? FRESHNESS_DAYS[input.freshness]
    : undefined
  const body = JSON.stringify({
    id: sessionId,
    model,
    commands: {
      search_query: [{ q: input.query.trim(), domains: input.include_domains, recency }],
      response_length: 'long',
    },
    settings: {
      external_web_access: true,
      search_context_size: 'medium',
      allowed_callers: ['direct'],
    },
    max_output_tokens: 8000,
  })
  const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS)
  let onAbort: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(callerSignal.aborted
      ? new AbortError('WebSearch was cancelled.')
      : new Error('OpenAI web search timed out.'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  const generator = withRetry(
    () => resolveAuth(context),
    async auth => {
      if (signal.aborted) throw new AbortError('WebSearch was cancelled.')
      let response: Response
      try {
        response = await startCodexCredentialSend(auth, authorized => {
          if (signal.aborted) throw new AbortError('WebSearch was cancelled.')
          return globalThis.fetch(SEARCH_URL, {
            ...getProxyFetchOptions(),
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              Authorization: `Bearer ${authorized.accessToken}`,
              'chatgpt-account-id': authorized.accountId,
              originator: 'cat_code',
              'conversation-id': sessionId,
            },
            body,
            signal,
            redirect: 'error',
          })
        }, (context as SearchContext).codexCredentialUse)
      } catch (error) {
        if (signal.aborted) throw new AbortError('WebSearch was cancelled.')
        if (error instanceof TypeError) {
          throw new APIConnectionError({ message: 'OpenAI web search connection failed.' })
        }
        throw error
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        if (response.status === 401) throw new CodexAccountAuthError(auth.accountId, 401)
        // A search-specific rate limit does not establish an inference quota cap.
        throw APIError.generate(response.status, undefined,
          'OpenAI web search request failed.', response.headers)
      }
      return parseResponse(await readResponse(response), input)
    },
    {
      maxRetries: 2,
      model,
      thinkingConfig: { type: 'disabled' },
      signal,
      ownerId: context.agentId ?? 'main-thread',
      isCodexRequest: true,
      querySource: 'web_search_tool',
    },
  )
  const run = async () => {
    let step = await generator.next()
    while (!step.done) step = await generator.next()
    return { ...step.value, durationSeconds: (performance.now() - started) / 1000 }
  }
  try {
    return await Promise.race([run(), aborted])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort!)
  }
}
