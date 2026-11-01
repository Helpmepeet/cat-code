import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { randomUUID, type UUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as fsPromises from 'node:fs/promises'
import z from 'zod/v4'
import { feature } from 'bun:bundle'

// Establish isolation before loading persistence, settings, hooks or bootstrap.
const root = mkdtempSync(join(tmpdir(), 'query-engine-interrupted-tools-'))
mkdirSync(join(root, 'workspace'))
const previousConfig = process.env.CLAUDE_CONFIG_DIR
const previousApiKey = process.env.ANTHROPIC_API_KEY
const previousSimple = process.env.CLAUDE_CODE_SIMPLE
const macroGlobal = globalThis as unknown as { MACRO?: { VERSION: string } }
const previousMacro = macroGlobal.MACRO
macroGlobal.MACRO = { VERSION: 'interrupted-tools-test' }
process.env.ANTHROPIC_API_KEY = 'isolated-scripted-test-key'
process.env.CLAUDE_CODE_SIMPLE = '1'
process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
const { query } = await import('./query.js')
const { asSystemPrompt } = await import('./utils/systemPromptType.js')
const { createUserMessage } = await import('./utils/messages.js')
const { getInterruptedToolRun } = await import('./services/tools/interruptedToolRun.js')
const { createTerminalInterruptedTools } = await import('./utils/terminalInterruptedTools.js')
const { QueryGuard } = await import('./utils/QueryGuard.js')
const { runForkedAgent } = await import('./utils/forkedAgent.js')
const { runAgent } = await import('./tools/AgentTool/runAgent.js')
const workerNames = await import('./utils/workerNames.js')
const { QueryEngine, ask } = await import('./QueryEngine.js')
const { buildTool } = await import('./Tool.js')
const { getDefaultAppState } = await import('./state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import('./utils/fileStateCache.js')
const bootstrap = await import('./bootstrap/state.js')
const { asSessionId, asAgentId } = await import('./types/ids.js')
const storage = await import('./utils/sessionStorage.js')
const { transcriptRecoveryDirectory } = await import('./utils/transcriptTailRecovery.js')
const { releaseActiveTranscriptLease } = await import('./utils/transcriptLease.js')
const claude = await import('./services/api/claude.js')
const hooks = await import('./utils/hooks.js')
const shell = await import('./utils/Shell.js')
const growthbook = await import('./services/analytics/growthbook.js')
const { toSDKMessages } = await import('./utils/messages/mappers.js')
const { SDKResultHandoffSchema } = await import('./entrypoints/sdk/coreSchemas.js')
const { createRuntimeBackedAppSession } = await import('./app-runtime/createRuntimeBackedAppSession.js')
const { loadConversationForResume } = await import('./utils/conversationRecovery.js')
import type { AssistantMessage, Message } from './types/message.js'
import type { AppState } from './state/AppStateStore.js'
import type { QueryEngineConfig } from './QueryEngine.js'
import type { SDKMessage } from './entrypoints/agentSdkTypes.js'
import type { ToolUseContext } from './Tool.js'

const originalSession = bootstrap.getSessionId()
const originalProject = bootstrap.getSessionProjectDir()
const originalProvider = bootstrap.getSessionProvider()
const originalCwd = bootstrap.getCwdState()
const previousPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
const spies: { mockRestore(): void }[] = []

beforeEach(async () => {
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  await releaseActiveTranscriptLease()
  storage.resetProjectForTesting()
  bootstrap.switchSession(asSessionId(randomUUID()), join(root, randomUUID()))
  bootstrap.setSessionProvider('firstParty')
  spies.push(spyOn(growthbook, 'checkStatsigFeatureGate_CACHED_MAY_BE_STALE').mockImplementation(name => name === 'tengu_streaming_tool_execution2'))
})
afterEach(async () => {
  process.env.CLAUDE_CODE_SIMPLE = '1'
  bootstrap.clearInvokedSkills()
  for (const spy of spies.splice(0)) spy.mockRestore()
  await storage.flushSessionStorage()
  await releaseActiveTranscriptLease()
  storage.resetProjectForTesting()
  bootstrap.switchSession(asSessionId(originalSession), originalProject)
  bootstrap.setSessionProvider(originalProvider)
  shell.setCwd(originalCwd)
  if (previousPersistence === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  else process.env.TEST_ENABLE_SESSION_PERSISTENCE = previousPersistence
})
afterAll(() => {
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfig
  if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = previousApiKey
  if (previousSimple === undefined) delete process.env.CLAUDE_CODE_SIMPLE
  else process.env.CLAUDE_CODE_SIMPLE = previousSimple
  if (previousMacro === undefined) delete macroGlobal.MACRO
  else macroGlobal.MACRO = previousMacro
  rmSync(root, { recursive: true, force: true })
})

function assistant(content: AssistantMessage['message']['content']): AssistantMessage {
  return { type: 'assistant', uuid: randomUUID(), timestamp: new Date().toISOString(), message: {
    id: randomUUID(), role: 'assistant', model: 'gpt-5.6-terra', content,
    usage: { input_tokens: 10, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    stop_reason: content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null,
  } } as AssistantMessage
}

function engineConfig(tools: ReturnType<typeof buildTool>[], overrides: Partial<QueryEngineConfig> = {}): QueryEngineConfig {
  let state: AppState = getDefaultAppState()
  return {
    cwd: join(root, 'workspace'), tools, commands: [], mcpClients: [], agents: [],
    canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
    getAppState: () => state, setAppState: update => { state = update(state) },
    readFileCache: createFileStateCacheWithSizeLimit(20), customSystemPrompt: 'isolated scripted handoff',
    userSpecifiedModel: 'claude-sonnet-4-6', thinkingConfig: { type: 'disabled' }, ...overrides,
  }
}
function engine(tools: ReturnType<typeof buildTool>[], overrides: Partial<QueryEngineConfig> = {}) {
  return new QueryEngine(engineConfig(tools, overrides))
}

const encoder = new TextEncoder()
const sse = (event: Record<string, unknown>) => encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('fixture did not settle')), 1500) })]) }
  finally { clearTimeout(timer) }
}

