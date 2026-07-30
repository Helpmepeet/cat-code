import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { getEmptyToolPermissionContext } from '../../Tool.js'
import { createUserMessage } from '../../utils/messages.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { queryModelWithStreaming } from './claude.js'

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
    expect(serializedEvents).toContain(
      'Stream interrupted after visible output started',
    )
    expect(serializedEvents).not.toContain('unexpected replay')
  })
})
