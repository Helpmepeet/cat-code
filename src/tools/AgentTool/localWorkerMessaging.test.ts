import { afterEach, describe, expect, test } from 'bun:test'

import { buildTool, type ToolUseContext } from '../../Tool.js'
import { z } from 'zod/v4'
import {
  getCodexLeaseForOwner,
  resetCodexLeaseManagerForTest,
  seedCodexLeaseForTest,
} from '../../services/api/codexAccountLeaseManager.js'
import {
  getDefaultAppState,
  type AppState,
} from '../../state/AppStateStore.js'
import {
  claimPendingMessagesForRequest,
  completeAgentTask,
  enqueueAgentNotification,
  failAgentTask,
  getUnresolvedAgentMessageDeliveries,
  queuePendingMessageIfRunning,
  registerAsyncAgent,
  settleAgentMessageDeliveries,
  settleAgentMessagesForRun,
  settleAgentMessagesForTerminal,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { AbortError } from '../../utils/errors.js'
import {
  getCommandsByMaxPriority,
  resetCommandQueue,
} from '../../utils/messageQueueManager.js'
import { createUserMessage } from '../../utils/messages.js'
import { SendMessageTool } from '../SendMessageTool/SendMessageTool.js'
import { query } from '../../query.js'
import type { QueryDeps } from '../../query/deps.js'
import type { AgentDefinition } from './loadAgentsDir.js'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

function assistantResponse(text: string, id: string): AssistantMessage {
  return {
    type: 'assistant',
    uuid: id,
    timestamp: new Date().toISOString(),
    message: {
      id,
      model: 'gpt-5.6-luna',
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
    },
  }
}

function ambiguousPartialResponse(id: string): AssistantMessage[] {
  const partial = assistantResponse('partially handled', `${id}-partial`)
  const error = assistantResponse(
    'API Error: Connection interrupted after partial output.',
    `${id}-error`,
  )
  error.isApiErrorMessage = true
  error.apiError = {
    version: 1,
    code: 'partial_stream_replay_skipped',
    provider: 'openai',
    transport: 'websocket',
    cause: 'closed',
    sealedPartialText: true,
    hadClientToolCall: true,
    openClientToolCalls: 1,
    hadHostedWebSearch: false,
    automaticContinuationEligible: false,
  }
  return [partial, error]
}

function toolUseResponse(id: string): AssistantMessage {
  const response = assistantResponse('use a tool', id)
  response.message.content = [
    {
      type: 'tool_use',
      id: 'toolu_local_worker_limit',
      name: 'LocalWorkerProbe',
      input: {},
    },
  ]
  response.message.stop_reason = 'tool_use'
  return response
}

function workerContext(
  getAppState: () => AppState,
  setAppState: (update: (prev: AppState) => AppState) => void,
  agentId: string,
  agentRunId: string,
  abortController: AbortController,
): ToolUseContext {
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'gpt-5.6-luna',
      mainLoopProvider: 'openai',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allowedAgentTypes: [] },
    },
    abortController,
    readFileState: new Map(),
    getAppState,
    setAppState,
    setAppStateForTasks: setAppState,
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: [],
    agentId: agentId as never,
    agentRunId,
    agentType: 'general-purpose',
  } as unknown as ToolUseContext
}

