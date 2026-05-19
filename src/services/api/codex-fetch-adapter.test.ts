import { describe, expect, test } from 'bun:test'
import {
  _setWebSocketFactoryForTest,
  CodexWebSocketClosedBeforeCompletedError,
  clearWebSocketSession,
} from './codex-websocket-transport.js'

import {
  _hasStickyHttpFallbackForTest,
  _markStickyHttpFallbackForTest,
  _setStickyFallbackNowForTest,
  CodexAccountCapError,
  createCodexFetch,
  resetCodexCacheContext,
  translateCodexStreamToAnthropic,
  translateCodexWsStreamToAnthropic,
  translateToCodexBody,
} from './codex-fetch-adapter.js'

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

    expect(codexBody.reasoning).toEqual({ effort: 'minimal' })
    expect(codexBody.include).toEqual([
      'reasoning.encrypted_content',
      'web_search_call.action.sources',
    ])
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
      'gpt-5.4',
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
      'gpt-5.4',
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
      await translateCodexStreamToAnthropic(searchOnly, 'gpt-5.4')
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
      await translateCodexStreamToAnthropic(mixed, 'gpt-5.4')
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
      const response = await createCodexFetch(accessToken, 'conv_http_direct')(
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
      expect(fetchCalls).toHaveLength(1)
      expect(fetchCalls[0]?.input).toBe('https://chatgpt.com/backend-api/codex/responses')
      expect(fetchCalls[0]?.init?.headers).toMatchObject({
        Authorization: `Bearer ${accessToken}`,
        'chatgpt-account-id': 'acct_test_streaming',
      })
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
      'gpt-5.4',
      {
        accountId: 'acct_test_streaming',
        model: 'gpt-5.4',
        cacheContextKey: 'acct_test_streaming:gpt-5.4',
        conversationId: 'conv_test_streaming',
      },
    )

    await expect(response.text()).rejects.toThrow('WebSocket closed before response.completed')
  })

  test('translateCodexWsStreamToAnthropic refuses replay after visible output has started', async () => {
    const response = translateCodexWsStreamToAnthropic(
      (async function* () {
        yield { type: 'response.output_text.delta', delta: 'hello' }
        throw new CodexWebSocketClosedBeforeCompletedError(1000, 'none')
      })(),
      'gpt-5.4',
      {
        accountId: 'acct_test_streaming',
        model: 'gpt-5.4',
        cacheContextKey: 'acct_test_streaming:gpt-5.4',
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

    fakeWs.responseBatches = [
      [completedWsResponse('resp_prewarm')],
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
      [completedWsResponse('resp_prewarm')],
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

  test('translateCodexWsStreamToAnthropic switches to HTTP fallback when the WS dies before visible output', async () => {
    const response = translateCodexWsStreamToAnthropic(
      (async function* () {
        yield { type: 'response.created', response: { id: 'resp_ws_turn_1' } }
        throw new CodexWebSocketClosedBeforeCompletedError(1000, 'none')
      })(),
      'gpt-5.4',
      {
        accountId: 'acct_test_streaming',
        model: 'gpt-5.4',
        cacheContextKey: 'acct_test_streaming:gpt-5.4',
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
      [completedWsResponse('resp_prewarm')],
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
      expect(fakeWs.getSentCount()).toBe(2)

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
      expect(fakeWs.getSentCount()).toBe(2)
    } finally {
      globalThis.fetch = originalFetch
      _setWebSocketFactoryForTest(null)
      clearWebSocketSession('conv_http_sticky')
      resetCodexCacheContext()
    }
  })
})
