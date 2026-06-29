import { AbortError, isAbortError } from '../../utils/errors.js'

export type WebSearchFreshness = 'day' | 'week' | 'month' | 'year' | 'any'

export type WebSearchInput = {
  query: string
  max_results?: number
  include_domains?: string[]
  exclude_domains?: string[]
  freshness?: WebSearchFreshness
}

export type WebSearchResult = {
  title: string
  url: string
  publishedDate?: string
  author?: string
  highlights?: string[]
}

export type WebSearchOutput = {
  query: string
  results: WebSearchResult[]
  durationSeconds: number
}

type ExaSearchRequest = {
  query: string
  numResults: number
  type: 'auto'
  contents: { highlights: { maxCharacters: number } }
  includeDomains?: string[]
  excludeDomains?: string[]
  startPublishedDate?: string
}

const EXA_SEARCH_URL = 'https://api.exa.ai/search'
const EXA_SEARCH_TIMEOUT_MS = 20_000
const DEFAULT_MAX_RESULTS = 5
const MAX_RESULTS = 10
const MAX_HIGHLIGHT_CHARACTERS = 500
const FRESHNESS_DAYS: Record<Exclude<WebSearchFreshness, 'any'>, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
}

function clampMaxResults(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_RESULTS
  return Math.max(1, Math.min(MAX_RESULTS, value))
}

function startPublishedDateForFreshness(
  freshness: WebSearchFreshness | undefined,
  now: Date,
): string | undefined {
  if (!freshness || freshness === 'any') return undefined
  const days = FRESHNESS_DAYS[freshness]
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  return start.toISOString()
}

function compactDomains(domains: string[] | undefined): string[] | undefined {
  if (!domains?.length) return undefined
  const compacted = domains.map(domain => domain.trim()).filter(Boolean)
  return compacted.length > 0 ? compacted : undefined
}

function withoutUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as T
}

function buildExaSearchRequest(
  input: WebSearchInput,
  now = new Date(),
): ExaSearchRequest {
  return withoutUndefined({
    query: input.query.trim(),
    numResults: clampMaxResults(input.max_results),
    type: 'auto',
    contents: { highlights: { maxCharacters: MAX_HIGHLIGHT_CHARACTERS } },
    includeDomains: compactDomains(input.include_domains),
    excludeDomains: compactDomains(input.exclude_domains),
    startPublishedDate: startPublishedDateForFreshness(input.freshness, now),
  })
}

const MAX_HIGHLIGHTS_PER_RESULT = 3

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value
    .filter(
      (item): item is string =>
        typeof item === 'string' && item.trim().length > 0,
    )
    .map(item => item.trim().slice(0, MAX_HIGHLIGHT_CHARACTERS))
  const capped = strings.slice(0, MAX_HIGHLIGHTS_PER_RESULT)
  return capped.length > 0 ? capped : undefined
}

function parseHttpUrl(value: unknown): string | undefined {
  const raw = optionalString(value)
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

function parseExaSearchResponse(
  body: unknown,
  query: string,
  durationSeconds: number,
  resultLimit: number,
): WebSearchOutput {
  if (!body || typeof body !== 'object') {
    throw new Error('Exa search returned an unexpected response.')
  }

  const record = body as Record<string, unknown>
  if (!Array.isArray(record.results)) {
    throw new Error('Exa search returned an unexpected response.')
  }

  const results: WebSearchResult[] = record.results.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const result = item as Record<string, unknown>
    const title = optionalString(result.title)
    const url = parseHttpUrl(result.url)
    if (!title || !url) return []

    const publishedDate = optionalString(result.publishedDate)
    const author = optionalString(result.author)
    const highlights = optionalStringArray(result.highlights)

    return [
      {
        title,
        url,
        ...(publishedDate ? { publishedDate } : {}),
        ...(author ? { author } : {}),
        ...(highlights ? { highlights } : {}),
      },
    ]
  }).slice(0, clampMaxResults(resultLimit))

  return {
    query,
    results,
    durationSeconds,
  }
}

function formatExaStatusError(status: number): string {
  if (status === 400) {
    return 'Exa rejected the search request with HTTP 400.'
  }
  if (status === 401) {
    return 'Exa authentication failed with HTTP 401. Check EXA_API_KEY.'
  }
  if (status === 402) {
    return 'Exa search is unavailable because Exa credits or budget are exhausted (HTTP 402).'
  }
  if (status === 403) {
    return 'Exa search access is forbidden with HTTP 403. Check the Exa account and API key permissions.'
  }
  if (status === 429) {
    return 'Exa rate limit exceeded with HTTP 429. Try again later or use fewer searches.'
  }
  return `Exa search failed with HTTP ${status}.`
}

function getExaApiKey(): string {
  const apiKey = process.env.EXA_API_KEY?.trim()
  if (!apiKey) {
    throw new Error(
      'EXA_API_KEY is not set. Set it in the shell environment before using WebSearch.',
    )
  }
  return apiKey
}

export async function searchExa(
  input: WebSearchInput,
  signal: AbortSignal,
): Promise<WebSearchOutput> {
  return searchExaWithTimeoutMs(input, signal, EXA_SEARCH_TIMEOUT_MS)
}

async function searchExaWithTimeoutMs(
  input: WebSearchInput,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<WebSearchOutput> {
  if (signal.aborted) {
    throw new AbortError('WebSearch was cancelled.')
  }

  const apiKey = getExaApiKey()
  const abortController = new AbortController()
  let timedOut = false
  let rejectCancellation: (error: Error) => void = () => {}
  const cancellationPromise = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject
  })
  const timeout = setTimeout(() => {
    timedOut = true
    abortController.abort()
    rejectCancellation(new Error('Exa search timed out after 20s.'))
  }, timeoutMs)

  const onAbort = () => {
    abortController.abort()
    rejectCancellation(new AbortError('WebSearch was cancelled.'))
  }
  signal.addEventListener('abort', onAbort, { once: true })

  const start = performance.now()
  try {
    const request = buildExaSearchRequest(input)
    const withCancellation = <T>(promise: Promise<T>): Promise<T> =>
      Promise.race([promise, cancellationPromise])

    const response = await withCancellation(
      globalThis.fetch(EXA_SEARCH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify(request),
        signal: abortController.signal,
      }),
    )

    const durationSeconds = (performance.now() - start) / 1000
    if (!response.ok) {
      response.body?.cancel().catch(() => {})
      throw new Error(formatExaStatusError(response.status))
    }

    let body: unknown
    try {
      body = await withCancellation(response.json())
    } catch (error) {
      if (
        error instanceof AbortError ||
        isAbortError(error) ||
        (error instanceof Error &&
          error.message === 'Exa search timed out after 20s.')
      ) {
        throw error
      }
      throw new Error('Exa search returned an unexpected response.')
    }

    return parseExaSearchResponse(
      body,
      input.query.trim(),
      durationSeconds,
      request.numResults,
    )
  } catch (error) {
    if (signal.aborted) {
      throw new AbortError('WebSearch was cancelled.')
    }
    if (timedOut && isAbortError(error)) {
      throw new Error('Exa search timed out after 20s.')
    }
    if (error instanceof Error && error.message.startsWith('Exa ')) {
      throw error
    }
    if (
      error instanceof Error &&
      error.message === 'Exa search returned an unexpected response.'
    ) {
      throw error
    }
    throw new Error('Exa search failed. Check your network connection.')
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', onAbort)
  }
}

export const _forTest = {
  buildExaSearchRequest,
  formatExaStatusError,
  parseExaSearchResponse,
  searchExaWithTimeoutMs,
}
