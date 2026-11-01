import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import z from 'zod/v4'
import { getEmptyToolPermissionContext, buildTool, type ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { createUserMessage } from '../../utils/messages.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { query } from '../../query.js'
import { queryModelWithStreaming } from './claude.js'
import { StreamIdleError } from './streamIdle.js'
import * as hookPolicy from '../../utils/hooks/hooksConfigSnapshot.js'
import * as rateLimitPolicy from '../rateLimitMocking.js'
import * as limits from '../claudeAiLimits.js'
import * as bootstrap from '../../bootstrap/state.js'
import * as vcr from '../vcr.js'
import * as growthbook from '../analytics/growthbook.js'
function createToolUseContext(messages: Message[]): ToolUseContext {
  const appState = {
    toolPermissionContext: {
      mode: 'default',
      additionalWorkingDirectories: new Map<string, string>(),
      alwaysAllowRules: {},
      alwaysDenyRules: {},
      alwaysAskRules: {},
    },
    mcp: {
      tools: [],
      clients: [],
    },
    tasks: {},
    sessionHooks: new Map(),
    fastMode: false,
    effortValue: undefined,
    advisorModel: undefined,
  }

  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'gpt-5.6-terra',
      mainLoopProvider: 'openai',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: {
        activeAgents: [],
        allowedAgentTypes: [],
      },
    },
    abortController: new AbortController(),
    readFileState: new Map(),
    getAppState: () => appState,
    setAppState: updater => {
      Object.assign(appState, updater(appState))
    },
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages,
  } as unknown as ToolUseContext
}



