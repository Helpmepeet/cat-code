import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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
    expect(result.boundaryMarker.compactMetadata?.preservedSegment).toEqual({
      headUuid: newestAnswer.uuid,
      anchorUuid: result.summaryMessages.at(-1)!.uuid,
      tailUuid: newest.uuid,
    })
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
