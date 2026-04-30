import type {
  CodexCoreCacheMetadata,
  CodexCoreUsage,
} from './types.js'
import { CodexCoreError } from './errors.js'

type ParsedCodexCoreResponse = {
  text: string
  usage?: CodexCoreUsage
  cache?: CodexCoreCacheMetadata
  stopReason?: string | null
  rawResponse: unknown
  rawEvents: Array<Record<string, unknown>>
}

export async function parseCodexCoreResponse(
  response: Response,
): Promise<ParsedCodexCoreResponse> {
  if (!response.ok) {
    throw await errorFromResponse(response)
  }

  const rawEvents: Array<Record<string, unknown>> = []
  let text = ''
  let usage: CodexCoreUsage | undefined
  let stopReason: string | null | undefined

  for await (const event of readSseEvents(response)) {
    rawEvents.push(event)

    if (event.type === 'error') {
      const error = event.error as { message?: unknown; type?: unknown } | undefined
      throw new CodexCoreError(
        'backend',
        typeof error?.message === 'string' ? error.message : 'Codex backend returned an error',
        { details: event },
      )
    }

    if (event.type === 'content_block_delta') {
      const delta = event.delta as { type?: unknown; text?: unknown } | undefined
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        text += delta.text
      }
    }

    if (event.type === 'message_start') {
      const message = event.message as { usage?: unknown } | undefined
      usage = mergeUsage(usage, message?.usage)
    }

    if (event.type === 'message_delta') {
      const delta = event.delta as { stop_reason?: unknown } | undefined
      stopReason = typeof delta?.stop_reason === 'string' ? delta.stop_reason : null
      usage = mergeUsage(usage, event.usage)
    }
  }

  const cachedInputTokens = usage?.cachedInputTokens
  const cacheCreationInputTokens = usage?.cacheCreationInputTokens

  return {
    text,
    usage,
    cache:
      cachedInputTokens !== undefined || cacheCreationInputTokens !== undefined
        ? {
            hit: typeof cachedInputTokens === 'number' ? cachedInputTokens > 0 : undefined,
            cachedInputTokens,
            cacheCreationInputTokens,
            raw: {
              inputTokens: usage?.inputTokens,
              outputTokens: usage?.outputTokens,
              cachedInputTokens,
              cacheCreationInputTokens,
            },
          }
        : undefined,
    stopReason,
    rawResponse: rawEvents,
    rawEvents,
  }
}

async function errorFromResponse(response: Response): Promise<CodexCoreError> {
  const body = await response.text().catch(() => '')
  const message = body || `Codex request failed with status ${response.status}`
  if (response.status === 401 || response.status === 403) {
    return new CodexCoreError('auth', message, { status: response.status, details: body })
  }
  if (response.status === 429) {
    const lower = body.toLowerCase()
    const code = lower.includes('quota') || lower.includes('cap') || lower.includes('usage')
      ? 'quota'
      : 'rate_limit'
    return new CodexCoreError(code, message, { status: response.status, details: body })
  }
  if (response.status === 400 || body.toLowerCase().includes('model')) {
    return new CodexCoreError('model', message, { status: response.status, details: body })
  }
  return new CodexCoreError('backend', message, { status: response.status, details: body })
}

async function* readSseEvents(
  response: Response,
): AsyncGenerator<Record<string, unknown>> {
  const body = response.body
  if (!body) return

  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      yield* drainSseBuffer(buffer, next => {
        buffer = next
      })
    }
    buffer += decoder.decode()
    yield* parseSseChunk(buffer)
  } finally {
    reader.releaseLock()
  }
}

function* drainSseBuffer(
  buffer: string,
  setBuffer: (next: string) => void,
): Generator<Record<string, unknown>> {
  while (true) {
    const splitIndex = buffer.search(/\r?\n\r?\n/)
    if (splitIndex < 0) {
      setBuffer(buffer)
      return
    }
    const separatorLength = buffer[splitIndex] === '\r' ? 4 : 2
    const chunk = buffer.slice(0, splitIndex)
    buffer = buffer.slice(splitIndex + separatorLength)
    yield* parseSseChunk(chunk)
  }
}

function* parseSseChunk(chunk: string): Generator<Record<string, unknown>> {
  const dataLines: string[] = []
  for (const line of chunk.split(/\r?\n/)) {
    if (line.startsWith('data: ')) {
      dataLines.push(line.slice(6))
    }
  }
  if (dataLines.length === 0) return

  const data = dataLines.join('\n')
  if (!data || data === '[DONE]') return

  try {
    const parsed = JSON.parse(data) as unknown
    if (parsed && typeof parsed === 'object') {
      yield parsed as Record<string, unknown>
    }
  } catch {
    throw new CodexCoreError('backend', `Failed to parse Codex stream event: ${data}`)
  }
}

function mergeUsage(
  current: CodexCoreUsage | undefined,
  rawUsage: unknown,
): CodexCoreUsage | undefined {
  if (!rawUsage || typeof rawUsage !== 'object') {
    return current
  }

  const usage = rawUsage as Record<string, unknown>
  return {
    inputTokens: positiveNumber(usage.input_tokens, current?.inputTokens),
    outputTokens: numberOrFallback(usage.output_tokens, current?.outputTokens),
    cacheCreationInputTokens: positiveNumber(
      usage.cache_creation_input_tokens,
      current?.cacheCreationInputTokens,
    ),
    cachedInputTokens: positiveNumber(
      usage.cache_read_input_tokens,
      current?.cachedInputTokens,
    ),
  }
}

function positiveNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && value > 0 ? value : fallback
}

function numberOrFallback(value: unknown, fallback = 0): number {
  return typeof value === 'number' ? value : fallback
}
