import { feature } from 'bun:bundle'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { APIConnectionTimeoutError } from '@anthropic-ai/sdk'
import {
  getSessionId,
  getSessionProjectDir,
  switchSession,
} from '../../bootstrap/state.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { createUserMessage } from '../../utils/messages.js'
// Spread into every claude.js module mock below. mock.module replaces the whole
// module for the rest of the process — mock.restore() does not put it back — so
// a mock that redefined getMaxOutputTokensForModel would follow this file into
// autoCompact.test.ts and shift its threshold arithmetic.
import * as realClaudeApi from '../api/claude.js'

/**
 * Rounds are what reactive compaction preserves, so the fixtures are built as
 * real API rounds: a new `message.id` opens a round, and the tool results and
 * user prompts that follow belong to it (grouping.ts).
 */
function assistant(id: string, text: string): AssistantMessage {
  return {
    type: 'assistant',
    uuid: `assistant-${id}`,
    timestamp: '2026-08-12T00:00:00.000Z',
    message: {
      id,
      model: 'gpt-5.6-terra',
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage: {
        input_tokens: 10,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      stop_reason: 'end_turn',
      stop_sequence: null,
    },
  } as AssistantMessage
}

function typedSummaryError(text: string): AssistantMessage {
  const message = assistant('summary-error', text)
  message.isApiErrorMessage = true
  return message
}

function assistantWithToolUse(id: string, toolUseId: string): AssistantMessage {
  const message = assistant(id, `calling a tool in ${id}`)
  message.message.content = [
    { type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'ls' } },
  ]
  return message
}

function toolResult(toolUseId: string, text: string): Message {
  return createUserMessage({
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }],
    toolUseResult: text,
  })
}

function promptTooLongResponse(errorDetails?: string): AssistantMessage {
  return {
    type: 'assistant',
    uuid: 'compact-summary-ptl',
    timestamp: '2026-08-12T00:00:00.000Z',
    isApiErrorMessage: true,
    errorDetails,
    message: {
      id: 'compact-summary-ptl',
      model: 'gpt-5.6-terra',
      role: 'assistant',
      content: [{ type: 'text', text: 'Prompt is too long' }],
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      stop_reason: 'end_turn',
      stop_sequence: null,
    },
  } as AssistantMessage
}

function createToolUseContext(messages: Message[]): ToolUseContext {
  const appState = {
    toolPermissionContext: {
      mode: 'default',
      additionalWorkingDirectories: new Map<string, string>(),
    },
    mcp: { tools: [], clients: [] },
    tasks: {},
    sessionHooks: new Map(),
    fastMode: false,
    effortValue: undefined,
    advisorModel: undefined,
  }

  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'gpt-5.6-terra',
      mainLoopProvider: 'openai',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allowedAgentTypes: [] },
    },
    abortController: new AbortController(),
    readFileState: new Map(),
    loadedNestedMemoryPaths: new Set(),
    getAppState: () => appState,
    setAppState: updater => {
      Object.assign(appState, updater(appState))
    },
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    setStreamMode: () => {},
    setSDKStatus: () => {},
    onCompactProgress: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages,
  } as unknown as ToolUseContext
}

function cacheSafeParamsFor(
  context: ToolUseContext,
  messages: Message[],
): CacheSafeParams {
  return {
    systemPrompt: ['system prompt'],
    userContext: {},
    systemContext: {},
    toolUseContext: context,
    forkContextMessages: messages,
  }
}