describe('local worker message delivery', () => {
  afterEach(() => {
    resetCodexLeaseManagerForTest()
    resetCommandQueue()
  })

  test('continues a held no-tool completion after SendMessage accepts an instruction', async () => {
    let appState = {
      tasks: {},
      agentNameRegistry: new Map<string, string>(),
      toolPermissionContext: {
        mode: 'default',
        additionalWorkingDirectories: new Map(),
      },
      mcp: { tools: [], clients: [] },
    } as unknown as AppState
    const setAppState = (update: (prev: AppState) => AppState) => {
      appState = update(appState)
    }
    const agentId = 'agent-local-worker-race'
    const selectedAgent = {
      agentType: 'general-purpose',
      whenToUse: 'test worker',
      source: 'built-in',
      baseDir: 'built-in',
      getSystemPrompt: () => 'test worker',
    } as AgentDefinition
    const registered = registerAsyncAgent({
      agentId,
      description: 'local worker race',
      prompt: 'initial work',
      selectedAgent,
      agentName: 'worker-one',
      setAppState,
    })
    appState = {
      ...appState,
      agentNameRegistry: new Map([['worker-one', agentId]]),
    }

    const firstRequestStarted = deferred<void>()
    const firstResponseRelease = deferred<void>()
    const continuationRequestStarted = deferred<void>()
    const continuationResponseRelease = deferred<void>()
    const secondContinuationRequestStarted = deferred<void>()
    const secondContinuationResponseRelease = deferred<void>()
    const requests: Message[][] = []
    let callCount = 0
    const deps: QueryDeps = {
      uuid: () => `query-${callCount}`,
      microcompact: async messages => ({ messages }),
      autocompact: async () => ({
        wasCompacted: false,
        consecutiveFailures: 0,
      }),
      callModel: async function* ({ messages }) {
        requests.push(messages)
        callCount += 1
        if (callCount === 1) {
          firstRequestStarted.resolve()
          await firstResponseRelease.promise
          yield assistantResponse('initial response', 'assistant-initial')
          return
        }
        if (callCount === 2) {
          continuationRequestStarted.resolve()
          await continuationResponseRelease.promise
          yield assistantResponse('continued response', 'assistant-continued')
          return
        }
        secondContinuationRequestStarted.resolve()
        await secondContinuationResponseRelease.promise
        yield assistantResponse('second continued response', 'assistant-continued-2')
      },
    }

    const context = workerContext(
      () => appState,
      setAppState,
      agentId,
      registered.runId,
      registered.abortController!,
    )
    const workerRun = (async () => {
      for await (const message of query({
        messages: [createUserMessage({ content: 'initial work' })],
        systemPrompt: ['test system prompt'] as never,
        userContext: {},
        systemContext: {},
        canUseTool: async () => ({
          behavior: 'allow' as const,
          decisionReason: { type: 'other' as const, reason: 'test' },
        }),
        toolUseContext: context,
        querySource: 'agent:general-purpose',
        maxTurns: 4,
        deps,
      })) {
        void message
      }
      completeAgentTask(
        {
          agentId,
          agentType: 'general-purpose',
          model: 'gpt-5.6-luna',
          content: [{ type: 'text', text: 'completed' }],
          totalToolUseCount: 0,
          totalDurationMs: 1,
          totalTokens: 1,
        },
        setAppState,
      )
    })()

    await firstRequestStarted.promise

    const sendResult = await SendMessageTool.call(
      { to: 'worker-one', summary: 'follow up', message: 'inspect the race' },
      {
        getAppState: () => appState,
        setAppState,
      } as never,
      undefined as never,
      { requestId: 'send-race' } as never,
    )
    expect(sendResult.data.success).toBe(true)

    firstResponseRelease.resolve()
    const outcome = await Promise.race([
      continuationRequestStarted.promise.then(() => 'continued' as const),
      workerRun.then(() => 'completed' as const),
    ])

    expect(outcome).toBe('continued')
    expect(appState.tasks[agentId]?.status).toBe('running')
    expect(requests[1]?.some(message => JSON.stringify(message).includes('inspect the race'))).toBe(true)

    const secondSendResult = await SendMessageTool.call(
      { to: 'worker-one', summary: 'another follow up', message: 'check the newer arrival' },
      {
        getAppState: () => appState,
        setAppState,
      } as never,
      undefined as never,
      { requestId: 'send-race-2' } as never,
    )
    expect(secondSendResult.data.success).toBe(true)
    continuationResponseRelease.resolve()
    await secondContinuationRequestStarted.promise
    expect(
      requests[2]?.some(message =>
        JSON.stringify(message).includes('check the newer arrival'),
      ),
    ).toBe(true)
    expect(appState.tasks[agentId]?.status).toBe('running')
    secondContinuationResponseRelease.resolve()
    await workerRun
    expect(appState.tasks[agentId]?.status).toBe('completed')
    expect(appState.tasks[agentId]?.acceptingMessages).toBe(false)
    const lateSend = await SendMessageTool.call(
      { to: 'worker-one', summary: 'late', message: 'too late for this run' },
      {
        getAppState: () => appState,
        setAppState,
      } as never,
      undefined as never,
      { requestId: 'send-late' } as never,
    )
    expect(lateSend.data.success).toBe(false)
    expect(requests).toHaveLength(3)
  })

  test('no-message completion closes acceptance before terminal status', async () => {
    let appState = {
      tasks: {},
      agentNameRegistry: new Map<string, string>(),
      toolPermissionContext: {
        mode: 'default',
        additionalWorkingDirectories: new Map(),
      },
      mcp: { tools: [], clients: [] },
    } as unknown as AppState
    const setAppState = (update: (prev: AppState) => AppState) => {
      appState = update(appState)
    }
    const agentId = 'agent-local-worker-no-message'
    const selectedAgent = {
      agentType: 'general-purpose',
      whenToUse: 'test worker',
      source: 'built-in',
      baseDir: 'built-in',
      getSystemPrompt: () => 'test worker',
    } as AgentDefinition
    const registered = registerAsyncAgent({
      agentId,
      description: 'local worker completion',
      prompt: 'initial work',
      selectedAgent,
      agentName: 'worker-two',
      setAppState,
    })
    const context = workerContext(
      () => appState,
      setAppState,
      agentId,
      registered.runId,
      registered.abortController!,
    )
    const deps: QueryDeps = {
      uuid: () => 'query-no-message',
      microcompact: async messages => ({ messages }),
      autocompact: async () => ({
        wasCompacted: false,
        consecutiveFailures: 0,
      }),
      callModel: async function* () {
        yield assistantResponse('done', 'assistant-no-message')
      },
    }

    for await (const _message of query({
      messages: [createUserMessage({ content: 'initial work' })],
      systemPrompt: ['test system prompt'] as never,
      userContext: {},
      systemContext: {},
      canUseTool: async () => ({
        behavior: 'allow' as const,
        decisionReason: { type: 'other' as const, reason: 'test' },
      }),
      toolUseContext: context,
      querySource: 'agent:general-purpose',
      deps,
    })) {
      void _message
    }

    expect(appState.tasks[agentId]?.acceptingMessages).toBe(false)
    expect(appState.tasks[agentId]?.status).toBe('running')
  })

  test('keeps exact outcomes for submitted, prepared, and newer instructions', () => {
    let appState = {
      tasks: {
        worker: {
          id: 'worker',
          type: 'local_agent',
          status: 'running',
          agentId: 'worker',
          agentType: 'general-purpose',
          runId: 'run-1',
          acceptingMessages: true,
          pendingMessages: [
            {
              id: 'message-1',
              message: 'first',
              status: 'pending',
              acceptedAt: 1,
            },
          ],
        },
      },
    } as unknown as AppState
    const setAppState = (update: (prev: AppState) => AppState) => {
      appState = update(appState)
    }

    const [prepared] = claimPendingMessagesForRequest(
      'worker',
      'run-1',
      setAppState,
    )
    expect(prepared?.status).toBe('prepared')
    queuePendingMessageIfRunning('worker', 'newer', setAppState)
    settleAgentMessageDeliveries(
      'worker',
      [prepared!.id],
      'run-1',
      'delivered',
      'valid response',
      setAppState,
    )
    const pendingNewer = getUnresolvedAgentMessageDeliveries(
      appState.tasks.worker as never,
    )
    expect(pendingNewer.map(message => message.message)).toEqual(['newer'])

    const [preparedNewer] = claimPendingMessagesForRequest(
      'worker',
      'run-1',
      setAppState,
    )
    settleAgentMessagesForRun(
      'worker',
      'run-1',
      'undelivered',
      'request preparation failed',
      setAppState,
    )
    expect(appState.tasks.worker.pendingMessages).toMatchObject([
      {
        id: preparedNewer!.id,
        status: 'undelivered',
        outcome: 'request preparation failed',
      },
    ])
    queuePendingMessageIfRunning('worker', 'budget limited', setAppState)
    const [preparedForBudget] = claimPendingMessagesForRequest(
      'worker',
      'run-1',
      setAppState,
    )
    settleAgentMessagesForTerminal(
      'worker',
      'run-1',
      'turn budget exhausted',
      setAppState,
    )
    expect(
      appState.tasks.worker.pendingMessages.find(
        (message: { id: string }) => message.id === preparedForBudget!.id,
      ),
    ).toMatchObject({
      status: 'undelivered',
      outcome: 'turn budget exhausted',
    })
  })

  test('routes unresolved terminal outcomes to the local worker that sent them', async () => {
    let appState = {
      tasks: {},
      agentNameRegistry: new Map<string, string>(),
      toolPermissionContext: {
        mode: 'default',
        additionalWorkingDirectories: new Map(),
      },
      mcp: { tools: [], clients: [] },
    } as unknown as AppState
    const setAppState = (update: (prev: AppState) => AppState) => {
      appState = update(appState)
    }
    const selectedAgent = {
      agentType: 'general-purpose',
      whenToUse: 'test worker',
      source: 'built-in',
      baseDir: 'built-in',
      getSystemPrompt: () => 'test worker',
    } as AgentDefinition
    const sender = registerAsyncAgent({
      agentId: 'worker-a',
      description: 'sender',
      prompt: 'send work',
      selectedAgent,
      agentName: 'worker-a',
      setAppState,
    })
    const recipient = registerAsyncAgent({
      agentId: 'worker-b',
      description: 'recipient',
      prompt: 'receive work',
      selectedAgent,
      agentName: 'worker-b',
      setAppState,
    })
    appState = {
      ...appState,
      agentNameRegistry: new Map([
        ['worker-a', sender.agentId as never],
        ['worker-b', recipient.agentId as never],
      ]),
    }

    const sendResult = await SendMessageTool.call(
      {
        to: 'worker-b',
        summary: 'send follow up',
        message: 'worker-a private follow-up',
      },
      {
        agentId: sender.agentId,
        getAppState: () => appState,
        setAppState,
        setAppStateForTasks: setAppState,
      } as never,
      undefined as never,
      { requestId: 'send-worker-to-worker' } as never,
    )
    expect(sendResult.data.success).toBe(true)
    expect(appState.tasks[recipient.agentId]?.pendingMessages).toMatchObject([
      {
        message: 'worker-a private follow-up',
        originAgentId: sender.agentId,
      },
    ])

    completeAgentTask(
      {
        agentId: recipient.agentId,
        content: [{ type: 'text', text: 'recipient completed' }],
        totalToolUseCount: 0,
        totalDurationMs: 1,
        totalTokens: 1,
      },
      setAppState,
      recipient.runId,
    )
    appState = {
      ...appState,
      speculation: getDefaultAppState().speculation,
    }
    enqueueAgentNotification({
      taskId: recipient.agentId,
      description: 'recipient',
      status: 'completed',
      setAppState,
      finalMessage: 'recipient completed',
      runId: recipient.runId,
    })

    const notifications = getCommandsByMaxPriority('later')
    const senderNotification = notifications.find(
      notification => notification.agentId === sender.agentId,
    )
    const mainNotification = notifications.find(
      notification => notification.agentId === undefined,
    )
    expect(senderNotification?.value).toContain('worker-a private follow-up')
    expect(mainNotification?.value).not.toContain('worker-a private follow-up')
    expect(
      getUnresolvedAgentMessageDeliveries(
        appState.tasks[recipient.agentId] as never,
      ),
    ).toEqual([])
  })

  test('cancellation during a continuation leaves its exact submission uncertain', async () => {
    let appState = {
      tasks: {},
      agentNameRegistry: new Map<string, string>(),
      toolPermissionContext: {
        mode: 'default',
        additionalWorkingDirectories: new Map(),
      },
      mcp: { tools: [], clients: [] },
    } as unknown as AppState
    const setAppState = (update: (prev: AppState) => AppState) => {
      appState = update(appState)
    }
    appState = { ...appState, sessionHooks: new Map() }
    const agentId = 'agent-local-worker-cancel'
    const selectedAgent = {
      agentType: 'general-purpose',
      whenToUse: 'test worker',
      source: 'built-in',
      baseDir: 'built-in',
      getSystemPrompt: () => 'test worker',
    } as AgentDefinition
    const registered = registerAsyncAgent({
      agentId,
      description: 'cancel continuation',
      prompt: 'initial work',
      selectedAgent,
      agentName: 'worker-cancel',
      setAppState,
    })
    appState = {
      ...appState,
      agentNameRegistry: new Map([['worker-cancel', agentId as never]]),
    }

    const firstRequestStarted = deferred<void>()
    const firstResponseRelease = deferred<void>()
    const continuationStarted = deferred<void>()
    const continuationRelease = deferred<void>()
    let callCount = 0
    const deps: QueryDeps = {
      uuid: () => `cancel-request-${callCount}`,
      microcompact: async messages => ({ messages }),
      autocompact: async () => ({
        wasCompacted: false,
        consecutiveFailures: 0,
      }),
      callModel: async function* ({ signal }) {
        callCount += 1
        if (callCount === 1) {
          firstRequestStarted.resolve()
          await firstResponseRelease.promise
          yield assistantResponse('initial response', 'cancel-initial')
          return
        }
        continuationStarted.resolve()
        await continuationRelease.promise
        if (signal.aborted) throw new AbortError()
      },
    }
    const context = workerContext(
      () => appState,
      setAppState,
      agentId,
      registered.runId,
      registered.abortController!,
    )
    const lifecycle = (async () => {
      const iterator = query({
        messages: [createUserMessage({ content: 'initial work' })],
        systemPrompt: ['test system prompt'] as never,
        userContext: {},
        systemContext: {},
        canUseTool: async () => ({
          behavior: 'allow' as const,
          decisionReason: { type: 'other' as const, reason: 'test' },
        }),
        toolUseContext: context,
        querySource: 'agent:general-purpose',
        deps,
      })
      for (;;) {
        const next = await iterator.next()
        if (next.done) return next.value
      }
    })()

    await firstRequestStarted.promise
    await SendMessageTool.call(
      {
        to: 'worker-cancel',
        summary: 'cancel follow up',
        message: 'instruction interrupted by cancellation',
      },
      {
        getAppState: () => appState,
        setAppState,
      } as never,
      undefined as never,
      { requestId: 'send-before-cancel' } as never,
    )
    const deliveryId = appState.tasks[agentId]?.pendingMessages[0]?.id
    firstResponseRelease.resolve()
    await continuationStarted.promise
    registered.abortController!.abort('test cancellation')
    continuationRelease.resolve()

    await expect(lifecycle).resolves.toMatchObject({ reason: 'model_error' })
    expect(callCount).toBe(2)
    expect(appState.tasks[agentId]?.pendingMessages).toMatchObject([
      {
        id: deliveryId,
        status: 'uncertain',
        reported: false,
      },
    ])
  })

  test('an ambiguous partial continuation is not replayed and stays uncertain', async () => {
    let appState = {
      tasks: {},
      agentNameRegistry: new Map<string, string>(),
      toolPermissionContext: {
        mode: 'default',
        additionalWorkingDirectories: new Map(),
      },
      mcp: { tools: [], clients: [] },
    } as unknown as AppState
    const setAppState = (update: (prev: AppState) => AppState) => {
      appState = update(appState)
    }
    appState = { ...appState, sessionHooks: new Map() }
    const agentId = 'agent-local-worker-partial'
    const selectedAgent = {
      agentType: 'general-purpose',
      whenToUse: 'test worker',
      source: 'built-in',
      baseDir: 'built-in',
      getSystemPrompt: () => 'test worker',
    } as AgentDefinition
    const registered = registerAsyncAgent({
      agentId,
      description: 'partial continuation',
      prompt: 'initial work',
      selectedAgent,
      agentName: 'worker-partial',
      setAppState,
    })
    appState = {
      ...appState,
      agentNameRegistry: new Map([['worker-partial', agentId as never]]),
    }

    const firstRequestStarted = deferred<void>()
    const firstResponseRelease = deferred<void>()
    const requests: Message[][] = []
    let callCount = 0
    const deps: QueryDeps = {
      uuid: () => `partial-request-${callCount}`,
      microcompact: async messages => ({ messages }),
      autocompact: async () => ({
        wasCompacted: false,
        consecutiveFailures: 0,
      }),
      callModel: async function* ({ messages }) {
        requests.push(messages)
        callCount += 1
        if (callCount === 1) {
          firstRequestStarted.resolve()
          await firstResponseRelease.promise
          yield assistantResponse('initial response', 'partial-initial')
          return
        }
        for (const message of ambiguousPartialResponse('local-worker')) {
          yield message
        }
      },
    }
    const context = workerContext(
      () => appState,
      setAppState,
      agentId,
      registered.runId,
      registered.abortController!,
    )
    const lifecycle = (async () => {
      for await (const _message of query({
        messages: [createUserMessage({ content: 'initial work' })],
        systemPrompt: ['test system prompt'] as never,
        userContext: {},
        systemContext: {},
        canUseTool: async () => ({
          behavior: 'allow' as const,
          decisionReason: { type: 'other' as const, reason: 'test' },
        }),
        toolUseContext: context,
        querySource: 'agent:general-purpose',
        deps,
      })) {
        void _message
      }
    })()

    await firstRequestStarted.promise
    await SendMessageTool.call(
      {
        to: 'worker-partial',
        summary: 'partial follow up',
        message: 'do not replay this instruction',
      },
      {
        getAppState: () => appState,
        setAppState,
      } as never,
      undefined as never,
      { requestId: 'send-before-partial' } as never,
    )
    const deliveryId = appState.tasks[agentId]?.pendingMessages[0]?.id
    firstResponseRelease.resolve()
    await lifecycle

    expect(callCount).toBe(2)
    expect(
      requests[1]?.some(message =>
        JSON.stringify(message).includes('do not replay this instruction'),
      ),
    ).toBe(true)
    expect(appState.tasks[agentId]?.pendingMessages).toMatchObject([
      {
        id: deliveryId,
        status: 'uncertain',
        outcome: 'The request ended without a valid provider response.',
        reported: false,
      },
    ])
  })

  test('max turns does not emit a prepared instruction or make another request', async () => {
    let appState = {
      tasks: {},
      agentNameRegistry: new Map<string, string>(),
      toolPermissionContext: {
        mode: 'default',
        additionalWorkingDirectories: new Map(),
      },
      mcp: { tools: [], clients: [] },
    } as unknown as AppState
    const setAppState = (update: (prev: AppState) => AppState) => {
      appState = update(appState)
    }
    appState = { ...appState, sessionHooks: new Map() }
    const agentId = 'agent-local-worker-max-turn'
    const selectedAgent = {
      agentType: 'general-purpose',
      whenToUse: 'test worker',
      source: 'built-in',
      baseDir: 'built-in',
      getSystemPrompt: () => 'test worker',
    } as AgentDefinition
    const registered = registerAsyncAgent({
      agentId,
      description: 'max turn continuation',
      prompt: 'initial work',
      selectedAgent,
      agentName: 'worker-max-turn',
      setAppState,
    })
    appState = {
      ...appState,
      agentNameRegistry: new Map([['worker-max-turn', agentId as never]]),
    }
    const firstRequestStarted = deferred<void>()
    const firstResponseRelease = deferred<void>()
    let callCount = 0
    const deps: QueryDeps = {
      uuid: () => `max-turn-request-${callCount}`,
      microcompact: async messages => ({ messages }),
      autocompact: async () => ({
        wasCompacted: false,
        consecutiveFailures: 0,
      }),
      callModel: async function* () {
        callCount += 1
        firstRequestStarted.resolve()
        await firstResponseRelease.promise
        yield toolUseResponse('max-turn-initial')
      },
    }
    const context = workerContext(
      () => appState,
      setAppState,
      agentId,
      registered.runId,
      registered.abortController!,
    )
    context.options.tools = [
      buildTool({
        name: 'LocalWorkerProbe',
        description: 'test tool',
        inputSchema: z.object({}),
        async *call() {
          yield { type: 'result' as const, data: 'done' }
        },
      }),
    ]
    const yielded: Array<{
      type?: string
      attachment?: { commandMode?: string }
    }> = []
    const lifecycle = (async () => {
      const iterator = query({
        messages: [createUserMessage({ content: 'initial work' })],
        systemPrompt: ['test system prompt'] as never,
        userContext: {},
        systemContext: {},
        canUseTool: async () => ({
          behavior: 'allow' as const,
          decisionReason: { type: 'other' as const, reason: 'test' },
        }),
        toolUseContext: context,
        querySource: 'agent:general-purpose',
        maxTurns: 1,
        deps,
      })
      for (;;) {
        const next = await iterator.next()
        if (next.done) return next.value
        yielded.push(next.value as never)
      }
    })()

    await firstRequestStarted.promise
    await SendMessageTool.call(
      {
        to: 'worker-max-turn',
        summary: 'limit follow up',
        message: 'instruction blocked by max turns',
      },
      {
        getAppState: () => appState,
        setAppState,
      } as never,
      undefined as never,
      { requestId: 'send-before-limit' } as never,
    )
    const deliveryId = appState.tasks[agentId]?.pendingMessages[0]?.id
    firstResponseRelease.resolve()
    await expect(lifecycle).resolves.toMatchObject({ reason: 'max_turns' })

    expect(callCount).toBe(1)
    expect(
      yielded.filter(
        message =>
          message.type === 'attachment' &&
          message.attachment?.commandMode === 'local-agent-message',
      ),
    ).toEqual([])
    expect(appState.tasks[agentId]?.pendingMessages).toMatchObject([
      {
        id: deliveryId,
        status: 'undelivered',
        outcome:
          'The turn budget was exhausted before the instruction was submitted.',
      },
    ])
  })

  test('stale completion or failure cannot mutate or release a replacement run', () => {
    let appState = { tasks: {} } as unknown as AppState
    const setAppState = (update: (prev: AppState) => AppState) => {
      appState = update(appState)
    }
    const selectedAgent = {
      agentType: 'general-purpose',
      whenToUse: 'test worker',
      source: 'built-in',
      baseDir: 'built-in',
      getSystemPrompt: () => 'test worker',
    } as AgentDefinition
    const first = registerAsyncAgent({
      agentId: 'replacement-worker',
      description: 'replacement',
      prompt: 'first',
      selectedAgent,
      setAppState,
    })
    queuePendingMessageIfRunning('replacement-worker', 'keep this', setAppState)
    const second = registerAsyncAgent({
      agentId: 'replacement-worker',
      description: 'replacement',
      prompt: 'second',
      selectedAgent,
      setAppState,
    })
    seedCodexLeaseForTest({
      ownerId: 'replacement-worker',
      ownerType: 'subagent',
      ownerLabel: 'replacement',
      accountId: 'replacement-account',
    })

    completeAgentTask(
      {
        agentId: 'replacement-worker',
        agentType: 'general-purpose',
        model: 'gpt-5.6-luna',
        content: [{ type: 'text', text: 'stale' }],
        totalToolUseCount: 0,
        totalDurationMs: 1,
        totalTokens: 1,
      },
      setAppState,
      first.runId,
    )
    expect(getCodexLeaseForOwner('replacement-worker')).toBeDefined()
    failAgentTask(
      'replacement-worker',
      'stale failure',
      setAppState,
      first.runId,
    )
    expect(getCodexLeaseForOwner('replacement-worker')).toBeDefined()
    expect(appState.tasks['replacement-worker']?.status).toBe('running')
    expect(appState.tasks['replacement-worker']?.runId).toBe(second.runId)
    expect(
      getUnresolvedAgentMessageDeliveries(
        appState.tasks['replacement-worker'] as never,
      ),
    ).toMatchObject([{ message: 'keep this', status: 'pending' }])
  })
})
