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
