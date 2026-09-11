import { describe, expect, test } from 'bun:test'

import type { ToolUseContext } from '../../Tool.js'
import type { AppState } from '../../state/AppStateStore.js'
import {
  claimPendingMessagesForRequest,
  completeAgentTask,
  getUnresolvedAgentMessageDeliveries,
  queuePendingMessageIfRunning,
  registerAsyncAgent,
  settleAgentMessageDeliveries,
  settleAgentMessagesForRun,
  settleAgentMessagesForTerminal,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { AssistantMessage, Message } from '../../types/message.js'
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

  test('stale completion cannot mutate a replacement run', () => {
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
    expect(appState.tasks['replacement-worker']?.status).toBe('running')
    expect(appState.tasks['replacement-worker']?.runId).toBe(second.runId)
    expect(
      getUnresolvedAgentMessageDeliveries(
        appState.tasks['replacement-worker'] as never,
      ),
    ).toMatchObject([{ message: 'keep this', status: 'pending' }])
  })
})
