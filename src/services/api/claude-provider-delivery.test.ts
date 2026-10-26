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

// This owner boundary includes query normalization/repair, SDK serialization,
// the production Codex adapter, and final HTTP JSON. Only credentials and the
// remote service are local fixtures; translating an earlier intermediate body
// would miss regressions where the native assembly bypasses processed history.
test.each(['fallback', 'delta', 'inline'] as const)(
  'GPT outbound requests retain processed history and discovery (%s)',
  async mode => {
    const { createAssistantMessage } = await import('../../utils/messages.js')
    const { buildProviderInstructionAssembly } = await import('./instructionAssembly.js')
    const { ToolSearchTool } = await import('../../tools/ToolSearchTool/ToolSearchTool.js')
    const {
      createAttachmentMessage, getDeferredToolsDeltaAttachment,
      getMcpInstructionsDeltaAttachment,
    } = await import('../../utils/attachments.js')
    const {
      createCodexFetch, _markStickyHttpFallbackForTest, resetCodexCacheContext,
    } = await import('./codex-fetch-adapter.js')
    const { createCodexCredentialHandle } = await import('./codexCredentialUse.js')
    const { createCodexCredentialLifecycle } = await import('./codexCredentialLifecycle.js')
    const accountId = `delivery-${mode}`
    const conversationId = `delivery-conversation-${mode}`
    const lifecycle = createCodexCredentialLifecycle({ directory: join(scratch, mode) })
    await lifecycle.withTransaction(accountId, { operationKind: 'login' }, permit => {
      const prepared = lifecycle.prepareLogin(permit)
      if (prepared.status !== 'applied') throw new Error('Cannot prepare test credential')
      const committed = lifecycle.commitLogin(permit, {
        expectedGeneration: prepared.record.credentialGeneration,
      })
      if (committed.status !== 'applied') throw new Error('Cannot admit test credential')
    })
    const accessToken = `e30.${Buffer.from(JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    })).toString('base64url')}.synthetic`
    const credential = createCodexCredentialHandle({
      accountId, accessToken, refreshToken: 'local-refresh',
      expiresAt: Date.now() + 60_000, credentialGeneration: 1,
      credentialSource: 'config', credentialPath: join(scratch, 'unused-credentials.json'),
    })
    const deferredTool = {
      ...ToolSearchTool, name: 'mcp__delivery__read', isMcp: true,
      async description() { return 'Read the delivery fixture.' },
      async prompt() { return 'Read the delivery fixture.' },
      inputJSONSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
    }
    const chromeTool = {
      ...deferredTool, name: 'mcp__claude-in-chrome__tabs_context_mcp', alwaysLoad: true,
    }
    const tools = [ToolSearchTool, deferredTool, chromeTool]
    const requestBodies: Array<Record<string, unknown>> = []
    const originalGate = gates.getFeatureValue_CACHED_MAY_BE_STALE
    const gateSpy = spyOn(gates, 'getFeatureValue_CACHED_MAY_BE_STALE').mockImplementation(<T>(name: string, fallback: T): T =>
      name === 'tengu_glacier_2xr' ? (mode === 'delta') as T : originalGate(name, fallback),
    )
    const savedToolSearch = process.env.ENABLE_TOOL_SEARCH
    const savedMcpDelta = process.env.CLAUDE_CODE_MCP_INSTR_DELTA
    const savedUserType = process.env.USER_TYPE
    process.env.ENABLE_TOOL_SEARCH = mode === 'inline' ? 'false' : 'true'
    process.env.CLAUDE_CODE_MCP_INSTR_DELTA = mode === 'delta' ? 'true' : 'false'
    delete process.env.USER_TYPE
    globalThis.fetch = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)))
      const events = [
        { type: 'response.output_text.delta', item_id: 'local-message', delta: 'Local response' },
        { type: 'response.completed', response: {
          id: 'local-response', usage: { input_tokens: 1, output_tokens: 2 },
        } },
      ]
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      })
    }, { preconnect: originalFetch.preconnect }) as typeof fetch
    // Select the existing HTTP recovery route to capture final outbound JSON
    // without opening a real WebSocket or consulting live accounts.
    _markStickyHttpFallbackForTest(conversationId, 'local delivery fixture', accountId)
    const codexFetch = createCodexFetch(credential, conversationId, { credentialUse: { lifecycle } })
    const clientSpy = spyOn(client, 'getAnthropicClient').mockImplementation(async () =>
      new Anthropic({ apiKey: 'isolated-test-key', maxRetries: 0, fetch: codexFetch }),
    )
    async function capture(messages: Parameters<typeof buildProviderInstructionAssembly>[0]['messages']) {
      const assembly = buildProviderInstructionAssembly({
        provider: 'openai', messages, systemPrompt: asSystemPrompt(['Stable delivery instructions']),
        userContext: { project: 'Stable project rules' }, systemContext: { gitStatus: 'Volatile git marker' },
      })
      const count = requestBodies.length
      const receivedEvents = []
      for await (const event of queryModelWithStreaming({
        messages: assembly.messages, systemPrompt: assembly.systemPrompt,
        openAIInstructionAssembly: assembly.openAIInstructionAssembly,
        thinkingConfig: { type: 'adaptive' }, tools, signal: new AbortController().signal,
        options: {
          model: 'gpt-6.1-sol', provider: 'openai', querySource: 'sdk',
          getToolPermissionContext: async () => getEmptyToolPermissionContext(),
          isNonInteractiveSession: true, agents: [], mcpTools: [deferredTool, chromeTool],
          hasAppendSystemPrompt: false,
        },
      })) receivedEvents.push(event)
      if (requestBodies.length === count) throw new Error(`No outbound request: ${JSON.stringify(receivedEvents)}`)
      expect(requestBodies.length).toBe(count + 1)
      return requestBodies.at(-1)! as {
        instructions: string
        input: Array<{ type: string; role?: string; phase?: string; call_id?: string; output?: unknown; content?: unknown }>
        tools: Array<{ name: string }>
      }
    }
    try {
      const initialMessages = [createUserMessage({ content: `Inspect tools and continue (${mode}).` })]
      const announcements = [
        ...getDeferredToolsDeltaAttachment(tools, 'gpt-6.1-sol', initialMessages),
        ...getMcpInstructionsDeltaAttachment([
          { type: 'connected', name: 'delivery', instructions: 'Delivery server guidance' },
          { type: 'connected', name: 'claude-in-chrome' },
        ] as Parameters<typeof getMcpInstructionsDeltaAttachment>[0], tools, 'gpt-6.1-sol', initialMessages),
      ].map(createAttachmentMessage)
      const first = await capture([...initialMessages, ...announcements])
      expect(JSON.stringify(first.input)).toContain('mcp__delivery__read')
      expect(first.tools.some(tool => tool.name === 'mcp__delivery__read')).toBe(mode === 'inline')
      expect(first.instructions).toBe('Stable delivery instructions\n\n# project\nStable project rules')
      expect(first.input[0]).toMatchObject({ type: 'message', role: 'developer' })
      expect(JSON.stringify(first.input[0])).toContain('Volatile git marker')
      if (mode === 'fallback') {
        expect(JSON.stringify(first.input)).toContain('<available-deferred-tools>')
        expect(JSON.stringify(first.input[0])).toContain('Before using any chrome browser tools')
      } else if (mode === 'delta') {
        expect(announcements.length).toBe(2)
        expect(JSON.stringify(first.input)).toContain('Delivery server guidance')
        expect(JSON.stringify(first.input)).not.toContain('<available-deferred-tools>')
      } else {
        expect(JSON.stringify(first.input)).toContain('<tools-inlined>')
      }

      const loadedMessages = [
        ...initialMessages, ...announcements,
        createAssistantMessage({ content: [{ type: 'tool_use', id: 'search', name: 'ToolSearch', input: { query: '+delivery read' } }] }),
        createUserMessage({ content: [ToolSearchTool.mapToolResultToToolResultBlockParam({
          matches: ['mcp__delivery__read'], query: '+delivery read', total_deferred_tools: 1,
        }, 'search')] }),
      ]
      if (mode !== 'inline') {
        const loaded = await capture(loadedMessages)
        expect(loaded.tools.some(tool => tool.name === 'mcp__delivery__read')).toBe(true)
        expect(loaded.input.some(item => item.type === 'function_call_output' && item.call_id === 'search')).toBe(true)
      }

      const commentaryBlock = { type: 'text' as const, text: 'Checking restored work', citations: [], phase: 'commentary' as const }
      const finalBlock = { type: 'text' as const, text: 'Previous final answer', citations: [], phase: 'final_answer' as const }
      const malformedHistory = [
        ...initialMessages, ...announcements,
        createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'Orphan result marker' }] }),
        createAssistantMessage({ content: [
          commentaryBlock,
          { type: 'tool_use', id: 'interrupted', name: 'mcp__delivery__read', input: {} },
        ] }),
        createUserMessage({ content: 'Continue after interruption.' }),
        createAssistantMessage({ content: [finalBlock] }),
        createUserMessage({ content: 'Continue.' }),
      ]
      const historyBefore = JSON.stringify(malformedHistory)
      const restored = await capture(malformedHistory)
      expect(JSON.stringify(restored.input)).not.toContain('Orphan result marker')
      const callIndex = restored.input.findIndex(item => item.type === 'function_call' && item.call_id === 'interrupted')
      expect(callIndex).toBeGreaterThan(-1)
      expect(restored.input[callIndex + 1]).toMatchObject({ type: 'function_call_output', call_id: 'interrupted' })
      expect(restored.input[callIndex + 1]!.output).toContain('Tool result missing')
      expect(restored.input.filter(item => item.role === 'assistant').map(item => item.phase)).toEqual(['commentary', 'final_answer'])
      expect(restored.instructions).toBe(first.instructions)
      expect(JSON.stringify(malformedHistory)).toBe(historyBefore)

      if (mode === 'fallback') {
        // A valid tiny PNG exercises count preservation without claiming that a
        // local transport fixture proves remote provider admission or quality.
        const image = { type: 'image' as const, source: {
          type: 'base64' as const, media_type: 'image/png' as const,
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4xsAAAAASUVORK5CYII=',
        } }
        const media = await capture([createUserMessage({ content: [
          { type: 'text', text: 'Inspect all screenshots.' }, ...Array.from({ length: 101 }, () => image),
        ] })])
        expect((JSON.stringify(media.input).match(/"type":"input_image"/g) ?? []).length).toBe(101)
      }
    } finally {
      clientSpy.mockRestore()
      gateSpy.mockRestore()
      resetCodexCacheContext()
      globalThis.fetch = Object.assign(async () => {
        throw new Error('Unexpected network request in provider delivery test')
      }, { preconnect: originalFetch.preconnect })
      for (const [key, value] of [
        ['ENABLE_TOOL_SEARCH', savedToolSearch], ['CLAUDE_CODE_MCP_INSTR_DELTA', savedMcpDelta], ['USER_TYPE', savedUserType],
      ]) {
        if (value === undefined) delete process.env[key!]
        else process.env[key!] = value
      }
    }
  },
)
