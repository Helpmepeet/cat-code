import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { APIUserAbortError } from '@anthropic-ai/sdk/error'

import { getEmptyToolPermissionContext } from '../../Tool.js'
import { createUserMessage } from '../../utils/messages.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { queryModelWithStreaming } from './claude.js'
import {
  CodexPartialStreamReplaySkippedError,
  parseCodexPartialStreamFailure,
} from './errorUtils.js'

/**
 * Three idle timers read the same `CLAUDE_STREAM_IDLE_TIMEOUT_MS`: the Codex
 * websocket transport, the Codex HTTP reader, and the opt-in outer watchdog in
 * `claude.ts`. On one stalled turn they can all come due at once, and the
 * question these tests answer is what the engine decides when they do. Every
 * timer here is pinned to tens of milliseconds through the real env var, so
 * nothing waits on a 90-second default.
 */

const encoder = new TextEncoder()

// Small enough that only the watchdog can abort inside a test's lifetime: the
// SDK's own request timeout is 10 minutes (BaseAnthropic.DEFAULT_TIMEOUT), so
// an abort observed within seconds has exactly one possible author.
const WATCHDOG_TIMEOUT_MS = '60'

function sseEvent(event: Record<string, unknown>): Uint8Array {
  return encoder.encode(
    `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`,
  )
}

/** message_start plus an opened, fed, never-closed text block. */
const VISIBLE_EVENTS: Record<string, unknown>[] = [
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

/**
 * A fetch stand-in that reacts to its signal the way a real fetch does: the
 * response body errors when the request is aborted. The watchdog cancels a
 * stream by aborting the SDK's request controller and nothing else, so a fake
 * that ignores `init.signal` leaves the reader parked forever and cannot
 * exercise this path at all.
 */
function makeFetchOverride(opts: {
  onDispatch: (streaming: boolean) => void
  onStreamOpened?: () => void
  /**
   * Error the body carries when the abort lands. Defaults to an AbortError,
   * which is what a real fetch delivers.
   */
  abortError?: () => Error
  /**
   * What the body does once the visible events are out. Defaults to stalling
   * forever, which is the state the idle timers exist to catch.
   */
  onStall?: (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ) => void | Promise<void>
  /**
   * Leave the body deaf to the request signal, so a test can choose exactly
   * which error the stream loop receives instead of racing the AbortError a
   * real fetch would deliver first.
   */
  ignoreSignal?: boolean
}): typeof fetch {
  return async (_input, init) => {
    const streaming =
      (JSON.parse(String(init?.body)) as { stream?: boolean }).stream === true
    opts.onDispatch(streaming)
    if (!streaming) {
      return new Response(
        JSON.stringify({
          id: 'msg_replay',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'NON_STREAMING_REPLAY' }],
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
            'request-id': 'req_replay',
          },
        },
      )
    }

    let index = 0
    const signal = init?.signal ?? undefined
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          if (opts.ignoreSignal) {
            return
          }
          signal?.addEventListener(
            'abort',
            () => {
              const aborted = new Error('The operation was aborted.')
              aborted.name = 'AbortError'
              try {
                controller.error(opts.abortError?.() ?? aborted)
              } catch {
                // The stream may already be errored or closed.
              }
            },
            { once: true },
          )
        },
        async pull(controller) {
          if (index < VISIBLE_EVENTS.length) {
            controller.enqueue(sseEvent(VISIBLE_EVENTS[index++]!))
            if (index === VISIBLE_EVENTS.length) {
              opts.onStreamOpened?.()
            }
            return
          }
          await (opts.onStall?.(controller) ?? new Promise(() => {}))
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
}

type YieldedEvent = {
  type?: string
  isApiErrorMessage?: boolean
  apiError?: unknown
  message?: { content?: { type: string; text?: string }[] }
}

