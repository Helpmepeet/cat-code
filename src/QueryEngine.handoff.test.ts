import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { randomUUID, type UUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as fsPromises from 'node:fs/promises'
import z from 'zod/v4'
import { feature } from 'bun:bundle'

// Establish isolation before loading persistence, settings, hooks or bootstrap.
const root = mkdtempSync(join(tmpdir(), 'query-engine-handoff-'))
mkdirSync(join(root, 'workspace'))
const previousConfig = process.env.CLAUDE_CONFIG_DIR
const previousApiKey = process.env.ANTHROPIC_API_KEY
const previousSimple = process.env.CLAUDE_CODE_SIMPLE
const macroGlobal = globalThis as unknown as { MACRO?: { VERSION: string } }
const previousMacro = macroGlobal.MACRO
macroGlobal.MACRO = { VERSION: 'handoff-test' }
process.env.ANTHROPIC_API_KEY = 'isolated-scripted-test-key'
process.env.CLAUDE_CODE_SIMPLE = '1'
process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
const { QueryEngine } = await import('./QueryEngine.js')
const { buildTool } = await import('./Tool.js')
const { getDefaultAppState } = await import('./state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import('./utils/fileStateCache.js')
const bootstrap = await import('./bootstrap/state.js')
const { asSessionId } = await import('./types/ids.js')
const storage = await import('./utils/sessionStorage.js')
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
  bootstrap.setSessionProvider('openai')
  spies.push(spyOn(growthbook, 'checkStatsigFeatureGate_CACHED_MAY_BE_STALE').mockReturnValue(false))
})
afterEach(async () => {
  process.env.CLAUDE_CODE_SIMPLE = '1'
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
    userSpecifiedModel: 'gpt-5.6-terra', thinkingConfig: { type: 'disabled' }, ...overrides,
  }
}
function engine(tools: ReturnType<typeof buildTool>[], overrides: Partial<QueryEngineConfig> = {}) {
  return new QueryEngine(engineConfig(tools, overrides))
}
function jumpTool() {
  return buildTool({
    name: 'Jump', inputSchema: z.object({}), description: async () => 'jump', prompt: async () => 'jump',
    maxResultSizeChars: 1000, renderToolUseMessage: () => null,
    async call(_input, context) {
      const request = { operationId: 'operation-test', toolUseId: context.toolUseId! }
      context.turnHandoff!.reserve(context, request)
      context.turnHandoff!.accept(context, request)
      return { data: 'accepted' }
    },
    mapToolResultToToolResultBlockParam: (_data, id) => ({ type: 'tool_result', tool_use_id: id, content: 'Jump accepted, movement pending.' }),
  })
}
async function drain(turn: AsyncIterable<SDKMessage>): Promise<SDKMessage[]> {
  const messages: SDKMessage[] = []
  for await (const message of turn) messages.push(message)
  return messages
}

function recovery(subtype: 'transport_recovery' | 'api_error'): Message {
  const message = subtype === 'transport_recovery'
    ? { type: 'system', subtype, uuid: randomUUID(), timestamp: new Date().toISOString(), content: 'Recovered scripted connection', attempt: 1, maxAttempts: 2 }
    : { type: 'system', subtype, uuid: randomUUID(), timestamp: new Date().toISOString(), retryAttempt: 1, maxRetries: 2, retryInMs: 0, error: { status: 503 } }
  return message as Message
}

test.each(['transport_recovery', 'api_error'] as const)('%s from the real system branch preserves completed work across ordinary input and outcome appends', async subtype => {
  process.env.CLAUDE_CODE_SIMPLE = '0'
  const first = assistant([{ type: 'text', text: 'completed first part' }])
  const completed = assistant([{ type: 'text', text: 'completed final report' }])
  const recovered = recovery(subtype)
  let modelCalls = 0
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
    modelCalls++
    if (modelCalls === 1) {
      yield first
      yield recovered as never
      yield completed
    } else {
      yield assistant([{ type: 'text', text: 'reviewed completed work' }])
    }
  }))
  const runtime = engine([])
  const output = await drain(runtime.submitMessage('complete the work'))
  expect(output.some(message => message.type === 'system' && message.subtype === 'api_retry' && message.uuid === recovered.uuid)).toBe(true)
  expect(output.at(-1)).toMatchObject({ type: 'result', subtype: 'success' })
  let admitted = false
  await drain(runtime.submitMessage('review the completed work', { onInputPersisted: () => { admitted = true } }))
  expect(admitted).toBe(true)
  await storage.flushSessionStorage()
  const path = storage.getTranscriptPathForSession(bootstrap.getSessionId())
  const loaded = await storage.loadTranscriptFile(path)
  const active = storage.selectActiveConversation(loaded.messages, loaded.leafUuids, loaded.activeConversationTip)
  expect(active.messages.map(message => message.uuid)).toEqual(runtime.getMessages().map(message => message.uuid))
  expect(loaded.messages.get(recovered.uuid as UUID)?.parentUuid).toBe(first.uuid as UUID)
  expect(loaded.messages.get(completed.uuid as UUID)?.parentUuid).toBe(recovered.uuid as UUID)
  const terminal = await runtime.persistHandoffOutcome('scripted-completed-work', 'uncertain')
  const reloaded = await storage.loadTranscriptFile(path)
  const settled = storage.selectActiveConversation(reloaded.messages, reloaded.leafUuids, reloaded.activeConversationTip)
  expect(settled.messages.some(message => message.uuid === completed.uuid)).toBe(true)
  expect(settled.tip?.uuid).toBe(terminal[1]?.uuid)
  expect(await runtime.persistHandoffOutcome('scripted-completed-work', 'uncertain')).toEqual(terminal)
  expect(modelCalls).toBe(2)
})

test.each(['ordinary input', 'terminal outcome'] as const)('defensive pre-existing deferred recovery refuses unsafe %s without publishing incomplete ancestry', async append => {
  process.env.CLAUDE_CODE_SIMPLE = '0'
  const { createUserMessage } = await import('./utils/messages.js')
  const user = createUserMessage({ content: 'complete the work' })
  const first = assistant([{ type: 'text', text: 'completed first part' }])
  const completed = assistant([{ type: 'text', text: 'completed final report' }])
  const recovered = recovery('transport_recovery')
  await storage.recordTranscript([user, first, completed])
  await storage.flushSessionStorage()
  const path = storage.getTranscriptPathForSession(bootstrap.getSessionId())
  const before = await fsPromises.readFile(path, 'utf8')
  let modelCalls = 0
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () { modelCalls++; yield assistant([{ type: 'text', text: 'unexpected turn' }]) }))
  const runtime = engine([], { initialMessages: [user, first, recovered, completed] })
  await expect(append === 'ordinary input'
    ? drain(runtime.submitMessage('review completed work'))
    : runtime.persistHandoffOutcome('unsafe-old-history', 'uncertain')).rejects.toThrow('Unsafe transcript append')
  await storage.flushSessionStorage()
  expect(await fsPromises.readFile(path, 'utf8')).toBe(before)
  const loaded = await storage.loadTranscriptFile(path)
  const active = storage.selectActiveConversation(loaded.messages, loaded.leafUuids, loaded.activeConversationTip)
  expect(active.tip?.uuid).toBe(completed.uuid)
  expect(active.messages.map(message => message.uuid)).toEqual([user.uuid, first.uuid, completed.uuid])
  expect(modelCalls).toBe(0)
})

