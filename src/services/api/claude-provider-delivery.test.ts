import Anthropic from '@anthropic-ai/sdk'
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../../Tool.js'
import { asAgentId } from '../../types/ids.js'

// Configure before loading the runtime: client selection must never see the
// user's accounts, and unexpected transport paths must fail closed.
const scratch = mkdtempSync(join(tmpdir(), 'claude-provider-delivery-'))
const savedEnv = { ...process.env }
const originalFetch = globalThis.fetch
const macroState = globalThis as typeof globalThis & { MACRO?: { VERSION: string } }
const originalMacro = macroState.MACRO
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: scratch,
  CLAUDE_CODE_TEST_FIXTURES_ROOT: scratch,
  CLAUDE_CODE_SIMPLE: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_MAX_RETRIES: '0',
  ANTHROPIC_API_KEY: 'isolated-test-key',
})
delete process.env.CLAUDE_CODE_DISABLE_THINKING
macroState.MACRO = { VERSION: 'test-version' }
globalThis.fetch = Object.assign(async () => {
  throw new Error('Unexpected network request in provider delivery test')
}, { preconnect: originalFetch.preconnect })

await import('../../query.js')
const state = await import('../../bootstrap/state.js')
const { getEmptyToolPermissionContext } = await import('../../Tool.js')
const { createUserMessage } = await import('../../utils/messages.js')
const { asSystemPrompt } = await import('../../utils/systemPromptType.js')
const { queryModelWithStreaming } = await import('./claude.js')
const client = await import('./client.js')
const { translateToCodexBody } = await import('./codex-fetch-adapter.js')
const gates = await import('../analytics/growthbook.js')
const { streamCompactSummary } = await import('../compact/compact.js')
const { getDefaultAppState } = await import('../../state/AppStateStore.js')

beforeEach(() => {
  state.resetStateForTests()
  state.setSessionProvider('openai')
})

afterEach(() => {
  state.resetStateForTests()
})

afterAll(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key]
  }
  Object.assign(process.env, savedEnv)
  globalThis.fetch = originalFetch
  macroState.MACRO = originalMacro
  rmSync(scratch, { recursive: true, force: true })
})

function responseFor(body: Record<string, unknown>): Response {
  const message = {
    id: 'msg_local', type: 'message', role: 'assistant', model: body.model,
    content: [{ type: 'text', text: 'Local response' }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 2 },
  }
  if (!body.stream) {
    return Response.json(message)
  }
  const events = [
    { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Local response' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

test.each([
  ['streamed', false],
  ['non-streaming recovery', true],
] as const)(
  'Claude worker retains its first-party route under a GPT parent (%s)',
  async (_mode, fallback) => {
    const requests: Array<Record<string, unknown>> = []
    const fetchOverride = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push(body)
      if (fallback && body.stream) {
        return new Response(new ReadableStream({
          start(controller) { controller.error(new Error('Connection reset before output')) },
        }), { headers: { 'content-type': 'text/event-stream' } })
      }
      return responseFor(body)
    }, { preconnect: originalFetch.preconnect }) as typeof fetch
    const events = []
    for await (const event of queryModelWithStreaming({
      messages: [createUserMessage({ content: `Answer this delegated task (fallback=${fallback}).` })],
      systemPrompt: asSystemPrompt(['You are a test assistant.']),
      thinkingConfig: { type: 'disabled' }, tools: [],
      signal: new AbortController().signal,
      options: {
        model: 'claude-sonnet-4-6', provider: 'firstParty',
        agentId: asAgentId('worker-native'), querySource: 'agent:verification',
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        isNonInteractiveSession: true, agents: [], mcpTools: [],
        hasAppendSystemPrompt: false, fetchOverride,
      },
    })) events.push(event)

    expect(requests.map(body => body.stream === true)).toEqual(fallback ? [true, false] : [true])
    expect(events.some(event => event.type === 'assistant' && !event.isApiErrorMessage)).toBe(true)
    expect(JSON.stringify(events)).toContain('Local response')
    expect(events.some(event => event.type === 'assistant' && event.isApiErrorMessage)).toBe(false)
    expect(state.getSessionProvider()).toBe('openai')
  },
)

test('regular GPT compaction overrides parent effort while ordinary thinking retains it', async () => {
  const bodies: Array<Record<string, unknown>> = []
  const fetchOverride = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    bodies.push(body)
    return responseFor(body)
  }, { preconnect: originalFetch.preconnect }) as typeof fetch
  // Replace only the credential-bearing client boundary, keeping production
  // compaction, request shaping, the SDK, and Codex translation in the path.
  const clientSpy = spyOn(client, 'getAnthropicClient').mockImplementation(async () =>
    new Anthropic({ apiKey: 'isolated-test-key', maxRetries: 0, fetch: fetchOverride }),
  )
  const originalGate = gates.getFeatureValue_CACHED_MAY_BE_STALE
  const gateSpy = spyOn(gates, 'getFeatureValue_CACHED_MAY_BE_STALE').mockImplementation(<T>(name: string, fallback: T): T =>
    name === 'tengu_compact_cache_prefix' ? false as T : originalGate(name, fallback),
  )
  try {
    const appState = getDefaultAppState()
    appState.effortValue = 'max'
    const messages = [createUserMessage({ content: 'Remember the work done so far.' })]
    const context = {
      options: {
        commands: [], debug: false, mainLoopModel: 'gpt-6.1-sol', mainLoopProvider: 'openai',
        tools: [], verbose: false, thinkingConfig: { type: 'adaptive' },
        mcpClients: [], mcpResources: {}, isNonInteractiveSession: true,
        agentDefinitions: { activeAgents: [], allAgents: [] },
      },
      abortController: new AbortController(), readFileState: new Map(),
      getAppState: () => appState, setAppState: () => {}, messages,
      setInProgressToolUseIDs: () => {}, setResponseLength: () => {},
    } as unknown as ToolUseContext
    const summary = await streamCompactSummary({
      messages, summaryRequest: createUserMessage({ content: 'Produce a summary.' }),
      appState, context, preCompactTokenCount: 100,
      cacheSafeParams: {
        systemPrompt: asSystemPrompt(['parent instructions']), userContext: {}, systemContext: {},
        toolUseContext: context, forkContextMessages: messages,
      },
    })
    expect(summary.message.content).toEqual([{ type: 'text', text: 'Local response' }])
    expect(translateToCodexBody(bodies[0]!).codexBody.reasoning).toEqual({ effort: 'low' })

    for await (const _event of queryModelWithStreaming({
      messages, systemPrompt: asSystemPrompt(['parent instructions']),
      openAIInstructionAssembly: { instructions: 'parent instructions', inputMessages: messages },
      thinkingConfig: { type: 'adaptive' }, tools: [], signal: context.abortController.signal,
      options: {
        model: 'gpt-6.1-sol', provider: 'openai', effortValue: 'max',
        querySource: 'sdk', getToolPermissionContext: async () => appState.toolPermissionContext,
        isNonInteractiveSession: true, agents: [], mcpTools: [], hasAppendSystemPrompt: false,
      },
    })) { /* Drain the response to observe the emitted request. */ }
    expect(translateToCodexBody(bodies[1]!).codexBody.reasoning).toMatchObject({ effort: 'max' })
  } finally {
    clientSpy.mockRestore()
    gateSpy.mockRestore()
  }
})
