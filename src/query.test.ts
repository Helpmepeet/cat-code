import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as analytics from './services/analytics/index.js'
import type { ToolUseContext } from './Tool.js'
import { query } from './query.js'
import type { QueryDeps } from './query/deps.js'
import { _forTest as postTurnStallForTest } from './query/postTurnStall.js'
import * as toolUseSummaryGenerator from './services/toolUseSummary/toolUseSummaryGenerator.js'
import * as sessionStorage from './utils/sessionStorage.js'
import type { CompactionResult } from './services/compact/compact.js'
import type { AssistantMessage, Message, SystemMessage } from './types/message.js'
import { createUserMessage } from './utils/messages.js'
import {
  enqueue,
  getCommandQueueSnapshot,
  resetCommandQueue,
} from './utils/messageQueueManager.js'
import { SLEEP_TOOL_NAME } from './tools/SleepTool/prompt.js'
import { buildTool } from './Tool.js'
import z from 'zod/v4'

function createAssistantMessage(text: string, uuid: string): AssistantMessage {
  return {
    type: 'assistant',
    uuid,
    timestamp: '2026-05-05T00:00:00.000Z',
    message: {
      id: uuid,
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

function createToolUseContext(messages: Message[]): ToolUseContext {
  const appState = {
    toolPermissionContext: {
      mode: 'default',
      additionalWorkingDirectories: new Map<string, string>(),
    },
    mcp: {
      tools: [],
      clients: [],
    },
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
      agentDefinitions: {
        activeAgents: [],
        allowedAgentTypes: [],
      },
    },
    abortController: new AbortController(),
    readFileState: new Map(),
    getAppState: () => appState,
    setAppState: updater => {
      Object.assign(appState, updater(appState))
    },
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages,
  } as unknown as ToolUseContext
}

describe('query auto-compaction request assembly', () => {
  test('sends post-compact messages to both generic and OpenAI request assembly', async () => {
    const originalUserMessage = createUserMessage({ content: 'pre compact user text' })
    const preservedUserMessage = createUserMessage({
      content: 'preserved user text',
    })
    const preservedAssistantMessage = createAssistantMessage(
      'preserved assistant text',
      'assistant-preserved',
    )
    const originalMessages: Message[] = [
      originalUserMessage,
      preservedUserMessage,
      preservedAssistantMessage,
      createAssistantMessage('pre compact assistant text', 'assistant-before-compact'),
    ]

    const compactSummary = createUserMessage({
      content: 'post compact summary text',
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    })
    const compactBoundary: SystemMessage = {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'compact-boundary',
      timestamp: '2026-05-05T00:00:01.000Z',
      compactMetadata: {
        trigger: 'auto',
        preTokens: 240_000,
        preservedMessages: {
          anchorUuid: compactSummary.uuid,
          durableUuids: [
            preservedUserMessage.uuid,
            preservedAssistantMessage.uuid,
          ],
        },
      },
    }
    const compactionResult: CompactionResult = {
      boundaryMarker: compactBoundary,
      summaryMessages: [compactSummary],
      attachments: [],
      hookResults: [],
      messagesToKeep: [preservedUserMessage, preservedAssistantMessage],
      preCompactTokenCount: 240_000,
      postCompactTokenCount: 1_200,
      truePostCompactTokenCount: 1_000,
      compactionUsage: {
        input_tokens: 1_100,
        output_tokens: 100,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 30,
      },
    }
    const expectedPostCompactMessages = [
      compactBoundary,
      compactSummary,
      preservedUserMessage,
      preservedAssistantMessage,
    ]

    let capturedMessages: Message[] | undefined
    let capturedOpenAIInputMessages: Message[] | undefined
    const logEvent = spyOn(analytics, 'logEvent')

    const deps: QueryDeps = {
      uuid: () => 'test-query-chain-id',
      microcompact: async messages => ({ messages }),
      autocompact: async () => ({
        wasCompacted: true,
        compactionResult,
        consecutiveFailures: 0,
      }),
      callModel: async function* ({ messages, openAIInstructionAssembly }) {
        capturedMessages = messages
        capturedOpenAIInputMessages = openAIInstructionAssembly?.inputMessages
        yield createAssistantMessage('final assistant response', 'assistant-after-compact')
      },
    }

    const toolUseContext = createToolUseContext(originalMessages)

    for await (const _message of query({
      messages: originalMessages,
      systemPrompt: ['system prompt'],
      userContext: {},
      systemContext: {},
      canUseTool: async () => ({
        behavior: 'allow',
        decisionReason: {
          type: 'other',
          reason: 'test allows all tools',
        },
      }),
      toolUseContext,
      querySource: 'repl_main_thread',
      deps,
    })) {
      // Drain the query generator so the fake model call runs.
    }

    expect(capturedMessages).toEqual(expectedPostCompactMessages)
    expect(capturedOpenAIInputMessages).toEqual(expectedPostCompactMessages)
    expect(logEvent).toHaveBeenCalledWith(
      'tengu_auto_compact_succeeded',
      expect.objectContaining({
        compactedMessageCount: 3,
        postCompactTokenCount: 1_200,
        truePostCompactTokenCount: 1_000,
        compactionInputTokens: 1_100,
        compactionOutputTokens: 100,
        compactionCacheCreationTokens: 20,
        compactionCacheReadTokens: 30,
        compactionTotalTokens: 1_250,
      }),
    )
  })
})

describe('query mid-turn drain gate', () => {
  afterEach(() => {
    resetCommandQueue()
  })

  // query.ts only raises the mid-turn drain ceiling to 'later' — the priority
  // deferred continuations are enqueued at — when a tool named Sleep ran this
  // turn. This fork ships no Sleep tool, so the test registers one to exercise
  // the gate as query.ts intends rather than asserting against a turn shape
  // that can never reach it.
  const sleepTool = buildTool({
    name: SLEEP_TOOL_NAME,
    inputSchema: z.strictObject({ duration: z.number() }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async description() {
      return 'test sleep'
    },
    async prompt() {
      return 'test sleep'
    },
    async validateInput() {
      return { result: true as const }
    },
    renderToolUseMessage: () => null,
    renderToolResultMessage: () => null,
    renderToolUseErrorMessage: () => null,
    mapToolResultToToolResultBlockParam(_output: unknown, toolUseID: string) {
      return { tool_use_id: toolUseID, type: 'tool_result' as const, content: 'slept' }
    },
    async *call() {
      yield { type: 'result' as const, data: 'slept' }
    },
  })

  function sleepThenAnswerDeps(): QueryDeps {
    let call = 0
    return {
      uuid: () => 'test-query-chain-id',
      microcompact: async messages => ({ messages }),
      autocompact: async () => ({ wasCompacted: false, consecutiveFailures: 0 }),
      callModel: async function* () {
        call++
        if (call === 1) {
          const withSleep = createAssistantMessage('sleeping', 'assistant-sleep')
          withSleep.message.content = [
            {
              type: 'tool_use',
              id: 'toolu_sleep_1',
              name: SLEEP_TOOL_NAME,
              input: { duration: 1 },
            },
          ] as AssistantMessage['message']['content']
          yield withSleep
          return
        }
        yield createAssistantMessage('done', 'assistant-done')
      },
    }
  }

  async function drainQuery(messages: Message[]): Promise<void> {
    const toolUseContext = createToolUseContext(messages)
    ;(toolUseContext.options as { tools: unknown[] }).tools = [sleepTool]
    for await (const _message of query({
      messages,
      systemPrompt: ['system prompt'],
      userContext: {},
      systemContext: {},
      canUseTool: async () => ({
        behavior: 'allow',
        decisionReason: { type: 'other', reason: 'test allows all tools' },
      }),
      toolUseContext,
      querySource: 'repl_main_thread',
      deps: sleepThenAnswerDeps(),
    })) {
      // Drain the generator so the mid-turn drain gate runs.
    }
  }

  test('does not drain a deferred continuation into the current turn', async () => {
    // Regression: a deferred continuation drained mid-turn becomes an
    // attachment instead of a user message in onQuery's newMessages. That skips
    // REPL.tsx's durable pre-provider barrier and never settles the runner's
    // UUID registry, so both filesystem locks are held for the process lifetime
    // and the job strands at 'submitted' -> 'ambiguous'. It must stay queued for
    // useQueueProcessor to submit after the turn.
    const deferred = {
      value: 'Automated continuation requested through /continue-after-limit.',
      mode: 'prompt' as const,
      skipSlashCommands: true,
      isMeta: false,
      priority: 'later' as const,
      uuid: '11111111-1111-4111-8111-111111111111',
      origin: {
        kind: 'deferred-continuation' as const,
        jobId: 'job-1',
        attemptUuid: '11111111-1111-4111-8111-111111111111',
      },
    }
    enqueue(deferred)

    await drainQuery([createUserMessage({ content: 'start' })])

    expect(getCommandQueueSnapshot()).toHaveLength(1)
    expect(getCommandQueueSnapshot()[0]?.origin?.kind).toBe(
      'deferred-continuation',
    )
  })

  test('still drains an ordinary later-priority prompt after a Sleep turn', async () => {
    // Guards the exclusion above from over-reaching: only the deferred origin
    // is held back, not every 'later' prompt.
    enqueue({
      value: 'ordinary queued prompt',
      mode: 'prompt' as const,
      priority: 'later' as const,
      uuid: '22222222-2222-4222-8222-222222222222',
    })

    await drainQuery([createUserMessage({ content: 'start' })])

    expect(getCommandQueueSnapshot()).toHaveLength(0)
  })
})

describe('post-turn stall diagnostics', () => {
  // An overnight run sat on `await pendingToolUseSummary` for nine hours and
  // wrote nothing anywhere, so the phase had to be reconstructed by hand
  // (docs/reports/2026-08-10-overnight-turn-hang-investigation.md). The await
  // must still be able to hang forever — it just has to name itself first.
  const probeTool = buildTool({
    name: 'StallProbe',
    inputSchema: z.strictObject({}),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async description() {
      return 'test probe'
    },
    async prompt() {
      return 'test probe'
    },
    async validateInput() {
      return { result: true as const }
    },
    renderToolUseMessage: () => null,
    renderToolResultMessage: () => null,
    renderToolUseErrorMessage: () => null,
    mapToolResultToToolResultBlockParam(_output: unknown, toolUseID: string) {
      return { tool_use_id: toolUseID, type: 'tool_result' as const, content: 'probed' }
    },
    async *call() {
      yield { type: 'result' as const, data: 'probed' }
    },
  })

  function probeThenAnswerDeps(): QueryDeps {
    let call = 0
    return {
      uuid: () => 'test-query-chain-id',
      microcompact: async messages => ({ messages }),
      autocompact: async () => ({ wasCompacted: false, consecutiveFailures: 0 }),
      callModel: async function* () {
        call++
        if (call === 1) {
          const withProbe = createAssistantMessage('probing', 'assistant-probe')
          withProbe.message.content = [
            { type: 'tool_use', id: 'toolu_probe_1', name: 'StallProbe', input: {} },
          ] as AssistantMessage['message']['content']
          yield withProbe
          return
        }
        yield createAssistantMessage('done', 'assistant-done')
      },
    }
  }

  const originalEmitFlag = process.env.CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES

  // Restored here, not at the end of each test body: a failing assertion returns
  // before an in-body restore, leaving `generateToolUseSummary` and
  // `recordPostTurnStall` mocked for every later test in the file.
  const spies: { mockRestore: () => void }[] = []

  afterEach(() => {
    while (spies.length > 0) spies.pop()!.mockRestore()
    postTurnStallForTest.setScheduler(null)
    if (originalEmitFlag === undefined) {
      delete process.env.CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES
    } else {
      process.env.CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES = originalEmitFlag
    }
  })

  test('names the tool_use_summary phase when that await outlives its threshold', async () => {
    process.env.CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES = '1'

    // The real generator, blocked. query() still builds the summary call, wraps
    // it, carries it across the loop iteration, and awaits it at the real site.
    let releaseSummary: (value: string | null) => void = () => {}
    const summarySpy = spyOn(
      toolUseSummaryGenerator,
      'generateToolUseSummary',
    ).mockImplementation(
      () =>
        new Promise<string | null>(resolve => {
          releaseSummary = resolve
        }),
    )
    const recordSpy = spyOn(sessionStorage, 'recordPostTurnStall').mockImplementation(
      () => {},
    )
    spies.push(summarySpy, recordSpy)

    const armed: { delayMs: number; fire: () => void; cancelled: boolean }[] = []
    postTurnStallForTest.setScheduler((callback, delayMs) => {
      const entry = { delayMs, fire: callback, cancelled: false }
      armed.push(entry)
      return () => {
        entry.cancelled = true
      }
    })

    const messages = [createUserMessage({ content: 'start' })]
    const toolUseContext = createToolUseContext(messages)
    ;(toolUseContext.options as { tools: unknown[] }).tools = [probeTool]
    const drained = (async () => {
      for await (const _message of query({
        messages,
        systemPrompt: ['system prompt'],
        userContext: {},
        systemContext: {},
        canUseTool: async () => ({
          behavior: 'allow',
          decisionReason: { type: 'other', reason: 'test allows all tools' },
        }),
        toolUseContext,
        querySource: 'repl_main_thread',
        deps: probeThenAnswerDeps(),
      })) {
        // Drain so the loop reaches the post-turn await.
      }
    })()

    // The run is now parked on the real await, with nothing else armed. Bounded
    // so an unwired await fails the assertion instead of hanging the suite.
    for (let i = 0; i < 200 && armed.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(armed).toHaveLength(1)
    expect(armed[0]!.delayMs).toBe(60_000)
    expect(armed[0]!.cancelled).toBe(false)
    expect(recordSpy).not.toHaveBeenCalled()

    armed[0]!.fire()

    expect(recordSpy).toHaveBeenCalledTimes(1)
    const entry = recordSpy.mock.calls[0]![0]
    expect(entry.phase).toBe('tool_use_summary')
    expect(entry.threshold_ms).toBe(60_000)
    expect(entry.query_source).toBe('repl_main_thread')
    expect(entry.turn_count).toBe(2)

    // Reporting does not unstick anything: the await is still pending, and the
    // turn only closes because the test resolves it.
    releaseSummary(null)
    await drained
    expect(armed[0]!.cancelled).toBe(true)
    expect(recordSpy).toHaveBeenCalledTimes(1)
  })

  test('a summary that resolves in time reports nothing', async () => {
    process.env.CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES = '1'

    const summarySpy = spyOn(
      toolUseSummaryGenerator,
      'generateToolUseSummary',
    ).mockImplementation(async () => 'Probed things')
    const recordSpy = spyOn(sessionStorage, 'recordPostTurnStall').mockImplementation(
      () => {},
    )
    spies.push(summarySpy, recordSpy)

    const armed: { fire: () => void; cancelled: boolean }[] = []
    postTurnStallForTest.setScheduler(callback => {
      const entry = { fire: callback, cancelled: false }
      armed.push(entry)
      return () => {
        entry.cancelled = true
      }
    })

    const messages = [createUserMessage({ content: 'start' })]
    const toolUseContext = createToolUseContext(messages)
    ;(toolUseContext.options as { tools: unknown[] }).tools = [probeTool]
    for await (const _message of query({
      messages,
      systemPrompt: ['system prompt'],
      userContext: {},
      systemContext: {},
      canUseTool: async () => ({
        behavior: 'allow',
        decisionReason: { type: 'other', reason: 'test allows all tools' },
      }),
      toolUseContext,
      querySource: 'repl_main_thread',
      deps: probeThenAnswerDeps(),
    })) {
      // Drain the whole turn.
    }

    expect(recordSpy).not.toHaveBeenCalled()
    // Assert the watch was armed BEFORE asserting it was cancelled: `every` on
    // an empty array is true, so without this the test would still pass if the
    // watch were deleted from the tool_use_summary site entirely.
    expect(armed.length).toBeGreaterThanOrEqual(1)
    expect(armed.every(entry => entry.cancelled)).toBe(true)
  })
})

describe('codex partial-stream continuation', () => {
  const eligibleFailure = {
    version: 1 as const,
    code: 'partial_stream_replay_skipped' as const,
    provider: 'openai' as const,
    transport: 'websocket' as const,
    cause: 'closed' as const,
    sealedPartialText: true,
    hadClientToolCall: false,
    openClientToolCalls: 0,
    hadHostedWebSearch: false,
    automaticContinuationEligible: true,
  }

  /** What claude.ts + errors.ts hand the loop after the adapter sealed a block. */
  function interruptedTurn(
    uuidSuffix: string,
    // No default: passing `undefined` explicitly is one of the cases under
    // test, and a default parameter would silently turn it into the eligible
    // marker.
    apiError: unknown,
  ): AssistantMessage[] {
    const partial = createAssistantMessage(
      'the half-written answer',
      `assistant-partial-${uuidSuffix}`,
    )
    const error = createAssistantMessage(
      'API Error: Connection interrupted after partial output. The request was not repeated because it may have already performed actions.',
      `assistant-error-${uuidSuffix}`,
    )
    ;(error as AssistantMessage).isApiErrorMessage = true
    ;(error as AssistantMessage).apiError = apiError
    return [partial, error]
  }

  function textOf(messages: Message[]): string[] {
    return messages.flatMap(message =>
      message.type === 'assistant' || message.type === 'user'
        ? typeof message.message.content === 'string'
          ? [message.message.content]
          : (message.message.content as { type: string; text?: string }[])
              .filter(block => block.type === 'text')
              .map(block => block.text ?? '')
        : [],
    )
  }

  async function runQuery(deps: QueryDeps, tools: unknown[] = []) {
    const messages: Message[] = [createUserMessage({ content: 'do the thing' })]
    const toolUseContext = createToolUseContext(messages)
    ;(toolUseContext.options as { tools: unknown[] }).tools = tools
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
      toolUseContext,
      querySource: 'repl_main_thread',
      deps,
    })) {
      yielded.push(message as Message)
    }
    return { yielded, toolUseContext }
  }

  function countApiErrors(yielded: Message[]): number {
    return yielded.filter(
      message =>
        message.type === 'assistant' &&
        (message as AssistantMessage).isApiErrorMessage === true,
    ).length
  }

  function recoveryNotices(yielded: Message[]): Message[] {
    return yielded.filter(
      message =>
        message.type === 'system' &&
        (message as { subtype?: string }).subtype === 'transport_recovery',
    )
  }

  test('continues the turn over the next request and carries the partial text', async () => {
    const seen: Message[][] = []
    let call = 0
    const deps: QueryDeps = {
      uuid: () => 'test-query-chain-id',
      microcompact: async messages => ({ messages }),
      autocompact: async () => ({ wasCompacted: false, consecutiveFailures: 0 }),
      callModel: async function* ({ messages }) {
        seen.push(messages)
        call++
        if (call === 1) {
          for (const message of interruptedTurn('one', eligibleFailure)) yield message
          return
        }
        yield createAssistantMessage('and the rest of it', 'assistant-final')
      },
    }

    const { yielded } = await runQuery(deps)

    expect(call).toBe(2)
    const secondCallText = textOf(seen[1]!)
    // The partial response the user already read is context, not something to
    // be regenerated; the instruction is what tells the model so.
    expect(secondCallText).toContain('the half-written answer')
    expect(secondCallText.join(' ')).toContain(
      'Continue from the preserved response without repeating completed work',
    )
    // The synthetic transport error is bookkeeping and must not read back as
    // the assistant's own turn.
    expect(secondCallText.join(' ')).not.toContain('API Error')

    // Nothing intermediate reaches a caller that treats an error field as fatal.
    expect(countApiErrors(yielded)).toBe(0)
    expect(recoveryNotices(yielded)).toHaveLength(1)
    expect(textOf(yielded)).toContain('and the rest of it')
  })

  test('a marker that reports a client tool call is never continued', async () => {
    let call = 0
    const deps: QueryDeps = {
      uuid: () => 'test-query-chain-id',
      microcompact: async messages => ({ messages }),
      autocompact: async () => ({ wasCompacted: false, consecutiveFailures: 0 }),
      callModel: async function* () {
        call++
        for (const message of interruptedTurn('tool', {
          ...eligibleFailure,
          hadClientToolCall: true,
          openClientToolCalls: 1,
          automaticContinuationEligible: false,
        })) {
          yield message
        }
      },
    }

    const { yielded } = await runQuery(deps)

    expect(call).toBe(1)
    expect(recoveryNotices(yielded)).toHaveLength(0)
    expect(countApiErrors(yielded)).toBe(1)
  })

  test('an absent or malformed marker fails closed', async () => {
    for (const apiError of [
      undefined,
      'partial_stream_replay_skipped',
      { code: 'partial_stream_replay_skipped' },
      { ...eligibleFailure, provider: 'anthropic' },
      { ...eligibleFailure, version: 2 },
    ]) {
      let call = 0
      const deps: QueryDeps = {
        uuid: () => 'test-query-chain-id',
        microcompact: async messages => ({ messages }),
        autocompact: async () => ({
          wasCompacted: false,
          consecutiveFailures: 0,
        }),
        callModel: async function* () {
          call++
          for (const message of interruptedTurn('malformed', apiError)) {
            yield message
          }
        },
      }

      const { yielded } = await runQuery(deps)
      const label = JSON.stringify(apiError ?? null)
      expect([label, call]).toEqual([label, 1])
      expect([label, countApiErrors(yielded)]).toEqual([label, 1])
      expect([label, recoveryNotices(yielded).length]).toEqual([label, 0])

    }
  })

  test('the budget stops a third interruption and surfaces one honest failure', async () => {
    let call = 0
    const deps: QueryDeps = {
      uuid: () => 'test-query-chain-id',
      microcompact: async messages => ({ messages }),
      autocompact: async () => ({ wasCompacted: false, consecutiveFailures: 0 }),
      callModel: async function* () {
        call++
        for (const message of interruptedTurn(`n${call}`, eligibleFailure)) yield message
      },
    }

    const { yielded } = await runQuery(deps)

    // One original request plus two continuations, then it stops.
    expect(call).toBe(3)
    expect(recoveryNotices(yielded)).toHaveLength(2)
    expect(countApiErrors(yielded)).toBe(1)
  })

  test('a tool round does not refill the budget', async () => {
    const toolCallTool = buildTool({
      name: 'Ping',
      description: 'test tool',
      inputSchema: z.object({}),
      async *call() {
        yield { type: 'result' as const, data: 'pong' }
      },
    })
    let call = 0
    const deps: QueryDeps = {
      uuid: () => 'test-query-chain-id',
      microcompact: async messages => ({ messages }),
      autocompact: async () => ({ wasCompacted: false, consecutiveFailures: 0 }),
      callModel: async function* () {
        call++
        if (call === 2) {
          const withTool = createAssistantMessage('calling', 'assistant-tool')
          withTool.message.content = [
            { type: 'tool_use', id: 'toolu_ping_1', name: 'Ping', input: {} },
          ] as AssistantMessage['message']['content']
          yield withTool
          return
        }
        for (const message of interruptedTurn(`n${call}`, eligibleFailure)) yield message
      },
    }

    const { yielded } = await runQuery(deps, [toolCallTool])

    // 1 interrupted, 2 continuation (tool round), 3 interrupted after the tool
    // round, 4 the second and last continuation, also interrupted. A budget
    // reset on the tool round would let this run on.
    expect(call).toBe(4)
    expect(recoveryNotices(yielded)).toHaveLength(2)
    expect(countApiErrors(yielded)).toBe(1)
  })

  test('a user abort wins over a pending recovery', async () => {
    let call = 0
    let context: ToolUseContext | undefined
    const deps: QueryDeps = {
      uuid: () => 'test-query-chain-id',
      microcompact: async messages => ({ messages }),
      autocompact: async () => ({ wasCompacted: false, consecutiveFailures: 0 }),
      callModel: async function* () {
        call++
        for (const message of interruptedTurn('abort', eligibleFailure)) yield message
        context?.abortController.abort()
      },
    }

    const messages: Message[] = [createUserMessage({ content: 'do the thing' })]
    const toolUseContext = createToolUseContext(messages)
    context = toolUseContext
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
      toolUseContext,
      querySource: 'repl_main_thread',
      deps,
    })) {
      yielded.push(message as Message)
    }

    expect(call).toBe(1)
    expect(recoveryNotices(yielded)).toHaveLength(0)
  })
})
