import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
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
import type { AssistantMessage } from './types/message.js'
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