test('recovery recording remains asynchronous while streamed assistant metadata settles', async () => {
  process.env.CLAUDE_CODE_SIMPLE = '0'
  const first = assistant([{ type: 'text', text: 'streamed first block' }])
  const completed = assistant([{ type: 'text', text: 'streamed final block' }])
  first.message.stop_reason = null
  completed.message.stop_reason = null
  completed.message.usage.output_tokens = 0
  const recovered = recovery('transport_recovery')
  let release!: () => void
  const metadataSettled = new Promise<void>(resolve => { release = resolve })
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
    yield first
    yield recovered as never
    yield completed
    completed.message.usage.output_tokens = 37
    completed.message.stop_reason = 'end_turn'
    release()
    yield { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 37 }, delta: { stop_reason: 'end_turn' } } } as never
  }))
  const runtime = engine([], { recordTranscript: async (...args) => {
    const tip = await storage.recordTranscript(...args)
    if (args[0].some(message => message.uuid === first.uuid)) await metadataSettled
    return tip
  } })
  expect((await drain(runtime.submitMessage('complete streamed work'))).at(-1)).toMatchObject({ type: 'result', subtype: 'success', stop_reason: 'end_turn' })
  await storage.flushSessionStorage()
  const loaded = await storage.loadTranscriptFile(storage.getTranscriptPathForSession(bootstrap.getSessionId()))
  const active = storage.selectActiveConversation(loaded.messages, loaded.leafUuids, loaded.activeConversationTip)
  const saved = active.messages.find(message => message.uuid === completed.uuid)
  expect(saved).toMatchObject({ message: { usage: { output_tokens: 37 }, stop_reason: 'end_turn' } })
  expect(active.messages.map(message => message.uuid)).toContain(recovered.uuid)
})

test('a deferred recovery write failure is observed before ordinary terminal success', async () => {
  const recovered = recovery('transport_recovery')
  const completed = assistant([{ type: 'text', text: 'finished scripted work' }])
  let release!: () => void
  const providerFinished = new Promise<void>(resolve => { release = resolve })
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
    yield assistant([{ type: 'text', text: 'first part' }])
    yield recovered as never
    yield completed
    release()
  }))
  const runtime = engine([], { recordTranscript: async (...args) => {
    if (args[0].at(-1)?.uuid === recovered.uuid) {
      await providerFinished
      throw new Error('isolated recovery write failure')
    }
    return storage.recordTranscript(...args)
  } })
  const output: SDKMessage[] = []
  await expect((async () => {
    for await (const message of runtime.submitMessage('complete the work')) output.push(message)
  })()).rejects.toThrow('isolated recovery write failure')
  expect(output.some(message => message.type === 'result' && message.subtype === 'success')).toBe(false)
})

// This exercises QueryEngine's actual query, tool executor, transcript owner,
// active-chain load and fsync boundary. Only provider output is scripted.
test('handoff emits its durable boundary and source usage, then internal continuation skips submit hooks', async () => {
  let submissions = 0
  let stopHooks = 0
  let cleanups = 0
  spies.push(spyOn(hooks, 'executeStopHooks').mockImplementation(async function* () { stopHooks++ }))
  if (feature('CHICAGO_MCP')) {
    const cleanup = await import('./utils/computerUse/cleanup.js')
    spies.push(spyOn(cleanup, 'cleanupComputerUseAfterTurn').mockImplementation(async () => { cleanups++ }))
  }
  spies.push(spyOn(hooks, 'executeUserPromptSubmitHooks').mockImplementation(async function* () { submissions++ }))
  let modelCalls = 0
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
    modelCalls++
    yield { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } } } as never
    yield assistant(modelCalls === 1
      ? [{ type: 'tool_use', id: 'jump-sdk', name: 'Jump', input: {} }]
      : [{ type: 'text', text: 'continued the saved request' }])
    yield { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 3 }, delta: { stop_reason: 'tool_use' } } } as never
    yield { type: 'stream_event', event: { type: 'message_stop' } } as never
  }))
  const runtime = engine([jumpTool()])
  const source = await drain(runtime.submitMessage('What is the selected project?'))
  const result = source.findLast(m => m.type === 'result')
  expect(result).toMatchObject({ type: 'result', subtype: 'handoff', operation_id: 'operation-test', usage: { input_tokens: 10, output_tokens: 3 }, transcript_boundary: { tool_use_id: 'jump-sdk' } })
  expect(SDKResultHandoffSchema().safeParse(result).success).toBe(true)
  expect(SDKResultHandoffSchema().safeParse({ ...result, is_error: true }).success).toBe(false)
  expect(modelCalls).toBe(1)
  expect(stopHooks).toBe(0)
  if (feature('CHICAGO_MCP')) expect(cleanups).toBe(1)
  const chain = await storage.loadTranscriptFile(storage.getTranscriptPathForSession(bootstrap.getSessionId()))
  const active = storage.selectActiveConversation(chain.messages, chain.leafUuids, chain.activeConversationTip)
  expect(active.tip?.uuid).toBe((result as { transcript_boundary: { tip_uuid: string } }).transcript_boundary.tip_uuid)
  const continuationId = randomUUID()
  let admitted = false
  await drain(runtime.continueHandoff('operation-test', { uuid: continuationId, onInputPersisted: () => { admitted = true } }))
  expect(admitted).toBe(true)
  expect(submissions).toBe(1)
  expect(modelCalls).toBe(2)
  expect(stopHooks).toBe(1)
  expect(runtime.getMessages().filter(m => m.type === 'user' && m.uuid === continuationId)).toHaveLength(1)
  expect(runtime.getMessages().filter(m => m.type === 'user' && m.message.content === 'What is the selected project?')).toHaveLength(1)
})

test('accepted move without persistence emits failure and never publishes readiness', async () => {
  delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  let calls = 0
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () { calls++; yield assistant([{ type: 'tool_use', id: 'jump-no-persistence', name: 'Jump', input: {} }]) }))
  const output = await drain(engine([jumpTool()]).submitMessage('jump'))
  expect(output.findLast(m => m.type === 'result')).toMatchObject({ subtype: 'error_during_execution', is_error: true })
  expect(output.some(m => m.type === 'result' && m.subtype === 'handoff')).toBe(false)
  expect(calls).toBe(1)
})