for (const mode of ['late', 'writer-failure', 'replacement', 'cancel', 'batch-cancel', 'batch-concurrent-cancel', 'late-stop', 'stale-dispose', 'stale-interrupt'] as const) {
  test(`real runtime bounds interrupted tool ownership: ${mode}`, async () => {
    const started = deferred(), complete = deferred(), delivered = deferred(), writeAttempted = deferred()
    const counter = join(root, `${bootstrap.getSessionId()}.counter`)
    writeFileSync(counter, '0')
    const batch = mode === 'batch-cancel' || mode === 'batch-concurrent-cancel'
    if (batch) spies.push(spyOn(growthbook, 'checkStatsigFeatureGate_CACHED_MAY_BE_STALE').mockReturnValue(false))
    let running = false, stopped = false, requests = 0, failWriter = mode === 'writer-failure'
    const previousIdle = process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS
    process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '30'
    const encoderTool = buildTool({
      name: 'DurableCounter', inputSchema: z.object({}), description: async () => 'fixture', prompt: async () => 'fixture',
      maxResultSizeChars: 1000, renderToolUseMessage: () => null,
      isConcurrencySafe: () => mode === 'batch-concurrent-cancel',
      async call(_input, context) {
        context.abortController.signal.addEventListener('abort', () => { stopped = true }, { once: true })
        running = true
        started.resolve()
        writeFileSync(counter, String(Number(readFileSync(counter, 'utf8')) + 1))
        await complete.promise
        running = false
        return { data: 'actual late receipt' }
      },
      mapToolResultToToolResultBlockParam: (data, id) => ({ type: 'tool_result', tool_use_id: id, content: data }),
    })
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => {
      requests++
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(sse({ type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }))
        controller.enqueue(sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'durable-effect', name: 'DurableCounter', input: {} } }))
        controller.enqueue(sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }))
        controller.enqueue(sse({ type: 'content_block_stop', index: 0 }))
        if (mode === 'batch-cancel') {
          controller.enqueue(sse({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'unstarted-effect', name: 'DurableCounter', input: {} } }))
          controller.enqueue(sse({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } }))
          controller.enqueue(sse({ type: 'content_block_stop', index: 1 }))
        }
        if (mode === 'cancel' || batch) {
          controller.enqueue(sse({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } }))
          controller.enqueue(sse({ type: 'message_stop' })); controller.close()
        }
      } }), { headers: { 'content-type': 'text/event-stream', 'request-id': 'fixture-request' } })
    }, { preconnect: globalThis.fetch.preconnect }))
    // Recording is the only bypass: production query, SDK parsing, permission,
    // tool execution, transcript persistence, and app-runtime remain real.
    const vcr = await import('./services/vcr.js')
    const recording = spyOn(vcr, 'withStreamingVCR').mockImplementation(async function* (_messages, produce) { yield* produce() })
    const engines: InstanceType<typeof QueryEngine>[] = []
    const makeRuntime = (initialMessages?: Message[]) => createRuntimeBackedAppSession({ queryEngineConfig: {
      ...engineConfig([encoderTool]), initialMessages,
      recordTranscript: async messages => {
        if (messages.some(message => message.type === 'user' && message.sourceToolAssistantUUID)) {
          writeAttempted.resolve()
          if (failWriter) throw new Error('isolated receipt writer failure')
        }
        return storage.recordTranscript(messages)
      },
      createEngine: config => { const instance = new QueryEngine(config); engines.push(instance); return instance },
    } })
    let controller = makeRuntime()
    const oldController = controller
    const staleOwner = mode === 'stale-dispose' || mode === 'stale-interrupt'
    if (staleOwner) {
      controller.dispose()
      controller = makeRuntime()
    }
    let oldLateFrames = 0, lateFrames = 0
    const observe = (active: typeof controller) => active.subscribe(event => {
      if (event.type === 'message' && JSON.stringify(event.message).includes('actual late receipt')) {
        lateFrames++
        if (active === oldController) oldLateFrames++
        expect(active.canStartQueuedTurn()).toBe(false)
        expect(readFileSync(storage.getTranscriptPathForSession(bootstrap.getSessionId()), 'utf8')).toContain('actual late receipt')
        delivered.resolve()
      }
    })
    observe(controller)
    try {
      const began = performance.now()
      const turn = controller.submit('run one effect')
      if (mode === 'cancel' || batch) { await within(started.promise); controller.abort('fixture cancellation') }
      await within(turn)
      expect(performance.now() - began).toBeLessThan(1400)
      expect(running).toBe(true)
      expect(controller.isTurnActive()).toBe(false)
      expect(controller.canStartQueuedTurn()).toBe(false)
      expect(controller.canStartInlineCommand()).toBe(false)
      await expect(controller.submit('do not duplicate')).rejects.toThrow('Some tool actions')
      expect(requests).toBe(1)
      expect(readFileSync(counter, 'utf8')).toBe('1')
      if (staleOwner) {
        expect(stopped).toBe(false)
        if (mode === 'stale-dispose') engines[0]!.dispose()
        else engines[0]!.interrupt('late stale Stop')
        expect(stopped).toBe(false)
        expect(running).toBe(true)
        expect(controller.canStartQueuedTurn()).toBe(false)
        expect(lateFrames).toBe(0)
      }
      if (mode === 'late-stop') {
        controller.abort('Stop after bounded turn')
        expect(stopped).toBe(true)
        expect(running).toBe(true)
        expect(controller.canStartQueuedTurn()).toBe(false)
      }
      if (mode === 'replacement') {
        const history = [...engines[0]!.getMessages()]
        controller.dispose()
        controller = makeRuntime(history)
        observe(controller)
        expect(controller.canStartQueuedTurn()).toBe(false)
      }
      complete.resolve()
      if (mode === 'writer-failure') {
        await within(writeAttempted.promise)
        await Bun.sleep(0)
        expect(controller.canStartQueuedTurn()).toBe(false)
        expect(JSON.stringify(engines[0]!.getMessages())).not.toContain('actual late receipt')
        failWriter = false
        await expect(controller.submit('retry receipt delivery')).rejects.toThrow('Some tool actions')
      }
      await within(delivered.promise)
      if (batch) await within(getInterruptedToolRun(bootstrap.getSessionId()).whenSettled())
      await Bun.sleep(0)
      expect(controller.canStartQueuedTurn()).toBe(true)
      expect(lateFrames).toBe(1)
      if (staleOwner) {
        expect(oldLateFrames).toBe(0)
        expect(stopped).toBe(false)
        expect(engines[0]!.hasUnresolvedToolEffects()).toBe(true)
      }
      expect(readFileSync(counter, 'utf8')).toBe('1')
      const loaded = await storage.loadTranscriptFile(storage.getTranscriptPathForSession(bootstrap.getSessionId()))
      expect([...loaded.messages.values()].filter(message => JSON.stringify(message).includes('actual late receipt'))).toHaveLength(1)
      if (mode === 'replacement') {
        expect(oldLateFrames).toBe(0)
        expect(engines[0]!.hasUnresolvedToolEffects()).toBe(true)
        await expect(oldController.submit('stale generation')).rejects.toThrow('disposed')
      }
    } finally {
      complete.resolve()
      controller.dispose(); if (oldController !== controller) oldController.dispose()
      recording.mockRestore(); fetchSpy.mockRestore()
      if (previousIdle === undefined) delete process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS
      else process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = previousIdle
    }
  }, 5000)
}


