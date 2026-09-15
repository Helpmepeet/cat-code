import { afterEach, expect, test } from 'bun:test'

import {
  _setWebSocketFactoryForTest,
  clearWebSocketSession,
} from './codex-websocket-transport.js'
import {
  CodexResponseIncompleteError,
  createCodexFetch,
  resetCodexCacheContext,
  translateCodexWsStreamToAnthropic,
} from './codex-fetch-adapter.js'
import {
  findCodexPartialStreamFailure,
  isCodexPartialStreamReplaySkippedError,
} from './errorUtils.js'

const CONVERSATION_ID = 'conv_ws_incomplete_regression'

function withFetchPreconnect(
  implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): typeof fetch {
  return Object.assign(implementation, { preconnect: fetch.preconnect })
}

type WsListener = (...args: unknown[]) => void

class IncompleteWebSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3

  readyState: number = IncompleteWebSocket.OPEN
  private readonly listeners = new Map<string, WsListener[]>()

  triggerOpen(): void {
    for (const listener of this.listeners.get('open') ?? []) listener()
  }

  on(type: string, listener: WsListener): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  off(type: string, listener: WsListener): void {
    const listeners = this.listeners.get(type) ?? []
    this.listeners.set(type, listeners.filter(candidate => candidate !== listener))
  }

  send(): void {
    queueMicrotask(() => {
      const data = JSON.stringify({
        type: 'response.incomplete',
        response: {
          id: 'resp_incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
        },
      })
      for (const listener of this.listeners.get('message') ?? []) listener(data)
    })
  }

  close(): void {
    this.readyState = IncompleteWebSocket.CLOSED
  }
}

function createAccessToken(accountId: string): string {
  const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }))
  const payload = btoa(JSON.stringify({
    'https://api.openai.com/auth': {
      chatgpt_account_id: accountId,
    },
  }))
  return `${header}.${payload}.signature`
}

async function readUntilError(response: Response): Promise<{
  sse: string
  error: unknown
}> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let sse = ''

  try {
    while (true) {
      const next = await reader.read()
      if (next.done) return { sse, error: null }
      sse += decoder.decode(next.value, { stream: true })
    }
  } catch (error) {
    return { sse, error }
  } finally {
    reader.releaseLock()
  }
}

afterEach(() => {
  _setWebSocketFactoryForTest(null)
  clearWebSocketSession(CONVERSATION_ID)
  resetCodexCacheContext()
})

test('createCodexFetch surfaces a pre-visible websocket incomplete response without HTTP replay', async () => {
  const socket = new IncompleteWebSocket()
  _setWebSocketFactoryForTest(() => {
    queueMicrotask(() => socket.triggerOpen())
    return socket as never
  })

  const originalFetch = globalThis.fetch
  let httpRequests = 0
  globalThis.fetch = withFetchPreconnect(async () => {
    httpRequests += 1
    throw new Error('HTTP fallback must not replay an incomplete response')
  })

  try {
    await expect(
      createCodexFetch(
        createAccessToken('acct_ws_incomplete'),
        CONVERSATION_ID,
      )('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({
          stream: true,
          model: 'gpt-5.6-luna',
          _openaiInstructionAssembly: {
            instructions: 'Be precise.',
            inputMessages: [],
          },
        }),
      }),
    ).rejects.toMatchObject({
      name: 'CodexResponseIncompleteError',
      reason: 'max_output_tokens',
    })
    expect(httpRequests).toBe(0)
    expect(socket.readyState).toBe(IncompleteWebSocket.CLOSED)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('post-visible websocket incomplete response seals text and blocks replay or continuation', async () => {
  let httpFallbackCalls = 0
  const response = translateCodexWsStreamToAnthropic(
    (async function* () {
      yield { type: 'response.output_text.delta', delta: 'partial answer' }
      yield {
        type: 'response.incomplete',
        response: {
          incomplete_details: { reason: 'content_filter' },
        },
      }
    })(),
    'gpt-5.6-luna',
    {
      accountId: 'acct_ws_incomplete',
      model: 'gpt-5.6-luna',
      cacheContextKey: 'acct_ws_incomplete:gpt-5.6-luna',
      conversationId: CONVERSATION_ID,
    },
    async () => {
      httpFallbackCalls += 1
      return { events: (async function* () {})() }
    },
    { transport: 'websocket', requestStartedAtMs: 0 },
  )

  const { sse, error } = await readUntilError(response)
  expect(sse).toContain('partial answer')
  expect(sse).toContain('content_block_stop')
  expect(sse).not.toContain('message_stop')
  expect(isCodexPartialStreamReplaySkippedError(error)).toBe(true)
  expect(error).toMatchObject({
    cause: expect.any(CodexResponseIncompleteError),
  })
  expect(findCodexPartialStreamFailure(error)).toMatchObject({
    transport: 'websocket',
    cause: 'provider_failure',
    sealedPartialText: true,
    automaticContinuationEligible: false,
  })
  expect(httpFallbackCalls).toBe(0)
})

test('websocket incomplete response never completes or replays a partial tool call', async () => {
  let httpFallbackCalls = 0
  const response = translateCodexWsStreamToAnthropic(
    (async function* () {
      yield { type: 'response.output_text.delta', delta: 'checking' }
      yield {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'function_call',
          call_id: 'call_incomplete',
          name: 'Read',
          arguments: '',
        },
      }
      yield {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: '{"file_path":',
      }
      yield {
        type: 'response.incomplete',
        response: {
          incomplete_details: { reason: 'max_output_tokens' },
        },
      }
    })(),
    'gpt-5.6-luna',
    {
      accountId: 'acct_ws_incomplete',
      model: 'gpt-5.6-luna',
      cacheContextKey: 'acct_ws_incomplete:gpt-5.6-luna',
      conversationId: CONVERSATION_ID,
    },
    async () => {
      httpFallbackCalls += 1
      return { events: (async function* () {})() }
    },
    { transport: 'websocket', requestStartedAtMs: 0 },
  )

  const { sse, error } = await readUntilError(response)
  expect(isCodexPartialStreamReplaySkippedError(error)).toBe(true)
  expect(findCodexPartialStreamFailure(error)).toMatchObject({
    cause: 'provider_failure',
    hadClientToolCall: true,
    openClientToolCalls: 1,
    automaticContinuationEligible: false,
  })
  expect(sse).not.toContain('"content_block_stop","index":1')
  expect(sse).not.toContain('message_stop')
  expect(httpFallbackCalls).toBe(0)
})