test('write failure prevents readiness and trusted terminal outcome persists the fenced exchange without a model turn', async () => {
  let calls = 0
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
    calls++; yield assistant([
      { type: 'tool_use', id: 'jump-write-failure', name: 'Jump', input: {} },
      { type: 'tool_use', id: 'later-edit', name: 'Edit', input: {} },
    ])
  }))
  let cleanups = 0
  if (feature('CHICAGO_MCP')) {
    const cleanup = await import('./utils/computerUse/cleanup.js')
    spies.push(spyOn(cleanup, 'cleanupComputerUseAfterTurn').mockImplementation(async () => { cleanups++ }))
  }
  let failOnce = true
  const runtime = engine([jumpTool()], { recordTranscript: async (...args) => {
    const hasPairedResult = args[0].some(m => m.type === 'user' && Array.isArray(m.message.content) && m.message.content.some(b => b.type === 'tool_result'))
    await storage.recordTranscript(...args)
    if (failOnce && hasPairedResult) {
      failOnce = false
      throw new Error('private filesystem details must not reach the model')
    }
    return null
  } })
  const output = await drain(runtime.submitMessage('jump'))
  expect(output.some(m => m.type === 'result' && m.subtype === 'handoff')).toBe(false)
  expect(output.findLast(m => m.type === 'result')).toMatchObject({ subtype: 'error_during_execution' })
  if (feature('CHICAGO_MCP')) expect(cleanups).toBe(1)
  const terminal = await runtime.persistHandoffOutcome('operation-test', 'failed')
  expect(terminal).toEqual([expect.objectContaining({ type: 'system', subtype: 'local_command_output' }), expect.objectContaining({ type: 'user', isSynthetic: true })])
  expect(JSON.stringify(terminal)).not.toContain('private filesystem details')
  expect(calls).toBe(1)
  const loaded = await storage.loadTranscriptFile(storage.getTranscriptPathForSession(bootstrap.getSessionId()))
  const active = storage.selectActiveConversation(loaded.messages, loaded.leafUuids, loaded.activeConversationTip)
  expect(active.messages.flatMap(m => m.type === 'user' && Array.isArray(m.message.content) ? m.message.content.filter(b => b.type === 'tool_result').map(b => b.tool_use_id) : [])).toEqual(['jump-write-failure', 'later-edit'])
  expect(active.tip?.uuid).toBe(terminal[1]?.uuid)
  expect(toSDKMessages(active.messages).find(m => m.type === 'system' && m.subtype === 'local_command_output')).toEqual(terminal[0])
  const retransmit = await runtime.persistHandoffOutcome('operation-test', 'failed')
  expect(retransmit).toEqual(terminal)
  const reloaded = await storage.loadTranscriptFile(storage.getTranscriptPathForSession(bootstrap.getSessionId()))
  const replay = storage.selectActiveConversation(reloaded.messages, reloaded.leafUuids, reloaded.activeConversationTip)
  expect(replay.messages.filter(m => m.type === 'system' && m.subtype === 'workspace_handoff_outcome')).toHaveLength(1)
  await expect(runtime.persistHandoffOutcome('operation-test', 'uncertain')).rejects.toThrow('conflicts')
})


test.each(['uncertain', 'cancelled'] as const)('%s terminal outcome is visible and never claims admitted work did not continue', async outcome => {
  let modelCalls = 0
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () { modelCalls++; throw new Error('terminal outcomes cannot query a model') }))
  const runtime = engine([])
  const output = await runtime.persistHandoffOutcome('interrupted-operation', outcome)
  const visible = output.find(m => m.type === 'system' && m.subtype === 'local_command_output') as { content: string }
  expect(visible.content).toContain(outcome === 'uncertain' ? 'Some work may have started' : 'Review existing progress')
  expect(visible.content).not.toContain('Work did not continue')
  expect(modelCalls).toBe(0)
})

test('reopening a durable cancellation without a host operation preserves the hold until a genuine user input is persisted', async () => {
  let modelCalls = 0
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
    modelCalls++; yield assistant([{ type: 'text', text: 'reviewed existing progress' }])
  }))
  await engine([]).persistHandoffOutcome('never-accepted-operation', 'cancelled')
  const path = storage.getTranscriptPathForSession(bootstrap.getSessionId())
  const resumed = await loadConversationForResume(bootstrap.getSessionId(), path, { interruptedTurn: 'ignore' })
  expect(resumed).not.toBeNull()
  let initializedWithHold = false
  const reopened = createRuntimeBackedAppSession({
    queryEngineConfig: engineConfig([], { initialMessages: resumed!.messages }),
    initializeController: controller => { initializedWithHold = controller.requiresHandoffReconciliation() },
  })
  expect(initializedWithHold).toBe(true)
  expect(reopened.canStartAutomaticTurn()).toBe(false)
  await expect(reopened.submit('automatic continuation', { isMeta: true })).rejects.toThrow('user reconciliation')
  expect(modelCalls).toBe(0)
  process.env.CLAUDE_CODE_SIMPLE = '0'
  try { await reopened.submit('review the progress and continue') }
  finally { process.env.CLAUDE_CODE_SIMPLE = '1' }
  expect(reopened.requiresHandoffReconciliation()).toBe(false)
  await storage.flushCurrentTranscriptDurably()
  const afterUser = await loadConversationForResume(bootstrap.getSessionId(), path, { interruptedTurn: 'ignore' })
  const reconciled = createRuntimeBackedAppSession({ queryEngineConfig: engineConfig([], { initialMessages: afterUser!.messages }) })
  expect(reconciled.requiresHandoffReconciliation()).toBe(false)
  expect(reconciled.canStartAutomaticTurn()).toBe(true)
  expect(modelCalls).toBe(1)
})