for (const delivery of ['default', 'delayed', 'failure'] as const) test(`ask retains headless late receipts across inputs: ${delivery}`, async () => {
  const started = deferred(), complete = deferred(), publishing = deferred(), release = deferred()
  const abortController = new AbortController()
  let requests = 0, publications = 0, fail = delivery === 'failure'
  const counter = join(root, `${bootstrap.getSessionId()}.headless-counter`)
  writeFileSync(counter, '0')
  const history: Message[] = []
  const tool = buildTool({
    name: 'HeadlessCounter', inputSchema: z.object({}), description: async () => 'fixture', prompt: async () => 'fixture',
    maxResultSizeChars: 1000, renderToolUseMessage: () => null,
    async call() { writeFileSync(counter, String(Number(readFileSync(counter, 'utf8')) + 1)); started.resolve(); await complete.promise; return { data: 'headless actual receipt' } },
    mapToolResultToToolResultBlockParam: (data, id) => ({ type: 'tool_result', tool_use_id: id, content: data }),
  })
  const config = engineConfig([tool])
  const provider = spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* (params) {
    requests++
    if (requests === 1) yield assistant([{ type: 'tool_use', id: 'headless-effect', name: tool.name, input: {} }])
    else {
      expect(JSON.stringify(params.messages)).toContain('headless actual receipt')
      yield assistant([{ type: 'text', text: 'next input accepted' }])
    }
  })
  const args = {
    ...config, prompt: 'run once', mutableMessages: history, abortController,
    getReadFileCache: () => config.readFileCache, setReadFileCache: () => {},
    ...(delivery === 'default' ? {} : { publishLateToolMessage: async (frame: SDKMessage) => {
      expect(JSON.stringify(frame)).toContain('headless actual receipt')
      expect(JSON.stringify(history)).toContain('headless actual receipt')
      expect(readFileSync(storage.getTranscriptPathForSession(bootstrap.getSessionId()), 'utf8')).toContain('headless actual receipt')
      publishing.resolve()
      if (fail) throw new Error('fixture publisher failure')
      await release.promise
      publications++
    } }),
  }
  const consume = async (input: typeof args) => { for await (const _frame of ask(input)) {} }
  const owner = getInterruptedToolRun(bootstrap.getSessionId())
  try {
    const first = consume(args)
    await within(started.promise)
    abortController.abort('fixture cancellation')
    await within(first)
    expect(owner.blocked).toBe(true)
    expect(readFileSync(counter, 'utf8')).toBe('1')
    complete.resolve()
    if (delivery !== 'default') {
      await within(publishing.promise)
      await Bun.sleep(0)
      expect(owner.blocked).toBe(true)
      fail = false
      release.resolve()
      if (delivery === 'failure') owner.retryDelivery()
    }
    await within(owner.whenSettled())
    expect(history.filter(row => JSON.stringify(row).includes('headless actual receipt'))).toHaveLength(1)
    expect(publications).toBe(delivery === 'default' ? 0 : 1)
    await consume({ ...args, prompt: 'next input', abortController: new AbortController() })
    expect(requests).toBe(2)
    expect(readFileSync(counter, 'utf8')).toBe('1')
  } finally { complete.resolve(); release.resolve(); provider.mockRestore() }
}, 5000)

