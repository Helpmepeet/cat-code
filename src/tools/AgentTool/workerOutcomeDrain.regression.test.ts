import { test, expect } from 'bun:test'
import { mkdtempSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { z } from 'zod/v4'
const fixtureRoot = mkdtempSync(join(tmpdir(), 'worker-outcome-review-'))
process.env.CLAUDE_CONFIG_DIR = fixtureRoot
const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { registerAsyncAgent, registerAgentForeground, failAgentTask, enqueueAgentNotification } = await import('../../tasks/LocalAgentTask/LocalAgentTask.js')
const { SendMessageTool } = await import('../../tools/SendMessageTool/SendMessageTool.js')
const { getCommandQueue, resetCommandQueue, remove, enqueuePendingNotification } = await import('../../utils/messageQueueManager.js')
const { createAssistantMessage, createUserMessage } = await import('../../utils/messages.js')
const { asAgentId } = await import('../../types/ids.js')
const { buildTool } = await import('../../Tool.js')
const { query } = await import('../../query.js')
const diskOutput = await import('../../utils/task/diskOutput.js')

for (const withTool of [true, false]) test(`a worker receives its delivery-failure report ${withTool ? 'during normal tool rounds' : 'after a no-tool completion'}`, async () => {
  let state = getDefaultAppState()
  const setAppState = (update: any) => { state = update(state) }
  const selectedAgent: any = {
    agentType: 'general-purpose', source: 'built-in', baseDir: 'built-in',
    whenToUse: 'fixture only', getSystemPrompt: () => 'fixture',
  }
  const requests: string[] = []
  try {
    const sender = registerAgentForeground({
      agentId: 'sender-worker', description: 'sender', prompt: 'help sibling',
      selectedAgent, agentName: 'sender', setAppState,
    })
    const recipient = registerAsyncAgent({
      agentId: 'recipient-worker', description: 'recipient', prompt: 'assigned work',
      selectedAgent, agentName: 'recipient', setAppState,
    })
    state = { ...state, agentNameRegistry: new Map([['recipient', asAgentId(recipient.agentId)]]) }
    const context: any = {
      getAppState: () => state, setAppState, setAppStateForTasks: setAppState,
      agentId: asAgentId(sender.taskId), agentRunId: sender.runId,
      agentType: 'general-purpose', abortController: sender.abortController,
      readFileState: new Map(), setInProgressToolUseIDs: () => {},
      setResponseLength: () => {}, updateFileHistoryState: () => {},
      updateAttributionState: () => {}, messages: [],
      options: {
        tools: [buildTool({
          name: 'ReviewNop', description: 'fixture tool', inputSchema: z.object({}),
          async *call() { yield { type: 'result' as const, data: 'done' } },
        })], commands: [], mcpClients: [], mcpResources: {},
        debug: false, verbose: false, isNonInteractiveSession: true,
        thinkingConfig: { type: 'disabled' },
        mainLoopModel: 'gpt-5.6-luna', mainLoopProvider: 'openai',
        agentDefinitions: { activeAgents: [], allAgents: [] },
      },
    }
    const instruction = 'Check the violet fixture invariant.'
    const sent = await SendMessageTool.call({
      to: 'recipient', summary: 'check sibling invariant', message: instruction,
    }, context, undefined as never, { requestId: 'fixture-send' } as never)
    expect(sent.data.success).toBe(true)
    failAgentTask(recipient.agentId, 'fixture stopped before receipt', setAppState, recipient.runId)
    enqueueAgentNotification({
      taskId: recipient.agentId, description: 'recipient', status: 'failed',
      error: 'fixture stopped before receipt', setAppState, runId: recipient.runId,
    })
    const targeted = getCommandQueue().filter(command => command.agentId === sender.taskId)
    expect(targeted).toHaveLength(1)
    expect(String(targeted[0]?.value)).toContain('Undelivered:')
    if (process.env.REVIEW_OUTCOME_PRIORITY_NEXT === '1') {
      remove(targeted)
      for (const command of targeted) enqueuePendingNotification({ ...command, priority: 'next' })
    }
    const effectivePriority = getCommandQueue().find(command => command.agentId === sender.taskId)?.priority
    const deps: any = {
      uuid: () => randomUUID(),
      microcompact: async (messages: any) => ({ messages }),
      autocompact: async () => ({ wasCompacted: false, consecutiveFailures: 0 }),
      callModel: async function* ({ messages }: any) {
        requests.push(JSON.stringify(messages))
        const message = createAssistantMessage({ content: 'Finished.' })
        if (withTool && requests.length === 1) {
          message.message.content = [{ type: 'tool_use', name: 'ReviewNop', id: 'fixture-tool', input: {} }]
          message.message.stop_reason = 'tool_use'
        }
        yield message
      },
    }
    for await (const message of query({
      messages: [createUserMessage({ content: 'Continue my own work.' })],
      systemPrompt: ['fixture'] as never, userContext: {}, systemContext: {},
      canUseTool: (async () => ({ behavior: 'allow', decisionReason: { type: 'other', reason: 'fixture' } })) as never,
      toolUseContext: context, querySource: 'agent:general-purpose', maxTurns: 3, deps,
    })) { void message }
    const pendingAfter = getCommandQueue().filter(command => command.agentId === sender.taskId)
    const reportReachedModel = requests.some(request => request.includes('Undelivered:'))
    console.log(JSON.stringify({ modelRequests: requests.length, targetedPriority: effectivePriority, reportReachedModel, targetedReportsStillQueued: pendingAfter.length }))
    expect(requests).toHaveLength(2)
    expect(reportReachedModel).toBe(true)
  } finally {
    resetCommandQueue()
    await diskOutput._clearOutputsForTest()
    diskOutput._resetTaskOutputDirForTest()
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})
