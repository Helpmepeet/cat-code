import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import z from 'zod/v4'
import { buildTool, type ToolUseContext } from '../../Tool.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { createUserMessage } from '../../utils/messages.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { query } from '../../query.js'
import * as growthbook from '../analytics/growthbook.js'
function createAssistantMessage(text: string, uuid: string): AssistantMessage {
  return {
    type: 'assistant',
    uuid,
    timestamp: '2026-05-05T00:00:00.000Z',
    message: {
      id: uuid,
      model: 'gpt-5.6-terra',
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage: {
        input_tokens: 10,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      stop_reason: 'end_turn',
      stop_sequence: null,
    },
  } as AssistantMessage
}

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


for (const running of [false, true]) {
  test(`interrupted stream retains durable tool receipt (running=${running})`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'stream-effect-'))
    const counter = join(root, 'counter')
    writeFileSync(counter, '0')
    const gate = spyOn(growthbook, 'checkStatsigFeatureGate_CACHED_MAY_BE_STALE').mockImplementation(name => name === 'tengu_streaming_tool_execution2')
    try {
      const messages = [createUserMessage({ content: 'fixture' })]
      const context = createToolUseContext(messages)
      let started!: () => void
      const start = new Promise<void>(resolve => { started = resolve })
      let finish!: () => void
      const completion = new Promise<void>(resolve => { finish = resolve })
      context.options.tools = [buildTool({
        name: 'DurableCounter', inputSchema: z.object({}), description: async () => 'fixture', prompt: async () => 'fixture',
        maxResultSizeChars: 1000, renderToolUseMessage: () => null,
        async call() {
          writeFileSync(counter, String(Number(readFileSync(counter, 'utf8')) + 1))
          started()
          if (running) await completion
          return { data: 'durable effect completed' }
        },
        mapToolResultToToolResultBlockParam: (data, id) => ({ type: 'tool_result', tool_use_id: id, content: data }),
      })]
      const assistant = createAssistantMessage('fixture', 'effect-assistant')
      assistant.message.content = [{ type: 'tool_use', name: 'DurableCounter', id: 'effect-call', input: {} }]
      let calls = 0
      const rows: Message[] = []
      const iterator = query({ messages, systemPrompt: asSystemPrompt(['test']), userContext: {}, systemContext: {},
        canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }), querySource: 'sdk', toolUseContext: context,
        deps: { uuid: () => 'effect-query', microcompact: async messages => ({ messages }), autocompact: async () => ({ wasCompacted: false }),
          callModel: async function* ({ options }) {
            calls++; yield assistant; await start
            if (!running) await Bun.sleep(10)
            // Simulate a provider attempting fallback after the escaped effect.
            queueMicrotask(finish)
            options.onStreamingFallback?.()
            yield createAssistantMessage('must not replay', 'replayed')
          },
        },
      })
      for await (const row of iterator) rows.push(row as Message)
      expect(calls).toBe(1)
      expect(readFileSync(counter, 'utf8')).toBe('1')
      expect(rows.some(row => row.type === 'tombstone')).toBe(false)
      expect(JSON.stringify(rows)).toContain('durable effect completed')
      expect(JSON.stringify(rows)).not.toContain('must not replay')
    } finally { gate.mockRestore(); rmSync(root, { recursive: true, force: true }) }
  })
}
