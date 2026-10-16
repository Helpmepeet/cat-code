import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod/v4'

const root = mkdtempSync(join(tmpdir(), 'urgent-worker-regression-'))
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = root
const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { getEmptyToolPermissionContext, buildTool } = await import('../../Tool.js')
const tasks = await import('../../tasks/LocalAgentTask/LocalAgentTask.js')
const { SendMessageTool } = await import('../SendMessageTool/SendMessageTool.js')
const { TaskOutputTool } = await import('../TaskOutputTool/TaskOutputTool.js')
const { query } = await import('../../query.js')
const { createAssistantMessage, createUserMessage, normalizeMessagesForAPI } = await import('../../utils/messages.js')
const { asSystemPrompt } = await import('../../utils/systemPromptType.js')
const { asAgentId } = await import('../../types/ids.js')
const growthbook = await import('../../services/analytics/growthbook.js')
const { getCommandQueue, resetCommandQueue } = await import('../../utils/messageQueueManager.js')
const { drainSdkEvents } = await import('../../utils/sdkEventQueue.js')
const diskOutput = await import('../../utils/task/diskOutput.js')
import type { ToolUseContext, Tools } from '../../Tool.js'
import type { QueryDeps } from '../../query/deps.js'
import type { Message } from '../../types/message.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function waitForAbort(signal: AbortSignal): Promise<void> {
  return signal.aborted ? Promise.resolve() : new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
}
const fixtureCleanups: Array<() => Promise<void>> = []
function fixture(tools: Tools = []) {
  let state = getDefaultAppState()
  state = { ...state, toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'acceptEdits' } }
  const setAppState = (update: (previous: typeof state) => typeof state) => { state = update(state) }
  const id = `urgent-${randomUUID()}`
  const registered = tasks.registerAsyncAgent({
    agentId: id, agentName: id, description: 'urgent fixture', prompt: 'initial work', setAppState,
    selectedAgent: { agentType: 'fixture', source: 'built-in', baseDir: 'built-in', whenToUse: 'fixture', getSystemPrompt: () => 'fixture' },
  })
  state = { ...state, agentNameRegistry: new Map([[id, asAgentId(id)]]) }
  const main = { getAppState: () => state, setAppState, setAppStateForTasks: setAppState, abortController: new AbortController() }
  const context = {
    ...main, agentId: asAgentId(id), agentRunId: registered.runId, agentType: 'fixture',
    abortController: registered.abortController!, readFileState: new Map(), messages: [],
    setInProgressToolUseIDs: () => {}, setResponseLength: () => {}, updateFileHistoryState: () => {}, updateAttributionState: () => {},
    options: {
      commands: [], tools, debug: false, verbose: false, mainLoopModel: 'gpt-6.1-sol', mainLoopProvider: 'openai',
      thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allAgents: [], allowedAgentTypes: [] },
    },
  } as unknown as ToolUseContext
  const events: unknown[] = []
  let running: Promise<unknown> | undefined
  const f = {
    id, registered, main, context, events, state: () => state,
    send: (message: string, urgent = true, sender = main) => SendMessageTool.call(
      { to: id, summary: 'correct worker direction', message, urgent }, sender as never, undefined as never, undefined as never,
    ),
    receipt: async () => (await TaskOutputTool.call(
      { task_id: id, block: false, timeout: 0 }, main as never, undefined as never, undefined as never,
    )).data.task!.output,
    start: (callModel: QueryDeps['callModel'], options: { autocompact?: QueryDeps['autocompact']; onEvent?: (event: any) => void | Promise<void>; maxTurns?: number } = {}) => {
      const deps: QueryDeps = {
        uuid: randomUUID, microcompact: async messages => ({ messages }),
        autocompact: options.autocompact ?? (async () => ({ wasCompacted: false })), callModel,
      }
      running = (async () => {
        const iterator = query({ messages: [createUserMessage({ content: 'initial work' })],
          systemPrompt: asSystemPrompt(['fixture']), userContext: {}, systemContext: {}, toolUseContext: context,
          canUseTool: async () => ({ behavior: 'allow', decisionReason: { type: 'other', reason: 'fixture' } }),
          querySource: 'agent:custom', maxTurns: options.maxTurns ?? 1, deps,
        })
        for (;;) {
          const next = await iterator.next()
          if (next.done) return next.value
          events.push(next.value)
          await options.onEvent?.(next.value)
        }
      })()
      return running
    },
    cleanup: async () => {
      registered.abortController!.abort()
      registered.unregisterCleanup?.()
      await running?.catch(() => {})
    },
  }
  fixtureCleanups.push(f.cleanup)
  drainSdkEvents()
  return f
}