describe('reactiveCompactOnPromptTooLong', () => {
  const originalSessionId = getSessionId()
  const originalProjectDir = getSessionProjectDir()
  let tempDir: string
  let summarizerRequests: string[]

  /** Queue one response per summary attempt, oldest first. */
  function mockSummarizer(responses: AssistantMessage[]) {
    let attempt = 0
    return mock.module('../api/claude.js', () => ({
      ...realClaudeApi,
      queryModelWithStreaming: mock(async function* (params: unknown) {
        summarizerRequests.push(JSON.stringify(params))
        yield responses[Math.min(attempt++, responses.length - 1)]!
      }),
    }))
  }

  function mockSummarizerFailure(error: Error) {
    return mock.module('../api/claude.js', () => ({
      ...realClaudeApi,
      queryModelWithStreaming: mock(async function* () {
        summarizerRequests.push('attempt')
        throw error
      }),
    }))
  }

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'reactive-compact-'))
    switchSession('reactive-compact-session', tempDir)
    summarizerRequests = []

    // false keeps streamCompactSummary on the streaming path, which is the one
    // a mocked claude.js can drive; the forked path would spawn a real query.
    await mock.module('../analytics/growthbook.js', () => ({
      getFeatureValue_CACHED_MAY_BE_STALE: mock(
        (key: string, defaultValue: boolean) =>
          key === 'tengu_compact_cache_prefix' ? false : defaultValue,
      ),
    }))
  })

  afterEach(() => {
    mock.restore()
    switchSession(originalSessionId, originalProjectDir)
    rmSync(tempDir, { recursive: true, force: true })
  })

  /**
   * Four rounds. The last one is the live trajectory: a tool call, its result,
   * and the user's newest instruction, which is what a 413 interrupts.
   */
  function fourRoundConversation() {
    const first = createUserMessage({ content: 'OLDEST_USER_PROMPT' })
    const firstAnswer = assistant('round-1', 'OLDEST_ASSISTANT_ANSWER')
    const second = createUserMessage({ content: 'MIDDLE_USER_PROMPT' })
    const secondAnswer = assistant('round-2', 'MIDDLE_ASSISTANT_ANSWER')
    const third = createUserMessage({ content: 'THIRD_USER_PROMPT' })
    const thirdAnswer = assistantWithToolUse('round-3', 'tool-3')
    const thirdResult = toolResult('tool-3', 'THIRD_TOOL_RESULT')
    const newestAnswer = assistant('round-4', 'NEWEST_ASSISTANT_ANSWER')
    const newest = createUserMessage({ content: 'NEWEST_USER_PROMPT' })
    return {
      newestAnswer,
      newest,
      thirdAnswer,
      thirdResult,
      messages: [
        first,
        firstAnswer,
        second,
        secondAnswer,
        third,
        thirdAnswer,
        thirdResult,
        newestAnswer,
        newest,
      ],
    }
  }

  test('preserves the newest round verbatim and summarizes the older prefix', async () => {
    await mockSummarizer([
      assistant('summary', '<summary>Older rounds, summarized.</summary>'),
    ])
    const { reactiveCompactOnPromptTooLong } = await import(
      './reactiveCompact.js'
    )

    const { messages, newestAnswer, newest } = fourRoundConversation()
    const context = createToolUseContext(messages)
    const outcome = await reactiveCompactOnPromptTooLong(
      messages,
      cacheSafeParamsFor(context, messages),
      { trigger: 'auto' },
    )

    expect(outcome.ok).toBe(true)
    const result = outcome.result!
    // The whole trailing round survives byte for byte, newest user intent last.
    expect(result.messagesToKeep).toEqual([newestAnswer, newest])
    expect(result.summaryMessages[0]?.message.content).toContain(
      'Older rounds, summarized.',
    )
    expect(result.summaryMessages[0]?.message.content).toContain(
      'Recent messages are preserved verbatim',
    )

    // The summarizer saw the prefix and NOT the preserved round: sending the
    // preserved messages twice is exactly the size problem being recovered from.
    expect(summarizerRequests).toHaveLength(1)
    expect(summarizerRequests[0]).toContain('OLDEST_USER_PROMPT')
    expect(summarizerRequests[0]).toContain('THIRD_TOOL_RESULT')
    expect(summarizerRequests[0]).not.toContain('NEWEST_USER_PROMPT')

    // Both relink mechanisms read this: the live usage walk skips the range,
    // and resume rebuilds the chain from it.
    expect(result.boundaryMarker.compactMetadata?.preservedMessages).toEqual({
      anchorUuid: result.summaryMessages.at(-1)!.uuid,
      durableUuids: [newestAnswer.uuid, newest.uuid],
    })

    const { buildPostCompactMessages } = await import('./compact.js')
    const { roughTokenCountEstimationForMessages } = await import(
      '../tokenEstimation.js'
    )
    expect(result.postCompactTokenCount).toBe(11)
    expect(result.truePostCompactTokenCount).toBe(
      roughTokenCountEstimationForMessages(buildPostCompactMessages(result)),
    )
    expect(result.compactionUsage).toEqual({
      input_tokens: 10,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })
    expect(result.boundaryMarker.compactMetadata?.preservedSegment).toEqual({
      headUuid: newestAnswer.uuid,
      anchorUuid: result.summaryMessages.at(-1)!.uuid,
      tailUuid: newest.uuid,
    })
  })

  test('logical parent skips a summarized REPL-only round tail', async () => {
    await mockSummarizer([
      assistant('summary', '<summary>Older rounds, summarized.</summary>'),
    ])
    const { reactiveCompactOnPromptTooLong } = await import(
      './reactiveCompact.js'
    )
    const { messages } = fourRoundConversation()
    const summarizedPrompt = messages[4]!
    const replCall = messages[5] as AssistantMessage
    replCall.message.content = [
      {
        type: 'tool_use',
        id: 'tool-3',
        name: 'REPL',
        input: { code: '1 + 1' },
      },
    ]
    const context = createToolUseContext(messages)

    const outcome = await reactiveCompactOnPromptTooLong(
      messages,
      cacheSafeParamsFor(context, messages),
      { trigger: 'auto' },
    )

    expect(outcome.ok).toBe(true)
    expect(outcome.result!.boundaryMarker.logicalParentUuid).toBe(
      summarizedPrompt.uuid,
    )
  })

  test('preserves more trailing rounds when the summary request is itself too long', async () => {
    await mockSummarizer([
      promptTooLongResponse('prompt is too long: 100010 tokens > 100000'),
      assistant('summary', '<summary>Older rounds, summarized.</summary>'),
    ])
    const { reactiveCompactOnPromptTooLong } = await import(
      './reactiveCompact.js'
    )

    const { messages, newestAnswer, newest, thirdAnswer, thirdResult } =
      fourRoundConversation()
    const context = createToolUseContext(messages)
    const outcome = await reactiveCompactOnPromptTooLong(
      messages,
      cacheSafeParamsFor(context, messages),
      { trigger: 'auto' },
    )

    expect(outcome.ok).toBe(true)
    expect(summarizerRequests).toHaveLength(2)
    // Widened by one round rather than failing, and the widening moved content
    // out of the summarize set instead of dropping it.
    expect(outcome.result!.messagesToKeep).toEqual([
      thirdAnswer,
      thirdResult,
      newestAnswer,
      newest,
    ])
    expect(summarizerRequests[0]).toContain('THIRD_TOOL_RESULT')
    expect(summarizerRequests[1]).not.toContain('THIRD_TOOL_RESULT')
    expect(summarizerRequests[1]).toContain('OLDEST_USER_PROMPT')
  })

  test('reports exhausted when widening runs out of rounds to summarize', async () => {
    await mockSummarizer([
      // A gap no amount of widening can cover: every remaining round is small.
      promptTooLongResponse('prompt is too long: 900000 tokens > 100000'),
    ])
    const { reactiveCompactOnPromptTooLong } = await import(
      './reactiveCompact.js'
    )

    const { messages } = fourRoundConversation()
    const context = createToolUseContext(messages)
    const outcome = await reactiveCompactOnPromptTooLong(
      messages,
      cacheSafeParamsFor(context, messages),
      { trigger: 'auto' },
    )

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('exhausted')
    expect(outcome.result).toBeUndefined()
  })

  test('rejects a typed summary error whose text lacks the API Error prefix', async () => {
    await mockSummarizer([typedSummaryError('Request timed out')])
    const { reactiveCompactOnPromptTooLong } = await import(
      './reactiveCompact.js'
    )

    const { messages } = fourRoundConversation()
    const originalOldestMessage = messages[0]
    const context = createToolUseContext(messages)
    const outcome = await reactiveCompactOnPromptTooLong(
      messages,
      cacheSafeParamsFor(context, messages),
      { trigger: 'auto' },
    )

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('error')
    expect(outcome.error).toEqual(new Error('Request timed out'))
    expect(messages[0]).toBe(originalOldestMessage)
  })

  test('keeps transient reactive failures out of the auto-compact failure budget', async () => {
    await mockSummarizerFailure(new APIConnectionTimeoutError())
    const { autoCompactIfNeeded } = await import('./autoCompact.js')
    const { messages } = fourRoundConversation()
    ;(messages[7] as AssistantMessage).message.usage.input_tokens = 340_000
    const context = createToolUseContext(messages)
    const cacheSafeParams = cacheSafeParamsFor(context, messages)
    let consecutiveFailures: number | undefined

    for (let turn = 0; turn < 4; turn++) {
      const result = await autoCompactIfNeeded(
        messages,
        context,
        cacheSafeParams,
        'repl_main_thread',
        {
          compacted: false,
          turnCounter: turn,
          turnId: String(turn),
          consecutiveFailures,
        },
      )
      consecutiveFailures = result.consecutiveFailures
    }

    expect(consecutiveFailures).toBeUndefined()
    expect(summarizerRequests).toHaveLength(4)
  })

  test('reports too_few_groups instead of splitting a single round', async () => {
    await mockSummarizer([
      assistant('summary', '<summary>should never be requested</summary>'),
    ])
    const { reactiveCompactOnPromptTooLong } = await import(
      './reactiveCompact.js'
    )

    const messages = [
      createUserMessage({ content: 'ONLY_USER_PROMPT' }),
      assistant('round-1', 'ONLY_ASSISTANT_ANSWER'),
    ]
    const context = createToolUseContext(messages)
    const outcome = await reactiveCompactOnPromptTooLong(
      messages,
      cacheSafeParamsFor(context, messages),
      { trigger: 'manual' },
    )

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('too_few_groups')
    expect(summarizerRequests).toHaveLength(0)
  })
})

