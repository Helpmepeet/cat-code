import { afterEach, describe, expect, test } from 'bun:test'
import {
  _setWebSocketFactoryForTest,
  CodexWebSocketClosedBeforeCompletedError,
  clearWebSocketSession,
} from './codex-websocket-transport.js'

import {
  _hasStickyHttpFallbackForTest,
  _markStickyHttpFallbackForTest,
  _setStickyFallbackNowForTest,
  CodexAccountAuthError,
  CodexAccountCapError,
  createCodexFetch,
  mapConversationIdToTrackingKey,
  mapEffortToCodex,
  resetCodexCacheContext,
  translateCodexStreamToAnthropic,
  translateCodexWsStreamToAnthropic,
  translateToCodexBody,
  truncateCodexToolOutputText,
  CODEX_TOOL_OUTPUT_MAX_CHARS,
} from './codex-fetch-adapter.js'
import {
  resetCodexAccountPoolForTest,
  seedCodexAccountPoolForTest,
} from './codexAccountPool.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../../tools/SyntheticOutputTool/SyntheticOutputTool.js'

function createAccessToken(accountId: string): string {
  const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }))
  const payload = btoa(JSON.stringify({
    'https://api.openai.com/auth': {
      chatgpt_account_id: accountId,
    },
  }))
  return `${header}.${payload}.signature`
}

type WsListener = (...args: unknown[]) => void
type FakeWsBatchItem =
  | Record<string, unknown>
  | { __close: { code?: number; reason?: string; wasClean?: boolean } }

class FakeWebSocket {
  static OPEN = 1
  static CLOSED = 3

  readyState: number = FakeWebSocket.OPEN

  responseBatches: Array<Array<FakeWsBatchItem>> = []

  private listeners = new Map<string, WsListener[]>()
  private sent: string[] = []

  triggerOpen() {
    for (const fn of this.listeners.get('open') ?? []) fn()
  }

  deliver(payload: Record<string, unknown>) {
    const data = JSON.stringify(payload)
    for (const fn of this.listeners.get('message') ?? []) fn(data)
  }

  deliverError(error: Record<string, unknown>) {
    this.deliver({ type: 'error', error })
  }

  triggerClose(options?: { code?: number; reason?: string; wasClean?: boolean }) {
    this.readyState = FakeWebSocket.CLOSED
    for (const fn of this.listeners.get('close') ?? []) {
      fn(options?.code, Buffer.from(options?.reason ?? ''))
    }
  }

  on(type: string, fn: WsListener) {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }

  off(type: string, fn: WsListener) {
    const list = this.listeners.get(type) ?? []
    this.listeners.set(type, list.filter(listener => listener !== fn))
  }

  send(data: string) {
    this.sent.push(data)
    for (const payload of this.responseBatches.shift() ?? []) {
      Promise.resolve().then(() => {
        if ('__close' in payload) {
          this.triggerClose(payload.__close)
          return
        }
        this.deliver(payload)
      })
    }
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
  }

  getSentCount() {
    return this.sent.length
  }
}

function installFakeWs(): FakeWebSocket {
  const fakeWs = new FakeWebSocket()
  _setWebSocketFactoryForTest(() => fakeWs as never)
  setTimeout(() => fakeWs.triggerOpen(), 0)
  return fakeWs
}

function completedWsResponse(responseId = 'resp_001') {
  return {
    type: 'response.completed',
    response: {
      id: responseId,
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        input_tokens_details: { cached_tokens: 0 },
      },
    },
  }
}

