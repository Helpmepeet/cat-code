import { test, expect, mock } from 'bun:test'
import { mkdtempSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

const fixtureRoot = mkdtempSync(join(tmpdir(), 'resume-delivery-review-'))
process.env.CLAUDE_CONFIG_DIR = join(fixtureRoot, 'config')
process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
delete process.env.CLAUDE_CODE_COORDINATOR_MODE

const contextModule = await import('../../context.js')
mock.module('../../context.js', () => ({
  ...contextModule,
  getUserContext: async () => ({}),
  getSystemContext: async () => ({}),
}))
const queryModule = await import('../../query.js')
const realQuery = queryModule.query
let deps: any
mock.module('../../query.js', () => ({
  ...queryModule,
  query: (params: any) => realQuery({ ...params, deps }),
}))
const lifecycleModule = await import('../../tools/AgentTool/agentToolUtils.js')
const realLifecycle = lifecycleModule.runAsyncAgentLifecycle
const lifecycles: Promise<void>[] = []
mock.module('../../tools/AgentTool/agentToolUtils.js', () => ({
  ...lifecycleModule,
  runAsyncAgentLifecycle: (params: any) => {
    const promise = realLifecycle(params)
    lifecycles.push(promise)
    return promise
  },
}))

const { resetStateForTests, switchSession } = await import('../../bootstrap/state.js')
const { getEmptyToolPermissionContext } = await import('../../Tool.js')
const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { asAgentId, asSessionId } = await import('../../types/ids.js')
const { createAgentId } = await import('../../utils/uuid.js')
const { createUserMessage, createAssistantMessage } = await import('../../utils/messages.js')
const storage = await import('../../utils/sessionStorage.js')
const diskOutput = await import('../../utils/task/diskOutput.js')
const { enqueuePendingNotification, resetCommandQueue } = await import('../../utils/messageQueueManager.js')
const { ResumeAgentTool } = await import('../../tools/ResumeAgentTool/ResumeAgentTool.js')
const { SendMessageTool } = await import('../../tools/SendMessageTool/SendMessageTool.js')

test('a delivered SendMessage instruction remains available on the next ResumeAgent call', async () => {
  const fact = 'The cache directory for this work is violet-733.'
  const priorOutcome = 'Undelivered: violet-worker-outcome-914'
  const requests: string[] = []
  const agentId = createAgentId('review-resume')
  resetStateForTests()
  storage.resetProjectForTesting()
  switchSession(asSessionId(randomUUID()), join(fixtureRoot, 'sessions'))
  storage.clearSessionMessagesCache()
  const fixtureAgent = {
    agentType: 'review-fixture',
    whenToUse: 'fixture only',
    source: 'built-in',
    baseDir: 'built-in',
    tools: [],
    getSystemPrompt: () => 'Review fixture. Return concise results.',
  }
  let state: any = {
    ...getDefaultAppState(),
    toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'acceptEdits' },
    mcp: { tools: [], clients: [] },
    tasks: {},
    todos: {},
    sessionHooks: new Map(),
    agentNameRegistry: new Map(),
    agentDefinitions: { activeAgents: [fixtureAgent], allAgents: [fixtureAgent] },
  }
  const setAppState = (update: any) => { state = update(state) }
  const context: any = {
    toolUseId: 'toolu-review-resume',
    getAppState: () => state,
    setAppState,
    setAppStateForTasks: setAppState,
    abortController: new AbortController(),
    readFileState: new Map(),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    options: {
      tools: [], commands: [], mcpClients: [], mcpResources: {},
      debug: false, verbose: false, isNonInteractiveSession: true,
      thinkingConfig: { type: 'disabled' },
      mainLoopModel: 'gpt-5.6-luna', mainLoopProvider: 'openai',
      agentDefinitions: state.agentDefinitions,
    },
  }
  let sendAccepted = false
  deps = {
    uuid: () => randomUUID(),
    microcompact: async (messages: any) => ({ messages }),
    autocompact: async () => ({ wasCompacted: false, consecutiveFailures: 0 }),
    callModel: async function* ({ messages }: any) {
      requests.push(JSON.stringify(messages))
      if (requests.length === 1) {
        const result = await SendMessageTool.call(
          { to: 'review-worker', summary: 'cache directory instruction', message: fact },
          context, undefined as never, { requestId: 'fixture-send' } as never,
        )
        sendAccepted = result.data.success
      }
      yield createAssistantMessage({ content: `Acknowledged round ${requests.length}.` })
    },
  }
  try {
    await storage.recordSidechainTranscript([
      createUserMessage({ content: 'Begin the fixture task.' }),
    ], agentId)
    await storage.flushSessionStorage()
    await storage.writeAgentMetadata(asAgentId(agentId), {
      agentType: fixtureAgent.agentType, agentName: 'review-worker', description: 'fixture',
    })
    enqueuePendingNotification({
      value: priorOutcome,
      mode: 'task-notification',
      agentId: asAgentId(agentId),
      isMeta: true,
    })

    const first = await ResumeAgentTool.call(
      { agentId: 'review-worker', prompt: 'Continue the fixture task.' },
      context, (async () => ({ behavior: 'allow' })) as never,
      { requestId: 'first-resume' } as never,
    )
    expect(first.data.success).toBe(true)
    await lifecycles.at(-1)
    await storage.flushSessionStorage()
    expect(requests[0]).toContain(priorOutcome)
    expect(sendAccepted).toBe(true)
    expect(requests).toHaveLength(2)
    expect(requests[1]).toContain(fact)
    expect(state.tasks[agentId].status).toBe('completed')
    expect(state.tasks[agentId].pendingMessages).toHaveLength(0)

    const firstTranscript = await storage.getAgentTranscript(asAgentId(agentId))
    const second = await ResumeAgentTool.call(
      { agentId: 'review-worker', prompt: 'Use the cache directory you were told in the previous run.' },
      context, (async () => ({ behavior: 'allow' })) as never,
      { requestId: 'second-resume' } as never,
    )
    expect(second.data.success).toBe(true)
    await lifecycles.at(-1)
    await storage.flushSessionStorage()
    expect(requests).toHaveLength(3)
    console.log(JSON.stringify({
      sendAccepted,
      followupReachedFirstRun: requests[1]?.includes(fact),
      deliveredRecordRemoved: state.tasks[agentId].pendingMessages.length === 0,
      savedTranscriptHasFact: JSON.stringify(firstTranscript).includes(fact),
      nextResumeHasFact: requests[2]?.includes(fact),
    }))
    expect(requests[2]?.includes(fact)).toBe(true)
  } finally {
    await storage.flushSessionStorage()
    storage.clearSessionMessagesCache()
    storage.resetProjectForTesting()
    await diskOutput._clearOutputsForTest()
    diskOutput._resetTaskOutputDirForTest()
    resetCommandQueue()
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})
