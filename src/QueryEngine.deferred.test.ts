import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { getDefaultAppState, type AppState } from './state/AppStateStore.js'
import { createFileStateCacheWithSizeLimit } from './utils/fileStateCache.js'
import { createUserMessage } from './utils/messages.js'
import type {
  AssistantMessage,
  Message,
  SystemCompactBoundaryMessage,
} from './types/message.js'

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
let queryMessages: Message[] = []

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
      userContext: {},
      systemContext: {},
    }
  },
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
    yield* queryMessages
  },
}))

const { QueryEngine } = await import('./QueryEngine.js')

beforeEach(() => {
  stubsActive = true
})

afterEach(() => {
  stubsActive = false
  calls.length = 0
  queryMessages = []
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

test('preserved compaction messages are not emitted as new SDK activity', async () => {
  let state: AppState = getDefaultAppState()
  const persistedSnapshots: Message[][] = []
  const preservedUser = createUserMessage({
    content: 'already emitted user message',
    uuid: randomUUID(),
  })
  const preservedAssistant: AssistantMessage = {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      id: randomUUID(),
      model: 'gpt-5.6-terra',
      role: 'assistant',
      content: [{ type: 'text', text: 'already emitted assistant message' }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      stop_reason: 'end_turn',
      stop_sequence: null,
    },
  }
  const compactSummary = createUserMessage({
    content: 'compact summary',
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
  })
  const compactBoundary: SystemCompactBoundaryMessage = {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    compactMetadata: {
      trigger: 'auto',
      preservedSegment: {
        headUuid: preservedUser.uuid,
        anchorUuid: compactSummary.uuid,
        tailUuid: preservedAssistant.uuid,
      },
      preservedMessages: {
        anchorUuid: compactSummary.uuid,
        durableUuids: [preservedUser.uuid, preservedAssistant.uuid],
      },
    },
  }
  const freshAssistant: AssistantMessage = {
    ...preservedAssistant,
    uuid: randomUUID(),
    message: {
      ...preservedAssistant.message,
      id: randomUUID(),
      content: [{ type: 'text', text: 'fresh assistant response' }],
    },
  }
  queryMessages = [
    compactBoundary,
    compactSummary,
    preservedUser,
    preservedAssistant,
    freshAssistant,
  ]

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
    initialMessages: [preservedUser, preservedAssistant],
    readFileCache: createFileStateCacheWithSizeLimit(20),
    customSystemPrompt: '',
    recordTranscript: async messages => {
      persistedSnapshots.push([...messages])
      return null
    },
  })

  const previousApiKey = process.env.ANTHROPIC_API_KEY
  const macroState = globalThis as typeof globalThis & {
    MACRO?: { VERSION: string }
  }
  const previousMacro = macroState.MACRO
  process.env.ANTHROPIC_API_KEY = 'test-api-key'
  macroState.MACRO = { VERSION: 'test-version' }
  const sdkMessages = []
  try {
    for await (const message of engine.submitMessage('new prompt')) {
      sdkMessages.push(message)
    }
  } finally {
    if (previousApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY
    } else {
      process.env.ANTHROPIC_API_KEY = previousApiKey
    }
    macroState.MACRO = previousMacro
  }

  expect(sdkMessages.map(message => message.uuid)).not.toContain(
    preservedUser.uuid,
  )
  expect(sdkMessages.map(message => message.uuid)).not.toContain(
    preservedAssistant.uuid,
  )
  expect(sdkMessages.map(message => message.uuid)).toContain(compactBoundary.uuid)
  expect(sdkMessages.map(message => message.uuid)).toContain(compactSummary.uuid)
  expect(sdkMessages.map(message => message.uuid)).toContain(freshAssistant.uuid)
  const boundarySnapshotIndex = persistedSnapshots.findIndex(messages =>
    messages.some(message => message.uuid === compactBoundary.uuid),
  )
  const postBoundarySnapshots = persistedSnapshots.slice(boundarySnapshotIndex + 1)
  expect(boundarySnapshotIndex).toBeGreaterThanOrEqual(0)
  expect(postBoundarySnapshots.length).toBeGreaterThan(0)
  expect(
    postBoundarySnapshots.every(
      messages =>
        !messages.some(
          message =>
            message.uuid === preservedUser.uuid ||
            message.uuid === preservedAssistant.uuid,
        ),
    ),
  ).toBe(true)
  expect(sdkMessages.at(-1)).toMatchObject({
    type: 'result',
    subtype: 'success',
    num_turns: 2,
  })
})
