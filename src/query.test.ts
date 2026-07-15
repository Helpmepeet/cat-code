import { afterEach, describe, expect, test } from 'bun:test'
import type { ToolUseContext } from './Tool.js'
import { query } from './query.js'
import type { QueryDeps } from './query/deps.js'
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
    const originalMessages: Message[] = [
      originalUserMessage,
      createAssistantMessage('pre compact assistant text', 'assistant-before-compact'),
    ]

    const compactBoundary: SystemMessage = {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'compact-boundary',
      timestamp: '2026-05-05T00:00:01.000Z',
      compactMetadata: {
        trigger: 'auto',
        preTokens: 240_000,
      },
    }
    const compactSummary = createUserMessage({
      content: 'post compact summary text',
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    })
    const compactionResult: CompactionResult = {
      boundaryMarker: compactBoundary,
      summaryMessages: [compactSummary],
      attachments: [],
      hookResults: [],
      preCompactTokenCount: 240_000,
      truePostCompactTokenCount: 1_000,
    }
    const expectedPostCompactMessages = [compactBoundary, compactSummary]

    let capturedMessages: Message[] | undefined
    let capturedOpenAIInputMessages: Message[] | undefined

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