async function collect(
  fetchOverride: typeof fetch,
  signal: AbortSignal,
): Promise<YieldedEvent[]> {
  const events: YieldedEvent[] = []
  for await (const event of queryModelWithStreaming({
    messages: [createUserMessage({ content: 'hello' })],
    systemPrompt: asSystemPrompt(['You are a test assistant.']),
    thinkingConfig: { type: 'disabled' },
    tools: [],
    signal,
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
    events.push(event as YieldedEvent)
  }
  return events
}

function apiErrorMessages(events: YieldedEvent[]): YieldedEvent[] {
  return events.filter(event => event.isApiErrorMessage === true)
}

function textOf(event: YieldedEvent): string {
  return (event.message?.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('')
}

describe('stream idle timeouts', () => {
  const originalEnv: Record<string, string | undefined> = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    CLAUDE_CODE_TEST_FIXTURES_ROOT: process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT,
    CLAUDE_ENABLE_STREAM_WATCHDOG: process.env.CLAUDE_ENABLE_STREAM_WATCHDOG,
    CLAUDE_STREAM_IDLE_TIMEOUT_MS: process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS,
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK:
      process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK,
  }
  const macroState = globalThis as typeof globalThis & {
    MACRO?: { VERSION: string }
  }
  const originalMacro = macroState.MACRO
  let fixturesRoot: string | undefined

  function setup(): void {
    process.env.ANTHROPIC_API_KEY = 'test-api-key'
    fixturesRoot = mkdtempSync(join(tmpdir(), 'cat-code-vcr-'))
    process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = fixturesRoot
    macroState.MACRO = { VERSION: 'test-version' }
    delete process.env.CLAUDE_ENABLE_STREAM_WATCHDOG
    delete process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS
    delete process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    if (fixturesRoot) {
      rmSync(fixturesRoot, { recursive: true, force: true })
      fixturesRoot = undefined
    }
    macroState.MACRO = originalMacro
  })

  test('a watchdog timeout is surfaced as a failure, not as a user cancel', async () => {
    setup()
    process.env.CLAUDE_ENABLE_STREAM_WATCHDOG = '1'
    process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = WATCHDOG_TIMEOUT_MS
    // Only so the decision is observable without a network round trip: the
    // classification under test happens before this flag is read.
    process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK = '1'

    const dispatches: boolean[] = []
    const userController = new AbortController()
    const events = await collect(
      makeFetchOverride({ onDispatch: streaming => dispatches.push(streaming) }),
      userController.signal,
    )

    // Nobody pressed ESC. The only abort in this turn came from the watchdog.
    expect(userController.signal.aborted).toBe(false)
    expect(dispatches).toEqual([true])

    // The user-cancel branch returns without yielding anything (claude.ts
    // suppresses the error message for APIUserAbortError so query.ts can print
    // the interruption instead). A watchdog timeout must not take that exit, or
    // a dead connection would look to the user like a turn they cancelled.
    const errors = apiErrorMessages(events)
    expect(errors.length).toBe(1)
    // Output had already escaped, so the watchdog's own exit refuses the
    // replay rather than handing the turn to the non-streaming fallback: the
    // abort destroys whatever the adapter was about to raise, its marker
    // included. `dispatches` above is the proof no second request went out.
    expect(textOf(errors[0]!)).toContain('Connection interrupted after partial output')
    expect(events.some(event => event.type === 'stream_event')).toBe(true)
  }, 10_000)

  test('an SDK abort with the signal untouched is read as a timeout', async () => {
    setup()
    // The branch itself, driven directly. Today the SDK swallows a controller
    // abort (`Stream.fromSSEResponse` returns on `isAbortError`) so the
    // watchdog never reaches here, but the moment an abort does surface as an
    // APIUserAbortError the only thing separating a dead transport from a
    // person pressing ESC is `signal.aborted`.
    const dispatches: boolean[] = []
    const userController = new AbortController()
    const events = await collect(
      makeFetchOverride({
        onDispatch: streaming => dispatches.push(streaming),
        ignoreSignal: true,
        onStall: controller => controller.error(new APIUserAbortError()),
      }),
      userController.signal,
    )

    expect(userController.signal.aborted).toBe(false)
    expect(dispatches).toEqual([true])
    const errors = apiErrorMessages(events)
    expect(errors.length).toBe(1)
    expect(textOf(errors[0]!)).toContain('Request timed out')
  }, 10_000)

  test('an SDK abort with the signal aborted stays a silent user cancel', async () => {
    setup()
    const dispatches: boolean[] = []
    const userController = new AbortController()
    const events = await collect(
      makeFetchOverride({
        onDispatch: streaming => dispatches.push(streaming),
        ignoreSignal: true,
        onStall: controller => {
          // The body ignores the signal here, so the error below is the one the
          // loop sees: the same throw as the previous test, with the one bit
          // that distinguishes intent flipped.
          userController.abort()
          controller.error(new APIUserAbortError())
        },
      }),
      userController.signal,
    )

    expect(userController.signal.aborted).toBe(true)
    expect(dispatches).toEqual([true])
    expect(apiErrorMessages(events)).toEqual([])
  }, 10_000)

  test('a real user cancel stays a cancel and is never surfaced as a timeout', async () => {
    setup()
    // The watchdog is off, as it is by default in production.
    const dispatches: boolean[] = []
    const userController = new AbortController()
    const events = await collect(
      makeFetchOverride({
        onDispatch: streaming => dispatches.push(streaming),
        onStreamOpened: () => setTimeout(() => userController.abort(), 40),
      }),
      userController.signal,
    )

    expect(userController.signal.aborted).toBe(true)
    // One streaming request and no second one. (The non-streaming fallback
    // builds its own client without this override, so this rules out a second
    // streaming attempt, not a replay.)
    expect(dispatches).toEqual([true])
    // Silence is the whole signature of the user-cancel branch. A timeout
    // classification would put an API error bubble on a turn the user ended.
    expect(apiErrorMessages(events)).toEqual([])
    expect(
      events.filter(event => event.type === 'stream_event').length,
    ).toBeGreaterThan(0)
  }, 10_000)

  test('a watchdog and a transport timeout landing together make one decision', async () => {
    setup()
    process.env.CLAUDE_ENABLE_STREAM_WATCHDOG = '1'
    process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = WATCHDOG_TIMEOUT_MS

    // The transport's own idle failure is delivered by the same abort the
    // watchdog raises, so the two timers come due at one instant by
    // construction rather than by a sleep that has to be guessed right.
    const dispatches: boolean[] = []
    const events = await collect(
      makeFetchOverride({
        onDispatch: streaming => dispatches.push(streaming),
        abortError: () =>
          new CodexPartialStreamReplaySkippedError(
            'Stream interrupted after visible output started.',
            {
              version: 1,
              code: 'partial_stream_replay_skipped',
              provider: 'openai',
              transport: 'websocket',
              cause: 'idle_timeout',
              sealedPartialText: false,
              hadClientToolCall: false,
              openClientToolCalls: 0,
              hadHostedWebSearch: false,
              automaticContinuationEligible: true,
            },
          ),
      }),
      new AbortController().signal,
    )

    // One decision, not two: a single error reaches the caller.
    const errors = apiErrorMessages(events)
    expect(errors.length).toBe(1)

    // And it is the fail-closed one. The watchdog's own verdict ("Stream idle
    // timeout") authorizes the non-streaming replay; the transport's verdict
    // refuses it because visible output already escaped. When they collide the
    // refusal has to win, or the turn is re-sent and its output or its tool
    // call happens twice.
    expect(textOf(errors[0]!)).toContain(
      'Connection interrupted after partial output',
    )
    expect(dispatches).toEqual([true])
    expect(
      events.some(event => textOf(event).includes('NON_STREAMING_REPLAY')),
    ).toBe(false)

    // The structured payload survives intact, so the query loop still reads a
    // single, unambiguous continuation verdict rather than two.
    const failure = parseCodexPartialStreamFailure(errors[0]!.apiError)
    expect(failure).not.toBeNull()
    expect(failure!.cause).toBe('idle_timeout')
    expect(failure!.automaticContinuationEligible).toBe(true)
  }, 10_000)
})