test('actual terminal owner returns bounded, fences replay, and persists the original late receipt', async () => {
  const complete = deferred(), delivered = deferred()
  const guard = new QueryGuard()
  const generation = guard.tryStart()!
  const counter = join(root, `${bootstrap.getSessionId()}.direct-counter`)
  writeFileSync(counter, '0')
  const tool = buildTool({
    name: 'DurableCounter', inputSchema: z.object({}), description: async () => 'fixture', prompt: async () => 'fixture',
    maxResultSizeChars: 1000, renderToolUseMessage: () => null,
    async call() { writeFileSync(counter, String(Number(readFileSync(counter, 'utf8')) + 1)); await complete.promise; return { data: 'direct actual receipt' } },
    mapToolResultToToolResultBlockParam: (data, id) => ({ type: 'tool_result', tool_use_id: id, content: data }),
  })
  let requests = 0
  const fakeFetch = Object.assign(async () => {
    requests++
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(sse({ type: 'message_start', message: { id: 'direct-message', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }))
      controller.enqueue(sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'direct-effect', name: 'DurableCounter', input: {} } }))
      controller.enqueue(sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }))
      controller.enqueue(sse({ type: 'content_block_stop', index: 0 }))
    } }), { headers: { 'content-type': 'text/event-stream' } })
  }, { preconnect: globalThis.fetch.preconnect })
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fakeFetch)
  const vcr = await import('./services/vcr.js')
  const recording = spyOn(vcr, 'withStreamingVCR').mockImplementation(async function* (_messages, produce) { yield* produce() })
  const previousIdle = process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS
  process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '30'
  const messages: Message[] = [createUserMessage({ content: 'direct fixture' })]
  const config = engineConfig([tool])
  const terminal = createTerminalInterruptedTools({ sessionId: bootstrap.getSessionId(), guard, getMessages: () => messages, append: message => { messages.push(message); delivered.resolve() } })
  const owner = terminal.run
  const context = {
    messages, interruptedToolRun: owner,
    options: { commands: [], tools: [tool], debug: false, verbose: false, mainLoopModel: 'claude-sonnet-4-6', mainLoopProvider: 'firstParty', thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [], allAgents: [] } },
    abortController: new AbortController(), getAppState: config.getAppState, setAppState: config.setAppState,
    readFileState: config.readFileCache, setInProgressToolUseIDs: () => {}, setResponseLength: () => {}, updateFileHistoryState: () => {}, updateAttributionState: () => {},
  } as ToolUseContext
  const params = { messages, systemPrompt: asSystemPrompt(['isolated fixture']), userContext: {}, systemContext: {}, toolUseContext: context, canUseTool: config.canUseTool, querySource: 'sdk' as const }
  try {
    await within((async () => {
      for await (const row of query(params)) {
        if (row.type === 'assistant' || row.type === 'user') {
          messages.push(row as Message)
          await storage.recordTranscript(messages)
        }
      }
    })())
    expect(owner.blocked).toBe(true)
    expect(() => terminal.assertAdmission()).toThrow('Some tool actions')
    guard.end(generation)
    expect(readFileSync(counter, 'utf8')).toBe('1')
    expect(JSON.stringify(messages)).not.toContain('direct actual receipt')
    for await (const _row of query(params)) { /* A new query must not reach the provider. */ }
    expect(requests).toBe(1)
    complete.resolve()
    await within(delivered.promise)
    await Bun.sleep(0)
    expect(owner.blocked).toBe(false)
    const loaded = await storage.loadTranscriptFile(storage.getTranscriptPathForSession(bootstrap.getSessionId()))
    expect([...loaded.messages.values()].some(message => JSON.stringify(message).includes('direct actual receipt'))).toBe(true)
    expect(readFileSync(counter, 'utf8')).toBe('1')
  } finally {
    complete.resolve(); guard.end(generation); terminal.dispose(); recording.mockRestore(); fetchSpy.mockRestore()
    if (previousIdle === undefined) delete process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS
    else process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = previousIdle
  }
}, 5000)