test.each(['complete', 'fail'] as const)('reconciliation admission waits for actual transcript durability (%s)', async barrierOutcome => {
  let modelCalls = 0
  let receiptCount = 0
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
    modelCalls++; yield assistant([{ type: 'text', text: 'reviewed existing progress' }])
  }))
  const original = engine([])
  await original.persistHandoffOutcome('reconciliation-barrier-operation', 'cancelled')
  const path = storage.getTranscriptPathForSession(bootstrap.getSessionId())
  const resumed = await loadConversationForResume(bootstrap.getSessionId(), path, { interruptedTurn: 'ignore' })
  const reopened = createRuntimeBackedAppSession({ queryEngineConfig: engineConfig([], { initialMessages: resumed!.messages }) })
  const inputUuid = randomUUID()
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  let syncStarted = false
  const realOpen = fsPromises.open
  spies.push(spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
    const handle = await realOpen(...args)
    if (String(args[0]) === path) {
      const realSync = handle.sync.bind(handle)
      handle.sync = async () => {
        syncStarted = true
        await blocked
        if (barrierOutcome === 'fail') throw new Error('isolated transcript sync failure')
        await realSync()
      }
    }
    return handle
  }))
  // Both ordinary and bare-mode reconciliation must use the stronger barrier.
  process.env.CLAUDE_CODE_SIMPLE = barrierOutcome === 'complete' ? '1' : '0'
  let failure: unknown
  const turn = reopened.submit('review the progress and continue', {
    uuid: inputUuid, onInputPersisted: () => { receiptCount++ },
  }).catch(error => { failure = error })
  try {
    for (let i = 0; i < 100 && !syncStarted && modelCalls === 0; i++) await new Promise(resolve => setTimeout(resolve, 5))
    expect(syncStarted).toBe(true)
    expect(reopened.requiresHandoffReconciliation()).toBe(true)
    expect(receiptCount).toBe(0)
    expect(modelCalls).toBe(0)
  } finally {
    release()
    await turn
    process.env.CLAUDE_CODE_SIMPLE = '1'
  }
  if (barrierOutcome === 'fail') {
    expect(failure).toBeInstanceOf(Error)
    expect(reopened.requiresHandoffReconciliation()).toBe(true)
    expect(reopened.canStartAutomaticTurn()).toBe(false)
    expect(receiptCount).toBe(0)
    expect(modelCalls).toBe(0)
  } else {
    expect(failure).toBeUndefined()
    expect(receiptCount).toBe(1)
    expect(modelCalls).toBe(1)
    expect(reopened.requiresHandoffReconciliation()).toBe(false)
    const loaded = await storage.loadTranscriptFile(path)
    const active = storage.selectActiveConversation(loaded.messages, loaded.leafUuids, loaded.activeConversationTip)
    expect(active.messages.some(message => message.type === 'user' && message.uuid === inputUuid)).toBe(true)
  }
})

// W/R protects complete independently retained engine content; the fixtures use
// the real writer/selector and never supply a successful checkpoint.
test('resume seal retains final streamed metadata and excludes later appended records from its proof', async () => {
  process.env.CLAUDE_CODE_SIMPLE = '0'
  const completed = assistant([{ type: 'text', text: 'streamed complete report' }])
  completed.message.usage.output_tokens = 0
  completed.message.stop_reason = null
  let persistedEarly = false
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
    yield completed
    await storage.flushCurrentTranscriptDurably()
    const before = await storage.loadTranscriptFile(storage.getTranscriptPathForSession(bootstrap.getSessionId()))
    expect(before.messages.get(completed.uuid as UUID)).toMatchObject({ message: { usage: { output_tokens: 0 }, stop_reason: null } })
    persistedEarly = true
    completed.message.usage.output_tokens = 91
    completed.message.stop_reason = 'end_turn'
  }))
  const runtime = engine([])
  await drain(runtime.submitMessage('finish the work'))
  expect(persistedEarly).toBe(true)
  const checkpoint = await runtime.sealResumeCheckpoint()
  expect(checkpoint.messageCount).toBe(storage.intendedResumeProjection([...runtime.getMessages()]).length)
  const { createUserMessage } = await import('./utils/messages.js')
  await storage.recordTranscript([...runtime.getMessages(), createUserMessage({ content: 'later conversation' })])
  await storage.flushCurrentTranscriptDurably()
  await storage.verifyResumeCheckpoint(checkpoint)
  const prefix = await storage.loadTranscriptFile(storage.getTranscriptPathForSession(bootstrap.getSessionId()), { prefixBytes: checkpoint.prefixBytes, strict: true, keepAllLeaves: true })
  const active = storage.selectActiveConversation(prefix.messages, prefix.leafUuids, prefix.activeConversationTip)
  expect(active.tip?.uuid).toBe(completed.uuid)
  expect(active.messages.find(message => message.uuid === completed.uuid)).toMatchObject({ message: { usage: { output_tokens: 91 }, stop_reason: 'end_turn' } })
})

test('seal verifies full parallel results over the large-file threshold and fails on missing content', async () => {
  const { createUserMessage } = await import('./utils/messages.js')
  const user = createUserMessage({ content: 'large complete prefix ' + 'x'.repeat(6 * 1024 * 1024) })
  const left = assistant([{ type: 'tool_use', id: 'left-use', name: 'Read', input: { file_path: 'left' } }])
  const right = assistant([{ type: 'tool_use', id: 'right-use', name: 'Read', input: { file_path: 'right' } }])
  right.message.id = left.message.id
  const leftResult = createUserMessage({ sourceToolAssistantUUID: left.uuid as UUID,
    content: [{ type: 'tool_result', tool_use_id: 'left-use', content: 'real left result' }] })
  const rightResult = createUserMessage({ sourceToolAssistantUUID: right.uuid as UUID,
    content: [{ type: 'tool_result', tool_use_id: 'right-use', content: 'real right result' }] })
  const completed = assistant([{ type: 'text', text: 'both results complete' }])
  const intended = [user, left, right, leftResult, rightResult, completed]
  await storage.recordTranscript(intended)
  const runtime = engine([], { initialMessages: intended })
  const checkpoint = await runtime.sealResumeCheckpoint()
  expect(checkpoint.prefixBytes).toBeGreaterThan(5 * 1024 * 1024)
  expect(checkpoint.messageCount).toBe(6)
  await runtime.verifyResumeCheckpoint(checkpoint)
  const path = storage.getTranscriptPathForSession(bootstrap.getSessionId())
  const text = await fsPromises.readFile(path, 'utf8')
  await fsPromises.writeFile(path, text.replace('real right result', 'lost right result'))
  await expect(runtime.verifyResumeCheckpoint(checkpoint)).rejects.toThrow('digest differs')
  await expect(runtime.sealResumeCheckpoint()).rejects.toThrow('projection differs')
})

test('seal uses valid compaction logging transforms and preserves retained provenance', async () => {
  const { createUserMessage, createCompactBoundaryMessage } = await import('./utils/messages.js')
  const { annotateBoundaryWithPreservedSegment } = await import('./services/compact/compact.js')
  const archival = createUserMessage({ content: 'archival ' + 'x'.repeat(6 * 1024 * 1024) })
  const retained = createUserMessage({ content: 'retained real instruction', origin: { kind: 'deferred-continuation', jobId: 'job', attemptUuid: randomUUID() } })
  await storage.recordTranscript([archival, retained])
  const summary = createUserMessage({ content: 'real compact summary', isCompactSummary: true, isVisibleInTranscriptOnly: true })
  const boundary = annotateBoundaryWithPreservedSegment(createCompactBoundaryMessage('auto', 180_000, retained.uuid as UUID), summary.uuid as UUID, [retained], [archival, retained])
  const intended = [boundary, summary, retained]
  await storage.recordTranscript(intended)
  const runtime = engine([], { initialMessages: intended })
  const checkpoint = await runtime.sealResumeCheckpoint()
  expect(checkpoint.messageCount).toBe(3)
  await runtime.verifyResumeCheckpoint(checkpoint)
  const loaded = await storage.loadTranscriptFile(storage.getTranscriptPathForSession(bootstrap.getSessionId()), { prefixBytes: checkpoint.prefixBytes, strict: true, keepAllLeaves: true })
  const active = storage.selectActiveConversation(loaded.messages, loaded.leafUuids, loaded.activeConversationTip)
  expect(active.messages.map(message => message.uuid)).toEqual([boundary.uuid, summary.uuid, retained.uuid])
  expect(active.messages.at(-1)).toMatchObject({ origin: retained.origin })
})