afterEach(async () => {
  for (const cleanup of fixtureCleanups.splice(0)) await cleanup()
  mock.restore()
  resetCommandQueue()
  drainSdkEvents()
})
afterAll(async () => {
  await diskOutput._clearOutputsForTest()
  diskOutput._resetTaskOutputDirForTest()
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await rm(root, { recursive: true, force: true })
})

test('urgent cuts a slow response on the final allowed turn without ending the worker run', async () => {
  const f = fixture()
  const stopHooks = await import('../../query/stopHooks.js')
  const hooks = spyOn(stopHooks, 'handleStopHooks')
  const started = deferred()
  const requests: string[] = []
  let firstSignal!: AbortSignal
  const running = f.start(async function* ({ messages, signal }) {
    requests.push(JSON.stringify(normalizeMessagesForAPI(messages, [], 'openai')))
    if (requests.length === 1) {
      firstSignal = signal
      yield createAssistantMessage({ content: 'Completed before cut.' })
      started.resolve()
      await waitForAbort(signal)
    } else yield createAssistantMessage({ content: 'Corrected result.' })
  })
  await started.promise
  expect((await f.send('Return the current result NOW.')).data.success).toBe(true)
  expect(firstSignal.aborted).toBe(true)
  await expect(running).resolves.toMatchObject({ reason: 'completed' })
  expect(requests).toHaveLength(2)
  expect(requests[1]).toContain('Completed before cut.')
  expect(requests[1]).toContain('The coordinator sent an urgent message while you were working:')
  expect(requests[1]).toContain('Return the current result NOW.')
  expect(f.state().tasks[f.id]).toMatchObject({ status: 'running', runId: f.registered.runId })
  expect(f.registered.abortController!.signal.aborted).toBe(false)
  expect(getCommandQueue()).toHaveLength(0)
  expect(drainSdkEvents().filter(event => event.type === 'system' && event.subtype === 'task_notification')).toHaveLength(0)
  expect(JSON.stringify(f.events)).not.toContain('[Request interrupted by user]')
  expect(JSON.stringify(f.events)).not.toContain('max_turns_reached')
  expect(hooks).toHaveBeenCalledTimes(1)
  expect(await f.receipt()).toContain('seen: "Return the current result NOW."')
})

test('urgent waits through compaction and is admitted after history replacement', async () => {
  const f = fixture()
  const compacting = deferred(), release = deferred()
  const requests: string[] = []
  let compactionSignal!: AbortSignal
  let compactions = 0
  const running = f.start(async function* ({ messages }) {
    requests.push(JSON.stringify(normalizeMessagesForAPI(messages, [], 'openai')))
    yield createAssistantMessage({ content: 'done' })
  }, { autocompact: async (_messages, context) => {
    compactions++
    compactionSignal = context.abortController.signal
    compacting.resolve()
    await release.promise
    return { wasCompacted: true, compactionResult: {
      boundaryMarker: { type: 'system', subtype: 'compact_boundary', uuid: randomUUID(), timestamp: new Date().toISOString(), content: 'compacted' },
      summaryMessages: [createUserMessage({ content: 'Replacement history.' })], attachments: [], hookResults: [], preCompactTokenCount: 100,
    } } as never
  } })
  await compacting.promise
  try {
    expect((await f.send('Use the corrected plan.')).data.success).toBe(true)
    expect(compactionSignal.aborted).toBe(false)
    expect(f.state().tasks[f.id].modelRequest).toBeUndefined()
  } finally { release.resolve() }
  await running
  expect(compactions).toBe(1)
  expect(requests).toHaveLength(1)
  expect(requests[0]).toContain('Replacement history.')
  expect(requests[0]?.match(/Use the corrected plan\./g)).toHaveLength(1)
})