describe('tryReactiveCompact', () => {
  const originalSessionId = getSessionId()
  const originalProjectDir = getSessionProjectDir()
  let tempDir: string
  let summaryAttempts: number

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'reactive-compact-try-'))
    switchSession('reactive-compact-try-session', tempDir)
    summaryAttempts = 0

    await mock.module('../analytics/growthbook.js', () => ({
      getFeatureValue_CACHED_MAY_BE_STALE: mock(
        (key: string, defaultValue: boolean) =>
          key === 'tengu_compact_cache_prefix' ? false : defaultValue,
      ),
    }))
    await mock.module('../api/claude.js', () => ({
      ...realClaudeApi,
      queryModelWithStreaming: mock(async function* () {
        summaryAttempts++
        yield assistant('summary', '<summary>Recovered.</summary>')
      }),
    }))
  })

  afterEach(() => {
    mock.restore()
    switchSession(originalSessionId, originalProjectDir)
    rmSync(tempDir, { recursive: true, force: true })
  })

  function interruptedConversation(): Message[] {
    return [
      createUserMessage({ content: 'OLDEST_USER_PROMPT' }),
      assistant('round-1', 'OLDEST_ASSISTANT_ANSWER'),
      createUserMessage({ content: 'MIDDLE_USER_PROMPT' }),
      assistant('round-2', 'MIDDLE_ASSISTANT_ANSWER'),
      createUserMessage({ content: 'NEWEST_USER_PROMPT' }),
    ]
  }

  test('recovers the interrupted turn with the newest round intact', async () => {
    const { tryReactiveCompact } = await import('./reactiveCompact.js')
    const { buildPostCompactMessages } = await import('./compact.js')

    const messages = interruptedConversation()
    const context = createToolUseContext(messages)
    const result = await tryReactiveCompact({
      hasAttempted: false,
      querySource: 'repl_main_thread',
      aborted: false,
      messages,
      cacheSafeParams: cacheSafeParamsFor(context, messages),
    })

    expect(result).not.toBeNull()
    expect(summaryAttempts).toBe(1)
    // This array is what query.ts replays into the same turn: boundary first,
    // then the summary, then the preserved round.
    const replayed = buildPostCompactMessages(result!)
    expect(replayed[0]?.type).toBe('system')
    expect(replayed[1]).toBe(result!.summaryMessages[0]!)
    expect(replayed.at(2)).toBe(messages.at(-2)!)
    expect(replayed.at(3)).toBe(messages.at(-1)!)
  })

  test('does not compact twice in one turn', async () => {
    const { tryReactiveCompact } = await import('./reactiveCompact.js')

    const messages = interruptedConversation()
    const context = createToolUseContext(messages)
    const result = await tryReactiveCompact({
      hasAttempted: true,
      querySource: 'repl_main_thread',
      aborted: false,
      messages,
      cacheSafeParams: cacheSafeParamsFor(context, messages),
    })

    expect(result).toBeNull()
    expect(summaryAttempts).toBe(0)
  })

  test('refuses to compact from inside the compact fork', async () => {
    const { tryReactiveCompact } = await import('./reactiveCompact.js')

    const messages = interruptedConversation()
    const context = createToolUseContext(messages)
    const result = await tryReactiveCompact({
      hasAttempted: false,
      querySource: 'compact',
      aborted: false,
      messages,
      cacheSafeParams: cacheSafeParamsFor(context, messages),
    })

    expect(result).toBeNull()
    expect(summaryAttempts).toBe(0)
  })
})

