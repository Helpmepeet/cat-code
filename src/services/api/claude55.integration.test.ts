import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { resetStateForTests, setSessionProvider } from '../../bootstrap/state.js'
import { getTools } from '../../tools.js'
import { clearToolSchemaCache } from '../../utils/toolSchemaCache.js'
import { createUserMessage } from '../../utils/messages.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { queryModelWithStreaming } from './claude.js'

const originalEnv = { ...process.env }
const macroState = globalThis as typeof globalThis & { MACRO?: { VERSION: string } }
const originalMacro = macroState.MACRO
let fixturesRoot: string | undefined

afterEach(() => {
  for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_TEST_FIXTURES_ROOT', 'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING']) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
  macroState.MACRO = originalMacro
  resetStateForTests()
  clearToolSchemaCache()
  if (fixturesRoot) rmSync(fixturesRoot, { recursive: true, force: true })
})

test.each([
  ['Opus 5.5 response', 'claude-opus-5-5', 'none'],
  ['Sonnet 5.5 response', 'claude-sonnet-5-5', 'none'],
  ['Opus 5.5 refusal details', 'claude-opus-5-5', 'details'],
  ['Opus 5.5 refusal without details', 'claude-opus-5-5', 'no-details'],
] as const)(
  '%s with tools assembled before a provider switch',
  async (_case, model, refusalMode) => {
    const refused = refusalMode !== 'none'
    process.env.ANTHROPIC_API_KEY = 'test-api-key'
    fixturesRoot = mkdtempSync(join(tmpdir(), 'cat-code-claude55-'))
    process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = fixturesRoot
    process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING = '1'
    macroState.MACRO = { VERSION: 'test-version' }
    setSessionProvider('openai')
    const tools = getTools(getEmptyToolPermissionContext())
    setSessionProvider('firstParty')
    let requests = 0
    const bodies: Record<string, any>[] = []
    const fetchOverride = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body))
      requests++
      bodies.push(body)
      const events = [
        { type: 'message_start', message: { id: 'msg_55', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Claude 5.5 ready' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: refused ? 'refusal' : 'end_turn', stop_sequence: null, stop_details: refusalMode === 'details' ? { type: 'refusal', category: 'reasoning_extraction', explanation: 'The request asks for private reasoning.' } : null }, usage: { output_tokens: 4 } },
        { type: 'message_stop' },
      ]
      const streamedEvents = refused ? events.filter(event => !event.type.startsWith('content_block_')) : events
      return new Response(streamedEvents.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      })
    }, { preconnect: fetch.preconnect }) as typeof fetch
    const events = []
    for await (const event of queryModelWithStreaming({
      messages: [createUserMessage({ content: 'hello' })],
      systemPrompt: asSystemPrompt(['You are a test assistant.']),
      thinkingConfig: { type: 'disabled' },
      tools,
      signal: new AbortController().signal,
      options: {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        model, provider: 'firstParty', isNonInteractiveSession: true,
        querySource: 'compact', agents: [], hasAppendSystemPrompt: false,
        fetchOverride, mcpTools: [], temperatureOverride: 0,
        toolChoice: { type: 'tool', name: 'apply_patch' },
      },
    })) events.push(event)
    expect(requests).toBe(1)
    const body = bodies[0]!
    expect(body.model).toBe(model)
    expect(body.tools.length).toBeGreaterThan(10)
    for (const tool of body.tools) {
      expect(tool.input_schema.type, tool.name).toBe('object')
      expect(tool).not.toHaveProperty('openai_tool_type')
    }
    expect(body.tool_choice).toEqual({ type: 'auto' })
    expect(body).not.toHaveProperty('temperature')
    expect(body.thinking).toMatchObject({ type: 'adaptive', display: 'summarized' })

    if (refused) {
      const refusal = events.find(event => 'isApiErrorMessage' in event && event.isApiErrorMessage)
      expect(refusal).toBeDefined()
      expect(JSON.stringify(refusal)).toContain('Claude declined this request')
      if (refusalMode === 'details') {
        expect(JSON.stringify(refusal)).toContain('reasoning_extraction')
        expect(JSON.stringify(refusal)).toContain('The request asks for private reasoning.')
      }
      expect(JSON.stringify(refusal)).not.toContain('claude-sonnet-4-20250514')
    } else {
      expect(JSON.stringify(events)).toContain('Claude 5.5 ready')
      expect(events.some(event => 'isApiErrorMessage' in event && event.isApiErrorMessage)).toBe(false)
    }
  },
)