test('messages arriving after admission cut that request; interrupted receipts stay unconfirmed until completion', async () => {
  const f = fixture()
  await f.send('First correction.')
  let sentAfterClaim = false
  let completed = false
  const requests: string[] = []
  const running = f.start(async function* ({ messages, signal }) {
    requests.push(JSON.stringify(normalizeMessagesForAPI(messages, [], 'openai')))
    expect(signal.aborted).toBe(false)
    if (requests.length === 1) {
      const result = await f.send('Second correction.')
      expect(result.data.success).toBe(true)
      expect(signal.aborted).toBe(true)
      expect(await f.receipt()).toContain('not confirmed: "First correction."')
      expect(await f.receipt()).not.toContain('\n- seen:')
      await f.send('Third correction.')
      return
    }
    expect(await f.receipt()).toContain('not confirmed: "First correction."')
    for (const instruction of ['First correction.', 'Second correction.', 'Third correction.']) {
      expect(requests[1]?.split(instruction)).toHaveLength(2)
    }
    yield createAssistantMessage({ content: 'Corrected.' })
    completed = true
  }, { onEvent: async event => {
    if (!sentAfterClaim && event.type === 'attachment' && event.attachment.urgent) {
      sentAfterClaim = true
      await f.send('Arrived after claim.')
    }
  }, autocompact: async () => requests.length === 1 ? {
    wasCompacted: true,
    compactionResult: {
      boundaryMarker: { type: 'system', subtype: 'compact_boundary', uuid: randomUUID(), timestamp: new Date().toISOString(), content: 'compacted' },
      summaryMessages: [createUserMessage({ content: 'History replaced after the cut.' })],
      attachments: [], hookResults: [], preCompactTokenCount: 100,
    },
  } as never : { wasCompacted: false } })
  await running
  expect(sentAfterClaim).toBe(true)
  expect(completed).toBe(true)
  expect(requests).toHaveLength(2)
  expect(requests[0]).toContain('Arrived after claim.')
  expect(await f.receipt()).not.toContain('not confirmed:')
  expect(await f.receipt()).not.toContain('not seen yet:')
})

function toolMessage(id: string) {
  return createAssistantMessage({ content: [{ type: 'tool_use', id, name: 'UrgentProbe', input: { id } }] })
}
function probeTool(call: (input: { id: string }, context: ToolUseContext) => Promise<{ data: string }>) {
  return buildTool({
    name: 'UrgentProbe', inputSchema: z.object({ id: z.string() }), maxResultSizeChars: 1000,
    isReadOnly: () => true, isConcurrencySafe: () => false,
    async description() { return 'fixture tool' }, async prompt() { return 'fixture tool' },
    async validateInput() { return { result: true } },
    renderToolUseMessage: () => null, renderToolResultMessage: () => null, renderToolUseErrorMessage: () => null,
    mapToolResultToToolResultBlockParam(data: string, id: string) { return { type: 'tool_result' as const, tool_use_id: id, content: data } },
    call,
  })
}
for (const stopRun of [false, true]) test(`a cut preserves started tools and skips queued calls${stopRun ? ', with TaskStop taking precedence' : ''}`, async () => {
  const gate = spyOn(growthbook, 'checkStatsigFeatureGate_CACHED_MAY_BE_STALE').mockImplementation(name => name === 'tengu_streaming_tool_execution2')
  const toolStarted = deferred(), releaseTool = deferred(), streamReady = deferred()
  const executed: string[] = []
  const tool = probeTool(async ({ id }, context) => {
      executed.push(id)
      toolStarted.resolve()
      await Promise.race([releaseTool.promise, waitForAbort(context.abortController.signal)])
      return { data: 'started tool finished' }
  })
  const f = fixture([tool])
  const requests: Message[][] = []
  let streamSignal!: AbortSignal
  const running = f.start(async function* ({ messages, signal }) {
    requests.push(messages)
    if (requests.length === 1) {
      streamSignal = signal
      yield toolMessage('started')
      await toolStarted.promise
      yield toolMessage('queued')
      streamReady.resolve()
      await waitForAbort(signal)
    } else yield createAssistantMessage({ content: 'Reported current work.' })
  })
  try {
    await streamReady.promise
    await f.send('Stop and report.')
    expect(streamSignal.aborted).toBe(true)
    expect(executed).toEqual(['started'])
    expect(f.registered.abortController!.signal.aborted).toBe(false)
    if (stopRun) tasks.killAsyncAgent(f.id, f.main.setAppState, f.registered.runId)
    else releaseTool.resolve()
    const terminal = await running
    expect(executed).toEqual(['started'])
    if (stopRun) {
      expect(f.state().tasks[f.id].status).toBe('killed')
      expect(f.registered.abortController!.signal.aborted).toBe(true)
      expect(requests).toHaveLength(1)
      expect(terminal).toMatchObject({ reason: 'aborted_streaming' })
    } else {
      expect(requests).toHaveLength(2)
      const results = requests[1]!.flatMap(message => message.type === 'user' && Array.isArray(message.message.content) ? message.message.content.filter(block => block.type === 'tool_result') : [])
      expect(results).toHaveLength(2)
      expect(results).toContainEqual(expect.objectContaining({ tool_use_id: 'started', content: 'started tool finished' }))
      expect(results).toContainEqual(expect.objectContaining({ tool_use_id: 'queued', content: 'Not run: an urgent message changed the next step.' }))
    }
  } finally { releaseTool.resolve(); gate.mockRestore() }
})