describe('planReactiveSplit', () => {
  test('pulls the split back so a preserved tool_result keeps its tool_use', async () => {
    const { planReactiveSplit } = await import('./reactiveCompact.js')
    const { groupMessagesByApiRound } = await import('./grouping.js')

    // A resumed transcript can land the tool_result after the next round has
    // already opened. Splitting on the raw group boundary would preserve the
    // result and summarize away its tool_use.
    const opening = createUserMessage({ content: 'start' })
    const callingRound = assistantWithToolUse('round-1', 'tool-1')
    const nextRound = assistant('round-2', 'next round text')
    const strandedResult = toolResult('tool-1', 'late result')
    const messages: Message[] = [
      opening,
      callingRound,
      nextRound,
      strandedResult,
    ]

    const groups = groupMessagesByApiRound(messages)
    expect(groups).toHaveLength(3)

    const pivot = planReactiveSplit(messages, groups, 1)
    // Raw boundary would be index 2 (nextRound); the tool_use sits at index 1.
    expect(pivot).toBe(1)
    expect(messages.slice(pivot!)).toContain(callingRound)
  })

  test('returns null when preserving every round would leave nothing to summarize', async () => {
    const { planReactiveSplit } = await import('./reactiveCompact.js')
    const { groupMessagesByApiRound } = await import('./grouping.js')

    const messages: Message[] = [
      createUserMessage({ content: 'start' }),
      assistant('round-1', 'one'),
    ]
    const groups = groupMessagesByApiRound(messages)
    expect(planReactiveSplit(messages, groups, groups.length)).toBeNull()
  })
})

