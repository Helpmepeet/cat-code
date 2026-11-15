import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { APIConnectionError, APIUserAbortError } from '@anthropic-ai/sdk/error'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'zod/v4'
import type { Message } from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'

// Configure isolation before importing the engine; no saved account or network
// traffic may participate in a transport recovery fixture.
const root = mkdtempSync(join(tmpdir(), 'claude-thinking-retry-'))
const savedEnv = { ...process.env }
const originalFetch = globalThis.fetch
const macro = globalThis as typeof globalThis & { MACRO?: { VERSION: string } }
const savedMacro = macro.MACRO
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: root,
  CLAUDE_CODE_TEST_FIXTURES_ROOT: root,
  CLAUDE_CODE_SIMPLE: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_MAX_RETRIES: '0',
  ANTHROPIC_API_KEY: 'isolated-test-key',
})
macro.MACRO = { VERSION: 'test-version' }
globalThis.fetch = Object.assign(async () => {
  throw new Error('Unexpected network request in thinking retry test')
}, { preconnect: originalFetch.preconnect })

const { query } = await import('../../query.js')
const state = await import('../../bootstrap/state.js')
const { buildTool, getEmptyToolPermissionContext } = await import('../../Tool.js')
const { createUserMessage } = await import('../../utils/messages.js')
const { asSystemPrompt } = await import('../../utils/systemPromptType.js')
const { queryModelWithStreaming } = await import('./claude.js')
const { StreamIdleError } = await import('./streamIdle.js')
const sleep = await import('../../utils/sleep.js')
const vcr = await import('../vcr.js')
const growthbook = await import('../analytics/growthbook.js')