const encoder = new TextEncoder()
const event = (data: Record<string, unknown>) => encoder.encode(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`)
const startEvent = () => ({ type: 'message_start', message: {
  id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
} })

for (const scenario of ['headers', 'heartbeats', 'running', 'completed', 'queued', 'success', 'error400', 'permission', 'hook', 'uncooperative', 'acquisition-retry'] as const) {
  test(`production Claude idle settlement: ${scenario}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-idle-integration-'))
    const keys = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_TEST_FIXTURES_ROOT', 'CLAUDE_STREAM_IDLE_TIMEOUT_MS', 'CLAUDE_ENABLE_STREAM_WATCHDOG', 'NODE_ENV', 'FORCE_VCR']
    const saved = keys.map(key => process.env[key])
    const macro = globalThis as typeof globalThis & { MACRO?: { VERSION: string } }
    const savedMacro = macro.MACRO
    const gate = spyOn(growthbook, 'checkStatsigFeatureGate_CACHED_MAY_BE_STALE').mockImplementation(name => name === 'tengu_streaming_tool_execution2')
    // VCR buffers the full turn; bypass only recording, not provider/tool execution.
    const recording = spyOn(vcr, 'withStreamingVCR').mockImplementation(async function* (_messages, produce) { yield* produce() })
    const hookPolicyGate = spyOn(hookPolicy, 'shouldAllowManagedHooksOnly').mockReturnValue(false)
    const hooksDisabled = spyOn(hookPolicy, 'shouldDisableAllHooksIncludingManaged').mockReturnValue(false)
    const savedHooks = bootstrap.getRegisteredHooks()
    const nonInteractive = spyOn(bootstrap, 'getIsNonInteractiveSession').mockReturnValue(true)
    const quotaPolicy = scenario === 'success' ? spyOn(rateLimitPolicy, 'shouldProcessRateLimits').mockReturnValue(true) : undefined
    const savedLimits = limits.currentLimits
    const quota = spyOn(limits, 'extractQuotaStatusFromHeaders')
    const quotaError = spyOn(limits, 'extractQuotaStatusFromError')
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined
    let finish!: () => void
    const completion = new Promise<void>(resolve => { finish = resolve })
    try {
      process.env.ANTHROPIC_API_KEY = 'test-api-key'
      process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = root
      process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '40'
      delete process.env.CLAUDE_ENABLE_STREAM_WATCHDOG
      macro.MACRO = { VERSION: 'test-version' }
      const counter = join(root, 'counter'); writeFileSync(counter, '0')
      let dispatches = 0, cancellations = 0, aborted = false, toolRunningAtAbort = false, running = false, pings = 0
      const fetchOverride = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        dispatches++
        const acquisitionFailure = scenario === 'acquisition-retry' && dispatches === 1
        const completedRetry = scenario === 'acquisition-retry' && dispatches > 2
        expect(JSON.parse(String(init?.body)).stream).toBe(true)
        init?.signal?.addEventListener('abort', () => { aborted = true; toolRunningAtAbort = running; if (scenario !== 'uncooperative') finish() }, { once: true })
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            if (scenario === 'headers' || scenario === 'error400' || acquisitionFailure) return
            if (scenario === 'success' || completedRetry) {
              controller.enqueue(event(startEvent()))
              controller.enqueue(event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'done' } }))
              controller.enqueue(event({ type: 'content_block_stop', index: 0 }))
              controller.enqueue(event({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }))
              controller.enqueue(event({ type: 'message_stop' })); controller.close(); return
            }
            controller.enqueue(event(startEvent()))
            if (scenario === 'heartbeats') {
              heartbeatTimer = setInterval(() => {
                pings++; controller.enqueue(event({ type: 'ping' }))
                if (pings === 8) clearInterval(heartbeatTimer)
              }, 15)
              return
            }
            const tool = (index: number) => {
              controller.enqueue(event({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `effect-${index}`, name: 'DurableCounter', input: {} } }))
              controller.enqueue(event({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '{}' } }))
              controller.enqueue(event({ type: 'content_block_stop', index }))
            }
            tool(0)
            if (scenario === 'queued') tool(1)
            if (scenario === 'acquisition-retry') {
              controller.enqueue(event({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } }))
              controller.enqueue(event({ type: 'message_stop' })); controller.close()
            }
          },
          cancel() { cancellations++; if (scenario !== 'uncooperative') finish() },
        }), { status: acquisitionFailure ? 500 : scenario === 'error400' ? 400 : 200, headers: { 'content-type': scenario === 'error400' ? 'application/json' : 'text/event-stream', 'request-id': 'req_idle', 'retry-after': '0', 'anthropic-ratelimit-unified-status': 'allowed', 'anthropic-ratelimit-unified-reset': '2000000000', 'anthropic-ratelimit-unified-fallback': 'available', 'anthropic-ratelimit-unified-5h-utilization': '0.25', 'anthropic-ratelimit-unified-5h-reset': '2000000000' } })
      }, { preconnect: fetch.preconnect })
      const messages = [createUserMessage({ content: 'fixture' })]
      const context = createToolUseContext(messages)
      context.options.mainLoopModel = 'claude-sonnet-4-6'
      context.options.mainLoopProvider = 'firstParty'
      context.options.tools = [buildTool({
        name: 'DurableCounter', inputSchema: z.object({}), description: async () => 'fixture', prompt: async () => 'fixture',
        maxResultSizeChars: 1000, renderToolUseMessage: () => null, isConcurrencySafe: () => false,
        async call() {
          running = true
          writeFileSync(counter, String(Number(readFileSync(counter, 'utf8')) + 1))
          if (scenario !== 'completed' && scenario !== 'acquisition-retry') await completion
          running = false
          return { data: 'durable effect completed' }
        },
        mapToolResultToToolResultBlockParam: (data, id) => ({ type: 'tool_result', tool_use_id: id, content: data }),
      })]
      let permissionEntered = false, hookEntered = false
      if (scenario === 'hook') bootstrap.registerHookCallbacks({ PreToolUse: [{ matcher: 'DurableCounter', hooks: [{ type: 'callback', callback: async () => { hookEntered = true; await completion; return {} } }] }] })
      const rows: unknown[] = []
      let typedIdle = false
      const began = performance.now()
      const collect = async () => {
        if (scenario === 'headers' || scenario === 'heartbeats' || scenario === 'success' || scenario === 'error400') {
          for await (const row of queryModelWithStreaming({ messages, systemPrompt: asSystemPrompt(['test']), thinkingConfig: { type: 'disabled' }, tools: [], signal: context.abortController.signal,
            options: { model: 'claude-sonnet-4-6', provider: 'firstParty', getToolPermissionContext: async () => getEmptyToolPermissionContext(), isNonInteractiveSession: true, querySource: 'sdk', agents: [], hasAppendSystemPrompt: false, fetchOverride, mcpTools: [] },
          })) rows.push(row)
        } else {
          for await (const row of query({ messages, systemPrompt: asSystemPrompt(['test']), userContext: {}, systemContext: {}, canUseTool: async () => { if (scenario === 'permission') { permissionEntered = true; await completion } return { behavior: 'allow', updatedInput: {} } }, querySource: 'sdk', toolUseContext: context,
            deps: { uuid: () => 'idle-query', microcompact: async messages => ({ messages }), autocompact: async () => ({ wasCompacted: false }),
              callModel: params => queryModelWithStreaming({ ...params, options: { ...params.options, fetchOverride } }),
            },
          })) {
            rows.push(row)
            if (scenario === 'uncooperative' && row.type === 'assistant' && row.isApiErrorMessage) {
              await Bun.sleep(20)
              expect(running).toBe(true)
              expect(JSON.stringify(rows)).not.toContain('durable effect completed')
              finish()
            }
          }
        }
      }
      let guard: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([collect().catch(error => { if (!(error instanceof StreamIdleError)) throw error; typedIdle = true; rows.push({ error: error.message }) }), new Promise<never>((_, reject) => { guard = setTimeout(() => { context.abortController.abort(); finish(); reject(new Error('turn did not settle')) }, 2000) })])
      } finally { clearTimeout(guard) }
      await Bun.sleep(0)
      expect(dispatches).toBe(scenario === 'acquisition-retry' ? 3 : 1)
      if (scenario === 'acquisition-retry') {
        expect(readFileSync(counter, 'utf8')).toBe('1')
        expect(JSON.stringify(rows)).toContain('durable effect completed')
        expect(JSON.stringify(rows)).not.toContain('Not run:')
      } else if (scenario === 'success') {
        expect(quota.mock.calls).toHaveLength(1)
        expect(quota.mock.calls[0]![0].get('request-id')).toBe('req_idle')
        expect(JSON.stringify(rows)).toContain('done')
        expect(limits.currentLimits.resetsAt).toBe(2000000000)
        expect(limits.currentLimits.unifiedRateLimitFallbackAvailable).toBe(true)
        expect(limits.getRawUtilization().five_hour).toEqual({ utilization: 0.25, resets_at: 2000000000 })
      } else if (scenario === 'error400') {
        expect(cancellations).toBe(1)
        expect(JSON.stringify(rows)).toContain('400')
        expect(quotaError.mock.calls).toHaveLength(1)
        expect(quotaError.mock.calls[0]![0].status).toBe(400)
        expect(quotaError.mock.calls[0]![0].headers?.get('request-id')).toBe('req_idle')
      } else {
        expect(aborted).toBe(true)
        expect(cancellations).toBe(1)
        expect(JSON.stringify(rows)).toContain('idle')
      }
      if (scenario === 'permission' || scenario === 'hook') {
        expect(scenario === 'permission' ? permissionEntered : hookEntered).toBe(true)
        expect(readFileSync(counter, 'utf8')).toBe('0')
        expect(rows.some(row => (row as Message).type === 'user')).toBe(true)
        expect(context.abortController.signal.aborted).toBe(false)
      }
      if (scenario === 'headers' || scenario === 'heartbeats') expect(typedIdle).toBe(true)
      if (scenario === 'heartbeats') { expect(pings).toBe(8); expect(performance.now() - began).toBeGreaterThan(120) }
      if (scenario === 'running' || scenario === 'completed' || scenario === 'queued' || scenario === 'uncooperative') {
        expect(readFileSync(counter, 'utf8')).toBe('1')
        expect(JSON.stringify(rows)).toContain('durable effect completed')
        expect(rows.some(row => (row as Message).type === 'tombstone')).toBe(false)
        expect(toolRunningAtAbort).toBe(scenario !== 'completed')
      }
      if (scenario === 'queued') expect(JSON.stringify(rows)).toContain('Not run: the response stream was interrupted.')
    } finally {
      bootstrap.clearRegisteredHooks(); if (savedHooks) bootstrap.registerHookCallbacks(savedHooks)
      finish(); clearInterval(heartbeatTimer); gate.mockRestore(); recording.mockRestore(); quota.mockRestore(); quotaError.mockRestore(); quotaPolicy?.mockRestore(); limits.resetClaudeAiLimits(true); limits.emitStatusChange(savedLimits, true); nonInteractive.mockRestore(); hookPolicyGate.mockRestore(); hooksDisabled.mockRestore(); macro.MACRO = savedMacro
      keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index] })
      rmSync(root, { recursive: true, force: true })
    }
  }, 5000)
}