/**
 * The production trigger, not the reactive function.
 *
 * The defect these tests exist for was a feature that was compiled in and
 * never reached: `autoCompactIfNeeded` is what actually fires at the token
 * threshold, so a test that calls `reactiveCompactOnPromptTooLong` directly
 * proves nothing about whether ordinary compaction routes into it. These drive
 * `autoCompactIfNeeded` and let the real gate decide.
 *
 * `feature()` is false under a plain `bun test`, so the reactive branch is
 * dead there. `bun test --feature=REACTIVE_COMPACT` compiles it in — the same
 * switch `scripts/build.ts` passes to `bun build` for dev-full. Both runs are
 * required: the pair asserts the reactive result WITH the feature and the
 * full-compaction fallback WITHOUT it.
 */
const REACTIVE_COMPILED_IN = ((): boolean => {
  if (feature('REACTIVE_COMPACT')) {
    return true
  }
  return false
})()

describe('query prompt-too-long recovery', () => {
  test.if(REACTIVE_COMPILED_IN)(
    'falls back to full compaction in the same turn without double-firing PreCompact',
    async () => {
      let summaryAttempts = 0
      await mock.module('../analytics/growthbook.js', () => ({
        getFeatureValue_CACHED_MAY_BE_STALE: mock(
          (key: string, defaultValue: boolean) =>
            key === 'tengu_compact_cache_prefix' ? false : defaultValue,
        ),
      }))
      await mock.module('../api/claude.js', () => ({
        ...realClaudeApi,
        queryModelWithStreaming: mock(async function* () {
          summaryAttempts++
          yield assistant('summary', '<summary>Fully compacted.</summary>')
        }),
      }))
      const { query } = await import('../../query.js')

      const messages = [
        createUserMessage({ content: 'ONLY_USER_PROMPT' }),
        assistantWithToolUse('round-1', 'oversized-tool'),
        toolResult('oversized-tool', 'OVERSIZED_TOOL_RESULT'),
      ]
      const progress: { type: string; hookType?: string }[] = []
      const context = createToolUseContext(messages)
      context.onCompactProgress = event => progress.push(event)

      let modelCalls = 0
      const submittedRequests: Message[][] = []
      const yielded: Message[] = []
      for await (const message of query({
        messages,
        systemPrompt: ['system prompt'],
        userContext: {},
        systemContext: {},
        canUseTool: async () => ({
          behavior: 'allow',
          decisionReason: { type: 'other', reason: 'test allows all tools' },
        }),
        toolUseContext: context,
        querySource: 'repl_main_thread',
        deps: {
          uuid: () => 'query-chain-id',
          microcompact: async input => ({ messages: input }),
          autocompact: async () => ({
            wasCompacted: false,
            consecutiveFailures: 0,
          }),
          callModel: async function* ({ messages: request }) {
            submittedRequests.push(request)
            modelCalls++
            if (modelCalls === 1) {
              yield promptTooLongResponse()
              return
            }
            yield assistant('recovered', 'RECOVERED_IN_SAME_TURN')
          },
        },
      })) {
        yielded.push(message)
      }

      expect(modelCalls).toBe(2)
      expect(summaryAttempts).toBe(1)
      expect(submittedRequests[1]?.some(message => message.type === 'system')).toBe(
        true,
      )
      expect(
        yielded.some(
          message =>
            message.type === 'assistant' &&
            message.message.content.some(
              block =>
                block.type === 'text' && block.text === 'RECOVERED_IN_SAME_TURN',
            ),
        ),
      ).toBe(true)
      expect(yielded).not.toContainEqual(promptTooLongResponse())
      expect(
        progress.filter(
          event =>
            event.type === 'hooks_start' && event.hookType === 'pre_compact',
        ),
      ).toHaveLength(1)
    },
  )
})

