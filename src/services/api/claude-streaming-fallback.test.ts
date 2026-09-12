import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { getEmptyToolPermissionContext } from '../../Tool.js'
import { createUserMessage } from '../../utils/messages.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { queryModelWithStreaming } from './claude.js'
import { translateCodexWsStreamToAnthropic } from './codex-fetch-adapter.js'
import {
  CodexPartialStreamReplaySkippedError,
  parseCodexPartialStreamFailure,
  type CodexPartialStreamFailureV1,
} from './errorUtils.js'

const encoder = new TextEncoder()

function sseEvent(event: Record<string, unknown>): Uint8Array {
  return encoder.encode(
    `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`,
  )
}

describe('Codex partial-stream recovery', () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY
  const originalFixturesRoot = process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT
  const macroState = globalThis as typeof globalThis & {
    MACRO?: { VERSION: string }
  }
  const originalMacro = macroState.MACRO
  let fixturesRoot: string | undefined

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY
    } else {
      process.env.ANTHROPIC_API_KEY = originalApiKey
    }
    if (originalFixturesRoot === undefined) {
      delete process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT
    } else {
      process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = originalFixturesRoot
    }
    if (fixturesRoot) {
      rmSync(fixturesRoot, { recursive: true, force: true })
      fixturesRoot = undefined
    }
    macroState.MACRO = originalMacro
  })

  test('does not dispatch the outer non-streaming fallback after visible output', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-api-key'
    fixturesRoot = mkdtempSync(join(tmpdir(), 'cat-code-vcr-'))
    process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = fixturesRoot
    macroState.MACRO = { VERSION: 'test-version' }
    let dispatchCount = 0
    let streamChunkIndex = 0

    const visibleEvents: Record<string, unknown>[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 1,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'visible text' },
      },
    ]

    const fetchOverride: typeof fetch = async (_input, init) => {
      dispatchCount++
      const body = JSON.parse(String(init?.body)) as { stream?: boolean }

      if (body.stream !== true) {
        return new Response(
          JSON.stringify({
            id: 'msg_fallback',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            content: [{ type: 'text', text: 'unexpected replay' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'request-id': 'req_fallback',
            },
          },
        )
      }

      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (streamChunkIndex < visibleEvents.length) {
              controller.enqueue(
                sseEvent(visibleEvents[streamChunkIndex++]!),
              )
              return
            }

            const error = new Error(
              'Stream interrupted after visible output started; the turn was not replayed to avoid duplicate output or tool calls.',
            )
            error.name = 'CodexPartialStreamReplaySkippedError'
            controller.error(error)
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'request-id': 'req_stream',
          },
        },
      )
    }

    const consume = async () => {
      const events: unknown[] = []
      for await (const event of queryModelWithStreaming({
        messages: [createUserMessage({ content: 'hello' })],
        systemPrompt: asSystemPrompt(['You are a test assistant.']),
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal: new AbortController().signal,
        options: {
          getToolPermissionContext: async () =>
            getEmptyToolPermissionContext(),
          model: 'claude-sonnet-4-6',
          provider: 'firstParty',
          isNonInteractiveSession: true,
          querySource: 'compact',
          agents: [],
          hasAppendSystemPrompt: false,
          fetchOverride,
          mcpTools: [],
        },
      })) {
        events.push(event)
      }
      return events
    }

    const events = await consume()
    const serializedEvents = JSON.stringify(events)
    expect(dispatchCount).toBe(1)
    expect(serializedEvents).not.toContain('unexpected replay')
    // A name-only marker still refuses the replay, and the user gets copy
    // written for a person instead of the raw transport message.
    expect(serializedEvents).toContain(
      'Connection interrupted after partial output',
    )
    expect(serializedEvents).not.toContain(
      'Stream interrupted after visible output started',
    )
    expect(serializedEvents).not.toContain('HTTP fallback on the next turn')

    // ...but it carries no continuation authority: the structured payload is
    // absent, so the query loop cannot read it as eligible.
    const errorMessage = events.find(
      event =>
        typeof event === 'object' &&
        event !== null &&
        (event as { isApiErrorMessage?: boolean }).isApiErrorMessage === true,
    ) as { apiError?: unknown } | undefined
    expect(errorMessage).toBeDefined()
    expect(parseCodexPartialStreamFailure(errorMessage!.apiError)).toBeNull()
  })

  test('the non-streaming fallback goes through the caller fetch, not around it', async () => {
    // `executeNonStreamingRequest` takes a `fetchOverride` and forwards it, but
    // neither fallback call site used to supply one, so a caller's fetch was
    // honored for the streaming request and silently bypassed for the retry.
    // The test above depends on this: its non-streaming branch is what proves
    // no replay happened, and that branch was unreachable.
    process.env.ANTHROPIC_API_KEY = 'test-api-key'
    fixturesRoot = mkdtempSync(join(tmpdir(), 'cat-code-vcr-'))
    process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = fixturesRoot
    macroState.MACRO = { VERSION: 'test-version' }
    const dispatchedStreamFlags: boolean[] = []

    const fetchOverride: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { stream?: boolean }
      dispatchedStreamFlags.push(body.stream === true)
      if (body.stream === true) {
        // Fail BEFORE any visible output, which is the one shape that is still
        // free to fall back.
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error('connection reset before any output'))
            },
          }),
          {
            status: 200,
            headers: {
              'content-type': 'text/event-stream',
              'request-id': 'req_stream',
            },
          },
        )
      }
      return new Response(
        JSON.stringify({
          id: 'msg_fallback',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'answered by the fallback' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'request-id': 'req_fallback',
          },
        },
      )
    }

    const events: unknown[] = []
    for await (const event of queryModelWithStreaming({
      messages: [createUserMessage({ content: 'hello' })],
      systemPrompt: asSystemPrompt(['You are a test assistant.']),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: new AbortController().signal,
      options: {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        model: 'claude-sonnet-4-6',
        provider: 'firstParty',
        isNonInteractiveSession: true,
        querySource: 'compact',
        agents: [],
        hasAppendSystemPrompt: false,
        fetchOverride,
        mcpTools: [],
      },
    })) {
      events.push(event)
    }

    // The retry reached the caller's fetch rather than the real endpoint.
    expect(dispatchedStreamFlags).toEqual([true, false])
    expect(JSON.stringify(events)).toContain('answered by the fallback')
  })

  test.each(['response.failed', 'response.incomplete'])(
    '%s after an encrypted reasoning carrier does not dispatch a fallback',
    async terminalType => {
      process.env.ANTHROPIC_API_KEY = 'test-api-key'
      fixturesRoot = mkdtempSync(join(tmpdir(), 'cat-code-vcr-'))
      process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = fixturesRoot
      macroState.MACRO = { VERSION: 'test-version' }
      const dispatchedStreamFlags: boolean[] = []

      const fetchOverride: typeof fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { stream?: boolean }
        dispatchedStreamFlags.push(body.stream === true)
        if (body.stream === true) {
          return translateCodexWsStreamToAnthropic(
            (async function* () {
              yield {
                type: 'response.output_item.done',
                output_index: 0,
                item: {
                  type: 'reasoning',
                  encrypted_content: 'synthetic-reasoning',
                  summary: [],
                },
              }
              yield {
                type: terminalType,
                response: {
                  incomplete_details: { reason: 'max_output_tokens' },
                  error: {
                    code: 'invalid_request_error',
                    message: 'Synthetic terminal provider failure',
                  },
                },
              }
            })(),
            'gpt-5.6-luna',
          )
        }

        return new Response(JSON.stringify({
          id: 'msg_unexpected_fallback',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'unexpected replay' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }), {
          headers: { 'content-type': 'application/json' },
        })
      }

      const events: unknown[] = []
      for await (const event of queryModelWithStreaming({
        messages: [createUserMessage({ content: 'hello' })],
        systemPrompt: asSystemPrompt(['You are a test assistant.']),
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal: new AbortController().signal,
        options: {
          getToolPermissionContext: async () => getEmptyToolPermissionContext(),
          model: 'claude-sonnet-4-6',
          provider: 'firstParty',
          isNonInteractiveSession: true,
          querySource: 'compact',
          agents: [],
          hasAppendSystemPrompt: false,
          fetchOverride,
          mcpTools: [],
        },
      })) {
        events.push(event)
      }

      expect(dispatchedStreamFlags).toEqual([true])
      expect(JSON.stringify(events)).not.toContain('unexpected replay')
      expect(events.some(event => (
        event !== null &&
        typeof event === 'object' &&
        'isApiErrorMessage' in event &&
        event.isApiErrorMessage === true
      ))).toBe(true)
    },
  )

  test('a typed interruption keeps its structured marker and its sealed text', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-api-key'
    fixturesRoot = mkdtempSync(join(tmpdir(), 'cat-code-vcr-'))
    process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = fixturesRoot
    macroState.MACRO = { VERSION: 'test-version' }
    let dispatchCount = 0
    let streamChunkIndex = 0

    // What the adapter writes on the sealing path: a text block opened, fed,
    // and CLOSED before the failure surfaces.
    const sealedEvents: Record<string, unknown>[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 1,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'the half-written answer' },
      },
      { type: 'content_block_stop', index: 0 },
    ]

    const failure: CodexPartialStreamFailureV1 = {
      version: 1,
      code: 'partial_stream_replay_skipped',
      provider: 'openai',
      transport: 'websocket',
      cause: 'closed',
      sealedPartialText: true,
      hadClientToolCall: false,
      openClientToolCalls: 0,
      hadHostedWebSearch: false,
      automaticContinuationEligible: true,
    }

    const fetchOverride: typeof fetch = async (_input, init) => {
      dispatchCount++
      const body = JSON.parse(String(init?.body)) as { stream?: boolean }
      if (body.stream !== true) {
        throw new Error('the non-streaming fallback must not be dispatched')
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (streamChunkIndex < sealedEvents.length) {
              controller.enqueue(sseEvent(sealedEvents[streamChunkIndex++]!))
              return
            }
            controller.error(
              new CodexPartialStreamReplaySkippedError(
                'Stream interrupted after visible output started.',
                failure,
              ),
            )
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'request-id': 'req_stream',
          },
        },
      )
    }

    const events: unknown[] = []
    for await (const event of queryModelWithStreaming({
      messages: [createUserMessage({ content: 'hello' })],
      systemPrompt: asSystemPrompt(['You are a test assistant.']),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: new AbortController().signal,
      options: {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        model: 'claude-sonnet-4-6',
        provider: 'firstParty',
        isNonInteractiveSession: true,
        querySource: 'compact',
        agents: [],
        hasAppendSystemPrompt: false,
        fetchOverride,
        mcpTools: [],
      },
    })) {
      events.push(event)
    }

    expect(dispatchCount).toBe(1)

    // The sealed block became a real assistant message. Without it there is
    // nothing for a continuation to continue from.
    const assistantTexts = events.flatMap(event =>
      typeof event === 'object' &&
      event !== null &&
      (event as { type?: string }).type === 'assistant' &&
      (event as { isApiErrorMessage?: boolean }).isApiErrorMessage !== true
        ? ((event as { message: { content: { type: string; text?: string }[] } })
            .message.content.filter(block => block.type === 'text')
            .map(block => block.text ?? ''))
        : [],
    )
    expect(assistantTexts).toContain('the half-written answer')

    // The structured marker survived the SDK's wrapping and reached apiError.
    const errorMessage = events.find(
      event =>
        typeof event === 'object' &&
        event !== null &&
        (event as { isApiErrorMessage?: boolean }).isApiErrorMessage === true,
    ) as { apiError?: unknown } | undefined
    expect(errorMessage).toBeDefined()
    const parsed = parseCodexPartialStreamFailure(errorMessage!.apiError)
    expect(parsed).not.toBeNull()
    expect(parsed!.automaticContinuationEligible).toBe(true)
    expect(parsed!.sealedPartialText).toBe(true)
  })
})