test('actual fork caller isolates child ownership and durably delivers to its own sidechain', async () => {
  const complete = deferred(), delivered = deferred()
  const guard = new QueryGuard()
  const generation = guard.tryStart()!
  const counter = join(root, `${bootstrap.getSessionId()}.direct-counter`)
  writeFileSync(counter, '0')
  const tool = buildTool({
    name: 'DurableCounter', inputSchema: z.object({}), description: async () => 'fixture', prompt: async () => 'fixture',
    maxResultSizeChars: 1000, renderToolUseMessage: () => null,
    async call() { writeFileSync(counter, String(Number(readFileSync(counter, 'utf8')) + 1)); await complete.promise; return { data: 'direct actual receipt' } },
    mapToolResultToToolResultBlockParam: (data, id) => ({ type: 'tool_result', tool_use_id: id, content: data }),
  })
  let requests = 0
  const fakeFetch = Object.assign(async () => {
    requests++
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(sse({ type: 'message_start', message: { id: 'direct-message', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }))
      controller.enqueue(sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'direct-effect', name: 'DurableCounter', input: {} } }))
      controller.enqueue(sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }))
      controller.enqueue(sse({ type: 'content_block_stop', index: 0 }))
    } }), { headers: { 'content-type': 'text/event-stream' } })
  }, { preconnect: globalThis.fetch.preconnect })
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fakeFetch)
  const vcr = await import('./services/vcr.js')
  const recording = spyOn(vcr, 'withStreamingVCR').mockImplementation(async function* (_messages, produce) { yield* produce() })
  const previousIdle = process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS
  process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '30'
  const messages: Message[] = [createUserMessage({ content: 'direct fixture' })]
  const config = engineConfig([tool])
  const terminal = createTerminalInterruptedTools({ sessionId: bootstrap.getSessionId(), guard, getMessages: () => messages, append: message => { messages.push(message); delivered.resolve() } })
  const owner = terminal.run
  const context = {
    messages, interruptedToolRun: owner,
    options: { commands: [], tools: [tool], debug: false, verbose: false, mainLoopModel: 'claude-sonnet-4-6', mainLoopProvider: 'firstParty', thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [], allAgents: [] } },
    abortController: new AbortController(), getAppState: config.getAppState, setAppState: config.setAppState,
    readFileState: config.readFileCache, setInProgressToolUseIDs: () => {}, setResponseLength: () => {}, updateFileHistoryState: () => {}, updateAttributionState: () => {},
  } as ToolUseContext
  const params = { messages, systemPrompt: asSystemPrompt(['isolated fixture']), userContext: {}, systemContext: {}, toolUseContext: context, canUseTool: config.canUseTool, querySource: 'sdk' as const }
  try {
    const childId = asAgentId('interrupted-child-fixture')
    await within(runForkedAgent({
      promptMessages: messages, cacheSafeParams: { systemPrompt: asSystemPrompt(['isolated child']), userContext: {}, systemContext: {}, toolUseContext: context, forkContextMessages: [] },
      canUseTool: config.canUseTool, querySource: 'sdk', forkLabel: 'fixture', skipTranscript: true,
      overrides: { agentId: childId },
      onMessage: message => { if (JSON.stringify(message).includes('direct actual receipt')) delivered.resolve() },
    }))
    const childOwner = getInterruptedToolRun(bootstrap.getSessionId(), childId)
    expect(childOwner).not.toBe(owner)
    expect(owner.ownPending).toBe(false)
    expect(childOwner.ownPending).toBe(true)
    expect(owner.blocked).toBe(true)
    expect(() => terminal.assertAdmission()).toThrow('Some tool actions')
    guard.end(generation)
    expect(readFileSync(counter, 'utf8')).toBe('1')
    expect(JSON.stringify(messages)).not.toContain('direct actual receipt')
    for await (const _row of query(params)) { /* A new query must not reach the provider. */ }
    expect(requests).toBe(1)
    complete.resolve()
    await within(delivered.promise)
    await Bun.sleep(0)
    expect(owner.blocked).toBe(false)
    const loaded = await storage.loadTranscriptFile(storage.getAgentTranscriptPath(asAgentId('interrupted-child-fixture')))
    expect([...loaded.messages.values()].some(message => JSON.stringify(message).includes('direct actual receipt'))).toBe(true)
    expect(readFileSync(counter, 'utf8')).toBe('1')
    expect(JSON.stringify(messages)).not.toContain('direct actual receipt')
  } finally {
    complete.resolve(); guard.end(generation); terminal.dispose(); recording.mockRestore(); fetchSpy.mockRestore()
    if (previousIdle === undefined) delete process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS
    else process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = previousIdle
  }
}, 5000)