describe('autoCompactIfNeeded routing', () => {
  const originalSessionId = getSessionId()
  const originalProjectDir = getSessionProjectDir()
  const ENV_KEYS = [
    'DISABLE_COMPACT',
    'DISABLE_AUTO_COMPACT',
    'ENABLE_CLAUDE_CODE_SM_COMPACT',
    'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
  ] as const
  const envSnapshot = new Map<string, string | undefined>()
  let tempDir: string
  let summarizerRequests: string[]

  const MODEL = 'gpt-5.6-terra'

  beforeEach(async () => {
    for (const key of ENV_KEYS) {
      envSnapshot.set(key, process.env[key])
      delete process.env[key]
    }
    tempDir = mkdtempSync(join(tmpdir(), 'autocompact-routing-'))
    switchSession('autocompact-routing-session', tempDir)
    summarizerRequests = []

    await mock.module('../analytics/growthbook.js', () => ({
      getFeatureValue_CACHED_MAY_BE_STALE: mock(
        (key: string, defaultValue: boolean) =>
          key === 'tengu_compact_cache_prefix' ? false : defaultValue,
      ),
    }))
    await mock.module('../api/claude.js', () => ({
      ...realClaudeApi,
      queryModelWithStreaming: mock(async function* (params: unknown) {
        summarizerRequests.push(JSON.stringify(params))
        yield assistant('summary', '<summary>Older rounds, summarized.</summary>')
      }),
    }))
  })

  afterEach(() => {
    mock.restore()
    switchSession(originalSessionId, originalProjectDir)
    rmSync(tempDir, { recursive: true, force: true })
    for (const key of ENV_KEYS) {
      const value = envSnapshot.get(key)
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    envSnapshot.clear()
  })

  /**
   * Three rounds carrying a usage anchor above the model's autocompact
   * threshold, so `shouldAutoCompact` decides to compact from the same
   * measurement production uses instead of the test forcing the decision.
   */
  async function overThresholdConversation() {
    const { getAutoCompactThreshold } = await import('./autoCompact.js')
    const first = createUserMessage({ content: 'OLDEST_USER_PROMPT' })
    const firstAnswer = assistant('round-1', 'OLDEST_ASSISTANT_ANSWER')
    const second = createUserMessage({ content: 'MIDDLE_USER_PROMPT' })
    const secondAnswer = assistant('round-2', 'MIDDLE_ASSISTANT_ANSWER')
    const third = createUserMessage({ content: 'THIRD_USER_PROMPT' })
    const newestAnswer = assistant('round-3', 'NEWEST_ASSISTANT_ANSWER')
    newestAnswer.message.usage.input_tokens =
      getAutoCompactThreshold(MODEL) + 50_000
    const newest = createUserMessage({ content: 'NEWEST_USER_PROMPT' })
    return {
      newestAnswer,
      newest,
      messages: [
        first,
        firstAnswer,
        second,
        secondAnswer,
        third,
        newestAnswer,
        newest,
      ],
    }
  }

  function contextForModel(
    messages: Message[],
    progress?: { type: string }[],
  ): ToolUseContext {
    const context = createToolUseContext(messages)
    context.options.mainLoopModel = MODEL
    if (progress) {
      context.onCompactProgress = event => progress.push(event)
    }
    return context
  }

  test.if(REACTIVE_COMPILED_IN)(
    'threshold compaction preserves the newest round and hands it to the next request',
    async () => {
      const { autoCompactIfNeeded, isAutoCompactEnabled } = await import(
        './autoCompact.js'
      )
      const { buildPostCompactMessages } = await import('./compact.js')
      // Asserted rather than mocked: the user's own setting is allowed to turn
      // this off, so a machine where it is off must fail loudly here instead of
      // passing without ever reaching the subject.
      expect(isAutoCompactEnabled()).toBe(true)

      const { messages, newestAnswer, newest } =
        await overThresholdConversation()
      const context = contextForModel(messages)
      const outcome = await autoCompactIfNeeded(
        messages,
        context,
        cacheSafeParamsFor(context, messages),
        'repl_main_thread',
      )

      expect(outcome.wasCompacted).toBe(true)
      // Full compaction returns no messagesToKeep at all, so this key is the
      // discriminator between the two paths.
      expect(outcome.compactionResult!.messagesToKeep).toEqual([
        newestAnswer,
        newest,
      ])

      // The array query.ts replaces messagesForQuery with (query.ts:614-620):
      // boundary, summary, then the preserved round byte for byte.
      const nextRequest = buildPostCompactMessages(outcome.compactionResult!)
      expect(nextRequest[0]!.type).toBe('system')
      expect(nextRequest[1]).toBe(outcome.compactionResult!.summaryMessages[0]!)
      expect(nextRequest[2]).toBe(newestAnswer)
      expect(nextRequest[3]).toBe(newest)

      // One summary request, over the prefix only. Sending the preserved tail
      // to the summarizer as well is the size problem being avoided.
      expect(summarizerRequests).toHaveLength(1)
      expect(summarizerRequests[0]).toContain('OLDEST_USER_PROMPT')
      expect(summarizerRequests[0]).not.toContain('NEWEST_USER_PROMPT')
    },
  )

  test.if(REACTIVE_COMPILED_IN)(
    'falls back to full compaction when the conversation is one round',
    async () => {
      const { autoCompactIfNeeded } = await import('./autoCompact.js')
      const { getAutoCompactThreshold } = await import('./autoCompact.js')

      const onlyAnswer = assistant('round-1', 'ONLY_ASSISTANT_ANSWER')
      onlyAnswer.message.usage.input_tokens =
        getAutoCompactThreshold(MODEL) + 50_000
      const messages = [
        createUserMessage({ content: 'ONLY_USER_PROMPT' }),
        onlyAnswer,
      ]
      const progress: { type: string }[] = []
      const context = contextForModel(messages, progress)
      const outcome = await autoCompactIfNeeded(
        messages,
        context,
        cacheSafeParamsFor(context, messages),
        'repl_main_thread',
      )

      expect(outcome.wasCompacted).toBe(true)
      expect(outcome.compactionResult!.messagesToKeep).toBeUndefined()
      // Exactly one compaction was started. Two would mean the reactive path
      // ran far enough to emit its own progress and its own PreCompact hooks
      // before falling back, firing the user's hook twice for one compaction.
      expect(progress.filter(event => event.type === 'compact_start')).toEqual([
        { type: 'compact_start' },
      ])
    },
  )

  test.if(!REACTIVE_COMPILED_IN)(
    'compiles out to full compaction when REACTIVE_COMPACT is absent',
    async () => {
      const { autoCompactIfNeeded, isAutoCompactEnabled } = await import(
        './autoCompact.js'
      )
      expect(isAutoCompactEnabled()).toBe(true)

      const { messages } = await overThresholdConversation()
      const context = contextForModel(messages)
      const outcome = await autoCompactIfNeeded(
        messages,
        context,
        cacheSafeParamsFor(context, messages),
        'repl_main_thread',
      )

      expect(outcome.wasCompacted).toBe(true)
      expect(outcome.compactionResult!.messagesToKeep).toBeUndefined()
    },
  )

  test('DISABLE_AUTO_COMPACT suppresses the threshold trigger entirely', async () => {
    process.env.DISABLE_AUTO_COMPACT = '1'
    const { autoCompactIfNeeded } = await import('./autoCompact.js')

    const { messages } = await overThresholdConversation()
    const context = contextForModel(messages)
    const outcome = await autoCompactIfNeeded(
      messages,
      context,
      cacheSafeParamsFor(context, messages),
      'repl_main_thread',
    )

    expect(outcome.wasCompacted).toBe(false)
    expect(summarizerRequests).toHaveLength(0)
  })
})

describe('prefix-compaction gates', () => {
  const ENV_KEYS = ['DISABLE_COMPACT', 'DISABLE_AUTO_COMPACT'] as const
  const envSnapshot = new Map<string, string | undefined>()

  beforeEach(async () => {
    for (const key of ENV_KEYS) {
      envSnapshot.set(key, process.env[key])
      delete process.env[key]
    }
    await mock.module('../analytics/growthbook.js', () => ({
      getFeatureValue_CACHED_MAY_BE_STALE: mock(
        (_key: string, defaultValue: boolean) => defaultValue,
      ),
    }))
  })

  afterEach(() => {
    mock.restore()
    for (const key of ENV_KEYS) {
      const value = envSnapshot.get(key)
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    envSnapshot.clear()
  })

  test('turning automatic compaction off leaves manual /compact on the prefix path', async () => {
    const { isReactiveCompactEnabled, isReactiveManualCompactEnabled } =
      await import('./reactiveCompact.js')

    process.env.DISABLE_AUTO_COMPACT = '1'
    // The automatic triggers stand down, because the user asked for no
    // automatic compaction. An explicitly typed /compact still summarizes the
    // prefix rather than silently reverting to full replacement.
    expect(isReactiveCompactEnabled()).toBe(false)
    expect(isReactiveManualCompactEnabled()).toBe(true)
  })
})
