import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { resetStateForTests, setSessionProvider } from '../../bootstrap/state.js'
import { getTools } from '../../tools.js'
import { clearToolSchemaCache } from '../../utils/toolSchemaCache.js'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'
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
  ['Fable 5.2 prefix recovery', 'claude-fable-5-2', 'prefix'],
] as const)(
  '%s with tools assembled before a provider switch',
  async (_case, model, refusalMode) => {
    const recoverPrefix = refusalMode === 'prefix'
    const refused = refusalMode === 'details' || refusalMode === 'no-details'
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
    const rejectedThinking = { type: 'thinking' as const, thinking: 'early reasoning', signature: 'old-signature' }
    const laterThinking = { type: 'redacted_thinking' as const, data: 'later-signature' }
    const history = [
      createUserMessage({ content: 'First prompt' }),
      createAssistantMessage({ content: [rejectedThinking, { type: 'text', text: 'Keep the first reply', citations: null }] }),
      createUserMessage({ content: 'Next prompt' }),
      createAssistantMessage({ content: [laterThinking, { type: 'text', text: 'Keep the second reply', citations: null }] }),
    ]
    const fetchOverride = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body))
      requests++
      bodies.push(body)
      if (recoverPrefix && requests === 1) {
        const message = body.messages.findIndex((turn: any) => Array.isArray(turn.content) &&
          turn.content.some((block: any) => block.signature === rejectedThinking.signature))
        const block = body.messages[message].content.findIndex((item: any) => item.signature === rejectedThinking.signature)
        return Response.json({
          type: 'error',
          error: { type: 'invalid_request_error', message: `messages.${message}.content.${block}: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation.` },
        }, { status: 400 })
      }
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
      messages: [...(recoverPrefix ? history : []), createUserMessage({ content: 'hello' })],
      systemPrompt: asSystemPrompt(['You are a test assistant.']),
      thinkingConfig: { type: 'disabled' },
      tools,
      signal: new AbortController().signal,
      options: {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        model, provider: 'firstParty', isNonInteractiveSession: true,
        querySource: 'compact', agents: [], hasAppendSystemPrompt: false,
        fetchOverride, mcpTools: [], temperatureOverride: 0,
        toolChoice: recoverPrefix ? { type: 'any' } : { type: 'tool', name: 'apply_patch' },
        ...(recoverPrefix && { effortValue: 'xhigh' }),
      },
    })) events.push(event)
    expect(requests).toBe(recoverPrefix ? 2 : 1)
    const body = bodies.at(-1)!
    expect(body.model).toBe(model)
    expect(body.tools.length).toBeGreaterThan(10)
    for (const tool of body.tools) {
      expect(tool.input_schema.type, tool.name).toBe('object')
      expect(tool).not.toHaveProperty('openai_tool_type')
    }
    expect(body.tool_choice).toEqual({ type: 'auto' })
    expect(body).not.toHaveProperty('temperature')
    expect(body.thinking).toMatchObject({ type: 'adaptive', display: 'summarized' })
    if (recoverPrefix) {
      expect(body.output_config.effort).toBe('xhigh')
      expect(JSON.stringify(bodies[0]!.messages)).toContain(laterThinking.data)
      expect(JSON.stringify(body.messages)).not.toContain(rejectedThinking.signature)
      expect(JSON.stringify(body.messages)).not.toContain(laterThinking.data)
      expect(JSON.stringify(body.messages)).toContain('Keep the first reply')
      expect(JSON.stringify(body.messages)).toContain('Keep the second reply')
      expect(history[1]!.message.content[0]).toEqual(rejectedThinking)
    }

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