test.each(['transcript', 'directory'] as const)('seal does not certify %s fsync failure or a malformed bounded prefix', async failure => {
  const { createUserMessage } = await import('./utils/messages.js')
  const intended = [createUserMessage({ content: 'persist this real input' })]
  await storage.recordTranscript(intended)
  await storage.flushCurrentTranscriptDurably()
  const runtime = engine([], { initialMessages: intended })
  const realOpen = fsPromises.open
  const path = storage.getTranscriptPathForSession(bootstrap.getSessionId())
  const syncSpy = spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
    const handle = await realOpen(...args)
    if ((failure === 'transcript' && String(args[0]) === path) ||
      (failure === 'directory' && String(args[0]) === join(path, '..'))) {
      handle.sync = async () => { throw new Error('isolated fsync failure') }
    }
    return handle
  })
  try { await expect(runtime.sealResumeCheckpoint()).rejects.toThrow('isolated fsync failure') }
  finally { syncSpy.mockRestore() }
  const checkpoint = await runtime.sealResumeCheckpoint()
  const text = await fsPromises.readFile(path, 'utf8')
  await fsPromises.writeFile(path, text.slice(0, -1))
  await expect(storage.loadTranscriptFile(path, { prefixBytes: checkpoint.prefixBytes - 1, strict: true })).rejects.toThrow('newline aligned')
})

function handoffConfiguration(admission = true) {
  const generation = randomUUID()
  return { identity: { appSessionId: randomUUID(), engineSessionId: bootstrap.getSessionId(),
    operationId: randomUUID(), continuationId: randomUUID(), sourceGeneration: randomUUID(),
    admissionGeneration: admission ? generation : null, operationSha256: 'd'.repeat(64) },
    observerGeneration: generation, origin: 'fresh' as const, recover: false }
}

test.each(['before_claim', 'while_running', 'after_success', 'after_failure'] as const)('real engine cancellation ordering preserves %s execution evidence', async ordering => {
  const { createUserMessage } = await import('./utils/messages.js')
  const { createQueryEngineSessionController } = await import('./app-runtime/createQueryEngineSessionController.js')
  const seed = createUserMessage({ content: 'original requested work' })
  await storage.recordTranscript([seed])
  await storage.flushCurrentTranscriptDurably()
  let providerCalls = 0
  let releaseProvider!: () => void
  const blockedProvider = new Promise<void>(resolve => { releaseProvider = resolve })
  const completed = assistant([{ type: 'text', text: 'actual execution result' }])
  if (ordering === 'after_failure') completed.isApiErrorMessage = true
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
    providerCalls++
    if (ordering === 'while_running') await blockedProvider
    yield completed
  }))
  const runtime = engine([], { initialMessages: [seed] })
  const controller = createQueryEngineSessionController(runtime)
  const configuration = handoffConfiguration()
  await controller.configureWorkspaceHandoff(configuration)
  const cancelId = randomUUID()
  if (ordering === 'before_claim') {
    await controller.cancelWorkspaceHandoff(cancelId)
    await expect(controller.startHandoffContinuation()).rejects.toThrow('cannot be replayed')
    await controller.settleWorkspaceHandoff('cancelled')
    expect(providerCalls).toBe(0)
    expect(controller.getWorkspaceHandoffSnapshot()?.record).toMatchObject({ kind: 'valid', record: {
      consumed: false, cancellation: { cancelId, application: 'prevented_start' }, terminal: { outcome: 'not_started' } } })
    return
  }
  let lateCancellation: Promise<void> | null = null
  const unsubscribe = controller.subscribeHandoffStatus(() => {
    if (ordering.startsWith('after_') && !lateCancellation && controller.getWorkspaceHandoffSnapshot()?.execution === 'finalizing') {
      // Assign a sentinel before cancel's synchronous notification can recur.
      lateCancellation = Promise.resolve()
      lateCancellation = controller.cancelWorkspaceHandoff(cancelId)
    }
  })
  const { completion } = await controller.startHandoffContinuation()
  if (ordering === 'while_running') {
    while (!providerCalls) await Bun.sleep(1)
    await controller.cancelWorkspaceHandoff(cancelId)
    releaseProvider()
  }
  await completion
  if (lateCancellation) await lateCancellation
  unsubscribe()
  const snapshot = controller.getWorkspaceHandoffSnapshot()!
  expect(snapshot.record.kind).toBe('valid')
  if (snapshot.record.kind !== 'valid') throw new Error('Missing real execution receipt')
  const record = snapshot.record.record
  expect(record.inputCommitted).toBe(true)
  expect(record.terminal?.outcome).toBe(ordering === 'while_running' ? 'interrupted' : ordering === 'after_failure' ? 'failed' : 'success')
  expect(record.cancellation?.application).toBe(ordering === 'while_running' ? 'abort_signalled' : 'too_late')
  if (ordering.startsWith('after_')) expect(record.terminal!.order).toBeLessThan(record.cancellation!.order)
  expect(providerCalls).toBe(1)
  await runtime.verifyResumeCheckpoint(record.terminal!.checkpoint)
  await (await controller.startHandoffContinuation()).completion
  expect(providerCalls).toBe(1)
  if (ordering === 'after_success') {
    await expect(controller.settleWorkspaceHandoff('uncertain')).rejects.toThrow('cannot publish a warning')
    expect(runtime.getMessages().some(message => message.type === 'system' && message.subtype === 'workspace_handoff_outcome')).toBe(false)
  }
})