test('without streaming tool execution, complete calls from a cut response get not-run results', async () => {
  const gate = spyOn(growthbook, 'checkStatsigFeatureGate_CACHED_MAY_BE_STALE').mockReturnValue(false)
  let executions = 0, cut = false
  const f = fixture([probeTool(async () => { executions++; return { data: 'unexpected execution' } })])
  const requests: Message[][] = []
  try {
    await f.start(async function* ({ messages, signal }) {
      requests.push(messages)
      if (requests.length === 1) { yield toolMessage('unstarted'); await waitForAbort(signal) }
      else yield createAssistantMessage({ content: 'reported' })
    }, { onEvent: async event => {
      if (!cut && event.type === 'assistant') {
        cut = true
        await f.send('Do not run that call.')
      }
    } })
    expect(executions).toBe(0)
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[1])).toContain('Not run: an urgent message changed the next step.')
  } finally { gate.mockRestore() }
})

test('urgent after the response finished waits for the tool without aborting it', async () => {
  const gate = spyOn(growthbook, 'checkStatsigFeatureGate_CACHED_MAY_BE_STALE').mockReturnValue(false)
  const toolStarted = deferred(), releaseTool = deferred()
  let toolSignal!: AbortSignal
  const f = fixture([probeTool(async (_input, context) => {
    toolSignal = context.abortController.signal
    toolStarted.resolve()
    await releaseTool.promise
    return { data: 'finished normally' }
  })])
  const requests: string[] = []
  const running = f.start(async function* ({ messages }) {
    requests.push(JSON.stringify(messages))
    yield requests.length === 1 ? toolMessage('running') : createAssistantMessage({ content: 'reported' })
  }, { maxTurns: 2 })
  try {
    await toolStarted.promise
    expect(f.state().tasks[f.id].modelRequest).toBeUndefined()
    await f.send('Report after this tool.')
    expect(toolSignal.aborted).toBe(false)
  } finally { releaseTool.resolve(); gate.mockRestore() }
  await running
  expect(requests).toHaveLength(2)
  expect(requests[1]).toContain('Report after this tool.')
})

test('urgent is refused for agent senders and non-local or stopped targets without queueing', async () => {
  const f = fixture()
  const { ALL_AGENT_DISALLOWED_TOOLS } = await import('../../constants/tools.js')
  expect(ALL_AGENT_DISALLOWED_TOOLS.has('Agent')).toBe(true)
  expect(ALL_AGENT_DISALLOWED_TOOLS.has('ResumeAgent')).toBe(true)
  expect(ALL_AGENT_DISALLOWED_TOOLS.has('TaskStop')).toBe(true)
  const sibling = { ...f.main, agentId: asAgentId('sibling') }
  expect((await f.send('Sibling must not cut.', true, sibling)).data.success).toBe(false)
  expect(SendMessageTool.inputSchema.parse({ to: f.id, message: 'normal' }).urgent).toBe(false)
  expect(f.state().tasks[f.id].pendingMessages).toHaveLength(0)
  for (const to of ['*', 'uds:/fixture.sock', 'bridge:fixture', 'nonexistent-teammate']) {
    expect((await SendMessageTool.call({ to, message: 'must not send', urgent: true }, f.main as never, undefined as never, undefined as never)).data.success).toBe(false)
  }
  f.main.setAppState(previous => {
    const task = previous.tasks[f.id]
    if (task.type !== 'local_agent') throw new Error('expected local worker')
    return { ...previous, tasks: { ...previous.tasks, [f.id]: { ...task, acceptingMessages: false } } }
  })
  expect((await f.send('Finishing must refuse.')).data.success).toBe(false)
  tasks.killAsyncAgent(f.id, f.main.setAppState, f.registered.runId)
  const stopped = await f.send('Stopped must not resume.')
  expect(stopped.data.success).toBe(false)
  expect(stopped.data.message).toContain('ResumeAgent')
  expect(f.state().tasks[f.id].pendingMessages).toHaveLength(0)
})

