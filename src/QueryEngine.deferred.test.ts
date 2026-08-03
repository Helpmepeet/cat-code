import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { getDefaultAppState, type AppState } from './state/AppStateStore.js'
import { createFileStateCacheWithSizeLimit } from './utils/fileStateCache.js'
import { createUserMessage } from './utils/messages.js'
import type { Message } from './types/message.js'

const calls: string[] = []

// Every mock spreads the real module: bun installs mock.module during the
// import phase of every file in the invocation and never restores it, so a
// replacement that drops exports breaks unrelated importers. Spreading is not
// enough on its own, because a stub that is always live also rewrites behaviour
// other suites assert on. Each stub is therefore gated on this file's own tests
// being in flight; every other file in the same run gets the real function. The
// real implementation must be captured into a local binding BEFORE the mock is
// installed, because mock.module rewrites the live namespace object and reading
// it back off the namespace afterwards yields the stub. The transcript writers
// are injected through QueryEngineConfig rather than mocked at all, because
// stubbing sessionStorage.js this way silently disarmed the durable-barrier
// coverage in the sibling deferred-continuation suites.
let stubsActive = false

const actualProcessUserInput = await import(
  './utils/processUserInput/processUserInput.js'
)
const realProcessUserInput = actualProcessUserInput.processUserInput
mock.module('./utils/processUserInput/processUserInput.js', () => ({
  ...actualProcessUserInput,
  processUserInput: async (
    ...args: Parameters<typeof realProcessUserInput>
  ) => {
    if (!stubsActive) return realProcessUserInput(...args)
    const { input, uuid } = args[0] as unknown as {
      input: string
      uuid?: string
    }
    return {
      messages: [createUserMessage({ content: input, uuid })],
      shouldQuery: true,
      allowedTools: [],
      model: undefined,
      resultText: undefined,
    }
  },
}))

const actualQueryContext = await import('./utils/queryContext.js')
const realFetchSystemPromptParts = actualQueryContext.fetchSystemPromptParts
mock.module('./utils/queryContext.js', () => ({
  ...actualQueryContext,
  fetchSystemPromptParts: async (
    ...args: Parameters<typeof realFetchSystemPromptParts>
  ) => {
    if (!stubsActive) return realFetchSystemPromptParts(...args)
    return {
      defaultSystemPrompt: [],
      agentModePromptSections: [],
      userContext: {},
      systemContext: {},
    }
  },
}))

const actualAgentMode = await import('./agent-mode/agentMode.js')
const realGetAgentModeUserContext = actualAgentMode.getAgentModeUserContext
mock.module('./agent-mode/agentMode.js', () => ({
  ...actualAgentMode,
  getAgentModeUserContext: async (
    ...args: Parameters<typeof realGetAgentModeUserContext>
  ) => (stubsActive ? {} : realGetAgentModeUserContext(...args)),
}))

const actualQuery = await import('./query.js')
const realQuery = actualQuery.query
mock.module('./query.js', () => ({
  ...actualQuery,
  query: async function* (...args: Parameters<typeof realQuery>) {
    if (!stubsActive) {
      yield* realQuery(...args)
      return
    }
    calls.push('provider')
  },
}))

const { QueryEngine } = await import('./QueryEngine.js')

beforeEach(() => {
  stubsActive = true
})

afterEach(() => {
  stubsActive = false
  calls.length = 0
})

test('a public deferred submit cannot enter the provider before UUID durability succeeds', async () => {
  const attemptUuid = randomUUID()
  let state: AppState = getDefaultAppState()
  const engine = new QueryEngine({
    cwd: process.cwd(),
    tools: [],
    commands: [],
    mcpClients: [],
    agents: [],
    canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
    getAppState: () => state,
    setAppState: update => {
      state = update(state)
    },
    initialMessages: [],
    readFileCache: createFileStateCacheWithSizeLimit(20),
    customSystemPrompt: '',
    deferredAttemptUuid: attemptUuid,
    deferredJobId: randomUUID(),
    recordTranscript: async () => {
      calls.push('record')
      return null
    },
    flushCurrentTranscriptDurably: async () => {
      calls.push('durability-barrier')
      throw new Error('injected durability failure')
    },
  })

  await expect(
    (async () => {
      for await (const _message of engine.submitMessage('continue safely', {
        uuid: attemptUuid,
        isMeta: false,
      })) {
        // The injected durability failure occurs before any yielded provider data.
      }
    })(),
  ).rejects.toThrow('injected durability failure')

  expect(calls).toEqual(['record', 'durability-barrier'])
  expect(calls).not.toContain('provider')
})

test('a task notification origin is persisted before the sidecar acknowledgement', async () => {
  let state: AppState = getDefaultAppState()
  let persisted: Message[] = []
  let acknowledgementSawPersistedOrigin = false
  const engine = new QueryEngine({
    cwd: process.cwd(),
    tools: [],
    commands: [],
    mcpClients: [],
    agents: [],
    canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
    getAppState: () => state,
    setAppState: update => {
      state = update(state)
    },
    initialMessages: [],
    readFileCache: createFileStateCacheWithSizeLimit(20),
    customSystemPrompt: '',
    recordTranscript: async messages => {
      persisted = messages
      return null
    },
  })

  try {
    for await (const _message of engine.submitMessage('worker result', {
      origin: {
        kind: 'task-notification',
        taskId: 'worker-1',
        summary: 'Agent @Ada completed',
        result: 'done',
      },
      onInputPersisted: () => {
        acknowledgementSawPersistedOrigin = persisted.some(
          message =>
            message.type === 'user' &&
            message.origin?.kind === 'task-notification' &&
            message.origin.taskId === 'worker-1',
        )
      },
    })) {
      // The test needs only the pre-provider persistence boundary.
    }
  } catch {
    // This isolated engine fixture deliberately has no provider credentials.
  }

  expect(acknowledgementSawPersistedOrigin).toBe(true)
})