test('restart recovers genuine input committed before reconciliation receipt without replaying that input', async () => {
  const { createUserMessage } = await import('./utils/messages.js')
  const { createQueryEngineSessionController } = await import('./app-runtime/createQueryEngineSessionController.js')
  const seed = createUserMessage({ content: 'original work' })
  await storage.recordTranscript([seed])
  await storage.flushCurrentTranscriptDurably()
  let providerCalls = 0
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () { providerCalls++; yield assistant([{ type: 'text', text: 'unexpected replay' }]) }))
  const runtime = engine([], { initialMessages: [seed] })
  const controller = createQueryEngineSessionController(runtime)
  const configuration = handoffConfiguration(false)
  await controller.configureWorkspaceHandoff(configuration)
  await controller.settleWorkspaceHandoff('uncertain')
  const status = controller.getWorkspaceHandoffSnapshot()!
  if (status.record.kind !== 'valid' || !status.record.record.notice) throw new Error('Missing real warning receipt')
  const notice = status.record.record.notice
  const inputUuid = randomUUID(), contextUuid = randomUUID()
  await expect(drain(runtime.submitMessage('review the actual progress', {
    uuid: inputUuid, handoffReconciliationAdmission: true,
    handoffReconciliationContext: { operationId: configuration.identity.operationId, noticeUuid: notice.displayUuid, contextUuid },
    onHandoffInputCommitted: async () => { throw new Error('isolated process death before receipt') },
  }))).rejects.toThrow('before receipt')
  expect(providerCalls).toBe(0)
  const loaded = await storage.loadTranscriptFile(storage.getTranscriptPathForSession(bootstrap.getSessionId()), { keepAllLeaves: true, strict: true })
  const active = storage.selectActiveConversation(loaded.messages, loaded.leafUuids, loaded.activeConversationTip)
  const replacement = createQueryEngineSessionController(engine([], { initialMessages: storage.removeExtraFields(active.messages) }))
  await replacement.configureWorkspaceHandoff({ ...configuration, recover: true, observerGeneration: randomUUID() })
  expect(replacement.getWorkspaceHandoffSnapshot()).toMatchObject({ gate: { mode: 'open', requiresUserReconciliation: false },
    record: { kind: 'valid', record: { reconciliation: { noticeUuid: notice.displayUuid, inputUuid, contextUuid } } } })
  expect(providerCalls).toBe(0)
})

test('a recovered actual SDK APIError uses the existing enumerable JSON logging representation in the seal', async () => {
  const { APIError } = await import('@anthropic-ai/sdk')
  const { createSystemAPIErrorMessage } = await import('./utils/messages.js')
  const error = new APIError(503, { error: { type: 'api_error', message: 'isolated recovered transport' } }, 'isolated recovered transport', new Headers({ 'request-id': 'isolated' }))
  const recovered = createSystemAPIErrorMessage(error, 0, 1, 2)
  const completed = assistant([{ type: 'text', text: 'completed after actual SDK recovery' }])
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () { yield recovered as never; yield completed }))
  const runtime = engine([])
  await drain(runtime.submitMessage('complete after recovery'))
  const checkpoint = await runtime.sealResumeCheckpoint()
  await runtime.verifyResumeCheckpoint(checkpoint)
  const loaded = await storage.loadTranscriptFile(storage.getTranscriptPathForSession(bootstrap.getSessionId()), { prefixBytes: checkpoint.prefixBytes, strict: true, keepAllLeaves: true })
  expect(loaded.messages.get(recovered.uuid as UUID)).toMatchObject({ error: { status: 503, error: { error: { type: 'api_error', message: 'isolated recovered transport' } } } })
})

test('execution evidence refuses unsafe parent traversal, conflicting identity, malformed and oversized records', async () => {
  const { readWorkspaceHandoffExecution, updateWorkspaceHandoffExecution, workspaceHandoffExecutionDirectory } = await import('./utils/workspaceHandoffExecutionState.js')
  const { createUserMessage } = await import('./utils/messages.js')
  await storage.recordTranscript([createUserMessage({ content: 'lease authority' })])
  await storage.flushCurrentTranscriptDurably()
  const identity = handoffConfiguration().identity
  const first = await updateWorkspaceHandoffExecution(identity, () => ({ ...identity, version: 1, origin: 'fresh', revision: 1,
    consumed: false, inputCommitted: false, cancellation: null, terminal: null, notice: null, reconciliation: null }))
  expect(await readWorkspaceHandoffExecution(identity)).toMatchObject({ kind: 'valid', record: first })
  expect(await readWorkspaceHandoffExecution({ ...identity, appSessionId: randomUUID() })).toEqual({ kind: 'identity_mismatch' })
  const directory = join(workspaceHandoffExecutionDirectory(), identity.engineSessionId)
  const path = join(directory, `${identity.operationId}.json`)
  const text = await fsPromises.readFile(path, 'utf8')
  await fsPromises.writeFile(path, text.replace('"version":1', '"version":99'))
  expect(await readWorkspaceHandoffExecution(identity)).toEqual({ kind: 'invalid' })
  await fsPromises.writeFile(path, 'x'.repeat(16 * 1024 + 1))
  expect(await readWorkspaceHandoffExecution(identity)).toEqual({ kind: 'invalid' })
  await fsPromises.writeFile(path, text)
  await fsPromises.rename(directory, `${directory}-outside`)
  await fsPromises.symlink(`${directory}-outside`, directory)
  expect(await readWorkspaceHandoffExecution(identity)).toEqual({ kind: 'invalid' })
  await expect(updateWorkspaceHandoffExecution(identity, previous => ({ ...previous!, revision: previous!.revision + 1 }))).rejects.toThrow('unavailable')
})

test.each(['file_sync', 'replacement', 'directory_sync', 'base_sync', 'config_sync'] as const)('execution record %s failure retains prior evidence or remains unconfirmed until its barrier passes', async failure => {
  const { readWorkspaceHandoffExecution, updateWorkspaceHandoffExecution, workspaceHandoffExecutionDirectory } = await import('./utils/workspaceHandoffExecutionState.js')
  const { createUserMessage } = await import('./utils/messages.js')
  await storage.recordTranscript([createUserMessage({ content: 'lease authority' })])
  await storage.flushCurrentTranscriptDurably()
  const identity = handoffConfiguration().identity
  const previous = await updateWorkspaceHandoffExecution(identity, () => ({ ...identity, version: 1, origin: 'fresh', revision: 1,
    consumed: false, inputCommitted: false, cancellation: null, terminal: null, notice: null, reconciliation: null }))
  const realOpen = fsPromises.open, realRename = fsPromises.rename
  const directory = join(workspaceHandoffExecutionDirectory(), identity.engineSessionId)
  const faults: { mockRestore(): void }[] = []
  let replacementPublished = false
  const linkSyncFailure = ['directory_sync', 'base_sync', 'config_sync'].includes(failure)
  const selectedDirectory = failure === 'base_sync' ? workspaceHandoffExecutionDirectory() : failure === 'config_sync' ? process.env.CLAUDE_CONFIG_DIR! : directory
  if (linkSyncFailure) faults.push(spyOn(fsPromises, 'rename').mockImplementation(async (...args) => {
    await realRename(...args)
    if (String(args[1]).startsWith(directory)) replacementPublished = true
  }))
  if (failure === 'replacement') faults.push(spyOn(fsPromises, 'rename').mockImplementation(async (...args) => {
    if (String(args[1]).startsWith(directory)) throw new Error('isolated record replacement failure')
    return realRename(...args)
  }))
  else faults.push(spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
    const handle = await realOpen(...args)
    if ((failure === 'file_sync' && String(args[0]).startsWith(directory) && String(args[0]).endsWith('.tmp')) ||
      (linkSyncFailure && replacementPublished && String(args[0]) === selectedDirectory)) handle.sync = async () => { throw new Error('isolated record sync failure') }
    return handle
  }))
  try {
    await expect(updateWorkspaceHandoffExecution(identity, old => ({ ...old!, revision: old!.revision + 1, consumed: true }))).rejects.toThrow()
    const status = await readWorkspaceHandoffExecution(identity)
    if (linkSyncFailure) expect(status).toEqual({ kind: 'unreadable' })
    else expect(status).toMatchObject({ kind: 'valid', record: previous })
  } finally { for (const fault of faults) fault.mockRestore() }
  expect(await readWorkspaceHandoffExecution(identity)).toMatchObject({ kind: 'valid', record: { consumed: linkSyncFailure, revision: linkSyncFailure ? 2 : 1 } })
})