test('clearing an old request handle cannot clear or cut a newer request', () => {
  const f = fixture()
  const old = new AbortController(), current = new AbortController()
  tasks.admitAgentModelRequest(f.id, f.registered.runId, 'old-request', old, f.main.setAppState)
  tasks.admitAgentModelRequest(f.id, f.registered.runId, 'new-request', current, f.main.setAppState)
  tasks.clearAgentModelRequest(f.id, f.registered.runId, 'old-request', f.main.setAppState)
  tasks.queuePendingMessageIfRunning(f.id, 'new correction', f.main.setAppState, undefined, true)
  expect(old.signal.aborted).toBe(false)
  expect(current.signal.aborted).toBe(true)
  expect(f.state().tasks[f.id].modelRequest?.id).toBe('new-request')
})

async function withFakeTransport(
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  run: (callModel: QueryDeps['callModel']) => Promise<void>,
) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const clientModule = await import('../../services/api/client.js')
  const usageModule = await import('../../services/api/codexUsage.js')
  const vcr = await import('../../services/vcr.js')
  const { queryModelWithStreaming } = await import('../../services/api/claude.js')
  const originalKey = process.env.ANTHROPIC_API_KEY
  const macro = globalThis as typeof globalThis & { MACRO?: { VERSION: string } }
  const originalMacro = macro.MACRO
  process.env.ANTHROPIC_API_KEY = 'fixture-key'
  macro.MACRO = { VERSION: 'fixture-version' }
  const originalFetch = globalThis.fetch
  const noNetwork = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(
    async () => { throw new Error('Unexpected live fetch in urgent regression') },
    { preconnect: originalFetch.preconnect },
  ))
  const fakeFetch = Object.assign(fetcher, { preconnect: originalFetch.preconnect }) as typeof fetch
  const client = new Anthropic({ apiKey: 'fixture-key', maxRetries: 0, fetch: fakeFetch })
  const getClient = spyOn(clientModule, 'getAnthropicClient').mockResolvedValue(client)
  const refresh = spyOn(usageModule, 'schedulePoolUsageRefresh').mockImplementation(() => {})
  // VCR buffers complete responses in tests, which hides the real streaming boundary.
  const recording = spyOn(vcr, 'withStreamingVCR').mockImplementation((_messages, stream) => stream())
  try { await run(params => queryModelWithStreaming(params)) }
  finally {
    getClient.mockRestore()
    refresh.mockRestore()
    recording.mockRestore()
    noNetwork.mockRestore()
    macro.MACRO = originalMacro
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = originalKey
  }
}

function sse(events: Record<string, unknown>[], signal?: AbortSignal, hold = false): Response {
  const encoder = new TextEncoder()
  let detach = () => {}
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
      if (!hold) { controller.close(); return }
      const abort = () => controller.error(new DOMException('Fixture request aborted', 'AbortError'))
      signal?.addEventListener('abort', abort, { once: true })
      detach = () => signal?.removeEventListener('abort', abort)
      if (signal?.aborted) abort()
    },
    cancel() { detach() },
  }), { headers: { 'content-type': 'text/event-stream' } })
}
function anthropicResponse(thinkingOnly = false): Record<string, unknown>[] {
  return [
    { type: 'message_start', message: { id: randomUUID(), type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: thinkingOnly
      ? { type: 'thinking', thinking: '', signature: '' } : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: thinkingOnly
      ? { type: 'thinking_delta', thinking: 'Completed reasoning fragment.' } : { type: 'text_delta', text: 'Corrected result.' } },
    ...(thinkingOnly ? [{ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'fixture-reasoning' } }] : []),
    { type: 'content_block_stop', index: 0 },
    ...(!thinkingOnly ? [
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } },
      { type: 'message_stop' },
    ] : []),
  ]
}