describe('codex-fetch-adapter', () => {
  afterEach(() => {
    resetCodexAccountPoolForTest()
  })

  // Guards the invariant the WebFetch + side-call fixes depend on: any request
  // that reaches the OpenAI path without a provider-native instruction assembly
  // throws here (rather than silently sending an empty request). Call-sites that
  // route Haiku/cheap calls to Codex must build buildProviderInstructionAssembly.
  test('translateToCodexBody throws without an instruction assembly', () => {
    expect(() =>
      translateToCodexBody({ model: 'gpt-5.6-luna', tools: [] }),
    ).toThrow('OpenAI request missing provider-native instruction assembly payload')
  })

  // A Claude small-fast model on the OpenAI path is remapped to the GPT mini.
  // This is the route the away-summary / hook / skill-improvement side-calls
  // take (they pass claude-haiku-* and rely on the adapter's remap).
  test('translateToCodexBody remaps claude-haiku to gpt-5.6-luna', () => {
    const { codexModel } = translateToCodexBody({
      model: 'claude-haiku-4-5-20251001',
      tools: [],
      _openaiInstructionAssembly: {
        instructions: 'sys',
        inputMessages: [],
      },
    })
    expect(codexModel).toBe('gpt-5.6-luna')
  })

  test('translateToCodexBody sets service_tier="priority" when speed=fast', () => {
    const { codexBody } = translateToCodexBody({
      model: 'claude-sonnet-4-6',
      speed: 'fast',
      _openaiInstructionAssembly: {
        instructions: '',
        inputMessages: [],
      },
    })

    expect(codexBody.service_tier).toBe('priority')
  })

  test('translateToCodexBody omits service_tier when speed is standard or absent', () => {
    const standard = translateToCodexBody({
      model: 'claude-sonnet-4-6',
      speed: 'standard',
      _openaiInstructionAssembly: {
        instructions: '',
        inputMessages: [],
      },
    })
    const absent = translateToCodexBody({
      model: 'claude-sonnet-4-6',
      _openaiInstructionAssembly: {
        instructions: '',
        inputMessages: [],
      },
    })

    expect(standard.codexBody.service_tier).toBeUndefined()
    expect(absent.codexBody.service_tier).toBeUndefined()
  })

  test('translateToCodexBody sends developer context as developer input message', () => {
    const { codexBody } = translateToCodexBody({
      model: 'claude-sonnet-4-6',
      _openaiInstructionAssembly: {
        instructions: 'stable instructions',
        developerContext: '<session_context>git status</session_context>',
        inputMessages: [
          {
            role: 'user',
            content: 'real user prompt',
          },
        ],
      },
    })

    expect(codexBody.input).toEqual([
      {
        type: 'message',
        role: 'developer',
        content: [
          {
            type: 'input_text',
            text: '<session_context>git status</session_context>',
          },
        ],
      },
      {
        role: 'user',
        content: 'real user prompt',
      },
    ])
  })

  test('sticky HTTP fallback expires after its TTL and does not extend on remark', () => {
    const conv = 'sticky-test-conv'
    let t = 1_000
    _setStickyFallbackNowForTest(() => t)
    resetCodexCacheContext()

    try {
      _markStickyHttpFallbackForTest(conv, 'first')
      expect(_hasStickyHttpFallbackForTest(conv)).toBe(true)

      t += 60_000
      _markStickyHttpFallbackForTest(conv, 'second')
      expect(_hasStickyHttpFallbackForTest(conv)).toBe(true)

      t += 61_000
      expect(_hasStickyHttpFallbackForTest(conv)).toBe(false)
    } finally {
      _setStickyFallbackNowForTest(null)
      resetCodexCacheContext()
    }
  })

  test('sticky HTTP fallback is scoped to the account it was set for', () => {
    const conv = 'sticky-account-scope'
    _setStickyFallbackNowForTest(() => 1_000)
    resetCodexCacheContext()

    try {
      // WS failed on the account the subagent was spread onto.
      _markStickyHttpFallbackForTest(conv, 'initial_ws_unavailable', 'acct_bad')
      // Same account: the flag applies (stay on HTTP for the TTL).
      expect(_hasStickyHttpFallbackForTest(conv, 'acct_bad')).toBe(true)
      // Reassigned/healthy account: the stale flag must NOT force it onto HTTP — it
      // retries WebSocket instead. This is the link-4 fix; conv-only keying returned
      // true here and stranded the healthy account on HTTP (where luna 404s).
      expect(_hasStickyHttpFallbackForTest(conv, 'acct_healthy')).toBe(false)

      // A wildcard flag (no account) still matches any account — legacy callers.
      _markStickyHttpFallbackForTest('sticky-wildcard', 'idle_timeout')
      expect(_hasStickyHttpFallbackForTest('sticky-wildcard', 'acct_anything')).toBe(
        true,
      )
    } finally {
      _setStickyFallbackNowForTest(null)
      resetCodexCacheContext()
    }
  })

  test('HTTP model-not-found (404) clears sticky and throws retryable so the turn retries over WebSocket', async () => {
    const accessToken = createAccessToken('acct_luna_404')
    const conv = 'conv_luna_404'
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: {
            message: 'Model not found gpt-5.6-luna',
            type: 'invalid_request_error',
            param: 'model',
          },
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof globalThis.fetch

    try {
      // Force the HTTP path (as a WS blip would), then the HTTP channel 404s luna.
      _markStickyHttpFallbackForTest(conv, 'initial_ws_unavailable')
      await expect(
        createCodexFetch(accessToken, conv)('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          body: JSON.stringify({
            stream: true,
            model: 'claude-sonnet-4-6', // maps to gpt-5.6-luna
            _openaiInstructionAssembly: {
              instructions: 'Be precise.',
              inputMessages: [],
            },
          }),
        }),
      ).rejects.toThrow(/retrying over WebSocket/i)

      // Sticky was cleared, so the retry re-attempts WebSocket instead of HTTP.
      expect(_hasStickyHttpFallbackForTest(conv, 'acct_luna_404')).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      resetCodexCacheContext()
    }
  })

  test('translateToCodexBody preserves function tool strictness and custom tool metadata', () => {
    const { codexBody } = translateToCodexBody({
      model: 'claude-sonnet-4-6',
      tools: [
        {
          name: 'strict_tool',
          description: 'Strict tool',
          input_schema: { type: 'object', properties: {} },
          strict: true,
        },
        {
          name: 'loose_tool',
          description: 'Loose tool',
          input_schema: { type: 'object', properties: {} },
          strict: false,
        },
        {
          name: 'legacy_tool',
          description: 'Legacy tool',
          input_schema: { type: 'object', properties: {} },
        },
        {
          name: 'Apply_patch',
          description: 'Apply patches using V4A diff format.',
          input_schema: { type: 'object', properties: {} },
          openai_tool_type: 'custom',
          openai_tool_format: {
            type: 'grammar',
            syntax: 'lark',
            definition: 'start: /(.|\\n)*/',
          },
        },
      ],
      _openaiInstructionAssembly: {
        instructions: 'test instructions',
        inputMessages: [],
      },
    })

    expect(codexBody.tools).toEqual([
      {
        type: 'function',
        name: 'strict_tool',
        description: 'Strict tool',
        parameters: { type: 'object', properties: {} },
        strict: true,
      },
      {
        type: 'function',
        name: 'loose_tool',
        description: 'Loose tool',
        parameters: { type: 'object', properties: {} },
        strict: false,
      },
      {
        type: 'function',
        name: 'legacy_tool',
        description: 'Legacy tool',
        parameters: { type: 'object', properties: {} },
        strict: null,
      },
      {
        type: 'custom',
        name: 'Apply_patch',
        description: 'Apply patches using V4A diff format.',
        format: {
          type: 'grammar',
          syntax: 'lark',
          definition: 'start: /(.|\\n)*/',
        },
      },
    ])
  })

  test('translateToCodexBody sends Anthropic web search schema as OpenAI hosted web_search', () => {
    const { codexBody } = translateToCodexBody({
      model: 'claude-sonnet-4-6',
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          allowed_domains: ['openai.com', 'platform.openai.com'],
          max_uses: 8,
        },
      ],
      _openaiInstructionAssembly: {
        instructions: 'test instructions',
        inputMessages: [],
      },
    })

    expect(codexBody.tools).toEqual([
      {
        type: 'web_search',
        external_web_access: true,
        filters: {
          allowed_domains: ['openai.com', 'platform.openai.com'],
        },
      },
    ])
    expect(codexBody.include).toEqual(['web_search_call.action.sources'])
  })

  test('translateToCodexBody rejects blocked_domains on Anthropic web search schema', () => {
    expect(() =>
      translateToCodexBody({
        model: 'claude-sonnet-4-6',
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search',
            blocked_domains: ['evil.example.com'],
          },
        ],
        _openaiInstructionAssembly: {
          instructions: 'test instructions',
          inputMessages: [],
        },
      }),
    ).toThrow(/blocked_domains/)
  })

  test('translateToCodexBody passes Anthropic tool_choice through to Codex', () => {
    const forcedWebSearch = translateToCodexBody({
      model: 'claude-sonnet-4-6',
      tools: [
        { type: 'web_search_20250305', name: 'web_search' },
      ],
      tool_choice: { type: 'tool', name: 'web_search' },
      _openaiInstructionAssembly: { instructions: 's', inputMessages: [] },
    }).codexBody
    expect(forcedWebSearch.tool_choice).toEqual({ type: 'web_search' })

    const forcedFunction = translateToCodexBody({
      model: 'claude-sonnet-4-6',
      tools: [
        {
          name: 'lookup',
          description: 'd',
          input_schema: { type: 'object', properties: {} },
        },
      ],
      tool_choice: { type: 'tool', name: 'lookup' },
      _openaiInstructionAssembly: { instructions: 's', inputMessages: [] },
    }).codexBody
    expect(forcedFunction.tool_choice).toEqual({ type: 'function', name: 'lookup' })

    const anyChoice = translateToCodexBody({
      model: 'claude-sonnet-4-6',
      tool_choice: { type: 'any' },
      _openaiInstructionAssembly: { instructions: 's', inputMessages: [] },
    }).codexBody
    expect(anyChoice.tool_choice).toBe('required')

    const noneChoice = translateToCodexBody({
      model: 'claude-sonnet-4-6',
      tool_choice: { type: 'none' },
      _openaiInstructionAssembly: { instructions: 's', inputMessages: [] },
    }).codexBody
    expect(noneChoice.tool_choice).toBe('none')

    const defaultChoice = translateToCodexBody({
      model: 'claude-sonnet-4-6',
      _openaiInstructionAssembly: { instructions: 's', inputMessages: [] },
    }).codexBody
    expect(defaultChoice.tool_choice).toBe('auto')
  })

  test('translateToCodexBody does not force filtered StructuredOutput tool choice', () => {
    const body = translateToCodexBody({
      model: 'claude-sonnet-4-6',
      tools: [
        {
          name: SYNTHETIC_OUTPUT_TOOL_NAME,
          description: 'Return structured output',
          input_schema: {
            type: 'object',
            properties: { title: { type: 'string' } },
            required: ['title'],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: { type: 'tool', name: SYNTHETIC_OUTPUT_TOOL_NAME },
      _openaiInstructionAssembly: { instructions: 's', inputMessages: [] },
    }).codexBody

    expect(body.tool_choice).toBe('auto')
    expect(
      Array.isArray(body.tools)
        ? body.tools.some(tool => tool.name === SYNTHETIC_OUTPUT_TOOL_NAME)
        : false,
    ).toBe(false)
  })

  test('translateToCodexBody preserves reasoning include when thinking is disabled and web search is enabled', () => {
    const { codexBody } = translateToCodexBody({
      model: 'claude-sonnet-4-6',
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
        },
      ],
      thinking: { type: 'disabled' },
      _openaiInstructionAssembly: {
        instructions: 'test instructions',
        inputMessages: [],
      },
    })

    expect(codexBody.reasoning).toEqual({ effort: 'none' })
    expect(codexBody.include).toEqual([
      'reasoning.encrypted_content',
      'web_search_call.action.sources',
    ])
  })

  test('translateToCodexBody maps disabled thinking to none for GPT-5.6 Terra', () => {
    const { codexBody } = translateToCodexBody({
      model: 'gpt-5.6-terra',
      thinking: { type: 'disabled' },
      _openaiInstructionAssembly: {
        instructions: 'test instructions',
        inputMessages: [],
      },
    })

    expect(codexBody.reasoning).toEqual({ effort: 'none' })
  })

  test('translateToCodexBody maps boolean disabled thinking to none for GPT-5.6 Terra', () => {
    const { codexBody } = translateToCodexBody({
      model: 'gpt-5.6-terra',
      thinking: false,
      _openaiInstructionAssembly: {
        instructions: 'test instructions',
        inputMessages: [],
      },
    })

    expect(codexBody.reasoning).toEqual({ effort: 'none' })
  })

  test('translateToCodexBody maps disabled thinking to none for GPT-5.6 Luna', () => {
    const { codexBody } = translateToCodexBody({
      model: 'gpt-5.6-luna',
      thinking: { type: 'disabled' },
      _openaiInstructionAssembly: {
        instructions: 'test instructions',
        inputMessages: [],
      },
    })

    expect(codexBody.reasoning).toEqual({ effort: 'none' })
  })

  test('translateToCodexBody maps disabled thinking to none for GPT-5.6 Sol', () => {
    const { codexBody } = translateToCodexBody({
      model: 'gpt-5.6-sol',
      thinking: { type: 'disabled' },
      _openaiInstructionAssembly: {
        instructions: 'test instructions',
        inputMessages: [],
      },
    })

    expect(codexBody.reasoning).toEqual({ effort: 'none' })
  })

  test('translateToCodexBody maps disabled thinking to none for GPT-5.6 Terra', () => {
    const { codexBody } = translateToCodexBody({
      model: 'gpt-5.6-terra',
      thinking: { type: 'disabled' },
      _openaiInstructionAssembly: {
        instructions: 'test instructions',
        inputMessages: [],
      },
    })

    expect(codexBody.reasoning).toEqual({ effort: 'none' })
  })

  test('mapEffortToCodex maps explicit minimal to none for GPT-5.6 Terra and Luna', () => {
    expect(mapEffortToCodex('minimal', 'gpt-5.6-terra')).toBe('none')
    expect(mapEffortToCodex('minimal', 'gpt-5.6-luna')).toBe('none')
  })

  test('mapEffortToCodex preserves supported GPT-5.6 reasoning levels', () => {
    expect(mapEffortToCodex('xhigh', 'gpt-5.6-sol')).toBe('xhigh')
    expect(mapEffortToCodex('max', 'gpt-5.6-sol')).toBe('max')
    expect(mapEffortToCodex('ultra', 'gpt-5.6-sol')).toBe('ultra')
    expect(mapEffortToCodex('ultra', 'gpt-5.6-terra')).toBe('ultra')
    expect(mapEffortToCodex('max', 'gpt-5.6-luna')).toBe('max')
    expect(mapEffortToCodex('ultra', 'gpt-5.6-luna')).toBeUndefined()
  })

  test('translateToCodexBody merges web search sources include with reasoning include', () => {
    const { codexBody } = translateToCodexBody({
      model: 'claude-sonnet-4-6',
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 8,
        },
      ],
      output_config: { effort: 'low' },
      _openaiInstructionAssembly: {
        instructions: 'test instructions',
        inputMessages: [],
      },
    })

    expect(codexBody.reasoning).toEqual({ effort: 'low', summary: 'auto' })
    expect(codexBody.include).toEqual([
      'reasoning.encrypted_content',
      'web_search_call.action.sources',
    ])
  })

  test('translateToCodexBody preserves multimodal tool_result output', () => {
    const { codexBody } = translateToCodexBody({
      model: 'claude-sonnet-4-6',
      _openaiInstructionAssembly: {
        instructions: 'test instructions',
        inputMessages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call_image_tool',
                name: 'vision_tool',
                input: {},
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_image_tool',
                content: [
                  { type: 'text', text: 'caption' },
                  {
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: 'image/png',
                      data: 'ZmFrZQ==',
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    })

    expect(codexBody.input).toEqual([
      {
        type: 'function_call',
        call_id: 'call_image_tool',
        name: 'vision_tool',
        arguments: '{}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_image_tool',
        output: [
          { type: 'input_text', text: 'caption' },
          {
            type: 'input_image',
            image_url: 'data:image/png;base64,ZmFrZQ==',
          },
        ],
      },
    ])
  })

  test('translateCodexStreamToAnthropic normalizes custom Apply_patch tool calls', async () => {
    const codexResponse = new Response(
      [
        'event: response.output_item.added',
        `data: ${JSON.stringify({
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            id: 'item_apply_patch_1',
            type: 'custom_tool_call',
            call_id: 'call_apply_patch_1',
            name: 'Apply_patch',
            input: '',
          },
        })}`,
        '',
        'event: response.custom_tool_call_input.delta',
        `data: ${JSON.stringify({
          type: 'response.custom_tool_call_input.delta',
          item_id: 'item_apply_patch_1',
          delta: '*** Begin Patch\\n*** Update File: src/example.ts\\n@@ line\\n-line\\n+line changed\\n',
        })}`,
        '',
        'event: response.custom_tool_call_input.done',
        `data: ${JSON.stringify({
          type: 'response.custom_tool_call_input.done',
          item_id: 'item_apply_patch_1',
          input: '*** Begin Patch\\n*** Update File: src/example.ts\\n@@ line\\n-line\\n+line changed\\n*** End Patch',
        })}`,
        '',
        'event: response.output_item.done',
        `data: ${JSON.stringify({
          type: 'response.output_item.done',
          item: {
            id: 'item_apply_patch_1',
            type: 'custom_tool_call',
            call_id: 'call_apply_patch_1',
            name: 'Apply_patch',
            input: '*** Begin Patch\\n*** Update File: src/example.ts\\n@@ line\\n-line\\n+line changed\\n*** End Patch',
          },
        })}`,
        '',
        'event: response.completed',
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            usage: {
              input_tokens: 10,
              output_tokens: 4,
              input_tokens_details: { cached_tokens: 0 },
            },
          },
        })}`,
        '',
      ].join('\n'),
      {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      },
    )

    const anthropicResponse = await translateCodexStreamToAnthropic(
      codexResponse,
      'gpt-5.6-luna',
    )
    const body = await anthropicResponse.text()

    expect(body).toContain('event: content_block_start')
    expect(body).toContain('"type":"tool_use"')
    expect(body).toContain('"id":"call_apply_patch_1"')
    expect(body).toContain('"name":"Apply_patch"')
    expect(body).toContain('"type":"input_json_delta"')
    expect(body).toContain('*** Begin Patch')
    expect(body).toContain('*** Update File: src/example.ts')
    expect(body).toContain('event: content_block_stop')
    expect(body).toContain('"stop_reason":"tool_use"')
    expect(body).toContain('event: message_stop')
  })

  test('translateCodexStreamToAnthropic converts OpenAI web_search_call into Anthropic server tool blocks', async () => {
    const codexResponse = new Response(
      [
        'event: response.output_item.done',
        `data: ${JSON.stringify({
          type: 'response.output_item.done',
          item: {
            id: 'ws_123',
            type: 'web_search_call',
            status: 'completed',
            action: {
              type: 'search',
              query: 'OpenAI Responses web_search',
              sources: [
                {
                  type: 'url',
                  title: 'Web search - OpenAI API',
                  url: 'https://platform.openai.com/docs/guides/tools-web-search',
                },
              ],
            },
          },
        })}`,
        '',
        'event: response.output_text.delta',
        `data: ${JSON.stringify({
          type: 'response.output_text.delta',
          delta: 'OpenAI supports hosted web search.',
        })}`,
        '',
        'event: response.output_item.done',
        `data: ${JSON.stringify({
          type: 'response.output_item.done',
          item: {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'OpenAI supports hosted web search.',
                annotations: [
                  {
                    type: 'url_citation',
                    start_index: 17,
                    end_index: 35,
                    title: 'Web search - OpenAI API',
                    url: 'https://platform.openai.com/docs/guides/tools-web-search',
                  },
                ],
              },
            ],
            status: 'completed',
          },
        })}`,
        '',
        'event: response.completed',
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            usage: {
              input_tokens: 10,
              output_tokens: 4,
              input_tokens_details: { cached_tokens: 0 },
            },
          },
        })}`,
        '',
      ].join('\n'),
      {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      },
    )

    const anthropicResponse = await translateCodexStreamToAnthropic(
      codexResponse,
      'gpt-5.6-luna',
    )
    const body = await anthropicResponse.text()

    expect(body).toContain('"type":"server_tool_use"')
    expect(body).toContain('"id":"ws_123"')
    expect(body).toContain('"name":"web_search"')
    expect(body).toContain('"type":"input_json_delta"')
    expect(body).toContain('OpenAI Responses web_search')
    expect(body).toContain('"type":"web_search_tool_result"')
    expect(body).toContain('Web search - OpenAI API')
    expect(body).toContain('https://platform.openai.com/docs/guides/tools-web-search')
    expect(body).toContain('OpenAI supports hosted web search.')
    expect(body).toContain('"stop_reason":"end_turn"')
  })

  test('translateCodexStreamToAnthropic keeps stop_reason=end_turn for web_search-only output and uses tool_use when a real function call follows', async () => {
    const searchOnly = new Response(
      [
        'event: response.output_item.done',
        `data: ${JSON.stringify({
          type: 'response.output_item.done',
          item: {
            id: 'ws_only',
            type: 'web_search_call',
            status: 'completed',
            action: { type: 'search', query: 'q', sources: [] },
          },
        })}`,
        '',
        'event: response.completed',
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              input_tokens_details: { cached_tokens: 0 },
            },
          },
        })}`,
        '',
      ].join('\n'),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )

    const searchOnlyBody = await (
      await translateCodexStreamToAnthropic(searchOnly, 'gpt-5.6-luna')
    ).text()
    expect(searchOnlyBody).toContain('"stop_reason":"end_turn"')

    const mixed = new Response(
      [
        'event: response.output_item.done',
        `data: ${JSON.stringify({
          type: 'response.output_item.done',
          item: {
            id: 'ws_first',
            type: 'web_search_call',
            status: 'completed',
            action: { type: 'search', query: 'q', sources: [] },
          },
        })}`,
        '',
        'event: response.output_item.added',
        `data: ${JSON.stringify({
          type: 'response.output_item.added',
          output_index: 1,
          item: {
            id: 'item_fn',
            type: 'function_call',
            call_id: 'call_fn',
            name: 'lookup',
            arguments: '',
          },
        })}`,
        '',
        'event: response.function_call_arguments.delta',
        `data: ${JSON.stringify({
          type: 'response.function_call_arguments.delta',
          item_id: 'item_fn',
          delta: '{"x":1}',
        })}`,
        '',
        'event: response.function_call_arguments.done',
        `data: ${JSON.stringify({
          type: 'response.function_call_arguments.done',
          item_id: 'item_fn',
          arguments: '{"x":1}',
        })}`,
        '',
        'event: response.output_item.done',
        `data: ${JSON.stringify({
          type: 'response.output_item.done',
          item: {
            id: 'item_fn',
            type: 'function_call',
            call_id: 'call_fn',
            name: 'lookup',
            arguments: '{"x":1}',
          },
        })}`,
        '',
        'event: response.completed',
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              input_tokens_details: { cached_tokens: 0 },
            },
          },
        })}`,
        '',
      ].join('\n'),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )

    const mixedBody = await (
      await translateCodexStreamToAnthropic(mixed, 'gpt-5.6-luna')
    ).text()
    expect(mixedBody).toContain('"type":"server_tool_use"')
    expect(mixedBody).toContain('"id":"ws_first"')
    expect(mixedBody).toContain('"type":"tool_use"')
    expect(mixedBody).toContain('"id":"call_fn"')
    expect(mixedBody).toContain('"stop_reason":"tool_use"')
  })

  test('createCodexFetch completes streamed responses without referencing undefined account state', async () => {
    const accessToken = createAccessToken('acct_test_streaming')
    const fetchCalls: Array<{ input: RequestInfo | URL, init?: RequestInit }> = []
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ input, init })

      return new Response(
        [
          'event: response.completed',
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              usage: {
                input_tokens: 10,
                output_tokens: 4,
                input_tokens_details: { cached_tokens: 3 },
              },
            },
          })}`,
          '',
        ].join('\n'),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )
    }) as unknown as typeof globalThis.fetch

    try {
      _markStickyHttpFallbackForTest('conv_http_direct', 'test')
      const abortController = new AbortController()
      const response = await createCodexFetch(accessToken, 'conv_http_direct')(
        'https://api.anthropic.com/v1/messages',
        {
          method: 'POST',
          signal: abortController.signal,
          body: JSON.stringify({
            stream: true,
            model: 'claude-sonnet-4-6',
            _openaiInstructionAssembly: {
              instructions: 'Be precise.',
              inputMessages: [],
            },
          }),
        },
      )

      const body = await response.text()
      expect(fetchCalls).toHaveLength(1)
      expect(fetchCalls[0]?.input).toBe('https://chatgpt.com/backend-api/codex/responses')
      expect(fetchCalls[0]?.init?.headers).toMatchObject({
        Authorization: `Bearer ${accessToken}`,
        'chatgpt-account-id': 'acct_test_streaming',
      })
      expect(fetchCalls[0]?.init?.signal).toBe(abortController.signal)
      expect(body).toContain('event: message_stop')
      expect(body).toContain('"input_tokens":7')
      expect(body).toContain('"cache_read_input_tokens":3')
      // Invariant: emitted input_tokens + cache_read_input_tokens == original OpenAI input_tokens (10)
      // (adapter converts inclusive→exclusive semantics by subtracting cached from input)
      expect(body).toContain('"cache_creation_input_tokens":0')
      expect(body).not.toContain('currentAccountId is not defined')
    } finally {
      globalThis.fetch = originalFetch
      resetCodexCacheContext()
    }
  })

  test('createCodexFetch times out HTTP streams before initial visible output', async () => {
    const accessToken = createAccessToken('acct_test_initial_timeout')
    const originalFetch = globalThis.fetch
    const originalTimeout = process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS
    const encoder = new TextEncoder()
    let interval: ReturnType<typeof setInterval> | undefined
    let cancelCount = 0

    process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '20'
    globalThis.fetch = (async () => {
      return new Response(
        new ReadableStream({
          start(controller) {
            const sendHeartbeat = () => {
              controller.enqueue(
                encoder.encode(
                  [
                    'event: response.created',
                    `data: ${JSON.stringify({ type: 'response.created' })}`,
                    '',
                  ].join('\n'),
                ),
              )
            }
            sendHeartbeat()
            interval = setInterval(sendHeartbeat, 5)
          },
          cancel() {
            cancelCount++
            if (interval) clearInterval(interval)
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )
    }) as unknown as typeof globalThis.fetch

    try {
      _markStickyHttpFallbackForTest('conv_initial_timeout', 'test')
      await expect(
        createCodexFetch(accessToken, 'conv_initial_timeout')(
          'https://api.anthropic.com/v1/messages',
          {
            method: 'POST',
            body: JSON.stringify({
              stream: true,
              model: 'claude-sonnet-4-6',
              _openaiInstructionAssembly: {
                instructions: 'Be precise.',
                inputMessages: [],
              },
            }),
          },
        ),
      ).rejects.toThrow('no visible output')
      expect(cancelCount).toBe(1)
    } finally {
      if (interval) clearInterval(interval)
      if (originalTimeout === undefined) {
        delete process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS
      } else {
        process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = originalTimeout
      }
      globalThis.fetch = originalFetch
      resetCodexCacheContext()
    }
  })

  test('createCodexFetch sends hosted web_search and returns normalized web search stream blocks on HTTP path', async () => {
    const accessToken = createAccessToken('acct_test_web_search')
    const originalFetch = globalThis.fetch
    const fetchCalls: Array<{ input: RequestInfo | URL, init?: RequestInit }> = []

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ input, init })

      return new Response(
        [
          'event: response.output_item.done',
          `data: ${JSON.stringify({
            type: 'response.output_item.done',
            item: {
              id: 'ws_456',
              type: 'web_search_call',
              status: 'completed',
              action: {
                type: 'search',
                query: 'OpenAI native web search',
                sources: [
                  {
                    type: 'url',
                    title: 'OpenAI web search docs',
                    url: 'https://platform.openai.com/docs/guides/tools-web-search',
                  },
                ],
              },
            },
          })}`,
          '',
          'event: response.completed',
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              usage: {
                input_tokens: 10,
                output_tokens: 4,
                input_tokens_details: { cached_tokens: 0 },
              },
            },
          })}`,
          '',
        ].join('\n'),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )
    }) as unknown as typeof globalThis.fetch

    try {
      _markStickyHttpFallbackForTest('conv_web_search_http', 'test')
      const response = await createCodexFetch(accessToken, 'conv_web_search_http')(
        'https://api.anthropic.com/v1/messages',
        {
          method: 'POST',
          body: JSON.stringify({
            stream: true,
            model: 'claude-sonnet-4-6',
            tools: [
              {
                type: 'web_search_20250305',
                name: 'web_search',
                allowed_domains: ['platform.openai.com'],
                max_uses: 8,
              },
            ],
            _openaiInstructionAssembly: {
              instructions: 'Perform a web search.',
              inputMessages: [{ role: 'user', content: 'search docs' }],
            },
          }),
        },
      )

      const requestBody = JSON.parse(String(fetchCalls[0]?.init?.body))
      expect(requestBody.tools).toEqual([
        {
          type: 'web_search',
          external_web_access: true,
          filters: { allowed_domains: ['platform.openai.com'] },
        },
      ])
      expect(requestBody.include).toEqual(['web_search_call.action.sources'])

      const body = await response.text()
      expect(body).toContain('"type":"server_tool_use"')
      expect(body).toContain('"type":"web_search_tool_result"')
      expect(body).toContain('OpenAI web search docs')
      expect(body).toContain('https://platform.openai.com/docs/guides/tools-web-search')
    } finally {
      globalThis.fetch = originalFetch
      resetCodexCacheContext()
    }
  })

  test('createCodexFetch returns JSON for non-streaming custom tool calls on HTTP path', async () => {
    const accessToken = createAccessToken('acct_test_nonstream_tool')
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async () => {
      return new Response(
        [
          'event: response.output_item.added',
          `data: ${JSON.stringify({
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              id: 'item_apply_patch_1',
              type: 'custom_tool_call',
              call_id: 'call_apply_patch_1',
              name: 'Apply_patch',
              input: '',
            },
          })}`,
          '',
          'event: response.custom_tool_call_input.delta',
          `data: ${JSON.stringify({
            type: 'response.custom_tool_call_input.delta',
            item_id: 'item_apply_patch_1',
            delta: '*** Begin Patch\n*** Update File: src/example.ts\n@@\n-old\n+new\n',
          })}`,
          '',
          'event: response.custom_tool_call_input.done',
          `data: ${JSON.stringify({
            type: 'response.custom_tool_call_input.done',
            item_id: 'item_apply_patch_1',
            input: '*** Begin Patch\n*** Update File: src/example.ts\n@@\n-old\n+new\n*** End Patch',
          })}`,
          '',
          'event: response.output_item.done',
          `data: ${JSON.stringify({
            type: 'response.output_item.done',
            item: {
              id: 'item_apply_patch_1',
              type: 'custom_tool_call',
              call_id: 'call_apply_patch_1',
              name: 'Apply_patch',
              input: '*** Begin Patch\n*** Update File: src/example.ts\n@@\n-old\n+new\n*** End Patch',
            },
          })}`,
          '',
          'event: response.completed',
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_nonstream_tool',
              usage: {
                input_tokens: 10,
                output_tokens: 4,
                input_tokens_details: { cached_tokens: 0 },
              },
            },
          })}`,
          '',
        ].join('\n'),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )
    }) as unknown as typeof globalThis.fetch

    try {
      _markStickyHttpFallbackForTest('conv_nonstream_tool', 'test')
      const response = await createCodexFetch(accessToken, 'conv_nonstream_tool')(
        'https://api.anthropic.com/v1/messages',
        {
          method: 'POST',
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            tools: [
              {
                name: 'Apply_patch',
                description: 'Apply patches.',
                input_schema: { type: 'object', properties: {} },
                openai_tool_type: 'custom',
                openai_tool_format: {
                  type: 'grammar',
                  syntax: 'lark',
                  definition: 'start: /(.|\\n)*/',
                },
              },
            ],
            _openaiInstructionAssembly: {
              instructions: 'Be precise.',
              inputMessages: [{ role: 'user', content: 'patch it' }],
            },
          }),
        },
      )

      expect(response.headers.get('Content-Type')).toContain('application/json')
      const body = await response.json()
      expect(body.id).toBe('resp_nonstream_tool')
      expect(body.content).toEqual([
        {
          type: 'tool_use',
          id: 'call_apply_patch_1',
          name: 'Apply_patch',
          input: '*** Begin Patch\n*** Update File: src/example.ts\n@@\n-old\n+new\n*** End Patch',
        },
      ])
      expect(body.stop_reason).toBe('tool_use')
      expect(body.usage).toMatchObject({
        input_tokens: 10,
        output_tokens: 4,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      })
    } finally {
      globalThis.fetch = originalFetch
      resetCodexCacheContext()
    }
  })

  test('createCodexFetch returns object input for non-streaming function tool calls', async () => {
    const accessToken = createAccessToken('acct_test_nonstream_function_tool')
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async () => {
      return new Response(
        [
          'event: response.output_item.added',
          `data: ${JSON.stringify({
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              id: 'item_read_1',
              type: 'function_call',
              call_id: 'call_read_1',
              name: 'Read',
              arguments: '',
            },
          })}`,
          '',
          'event: response.function_call_arguments.delta',
          `data: ${JSON.stringify({
            type: 'response.function_call_arguments.delta',
            item_id: 'item_read_1',
            delta: '{"file_path":"/tmp/example.ts"}',
          })}`,
          '',
          'event: response.function_call_arguments.done',
          `data: ${JSON.stringify({
            type: 'response.function_call_arguments.done',
            item_id: 'item_read_1',
            arguments: '{"file_path":"/tmp/example.ts"}',
          })}`,
          '',
          'event: response.output_item.done',
          `data: ${JSON.stringify({
            type: 'response.output_item.done',
            item: {
              id: 'item_read_1',
              type: 'function_call',
              call_id: 'call_read_1',
              name: 'Read',
              arguments: '{"file_path":"/tmp/example.ts"}',
            },
          })}`,
          '',
          'event: response.completed',
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_nonstream_function_tool',
              usage: {
                input_tokens: 10,
                output_tokens: 4,
                input_tokens_details: { cached_tokens: 0 },
              },
            },
          })}`,
          '',
        ].join('\n'),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )
    }) as unknown as typeof globalThis.fetch

    try {
      _markStickyHttpFallbackForTest('conv_nonstream_function_tool', 'test')
      const response = await createCodexFetch(
        accessToken,
        'conv_nonstream_function_tool',
      )('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          tools: [
            {
              name: 'Read',
              description: 'Read a file.',
              input_schema: {
                type: 'object',
                properties: { file_path: { type: 'string' } },
              },
            },
          ],
          _openaiInstructionAssembly: {
            instructions: 'Be precise.',
            inputMessages: [{ role: 'user', content: 'read it' }],
          },
        }),
      })

      const body = await response.json()
      expect(body.id).toBe('resp_nonstream_function_tool')
      expect(body.content).toEqual([
        {
          type: 'tool_use',
          id: 'call_read_1',
          name: 'Read',
          input: { file_path: '/tmp/example.ts' },
        },
      ])
      expect(body.stop_reason).toBe('tool_use')
    } finally {
      globalThis.fetch = originalFetch
      resetCodexCacheContext()
    }
  })

  test('createCodexFetch returns JSON for non-streaming text-only HTTP responses', async () => {
    const accessToken = createAccessToken('acct_test_nonstream_text')
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async () => {
      return new Response(
        [
          'event: response.output_text.delta',
          `data: ${JSON.stringify({
            type: 'response.output_text.delta',
            delta: 'hello from fallback',
          })}`,
          '',
          'event: response.completed',
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_nonstream_text',
              usage: {
                input_tokens: 8,
                output_tokens: 3,
                input_tokens_details: { cached_tokens: 2 },
              },
            },
          })}`,
          '',
        ].join('\n'),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )
    }) as unknown as typeof globalThis.fetch

    try {
      _markStickyHttpFallbackForTest('conv_nonstream_text', 'test')
      const response = await createCodexFetch(accessToken, 'conv_nonstream_text')(
        'https://api.anthropic.com/v1/messages',
        {
          method: 'POST',
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            _openaiInstructionAssembly: {
              instructions: 'Be precise.',
              inputMessages: [{ role: 'user', content: 'say hello' }],
            },
          }),
        },
      )

      expect(response.headers.get('Content-Type')).toContain('application/json')
      const body = await response.json()
      expect(body.id).toBe('resp_nonstream_text')
      expect(body.content).toEqual([
        {
          type: 'text',
          text: 'hello from fallback',
        },
      ])
      expect(body.stop_reason).toBe('end_turn')
      expect(body.usage).toMatchObject({
        input_tokens: 6,
        output_tokens: 3,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 2,
      })
    } finally {
      globalThis.fetch = originalFetch
      resetCodexCacheContext()
    }
  })

  test('createCodexFetch fails visibly for empty non-streaming HTTP responses', async () => {
    const accessToken = createAccessToken('acct_test_nonstream_empty')
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async () => {
      return new Response(
        [
          'event: response.completed',
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_nonstream_empty',
              usage: {
                input_tokens: 8,
                output_tokens: 3,
                input_tokens_details: { cached_tokens: 0 },
              },
            },
          })}`,
          '',
        ].join('\n'),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )
    }) as unknown as typeof globalThis.fetch

    try {
      _markStickyHttpFallbackForTest('conv_nonstream_empty', 'test')
      await expect(
        createCodexFetch(accessToken, 'conv_nonstream_empty')(
          'https://api.anthropic.com/v1/messages',
          {
            method: 'POST',
            body: JSON.stringify({
              model: 'claude-sonnet-4-6',
              _openaiInstructionAssembly: {
                instructions: 'Be precise.',
                inputMessages: [{ role: 'user', content: 'say hello' }],
              },
            }),
          },
        ),
      ).rejects.toThrow(
        'Codex non-streaming fallback produced an empty or invalid assistant message',
      )
    } finally {
      globalThis.fetch = originalFetch
      resetCodexCacheContext()
    }
  })

  test('translateCodexWsStreamToAnthropic propagates stream failures instead of textifying them', async () => {
    const response = translateCodexWsStreamToAnthropic(
      (async function* () {
        yield { type: 'response.output_text.delta', delta: 'hello' }
        throw new Error('WebSocket closed before response.completed')
      })(),
      'gpt-5.6-luna',
      {
        accountId: 'acct_test_streaming',
        model: 'gpt-5.6-luna',
        cacheContextKey: 'acct_test_streaming:gpt-5.6-luna',
        conversationId: 'conv_test_streaming',
      },
    )

    await expect(response.text()).rejects.toThrow('WebSocket closed before response.completed')
  })

  test('translateCodexWsStreamToAnthropic surfaces usage-limit response.failed after visible output without account failover', async () => {
    const response = translateCodexWsStreamToAnthropic(
      (async function* () {
        yield { type: 'response.output_text.delta', delta: 'visible text' }
        yield {
          type: 'response.failed',
          response: {
            error: {
              code: 'usage_limit_reached',
              message: 'usage limit reached',
            },
          },
        }
      })(),
      'gpt-5.6-luna',
      {
        accountId: 'acct_test_streaming',
        model: 'gpt-5.6-luna',
        cacheContextKey: 'acct_test_streaming:gpt-5.6-luna',
        conversationId: 'conv_visible_response_failed',
      },
    )

    let thrown: unknown
    try {
      await response.text()
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect(thrown).not.toBeInstanceOf(CodexAccountCapError)
    expect((thrown as Error).message).toContain('usage_limit_reached')
    expect((thrown as Error).message).toContain('usage limit reached')
  })

  test('translateCodexStreamToAnthropic surfaces non-account response.failed instead of completing', async () => {
    const codexResponse = new Response(
      [
        'event: response.failed',
        `data: ${JSON.stringify({
          type: 'response.failed',
          response: {
            error: {
              code: 'invalid_request_error',
              message: 'bad request',
            },
          },
        })}`,
        '',
      ].join('\n'),
      {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      },
    )

    const response = await translateCodexStreamToAnthropic(
      codexResponse,
      'gpt-5.6-luna',
      {
        accountId: 'acct_test_streaming',
        model: 'gpt-5.6-luna',
        cacheContextKey: 'acct_test_streaming:gpt-5.6-luna',
        conversationId: 'conv_non_cap_response_failed',
      },
    )

    await expect(response.text()).rejects.toThrow(/invalid_request_error.*bad request/)
  })

  test('translateCodexStreamToAnthropic classifies pre-visible token_invalidated response.failed as CodexAccountAuthError', async () => {
    const codexResponse = new Response(
      [
        'event: response.failed',
        `data: ${JSON.stringify({
          type: 'response.failed',
          response: {
            error: {
              type: 'invalid_request_error',
              code: 'token_invalidated',
              message:
                'Your authentication token has been invalidated. Please try signing in again.',
            },
          },
        })}`,
        '',
      ].join('\n'),
      {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      },
    )

    const response = await translateCodexStreamToAnthropic(
      codexResponse,
      'gpt-5.6-luna',
      {
        accountId: 'acct_test_streaming',
        model: 'gpt-5.6-luna',
        cacheContextKey: 'acct_test_streaming:gpt-5.6-luna',
        conversationId: 'conv_token_invalidated_response_failed',
      },
    )

    let thrown: unknown
    try {
      await response.text()
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(CodexAccountAuthError)
    expect((thrown as CodexAccountAuthError).accountId).toBe('acct_test_streaming')
  })

  test('translateCodexWsStreamToAnthropic refuses replay after visible output has started', async () => {
    const response = translateCodexWsStreamToAnthropic(
      (async function* () {
        yield { type: 'response.output_text.delta', delta: 'hello' }
        throw new CodexWebSocketClosedBeforeCompletedError(1000, 'none')
      })(),
      'gpt-5.6-luna',
      {
        accountId: 'acct_test_streaming',
        model: 'gpt-5.6-luna',
        cacheContextKey: 'acct_test_streaming:gpt-5.6-luna',
        conversationId: 'conv_partial_visible',
      },
      async () => ({
        events: (async function* () {
          yield { type: 'response.output_text.delta', delta: 'should not replay' }
          yield {
            type: 'response.completed',
            response: {
              usage: {
                input_tokens: 12,
                output_tokens: 3,
                input_tokens_details: { cached_tokens: 0 },
              },
            },
          }
        })(),
        transportContext: undefined,
      }),
    )

    await expect(response.text()).rejects.toThrow(
      'the turn was not replayed to avoid duplicate output or tool calls',
    )
  })

  test('createCodexFetch uses HTTP fallback for immediate zero-event websocket closes', async () => {
    resetCodexCacheContext()
    const accessToken = createAccessToken('acct_test_streaming')
    const originalFetch = globalThis.fetch
    const fakeWs = installFakeWs()
    const fetchCalls: Array<{ input: RequestInfo | URL, init?: RequestInit }> = []

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ input, init })
      return new Response(
        [
          'event: response.output_text.delta',
          `data: ${JSON.stringify({
            type: 'response.output_text.delta',
            delta: 'http fallback after ws close',
          })}`,
          '',
          'event: response.completed',
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              usage: {
                input_tokens: 12,
                output_tokens: 3,
                input_tokens_details: { cached_tokens: 0 },
              },
            },
          })}`,
          '',
        ].join('\n'),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )
    }) as unknown as typeof globalThis.fetch

    // Item 3 rule 1: no per-request prewarm, so the first WS send is the real
    // turn — a zero-event close on it drives the HTTP fallback.
    fakeWs.responseBatches = [
      [{ __close: { code: 1000, reason: 'policy' } }],
    ]

    try {
      const response = await createCodexFetch(accessToken, 'conv_zero_event_close')(
        'https://api.anthropic.com/v1/messages',
        {
          method: 'POST',
          body: JSON.stringify({
            stream: true,
            model: 'claude-sonnet-4-6',
            _openaiInstructionAssembly: {
              instructions: 'Be precise.',
              inputMessages: [],
            },
          }),
        },
      )

      const body = await response.text()
      expect(body).toContain('http fallback after ws close')
      expect(body).toContain('event: message_stop')
      expect(fetchCalls).toHaveLength(1)
    } finally {
      globalThis.fetch = originalFetch
      _setWebSocketFactoryForTest(null)
      clearWebSocketSession('conv_zero_event_close')
      resetCodexCacheContext()
    }
  })

  test('createCodexFetch surfaces immediate WS usage-limit errors as CodexAccountCapError', async () => {
    resetCodexCacheContext()
    const accessToken = createAccessToken('acct_test_streaming')
    const originalFetch = globalThis.fetch
    const fakeWs = installFakeWs()

    globalThis.fetch = (async () => {
      throw new Error('HTTP fallback should not run for immediate WS cap errors')
    }) as unknown as typeof globalThis.fetch

    fakeWs.responseBatches = [
      [{ type: 'error', error: { message: 'The usage limit has been reached' } }],
    ]

    try {
      await expect(
        createCodexFetch(accessToken, 'conv_usage_limit')('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          body: JSON.stringify({
            stream: true,
            model: 'claude-sonnet-4-6',
            _openaiInstructionAssembly: {
              instructions: 'Be precise.',
              inputMessages: [],
            },
          }),
        }),
      ).rejects.toBeInstanceOf(CodexAccountCapError)
    } finally {
      globalThis.fetch = originalFetch
      _setWebSocketFactoryForTest(null)
      clearWebSocketSession('conv_usage_limit')
      resetCodexCacheContext()
    }
  })

  test('createCodexFetch surfaces immediate WS token_invalidated errors as CodexAccountAuthError', async () => {
    resetCodexCacheContext()
    const accessToken = createAccessToken('acct_test_streaming')
    const originalFetch = globalThis.fetch
    const fakeWs = installFakeWs()

    globalThis.fetch = (async () => {
      throw new Error('HTTP fallback should not run for immediate WS auth errors')
    }) as unknown as typeof globalThis.fetch

    fakeWs.responseBatches = [
      [
        {
          type: 'error',
          error: {
            code: 'token_invalidated',
            message:
              'Your authentication token has been invalidated. Please try signing in again.',
          },
        },
      ],
    ]

    try {
      await expect(
        createCodexFetch(accessToken, 'conv_ws_token_invalidated')(
          'https://api.anthropic.com/v1/messages',
          {
            method: 'POST',
            body: JSON.stringify({
              stream: true,
              model: 'claude-sonnet-4-6',
              _openaiInstructionAssembly: {
                instructions: 'Be precise.',
                inputMessages: [],
              },
            }),
          },
        ),
      ).rejects.toBeInstanceOf(CodexAccountAuthError)
    } finally {
      globalThis.fetch = originalFetch
      _setWebSocketFactoryForTest(null)
      clearWebSocketSession('conv_ws_token_invalidated')
      resetCodexCacheContext()
    }
  })

  test('createCodexFetch surfaces pre-visible WS response.failed usage limits as CodexAccountCapError', async () => {
    resetCodexCacheContext()
    const accessToken = createAccessToken('acct_test_streaming')
    const originalFetch = globalThis.fetch
    const fakeWs = installFakeWs()

    globalThis.fetch = (async () => {
      throw new Error('HTTP fallback should not run for immediate WS response.failed cap errors')
    }) as unknown as typeof globalThis.fetch

    fakeWs.responseBatches = [
      [
        {
          type: 'response.failed',
          response: {
            error: {
              code: 'usage_limit_reached',
              message: 'usage limit reached',
            },
          },
        },
      ],
    ]

    try {
      await expect(
        createCodexFetch(accessToken, 'conv_usage_limit_response_failed')(
          'https://api.anthropic.com/v1/messages',
          {
            method: 'POST',
            body: JSON.stringify({
              stream: true,
              model: 'claude-sonnet-4-6',
              _openaiInstructionAssembly: {
                instructions: 'Be precise.',
                inputMessages: [],
              },
            }),
          },
        ),
      ).rejects.toBeInstanceOf(CodexAccountCapError)
    } finally {
      globalThis.fetch = originalFetch
      _setWebSocketFactoryForTest(null)
      clearWebSocketSession('conv_usage_limit_response_failed')
      resetCodexCacheContext()
    }
  })

  test('createCodexFetch surfaces pre-visible WS response.failed after response.created as CodexAccountCapError', async () => {
    resetCodexCacheContext()
    const accessToken = createAccessToken('acct_test_streaming')
    const originalFetch = globalThis.fetch
    const fakeWs = installFakeWs()

    globalThis.fetch = (async () => {
      throw new Error('HTTP fallback should not run for pre-visible WS response.failed cap errors')
    }) as unknown as typeof globalThis.fetch

    fakeWs.responseBatches = [
      [
        {
          type: 'response.created',
          response: { id: 'resp_previsible_failed' },
        },
        {
          type: 'response.failed',
          response: {
            id: 'resp_previsible_failed',
            error: {
              code: 'usage_limit_reached',
              message: 'usage limit reached',
            },
          },
        },
      ],
    ]

    try {
      await expect(
        createCodexFetch(accessToken, 'conv_usage_limit_precreated')(
          'https://api.anthropic.com/v1/messages',
          {
            method: 'POST',
            body: JSON.stringify({
              stream: true,
              model: 'claude-sonnet-4-6',
              _openaiInstructionAssembly: {
                instructions: 'Be precise.',
                inputMessages: [],
              },
            }),
          },
        ),
      ).rejects.toBeInstanceOf(CodexAccountCapError)
    } finally {
      globalThis.fetch = originalFetch
      _setWebSocketFactoryForTest(null)
      clearWebSocketSession('conv_usage_limit_precreated')
      resetCodexCacheContext()
    }
  })

  test('createCodexFetch surfaces pre-visible non-account WS response.failed without HTTP fallback', async () => {
    resetCodexCacheContext()
    const accessToken = createAccessToken('acct_test_streaming')
    const originalFetch = globalThis.fetch
    const fakeWs = installFakeWs()
    let httpFallbackCalls = 0

    globalThis.fetch = (async () => {
      httpFallbackCalls += 1
      return new Response(
        [
          'event: response.output_text.delta',
          `data: ${JSON.stringify({
            type: 'response.output_text.delta',
            delta: 'http fallback should not run',
          })}`,
          '',
          'event: response.completed',
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                input_tokens_details: { cached_tokens: 0 },
              },
            },
          })}`,
          '',
        ].join('\n'),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )
    }) as unknown as typeof globalThis.fetch

    fakeWs.responseBatches = [
      [
        {
          type: 'response.failed',
          response: {
            error: {
              code: 'invalid_request_error',
              message: 'bad request from websocket',
            },
          },
        },
      ],
    ]

    try {
      await expect(
        createCodexFetch(accessToken, 'conv_non_cap_response_failed_ws')(
          'https://api.anthropic.com/v1/messages',
          {
            method: 'POST',
            body: JSON.stringify({
              stream: true,
              model: 'claude-sonnet-4-6',
              _openaiInstructionAssembly: {
                instructions: 'Be precise.',
                inputMessages: [],
              },
            }),
          },
        ),
      ).rejects.toThrow(/invalid_request_error.*bad request from websocket/)
      expect(httpFallbackCalls).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
      _setWebSocketFactoryForTest(null)
      clearWebSocketSession('conv_non_cap_response_failed_ws')
      resetCodexCacheContext()
    }
  })

  test('createCodexFetch does not classify ambiguous HTTP failures as Codex account cap or auth errors', async () => {
    const cases = [
      {
        status: 500,
        body: 'internal server error',
      },
      {
        status: 403,
        body: 'request forbidden by upstream policy',
      },
      {
        status: 429,
        body: 'rate limit exceeded; retry later',
      },
    ]

    for (const testCase of cases) {
      resetCodexCacheContext()
      seedCodexAccountPoolForTest({
        activeAccountId: 'acct_http_classification',
        accounts: [
          {
            accountId: 'acct_http_classification',
            accessToken: createAccessToken('acct_http_classification'),
            refreshToken: 'refresh-a',
            expiresAt: Date.now() + 60_000,
            source: 'vault',
            status: 'healthy',
            lastUsedAt: 0,
          },
          {
            accountId: 'acct_http_backup',
            accessToken: createAccessToken('acct_http_backup'),
            refreshToken: 'refresh-b',
            expiresAt: Date.now() + 60_000,
            source: 'vault',
            status: 'healthy',
            lastUsedAt: 0,
          },
        ],
      })

      const originalFetch = globalThis.fetch
      globalThis.fetch = (async () =>
        new Response(testCase.body, {
          status: testCase.status,
          headers: { 'Content-Type': 'text/plain' },
        })) as unknown as typeof globalThis.fetch

      try {
        let thrown: unknown
        const response = await createCodexFetch(
          createAccessToken('acct_http_classification'),
          `conv_ambiguous_${testCase.status}`,
        )('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            _openaiInstructionAssembly: {
              instructions: 'Be precise.',
              inputMessages: [],
            },
          }),
        }).catch(error => {
          thrown = error
          return null
        })

        expect(thrown).not.toBeInstanceOf(CodexAccountCapError)
        expect(thrown).not.toBeInstanceOf(CodexAccountAuthError)
        if (response) {
          expect(response.status).toBe(testCase.status)
        }
      } finally {
        globalThis.fetch = originalFetch
        resetCodexCacheContext()
        resetCodexAccountPoolForTest()
      }
    }
  })

  test('createCodexFetch classifies true HTTP cap and revoked-token responses precisely', async () => {
    const cases = [
      {
        status: 429,
        body: JSON.stringify({
          error: {
            code: 'usage_limit_reached',
            message: 'Your Codex usage limit has been reached.',
          },
        }),
        expected: CodexAccountCapError,
      },
      {
        status: 401,
        body: JSON.stringify({
          error: {
            code: 'token_revoked',
            message: 'OAuth token has been revoked.',
          },
        }),
        expected: CodexAccountAuthError,
      },
      {
        // Structured token_invalidated (superseded by a re-login). Its message
        // matches none of the legacy substring heuristics, so only the
        // structured error.code match classifies it as an auth error.
        status: 401,
        body: JSON.stringify({
          error: {
            message:
              'Your authentication token has been invalidated. Please try signing in again.',
            type: 'invalid_request_error',
            code: 'token_invalidated',
          },
        }),
        expected: CodexAccountAuthError,
      },
    ]

    for (const testCase of cases) {
      resetCodexCacheContext()
      seedCodexAccountPoolForTest({
        activeAccountId: 'acct_http_classification',
        accounts: [
          {
            accountId: 'acct_http_classification',
            accessToken: createAccessToken('acct_http_classification'),
            refreshToken: 'refresh-a',
            expiresAt: Date.now() + 60_000,
            source: 'vault',
            status: 'healthy',
            lastUsedAt: 0,
          },
          {
            accountId: 'acct_http_backup',
            accessToken: createAccessToken('acct_http_backup'),
            refreshToken: 'refresh-b',
            expiresAt: Date.now() + 60_000,
            source: 'vault',
            status: 'healthy',
            lastUsedAt: 0,
          },
        ],
      })

      const originalFetch = globalThis.fetch
      globalThis.fetch = (async () =>
        new Response(testCase.body, {
          status: testCase.status,
          headers: { 'Content-Type': 'application/json' },
        })) as unknown as typeof globalThis.fetch

      try {
        await expect(
          createCodexFetch(
            createAccessToken('acct_http_classification'),
            `conv_precise_${testCase.status}`,
            {
              resolveTokensForRequest: async () => ({
                accessToken: createAccessToken('acct_http_classification'),
                refreshToken: 'refresh-a',
                expiresAt: Date.now() + 5 * 60_000,
                accountId: 'acct_http_classification',
                source: 'pool',
              }),
            },
          )('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            body: JSON.stringify({
              model: 'claude-sonnet-4-6',
              _openaiInstructionAssembly: {
                instructions: 'Be precise.',
                inputMessages: [],
              },
            }),
          }),
        ).rejects.toBeInstanceOf(testCase.expected)
      } finally {
        globalThis.fetch = originalFetch
        resetCodexCacheContext()
        resetCodexAccountPoolForTest()
      }
    }
  })

  test('translateCodexWsStreamToAnthropic switches to HTTP fallback when the WS dies before visible output', async () => {
    const response = translateCodexWsStreamToAnthropic(
      (async function* () {
        yield { type: 'response.created', response: { id: 'resp_ws_turn_1' } }
        throw new CodexWebSocketClosedBeforeCompletedError(1000, 'none')
      })(),
      'gpt-5.6-luna',
      {
        accountId: 'acct_test_streaming',
        model: 'gpt-5.6-luna',
        cacheContextKey: 'acct_test_streaming:gpt-5.6-luna',
        conversationId: 'conv_http_fallback',
      },
      async () => ({
        events: (async function* () {
          yield { type: 'response.output_text.delta', delta: 'http fallback 1' }
          yield {
            type: 'response.completed',
            response: {
              usage: {
                input_tokens: 12,
                output_tokens: 3,
                input_tokens_details: { cached_tokens: 0 },
              },
            },
          }
        })(),
        transportContext: undefined,
      }),
    )

    const body = await response.text()
    expect(body).toContain('http fallback 1')
    expect(body).toContain('event: message_stop')
  })

  test('createCodexFetch keeps the conversation on HTTP after the websocket becomes unavailable', async () => {
    resetCodexCacheContext()

    const accessToken = createAccessToken('acct_test_streaming')
    const originalFetch = globalThis.fetch
    const fakeWs = installFakeWs()
    const fetchCalls: Array<{ input: RequestInfo | URL, init?: RequestInit }> = []
    let httpAttempt = 0

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ input, init })
      httpAttempt += 1

      return new Response(
        [
          'event: response.output_text.delta',
          `data: ${JSON.stringify({
            type: 'response.output_text.delta',
            delta: `http fallback ${httpAttempt}`,
          })}`,
          '',
          'event: response.completed',
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              usage: {
                input_tokens: 12,
                output_tokens: 3,
                input_tokens_details: { cached_tokens: 0 },
              },
            },
          })}`,
          '',
        ].join('\n'),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )
    }) as unknown as typeof globalThis.fetch

    fakeWs.responseBatches = [
      [{ type: 'error', error: { message: 'transient websocket failure' } }],
    ]

    try {
      const codexFetch = createCodexFetch(accessToken, 'conv_http_sticky')

      const firstResponse = await codexFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({
          stream: true,
          model: 'claude-sonnet-4-6',
          _openaiInstructionAssembly: {
            instructions: 'Be precise.',
            inputMessages: [],
          },
        }),
      })

      const firstBody = await firstResponse.text()
      expect(firstBody).toContain('http fallback 1')
      expect(firstBody).toContain('event: message_stop')
      expect(fetchCalls).toHaveLength(1)
      // Item 3 rule 1: only the real WS turn is sent (no prewarm), and it errors
      // → one WS send, then HTTP fallback.
      expect(fakeWs.getSentCount()).toBe(1)

      const secondResponse = await codexFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({
          stream: true,
          model: 'claude-sonnet-4-6',
          _openaiInstructionAssembly: {
            instructions: 'Be precise.',
            inputMessages: [],
          },
        }),
      })

      const secondBody = await secondResponse.text()
      expect(secondBody).toContain('http fallback 2')
      expect(fetchCalls).toHaveLength(2)
      // Sticky HTTP fallback is active for the second turn, so no further WS
      // send happens.
      expect(fakeWs.getSentCount()).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
      _setWebSocketFactoryForTest(null)
      clearWebSocketSession('conv_http_sticky')
      resetCodexCacheContext()
    }
  })

  // Item 3 rule 1: a normal streaming WS turn now sends exactly ONE request
  // (the real turn) — the per-request prewarm that produced the second send was
  // removed. This replaces the old six tests whose responseBatches[0] was a
  // dedicated 'resp_prewarm' seed batch.
  test('createCodexFetch sends a single WS request with no prewarm on the happy path', async () => {
    resetCodexCacheContext()
    const accessToken = createAccessToken('acct_test_streaming')
    const originalFetch = globalThis.fetch
    const fakeWs = installFakeWs()

    globalThis.fetch = (async () => {
      throw new Error('HTTP fallback must not run when the WS turn completes')
    }) as unknown as typeof globalThis.fetch

    fakeWs.responseBatches = [[completedWsResponse('resp_real')]]

    try {
      const response = await createCodexFetch(accessToken, 'conv_no_prewarm')(
        'https://api.anthropic.com/v1/messages',
        {
          method: 'POST',
          body: JSON.stringify({
            stream: true,
            model: 'claude-sonnet-4-6',
            _openaiInstructionAssembly: {
              instructions: 'Be precise.',
              inputMessages: [],
            },
          }),
        },
      )
      await response.text()
      // Exactly one WS send: the real turn, not a prewarm + real pair.
      expect(fakeWs.getSentCount()).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
      _setWebSocketFactoryForTest(null)
      clearWebSocketSession('conv_no_prewarm')
      resetCodexCacheContext()
    }
  })

  test('mapConversationIdToTrackingKey maps a bare session UUID to repl_main_thread', () => {
    // Main-thread conversations have no override, so the conversation ID is a
    // bare session UUID with no `/`. It must resolve to the repl_main_thread
    // tracking key that promptCacheBreakDetection stores main-thread state under.
    expect(
      mapConversationIdToTrackingKey('11111111-2222-3333-4444-555555555555'),
    ).toBe('repl_main_thread')
  })

  test('mapConversationIdToTrackingKey maps a subagent sessionId/agentId to the raw agentId', () => {
    // Subagent overrides are `${sessionId}/${agentId}`; the tracking key is the
    // raw agentId (getTrackingKey returns `agentId || querySource`), NOT
    // `agent:${id}` — that was the prior bug that made the subagent path miss.
    expect(
      mapConversationIdToTrackingKey(
        '11111111-2222-3333-4444-555555555555/agent_abc123',
      ),
    ).toBe('agent_abc123')
  })

  test('mapConversationIdToTrackingKey maps the session-title side query to its querySource', () => {
    expect(
      mapConversationIdToTrackingKey('side/title/99999999-0000-1111-2222-333333333333'),
    ).toBe('generate_session_title')
  })
})

describe('codex tool-result truncation (Item 2)', () => {
  const OVER = CODEX_TOOL_OUTPUT_MAX_CHARS + 5_000

  test('truncateCodexToolOutputText leaves under-cap output untouched', () => {
    const small = 'x'.repeat(CODEX_TOOL_OUTPUT_MAX_CHARS)
    expect(truncateCodexToolOutputText(small)).toBe(small)
    expect(truncateCodexToolOutputText('hello')).toBe('hello')
  })

  test('truncateCodexToolOutputText middle-truncates over-cap output within budget', () => {
    const big = 'A'.repeat(OVER)
    const out = truncateCodexToolOutputText(big)
    // Never exceeds the budget.
    expect(out.length).toBeLessThanOrEqual(CODEX_TOOL_OUTPUT_MAX_CHARS)
    // Keeps a head and a tail from the original.
    expect(out.startsWith('A')).toBe(true)
    expect(out.endsWith('A')).toBe(true)
    // Marker names the retrieval mechanism the model must use.
    expect(out).toContain('truncated')
    expect(out).toContain('offset/limit')
    expect(out).toContain('re-run the originating Bash/Grep command')
    // The elided count is reported.
    expect(out).toContain(`${OVER - CODEX_TOOL_OUTPUT_MAX_CHARS} characters`)
  })

  test('truncateCodexToolOutputText preserves distinct head and tail content', () => {
    const head = 'HEAD_MARKER_LINE\n'
    const tail = '\nTAIL_MARKER_LINE'
    const middle = 'm'.repeat(OVER)
    const out = truncateCodexToolOutputText(head + middle + tail)
    expect(out.startsWith('HEAD_MARKER_LINE')).toBe(true)
    expect(out.endsWith('TAIL_MARKER_LINE')).toBe(true)
  })

  test('truncateCodexToolOutputText is a pure function: byte-identical across calls', () => {
    const big = 'Z'.repeat(OVER)
    const a = truncateCodexToolOutputText(big)
    const b = truncateCodexToolOutputText(big)
    expect(a).toBe(b)
  })

  function buildBodyWithToolResult(
    toolName: string,
    resultText: string,
  ): Record<string, unknown> {
    const { codexBody } = translateToCodexBody({
      model: 'gpt-5.6-terra',
      _openaiInstructionAssembly: {
        instructions: 'test instructions',
        inputMessages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call_trunc_1',
                name: toolName,
                input: { file_path: '/tmp/huge.txt' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_trunc_1',
                content: [{ type: 'text', text: resultText }],
              },
            ],
          },
        ],
      },
    })
    return codexBody
  }

  function outputStringFor(codexBody: Record<string, unknown>): string {
    const input = codexBody.input as Array<Record<string, unknown>>
    const fco = input.find(i => i.type === 'function_call_output')
    expect(fco).toBeTruthy()
    const out = (fco as Record<string, unknown>).output
    if (typeof out === 'string') return out
    // array form (input_text parts): flatten text
    return (out as Array<Record<string, string>>)
      .map(p => p.text ?? '')
      .join('')
  }

  test('a >100KB Read tool_result is middle-truncated in the wire request with a retrieval hint', () => {
    const huge = 'L'.repeat(120_000) // ~120KB, well over the 48k cap
    const wire = outputStringFor(buildBodyWithToolResult('Read', huge))
    expect(wire.length).toBeLessThanOrEqual(CODEX_TOOL_OUTPUT_MAX_CHARS)
    expect(wire).toContain('offset/limit')
    expect(wire).toContain('truncated')
  })

  test('the truncated wire form is byte-identical across two translations (prefix stability)', () => {
    const huge = 'Q'.repeat(120_000)
    const a = outputStringFor(buildBodyWithToolResult('Read', huge))
    const b = outputStringFor(buildBodyWithToolResult('Read', huge))
    expect(a).toBe(b)
  })

  test('ToolSearch results are exempt from truncation (schema-bearing)', () => {
    const huge = 'S'.repeat(120_000)
    const wire = outputStringFor(buildBodyWithToolResult('ToolSearch', huge))
    // Untouched: full length, no marker.
    expect(wire.length).toBe(huge.length)
    expect(wire).not.toContain('truncated')
  })

  test('an orphaned tool_result (no matching tool_use in this pass) is exempt — fail safe', () => {
    // The openai path doesn't run ensureToolResultPairing, so a resumed/teleported
    // transcript can carry a tool_result whose tool_use isn't in the message set.
    // toolName is then undefined; we must NOT truncate (it could be an orphaned
    // schema-bearing ToolSearch payload — dropping its middle breaks tool loading).
    const huge = 'O'.repeat(120_000)
    const { codexBody } = translateToCodexBody({
      model: 'gpt-5.6-terra',
      _openaiInstructionAssembly: {
        instructions: 'test instructions',
        inputMessages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_orphan_1',
                content: [{ type: 'text', text: huge }],
              },
            ],
          },
        ],
      },
    })
    const wire = outputStringFor(codexBody)
    expect(wire.length).toBe(huge.length)
    expect(wire).not.toContain('truncated')
  })

  test('image tool_result blocks are never truncated (multimodal array preserved)', () => {
    const { codexBody } = translateToCodexBody({
      model: 'gpt-5.6-terra',
      _openaiInstructionAssembly: {
        instructions: 'test instructions',
        inputMessages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call_img_1',
                name: 'vision_tool',
                input: {},
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_img_1',
                content: [
                  {
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: 'image/png',
                      data: 'ZmFrZQ==',
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    })
    const input = codexBody.input as Array<Record<string, unknown>>
    const fco = input.find(i => i.type === 'function_call_output') as Record<
      string,
      unknown
    >
    // Output stays an array (image preserved), never coerced/truncated to string.
    expect(Array.isArray(fco.output)).toBe(true)
    expect((fco.output as Array<Record<string, string>>)[0].type).toBe(
      'input_image',
    )
  })

  test('an under-cap tool_result passes through unchanged in the wire request', () => {
    const small = 'ok result'
    const wire = outputStringFor(buildBodyWithToolResult('Read', small))
    expect(wire).toBe(small)
  })
})