test('execution-store terminal evidence is immutable and replacement revisions remain monotonic', async () => {
  const { updateWorkspaceHandoffExecution, readWorkspaceHandoffExecution } = await import('./utils/workspaceHandoffExecutionState.js')
  const { createUserMessage } = await import('./utils/messages.js')
  const intended = [createUserMessage({ content: 'independent persisted projection' })]
  await storage.recordTranscript(intended)
  const checkpoint = await storage.sealResumeCheckpoint(intended)
  const identity = handoffConfiguration().identity
  const terminal = { outcome: 'success' as const, order: 1, checkpoint }
  const original = await updateWorkspaceHandoffExecution(identity, () => ({ ...identity, version: 1, origin: 'fresh', revision: 1,
    consumed: true, inputCommitted: true, cancellation: null, terminal, notice: null, reconciliation: null }))
  await expect(updateWorkspaceHandoffExecution(identity, old => ({ ...old!, revision: 1 }))).rejects.toThrow('replacement')
  await expect(updateWorkspaceHandoffExecution(identity, old => ({ ...old!, revision: old!.revision + 1,
    terminal: { ...terminal, outcome: 'failed' } }))).rejects.toThrow('Conflicting')
  await expect(updateWorkspaceHandoffExecution(identity, old => ({ ...old!, revision: old!.revision + 1,
    forgedPath: '/forged' }))).rejects.toThrow('Invalid')
  expect(await readWorkspaceHandoffExecution(identity)).toEqual({ kind: 'valid', record: original })
  const extended = await updateWorkspaceHandoffExecution(identity, old => ({ ...old!, revision: old!.revision + 1,
    cancellation: { cancelId: randomUUID(), application: 'too_late', order: 2 } }))
  expect(extended.revision).toBe(2)
  expect(extended.terminal).toEqual(terminal)
})

test('handoff storage migration initializes only private metadata and preserves transcript and host-ledger bytes', async () => {
  const { migrateWorkspaceHandoffStorage } = await import('./migrations/migrateWorkspaceHandoffStorage.js')
  const { workspaceHandoffExecutionDirectory } = await import('./utils/workspaceHandoffExecutionState.js')
  const { createUserMessage } = await import('./utils/messages.js')
  await storage.recordTranscript([createUserMessage({ content: 'saved conversation remains owned' })])
  await storage.flushCurrentTranscriptDurably()
  const transcript = storage.getTranscriptPathForSession(bootstrap.getSessionId())
  const ledgerDirectory = join(process.env.CLAUDE_CONFIG_DIR!, 'workspace-jumps')
  await fsPromises.mkdir(ledgerDirectory, { recursive: true, mode: 0o700 })
  const ledger = join(ledgerDirectory, `${randomUUID()}.json`)
  await fsPromises.writeFile(ledger, '{"version":1,"preserve":"host-owned"}\n', { mode: 0o600 })
  const beforeTranscript = await fsPromises.readFile(transcript), beforeLedger = await fsPromises.readFile(ledger)
  expect(migrateWorkspaceHandoffStorage()).toBeNull()
  expect((await fsPromises.stat(workspaceHandoffExecutionDirectory())).mode & 0o777).toBe(0o700)
  expect(await fsPromises.readFile(transcript)).toEqual(beforeTranscript)
  expect(await fsPromises.readFile(ledger)).toEqual(beforeLedger)
})

test('live reconciliation receipt retry reuses one accepted input and context before exactly one provider execution', async () => {
  const { createUserMessage } = await import('./utils/messages.js')
  const { createQueryEngineSessionController } = await import('./app-runtime/createQueryEngineSessionController.js')
  const { workspaceHandoffExecutionDirectory } = await import('./utils/workspaceHandoffExecutionState.js')
  const seed = createUserMessage({ content: 'saved user request' })
  await storage.recordTranscript([seed]); await storage.flushCurrentTranscriptDurably()
  let calls = 0
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () { calls++; yield assistant([{ type: 'text', text: 'reviewed once' }]) }))
  const runtime = engine([], { initialMessages: [seed] })
  const controller = createQueryEngineSessionController(runtime)
  await controller.configureWorkspaceHandoff(handoffConfiguration(false))
  await controller.settleWorkspaceHandoff('uncertain')
  const uuid = randomUUID(), realRename = fsPromises.rename
  let failed = false
  const fault = spyOn(fsPromises, 'rename').mockImplementation(async (...args) => {
    if (!failed && String(args[0]).startsWith(workspaceHandoffExecutionDirectory())) {
      const staged = await fsPromises.readFile(String(args[0]), 'utf8')
      if (staged.includes('"reconciliation":{')) { failed = true; throw new Error('isolated reconciliation receipt replacement failure') }
    }
    return realRename(...args)
  })
  try { await expect(controller.submit('review existing work', { uuid })).rejects.toThrow('receipt replacement failure') }
  finally { fault.mockRestore() }
  expect(controller.requiresHandoffReconciliation()).toBe(true)
  expect(calls).toBe(0)
  await controller.submit('review existing work', { uuid })
  expect(calls).toBe(1)
  const status = controller.getWorkspaceHandoffSnapshot()!
  if (status.record.kind !== 'valid' || !status.record.record.reconciliation) throw new Error('Missing real reconciliation')
  const contextUuid = status.record.record.reconciliation.contextUuid
  expect(runtime.getMessages().filter(message => message.uuid === uuid)).toHaveLength(1)
  expect(runtime.getMessages().filter(message => message.uuid === contextUuid)).toHaveLength(1)
  await storage.flushCurrentTranscriptDurably()
  const lines = (await fsPromises.readFile(storage.getTranscriptPathForSession(bootstrap.getSessionId()), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(lines.filter(message => message.uuid === uuid)).toHaveLength(1)
  expect(lines.filter(message => message.uuid === contextUuid)).toHaveLength(1)
})