test('urgent during real provider retry backoff rebuilds input instead of retrying the old request', async () => {
  const f = fixture()
  f.context.options.mainLoopModel = 'claude-sonnet-4-6'
  f.context.options.mainLoopProvider = 'firstParty'
  await f.send('Existing correction.')
  const bodies: any[] = []
  let cut = false
  await withFakeTransport(async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    if (bodies.length === 1) return new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'fixture overload' } }), {
      status: 503, headers: { 'content-type': 'application/json', 'retry-after': '60' },
    })
    return sse(anthropicResponse())
  }, async callModel => {
    await f.start(callModel, { onEvent: async event => {
      if (!cut && event.type === 'system' && event.subtype === 'api_error') {
        cut = true
        expect((await f.send('New direction during retry.')).data.success).toBe(true)
      }
    } })
  })
  expect(cut).toBe(true)
  expect(bodies).toHaveLength(2)
  expect(JSON.stringify(bodies[0])).not.toContain('New direction during retry.')
  expect(JSON.stringify(bodies[1])).toContain('New direction during retry.')
  expect(JSON.stringify(bodies[1]).split('Existing correction.')).toHaveLength(2)
  expect(await f.receipt()).not.toContain('not confirmed:')
})

for (const provider of ['firstParty', 'openai'] as const) test(`cut thinking-only response is valid for a ${provider} worker under the opposite main provider`, async () => {
  const f = fixture()
  const bootstrap = await import('../../bootstrap/state.js')
  const originalProvider = bootstrap.getSessionProvider()
  bootstrap.setSessionProvider(provider === 'openai' ? 'firstParty' : 'openai')
  f.context.options.mainLoopProvider = provider
  f.context.options.mainLoopModel = provider === 'openai' ? 'gpt-6.1-sol' : 'claude-sonnet-4-6'
  const { translateToCodexBody, translateCodexStreamToAnthropic } = await import('../../services/api/codex-fetch-adapter.js')
  const bodies: any[] = []
  let cut = false
  try {
    await withFakeTransport(async (_input, init) => {
      const body = JSON.parse(String(init?.body))
      const wire = provider === 'openai' ? translateToCodexBody(body).codexBody : body
      bodies.push(wire)
      const first = bodies.length === 1
      if (provider === 'firstParty') {
        if (!first) expect(body.messages.every((message: any) => message.role !== 'assistant' || message.content.some((block: any) => block.type !== 'thinking'))).toBe(true)
        return sse(anthropicResponse(first), init?.signal ?? undefined, first)
      }
      if (!first) expect(wire.input).toContainEqual(expect.objectContaining({ type: 'reasoning', encrypted_content: 'fixture-reasoning' }))
      const events = first ? [
        { type: 'response.output_item.done', item: { type: 'reasoning', id: 'reasoning-1', encrypted_content: 'fixture-reasoning', summary: [] } },
      ] : [
        { type: 'response.output_item.done', item: { type: 'message', id: 'message-2', role: 'assistant', content: [{ type: 'output_text', text: 'Corrected result.' }] } },
        { type: 'response.completed', response: { id: 'response-2', usage: { input_tokens: 10, output_tokens: 10 } } },
      ]
      return translateCodexStreamToAnthropic(sse(events, init?.signal ?? undefined, first), 'gpt-6.1-sol')
    }, async callModel => {
      await f.start(callModel, { onEvent: async event => {
        if (!cut && event.type === 'assistant' && event.message.content.some((block: any) => block.type === 'thinking')) {
          cut = true
          expect((await f.send('Act on the correction.')).data.success).toBe(true)
        }
      } })
    })
    expect(cut).toBe(true)
    expect(bodies).toHaveLength(2)
    expect(JSON.stringify(bodies[1])).toContain('Act on the correction.')
    expect(JSON.stringify(f.events)).not.toContain('[Request interrupted by user]')
    expect(JSON.stringify(f.events)).not.toContain('isApiErrorMessage\":true')
  } finally { bootstrap.setSessionProvider(originalProvider) }
})
