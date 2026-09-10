/**
 * The engine mints SDK frames from internal messages, and that mapping is the
 * seam nothing else covers: `query.test.ts` proves the internal message is
 * yielded, and the desktop projector test proves a well-formed frame renders.
 * Neither would notice the engine emitting the wrong shape in between.
 */
import { APIError } from '@anthropic-ai/sdk'
import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

import { getDefaultAppState, type AppState } from './state/AppStateStore.js'
import { createFileStateCacheWithSizeLimit } from './utils/fileStateCache.js'
import {
  createAssistantMessage,
  createSystemAPIErrorMessage,
  createSystemTransportRecoveryMessage,
  createUserMessage,
} from './utils/messages.js'
import type { Message } from './types/message.js'

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
    const { input, uuid } = args[0] as unknown as { input: string; uuid?: string }
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
    yield* queryMessages
  },
}))

const { QueryEngine } = await import('./QueryEngine.js')

const originalApiKey = process.env.ANTHROPIC_API_KEY
const macroState = globalThis as typeof globalThis & { MACRO?: { VERSION: string } }
const originalMacro = macroState.MACRO

beforeEach(() => {
  stubsActive = true
  queryMessages = []
  // The init frame reads auth before any provider call; this test never
  // reaches the network.
  process.env.ANTHROPIC_API_KEY = 'test-api-key'
  // Build-time macro, absent under the test runner.
  macroState.MACRO = { VERSION: 'test-version' }
})

afterEach(() => {
  stubsActive = false
  queryMessages = []
  if (originalApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY
  } else {
    process.env.ANTHROPIC_API_KEY = originalApiKey
  }
  macroState.MACRO = originalMacro
})

async function collectFrames(
  options: { interrupt?: { reason?: string } } = {},
): Promise<Record<string, unknown>[]> {
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
    recordTranscript: async () => null,
  })
  if (options.interrupt) engine.interrupt(options.interrupt.reason)
  const frames: Record<string, unknown>[] = []
  for await (const message of engine.submitMessage('go')) {
    frames.push(message as unknown as Record<string, unknown>)
  }
  return frames
}

test('an interrupted result prefers its string abort reason over a stale assistant stop reason', async () => {
  const staleAssistant = createAssistantMessage({ content: 'partial response' })
  staleAssistant.message.stop_reason = 'tool_use'
  queryMessages = [staleAssistant]

  const submitInterruptFrames = await collectFrames({
    interrupt: { reason: 'interrupt' },
  })
  expect(submitInterruptFrames.find(frame => frame.type === 'result')).toMatchObject({
    subtype: 'interrupted',
    stop_reason: 'interrupt',
  })

  const defaultAbortFrames = await collectFrames({ interrupt: {} })
  expect(defaultAbortFrames.find(frame => frame.type === 'result')).toMatchObject({
    subtype: 'interrupted',
    stop_reason: 'tool_use',
  })
})

test('a transport recovery message becomes an api_retry frame the desktop can read', async () => {
  queryMessages = [
    createSystemTransportRecoveryMessage(
      'Connection interrupted. Continuing automatically.',
      1,
      2,
    ),
  ]

  const frames = await collectFrames()
  const retry = frames.find(
    frame => frame.type === 'system' && frame.subtype === 'api_retry',
  )

  expect(retry).toBeDefined()
  // The projector requires `error` to be a record carrying a string `message`;
  // a bare code is dropped on the floor. That is the whole reason this frame
  // is emitted in the object form.
  expect(retry).toMatchObject({
    type: 'system',
    subtype: 'api_retry',
    attempt: 1,
    max_retries: 2,
    retry_delay_ms: 0,
    error_status: null,
    error: {
      type: 'assistant_error',
      message: 'Connection interrupted. Continuing automatically.',
    },
  })
})

test('an api error message becomes an api_retry frame the desktop can read', async () => {
  queryMessages = [
    createSystemAPIErrorMessage(
      new APIError(429, undefined, 'Too Many Requests', new Headers()),
      1500,
      1,
      3,
    ),
  ]

  const frames = await collectFrames()
  const retry = frames.find(
    frame => frame.type === 'system' && frame.subtype === 'api_retry',
  )

  expect(retry).toBeDefined()
  expect(retry).toMatchObject({
    type: 'system',
    subtype: 'api_retry',
    attempt: 1,
    max_retries: 3,
    retry_delay_ms: 1500,
    error_status: 429,
    error: {
      type: 'assistant_error',
      error: 'rate_limit',
    },
  })
})