test('warning receipt recovery preserves an existing warning kind and duplicate settlement cannot re-arm reconciled review', async () => {
  const { createUserMessage } = await import('./utils/messages.js')
  const { createQueryEngineSessionController } = await import('./app-runtime/createQueryEngineSessionController.js')
  const seed = createUserMessage({ content: 'existing accepted work' })
  await storage.recordTranscript([seed]); await storage.flushCurrentTranscriptDurably()
  const configuration = handoffConfiguration(false)
  const runtime = engine([], { initialMessages: [seed] })
  // Model a crash after the real warning writer, before its execution receipt.
  const saved = await runtime.persistHandoffOutcome(configuration.identity.operationId, 'uncertain')
  const controller = createQueryEngineSessionController(runtime)
  await controller.configureWorkspaceHandoff({ ...configuration, recover: true })
  await Promise.all([controller.settleWorkspaceHandoff('failed'), controller.settleWorkspaceHandoff('cancelled')])
  const first = controller.getWorkspaceHandoffSnapshot()!
  expect(first.record).toMatchObject({ kind: 'valid', record: { notice: { displayUuid: saved[0]!.uuid, outcome: 'uncertain' } } })
  let calls = 0
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () { calls++; yield assistant([{ type: 'text', text: 'genuine review performed' }]) }))
  await controller.submit('review current progress', { uuid: randomUUID() })
  expect(controller.requiresHandoffReconciliation()).toBe(false)
  const before = await fsPromises.readFile(storage.getTranscriptPathForSession(bootstrap.getSessionId()), 'utf8')
  await controller.settleWorkspaceHandoff('cancelled')
  expect(controller.requiresHandoffReconciliation()).toBe(false)
  expect(controller.getWorkspaceHandoffSnapshot()?.gate.mode).toBe('open')
  expect(await fsPromises.readFile(storage.getTranscriptPathForSession(bootstrap.getSessionId()), 'utf8')).toBe(before)
  expect(calls).toBe(1)
})

test.each(['fresh', 'legacy'] as const)('replacement with absent %s execution evidence preserves historical uncertainty without inventing no-start or replay', async origin => {
  const { createUserMessage } = await import('./utils/messages.js')
  const { createQueryEngineSessionController } = await import('./app-runtime/createQueryEngineSessionController.js')
  const seed = createUserMessage({ content: 'possibly partially completed historic work' })
  await storage.recordTranscript([seed]); await storage.flushCurrentTranscriptDurably()
  let calls = 0
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () { calls++; yield assistant([{ type: 'text', text: 'must not replay' }]) }))
  const configuration = handoffConfiguration()
  const runtime = engine([], { initialMessages: [seed] })
  const controller = createQueryEngineSessionController(runtime)
  await controller.configureWorkspaceHandoff({ ...configuration, origin, recover: true, observerGeneration: randomUUID() })
  await expect(controller.cancelWorkspaceHandoff(randomUUID())).rejects.toThrow('unconfirmed')
  await controller.settleWorkspaceHandoff('uncertain')
  expect(controller.getWorkspaceHandoffSnapshot()).toMatchObject({ execution: 'unconfirmed', gate: { mode: 'review' },
    record: { kind: 'valid', record: { consumed: false, terminal: null, cancellation: null, notice: { outcome: 'uncertain' } } } })
  await expect(controller.startHandoffContinuation()).rejects.toThrow()
  expect(calls).toBe(0)
})

test.each(['success', 'reconciled', 'historical'] as const)('a fresh source handoff retires only converged %s ownership and refuses the old release', async prior => {
  const { createUserMessage } = await import('./utils/messages.js')
  const { createQueryEngineSessionController } = await import('./app-runtime/createQueryEngineSessionController.js')
  const seed = createUserMessage({ content: 'original accepted work' })
  await storage.recordTranscript([seed]); await storage.flushCurrentTranscriptDurably()
  const oldConfiguration = handoffConfiguration(prior === 'success')
  const nextConfiguration = handoffConfiguration(false)
  let controller: ReturnType<typeof createQueryEngineSessionController>
  let snapshotDuringReservation: ReturnType<typeof controller.getWorkspaceHandoffSnapshot> | undefined
  const nextJump = buildTool({
    name: 'NextJump', inputSchema: z.object({}), description: async () => 'jump', prompt: async () => 'jump',
    maxResultSizeChars: 1000, renderToolUseMessage: () => null,
    async call(_input, context) {
      expect(() => controller.reserveHandoff(oldConfiguration.identity.operationId)).toThrow('has not converged')
      controller.reserveHandoff(nextConfiguration.identity.operationId)
      snapshotDuringReservation = controller.getWorkspaceHandoffSnapshot()
      const request = { operationId: nextConfiguration.identity.operationId, toolUseId: context.toolUseId! }
      context.turnHandoff!.reserve(context, request)
      context.turnHandoff!.accept(context, request)
      return { data: 'accepted' }
    },
    mapToolResultToToolResultBlockParam: (_data, id) => ({ type: 'tool_result', tool_use_id: id, content: 'next movement accepted' }),
  })
  let calls = 0
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
    calls++
    yield assistant(calls === (prior === 'historical' ? 1 : 2)
      ? [{ type: 'tool_use', id: 'next-jump', name: 'NextJump', input: {} }]
      : [{ type: 'text', text: 'completed prior work or genuine review' }])
  }))
  const runtime = engine([nextJump], { initialMessages: [seed] })
  controller = createQueryEngineSessionController(runtime)
  await controller.configureWorkspaceHandoff({ ...oldConfiguration,
    ...(prior === 'historical' ? { historical: true as const, origin: 'legacy' as const, recover: true } : {}) })
  if (prior === 'success') {
    await (await controller.startHandoffContinuation()).completion
    expect(await controller.releaseWorkspaceHandoff(oldConfiguration.identity.operationId, 'open')).toBe('applied')
  } else if (prior === 'reconciled') {
    await controller.settleWorkspaceHandoff('uncertain')
    await controller.submit('review the existing progress', { uuid: randomUUID() })
  }
  expect(controller.getWorkspaceHandoffSnapshot()?.gate.mode).toBe('open')
  const output: SDKMessage[] = []
  const unsubscribe = controller.subscribe(event => { if (event.type === 'message') output.push(event.message) })
  await controller.submit('move the next requested task')
  unsubscribe()
  expect(output.findLast(message => message.type === 'result')).toMatchObject({ subtype: 'handoff', operation_id: nextConfiguration.identity.operationId })
  expect(snapshotDuringReservation).toBeNull()
  await controller.configureWorkspaceHandoff(nextConfiguration)
  expect(controller.getWorkspaceHandoffSnapshot()).toMatchObject({ operationId: nextConfiguration.identity.operationId,
    record: { kind: 'absent' }, gate: { mode: 'held', reservationOperationId: nextConfiguration.identity.operationId } })
  expect(await controller.releaseWorkspaceHandoff(oldConfiguration.identity.operationId, 'open')).toBe('refused')
  expect(controller.getHandoffReservation()).toBe(nextConfiguration.identity.operationId)
  expect(calls).toBe(prior === 'historical' ? 1 : 2)
})