test('actual runAgent transfers setup cleanup until its late receipt is durable and published', async () => {
  const complete = deferred(), delivered = deferred(), cleaned = deferred()
  const childId = asAgentId('interrupted-agent-cleanup-fixture')
  let childTranscriptPath = ''
  const releaseWorker = workerNames.releaseWorkerName
  const release = spyOn(workerNames, 'releaseWorkerName').mockImplementation(name => { releaseWorker(name); cleaned.resolve() })
  const clearMapping = spyOn(storage, 'clearAgentTranscriptSubdir')
  const guard = new QueryGuard()
  const generation = guard.tryStart()!
  const counter = join(root, `${bootstrap.getSessionId()}.direct-counter`)
  writeFileSync(counter, '0')
  const tool = buildTool({
    name: 'DurableCounter', inputSchema: z.object({}), description: async () => 'fixture', prompt: async () => 'fixture',
    maxResultSizeChars: 1000, renderToolUseMessage: () => null,
    async call() { childTranscriptPath = storage.getAgentTranscriptPath(childId); writeFileSync(counter, String(Number(readFileSync(counter, 'utf8')) + 1)); await complete.promise; return { data: 'direct actual receipt' } },
    mapToolResultToToolResultBlockParam: (data, id) => ({ type: 'tool_result', tool_use_id: id, content: data }),
  })
  let requests = 0
  const fakeFetch = Object.assign(async () => {
    requests++
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(sse({ type: 'message_start', message: { id: 'direct-message', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }))
      controller.enqueue(sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'direct-effect', name: 'DurableCounter', input: {} } }))
      controller.enqueue(sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }))
      controller.enqueue(sse({ type: 'content_block_stop', index: 0 }))
    } }), { headers: { 'content-type': 'text/event-stream' } })
  }, { preconnect: globalThis.fetch.preconnect })
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fakeFetch)
  const vcr = await import('./services/vcr.js')
  const recording = spyOn(vcr, 'withStreamingVCR').mockImplementation(async function* (_messages, produce) { yield* produce() })
  const previousIdle = process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS
  process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '30'
  const messages: Message[] = [createUserMessage({ content: 'direct fixture' })]
  const config = engineConfig([tool])
  const terminal = createTerminalInterruptedTools({ sessionId: bootstrap.getSessionId(), guard, getMessages: () => messages, append: message => { messages.push(message); delivered.resolve() } })
  const owner = terminal.run
  const context = {
    messages, interruptedToolRun: owner,
    options: { commands: [], tools: [tool], debug: false, verbose: false, mainLoopModel: 'claude-sonnet-4-6', mainLoopProvider: 'firstParty', thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [], allAgents: [] } },
    abortController: new AbortController(), getAppState: config.getAppState, setAppState: config.setAppState,
    readFileState: config.readFileCache, setInProgressToolUseIDs: () => {}, setResponseLength: () => {}, updateFileHistoryState: () => {}, updateAttributionState: () => {},
  } as ToolUseContext
  const params = { messages, systemPrompt: asSystemPrompt(['isolated fixture']), userContext: {}, systemContext: {}, toolUseContext: context, canUseTool: config.canUseTool, querySource: 'sdk' as const }
  try {
    context.toolUseId = 'cleanup-parent-tool'
    context.publishSubagentFrame = frame => {
      if (!JSON.stringify(frame).includes('direct actual receipt')) return
      expect(release.mock.calls).toHaveLength(0)
      expect(clearMapping.mock.calls).toHaveLength(0)
      expect(readFileSync(childTranscriptPath, 'utf8')).toContain('direct actual receipt')
      delivered.resolve()
    }
    await within((async () => {
      for await (const _message of runAgent({
        agentDefinition: { agentType: 'cleanup-fixture', source: 'built-in', baseDir: 'built-in', whenToUse: 'fixture', tools: [tool.name], getSystemPrompt: () => 'isolated cleanup fixture' },
        promptMessages: messages, toolUseContext: context, canUseTool: config.canUseTool,
        availableTools: [tool], useExactTools: true, isAsync: false,
        querySource: 'sdk', publishDisplaySteps: true, transcriptSubdir: 'cleanup-fixture',
        override: { agentId: childId, systemPrompt: asSystemPrompt(['isolated child']), userContext: {}, systemContext: {} },
      })) { /* Consume the actual caller, not a stubbed runAgent. */ }
    })())
    expect(release.mock.calls).toHaveLength(0)
    expect(clearMapping.mock.calls).toHaveLength(0)
    const childOwner = getInterruptedToolRun(bootstrap.getSessionId(), childId)
    expect(childOwner).not.toBe(owner)
    expect(owner.ownPending).toBe(false)
    expect(childOwner.ownPending).toBe(true)
    expect(owner.blocked).toBe(true)
    expect(() => terminal.assertAdmission()).toThrow('Some tool actions')
    guard.end(generation)
    expect(readFileSync(counter, 'utf8')).toBe('1')
    expect(JSON.stringify(messages)).not.toContain('direct actual receipt')
    for await (const _row of query(params)) { /* A new query must not reach the provider. */ }
    expect(requests).toBe(1)
    complete.resolve()
    await within(delivered.promise)
    await within(cleaned.promise)
    await Bun.sleep(0)
    expect(release.mock.calls).toHaveLength(1)
    expect(clearMapping.mock.calls).toHaveLength(1)
    expect(owner.blocked).toBe(false)
    const loaded = await storage.loadTranscriptFile(childTranscriptPath)
    expect([...loaded.messages.values()].some(message => JSON.stringify(message).includes('direct actual receipt'))).toBe(true)
    expect(readFileSync(counter, 'utf8')).toBe('1')
    expect(JSON.stringify(messages)).not.toContain('direct actual receipt')
  } finally {
    complete.resolve(); guard.end(generation); terminal.dispose(); recording.mockRestore(); fetchSpy.mockRestore(); release.mockRestore(); clearMapping.mockRestore()
    if (previousIdle === undefined) delete process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS
    else process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = previousIdle
  }
}, 5000)