const encoder = new TextEncoder()
const event = (data: Record<string, unknown>) => encoder.encode(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`)
const reset = () => Object.assign(new Error('The socket connection was closed unexpectedly. For more information, pass verbose: true to fetch()'), { code: 'ECONNRESET' })
const thinking = [
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'unfinished private thought' } },
]
function start(id: string) {
  return { type: 'message_start', message: {
    id, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  } }
}
function answer() {
  return [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Recovered answer' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ]
}
function response(events: Record<string, unknown>[], error?: Error) {
  let index = 0
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < events.length) controller.enqueue(event(events[index++]!))
      else if (error) controller.error(error)
      else controller.close()
    },
  }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream', 'request-id': 'req_fixture' } })
}

let waits: number[]
let wait: ReturnType<typeof spyOn<typeof sleep, 'sleep'>>
let recording: ReturnType<typeof spyOn<typeof vcr, 'withStreamingVCR'>>
beforeEach(() => {
  state.resetStateForTests()
  state.setSessionProvider('firstParty')
  waits = []
  wait = spyOn(sleep, 'sleep').mockImplementation(async (ms, signal, options) => {
    waits.push(ms)
    if (signal?.aborted) throw options?.abortError?.() ?? new Error('aborted')
  })
  recording = spyOn(vcr, 'withStreamingVCR').mockImplementation(async function* (_messages, produce) { yield* produce() })
})
afterEach(() => {
  wait.mockRestore()
  recording.mockRestore()
  state.resetStateForTests()
})
afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
  globalThis.fetch = originalFetch
  macro.MACRO = savedMacro
  rmSync(root, { recursive: true, force: true })
})

async function collect(makeResponse: (attempt: number) => Response, abort = new AbortController(), onRetry?: () => void) {
  const requests: Record<string, unknown>[] = []
  const rows: unknown[] = []
  let interrupted = 0
  const fetchOverride = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)))
    return makeResponse(requests.length)
  }, { preconnect: originalFetch.preconnect }) as typeof fetch
  for await (const row of queryModelWithStreaming({
    messages: [createUserMessage({ content: 'fixture' })], systemPrompt: asSystemPrompt(['test']),
    thinkingConfig: { type: 'adaptive' }, tools: [], signal: abort.signal,
    options: {
      model: 'claude-opus-5-5', provider: 'firstParty', getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      isNonInteractiveSession: true, querySource: 'sdk', agents: [], hasAppendSystemPrompt: false, mcpTools: [], fetchOverride,
      onStreamInterrupted: () => { interrupted++ },
    },
  })) {
    rows.push(row)
    if (row.type === 'system' && row.subtype === 'transport_recovery') onRetry?.()
  }
  return { requests, rows, interrupted, persisted: rows.filter(row => (row as Message).type === 'assistant') as Message[] }
}

for (const failures of [1, 2]) {
  test(`thinking-only reset recovers after ${failures} failure(s) with clean transcript state`, async () => {
    const result = await collect(attempt => attempt <= failures
      ? response([start(`failed-${attempt}`), ...thinking], reset())
      : response([start('recovered'), ...answer()]))
    expect(result.requests).toHaveLength(failures + 1)
    expect(result.requests.every(request => request.stream === true)).toBe(true)
    expect(result.requests.slice(1).every(request => JSON.stringify(request.messages) === JSON.stringify(result.requests[0]!.messages))).toBe(true)
    expect(waits).toEqual(failures === 1 ? [1000] : [1000, 2000])
    expect(result.interrupted).toBe(0)
    expect(JSON.stringify(result.persisted)).toContain('Recovered answer')
    expect(JSON.stringify(result.persisted)).not.toContain('unfinished private thought')
    expect(JSON.stringify(result.persisted)).not.toContain('isApiErrorMessage')
    const recovered = result.persisted[0] as Extract<Message, { type: 'assistant' }>
    expect(recovered.message.stop_reason).toBe('end_turn')
    expect(recovered.message.usage?.output_tokens).toBe(7)
    expect(result.rows.filter(row => (row as { subtype?: string }).subtype === 'transport_recovery')).toHaveLength(failures)
  })
}

test('retry exhaustion stops after three streaming requests without non-streaming replay', async () => {
  const result = await collect(attempt => response([start(`failed-${attempt}`), ...thinking], reset()))
  expect(result.requests).toHaveLength(3)
  expect(result.requests.every(request => request.stream === true)).toBe(true)
  expect(waits).toEqual([1000, 2000])
  expect(JSON.stringify(result.persisted)).not.toContain('unfinished private thought')
  expect(JSON.stringify(result.persisted)).not.toContain('verbose: true')
  expect(JSON.stringify(result.persisted)).toContain('isApiErrorMessage')
})

for (const [name, events] of [
  ['empty text start', [{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }]],
  ['text delta', [...thinking, { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Partial answer' } }]],
  ['client tool start', [...thinking, { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call-1', name: 'Bash', input: {} } }]],
  ['hosted tool start', [...thinking, { type: 'content_block_start', index: 1, content_block: { type: 'server_tool_use', id: 'search-1', name: 'web_search', input: {} } }]],
  ['completed thinking', [...thinking, { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed' } }, { type: 'content_block_stop', index: 0 }]],
] as const) {
  test(`does not replay after ${name}`, async () => {
    const result = await collect(() => response([start('unsafe'), ...events], reset()))
    expect(result.requests).toHaveLength(1)
    expect(waits).toEqual([])
    expect(JSON.stringify(result.rows)).not.toContain('transport_recovery')
    expect(JSON.stringify(result.persisted)).toContain('isApiErrorMessage')
  })
}

for (const [name, error] of [
  ['generic failure', new Error('Invalid SSE content')],
  ['certificate failure', new APIConnectionError({ cause: Object.assign(new Error('Untrusted certificate'), { code: 'CERT_HAS_EXPIRED' }) })],
  ['user cancellation', new APIUserAbortError()],
  ['wrapped user cancellation', new APIConnectionError({ cause: new APIUserAbortError() })],
  ['wrapped idle deadline', new APIConnectionError({ cause: new StreamIdleError(100) })],
] as const) {
  test(`does not retry ${name} during thinking`, async () => {
    const result = await collect(() => response([start('failed'), ...thinking], error))
    expect(result.requests).toHaveLength(1)
    expect(waits).toEqual([])
  })
}

test('abort during backoff prevents the next request', async () => {
  const abort = new AbortController()
  const result = await collect(() => response([start('failed'), ...thinking], reset()), abort, () => abort.abort())
  expect(result.requests).toHaveLength(1)
  expect(result.persisted).toHaveLength(0)
  expect(abort.signal.aborted).toBe(true)
})

test('SDK-wrapped connection reset recovers before any content', async () => {
  const result = await collect(attempt => attempt === 1
    ? response([start('failed')], new APIConnectionError({ cause: reset() }))
    : response([start('recovered'), ...answer()]))
  expect(result.requests).toHaveLength(2)
  expect(JSON.stringify(result.persisted)).toContain('Recovered answer')
})

test('retry notice and recovered answer survive VCR record and replay', async () => {
  recording.mockRestore()
  const recorded = await collect(attempt => attempt === 1
    ? response([start('failed'), ...thinking], reset())
    : response([start('recovered'), ...answer()]))
  expect(recorded.requests).toHaveLength(2)
  const replayed = await collect(() => { throw new Error('VCR replay dispatched a request') })
  expect(replayed.requests).toHaveLength(0)
  expect(JSON.stringify(replayed.persisted)).toContain('Recovered answer')
  expect(JSON.stringify(replayed.rows)).toContain('Connection lost. Retrying.')
})

test('real query executes a tool exactly once after a thinking-only retry', async () => {
  const counter = join(root, 'counter')
  writeFileSync(counter, '0')
  const gate = spyOn(growthbook, 'checkStatsigFeatureGate_CACHED_MAY_BE_STALE').mockImplementation(name => name === 'tengu_streaming_tool_execution2')
  const messages = [createUserMessage({ content: 'fixture' })]
  const appState = {
    toolPermissionContext: getEmptyToolPermissionContext(), mcp: { tools: [], clients: [] }, tasks: {}, sessionHooks: new Map(), fastMode: false,
  }
  let dispatches = 0
  const requests: unknown[] = []
  const fetchOverride = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)))
    dispatches++
    if (dispatches === 1) return response([start('failed'), ...thinking], reset())
    if (dispatches === 2) return response([
      start('tool'),
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'effect-call', name: 'DurableCounter', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 4 } },
      { type: 'message_stop' },
    ])
    return response([start('done'), ...answer()])
  }, { preconnect: originalFetch.preconnect }) as typeof fetch
  const tool = buildTool({
    name: 'DurableCounter', inputSchema: z.object({}), description: async () => 'fixture', prompt: async () => 'fixture',
    maxResultSizeChars: 1000, renderToolUseMessage: () => null, isConcurrencySafe: () => false,
    async call() {
      writeFileSync(counter, String(Number(readFileSync(counter, 'utf8')) + 1))
      return { data: 'durable effect completed' }
    },
    mapToolResultToToolResultBlockParam: (data, id) => ({ type: 'tool_result', tool_use_id: id, content: data }),
  })
  const context = {
    options: {
      commands: [], debug: false, mainLoopModel: 'claude-opus-5-5', mainLoopProvider: 'firstParty', tools: [tool], verbose: false,
      thinkingConfig: { type: 'adaptive' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allowedAgentTypes: [] },
    },
    abortController: new AbortController(), readFileState: new Map(), getAppState: () => appState,
    setAppState: (update: (state: unknown) => unknown) => Object.assign(appState, update(appState)),
    setInProgressToolUseIDs: () => {}, setResponseLength: () => {}, updateFileHistoryState: () => {}, updateAttributionState: () => {}, messages,
  } as unknown as ToolUseContext
  try {
    const rows = []
    for await (const row of query({
      messages, systemPrompt: asSystemPrompt(['test']), userContext: {}, systemContext: {},
      canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }), querySource: 'sdk', toolUseContext: context,
      deps: {
        uuid: () => 'thinking-retry-query', microcompact: async messages => ({ messages }), autocompact: async () => ({ wasCompacted: false }),
        callModel: params => queryModelWithStreaming({ ...params, options: { ...params.options, fetchOverride } }),
      },
    })) rows.push(row)
    expect(dispatches).toBe(3)
    expect(readFileSync(counter, 'utf8')).toBe('1')
    expect(JSON.stringify(rows)).toContain('durable effect completed')
    expect(JSON.stringify(rows)).not.toContain('Not run:')
    expect(JSON.stringify(rows)).toContain('Recovered answer')
    expect(JSON.stringify(requests)).not.toContain('unfinished private thought')
  } finally { gate.mockRestore() }
})
