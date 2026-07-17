import { afterAll, afterEach, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { getDefaultAppState, type AppState } from './state/AppStateStore.js'
import { createFileStateCacheWithSizeLimit } from './utils/fileStateCache.js'
import { createUserMessage } from './utils/messages.js'

const calls: string[] = []
const previousPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'

const actualSessionStorage = await import('./utils/sessionStorage.js')
mock.module('./utils/sessionStorage.js', () => ({
  ...actualSessionStorage,
  recordTranscript: async () => {
    calls.push('record')
  },
  flushCurrentTranscriptDurably: async () => {
    calls.push('durability-barrier')
    throw new Error('injected durability failure')
  },
}))

mock.module('./utils/processUserInput/processUserInput.js', () => ({
  processUserInput: async ({ input, uuid }: { input: string; uuid?: string }) => ({
    messages: [createUserMessage({ content: input, uuid })],
    shouldQuery: true,
    allowedTools: [],
    model: undefined,
    resultText: undefined,
  }),
}))

mock.module('./utils/queryContext.js', () => ({
  fetchSystemPromptParts: async () => ({
    defaultSystemPrompt: [],
    agentModePromptSections: [],
    userContext: {},
    systemContext: {},
  }),
}))

mock.module('./agent-mode/agentMode.js', () => ({
  getAgentModeUserContext: async () => ({}),
}))

mock.module('./query.js', () => ({
  query: async function* () {
    calls.push('provider')
  },
}))

const { QueryEngine } = await import('./QueryEngine.js')

afterEach(() => {
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

afterAll(() => {
  if (previousPersistence === undefined) {
    delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  } else {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = previousPersistence
  }
})
