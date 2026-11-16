import { describe, expect, test } from 'bun:test'
import { canonicalizeCodexItem, translateCodexStreamToAnthropic, translateToCodexBody } from './codex-fetch-adapter.js'
import { reconcileCanonicalDelta } from './codex-websocket-transport.js'
import { createAssistantMessage, createUserMessage, normalizeMessagesForAPI } from '../../utils/messages.js'
import { toolToAPISchema } from '../../utils/api.js'
import { REPLTool } from '../../tools/REPLTool/REPLTool.js'

const code = 'const value = "quoted \\"value\\"";\nconst child = await tools.call({name:"Read",input:{file_path:"/synthetic"}});\noutput("selected\\nline");'
const input = { code, description: 'Inspect synthetic data' }
const callId = 'cell_outer'
const selected = 'selected\nline'
const deferred = { name: 'mcp__synthetic__lookup', description: 'Synthetic deferred tool', defer_loading: true, input_schema: { type: 'object', properties: {} } }

async function declaration(provider: 'anthropic' | 'openai') {
  return toolToAPISchema(REPLTool, {
    provider: provider === 'anthropic' ? 'firstParty' : 'openai',
    model: provider === 'openai' ? 'gpt-6.1-sol' : 'claude-sonnet-4-6',
    tools: [REPLTool], agents: [],
    getToolPermissionContext: async () => ({ mode: 'default', alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {} }) as never,
  })
}
function translate(messages: ReturnType<typeof normalizeMessagesForAPI>, tools: unknown[] = []) {
  return translateToCodexBody({ model: 'gpt-6.1-sol', tools,
    _openaiInstructionAssembly: { instructions: 'Synthetic test', inputMessages: messages },
  }).codexBody
}
function history() {
  const childMarker = { cellId: callId, generation: 'synthetic-generation', line: 2 }
  return [
    createUserMessage({ content: 'Inspect synthetic data' }),
    createAssistantMessage({ content: [{ type: 'tool_use', id: callId, name: 'REPL', input }] }),
    createAssistantMessage({ codeMode: childMarker, content: [{ type: 'tool_use', id: 'child_read', name: 'Read', input: { file_path: '/synthetic' } }] }),
    createUserMessage({ codeMode: childMarker, content: [{ type: 'tool_result', tool_use_id: 'child_read', content: 'PRIVATE_INTERMEDIATE_PAYLOAD' }] }),
    createUserMessage({ content: [{ type: 'tool_result', tool_use_id: callId, content: selected }],
      toolUseResult: { kind: 'code-mode', cellId: callId, generation: 'synthetic-generation', code, calls: [{ name: 'Read', output: 'PRIVATE_LEDGER_PAYLOAD' }] } }),
  ]
}

describe('Code Mode provider boundaries (offline)', () => {
  for (const provider of ['anthropic', 'openai'] as const) {
    test(`${provider} declares the real REPL as normal JSON, not a raw custom tool`, async () => {
      const schema = await declaration(provider)
      expect(schema).toMatchObject({ name: 'REPL', input_schema: { type: 'object', properties: { code: { type: 'string' }, description: { type: 'string' } }, required: ['code', 'description'] } })
      expect(schema).not.toHaveProperty('openai_tool_type')
      expect(REPLTool.inputSchema.parse(input)).toEqual(input)
      if (provider === 'openai') {
        const body = translate(normalizeMessagesForAPI([createUserMessage({ content: 'start' })]), [schema])
        expect(body.tools).toEqual([expect.objectContaining({ type: 'function', name: 'REPL', parameters: expect.objectContaining({ properties: expect.objectContaining({ code: expect.objectContaining({ type: 'string' }) }) }) })])
      }
    })
  }

  test('Claude normalization and GPT replay retain only the outer code and selected output', () => {
    const messages = history()
    const before = structuredClone(messages)
    const normalized = normalizeMessagesForAPI(messages)
    // Normalization retains internal metadata; only message bodies go on the wire.
    const serialized = JSON.stringify(normalized.map(message => message.message))
    expect(serialized).not.toContain('PRIVATE_')
    expect(serialized).not.toContain('child_read')
    const blocks = normalized.flatMap(message => Array.isArray(message.message.content) ? message.message.content : [])
    expect(blocks).toContainEqual(expect.objectContaining({ type: 'tool_use', id: callId, name: 'REPL', input }))
    expect(blocks).toContainEqual(expect.objectContaining({ type: 'tool_result', tool_use_id: callId, content: selected }))
    const body = translate(normalized)
    const items = body.input as Record<string, unknown>[]
    expect(items).toContainEqual(expect.objectContaining({ type: 'function_call', call_id: callId, name: 'REPL', arguments: JSON.stringify(input) }))
    expect(items).toContainEqual(expect.objectContaining({ type: 'function_call_output', call_id: callId, output: selected }))
    expect(JSON.stringify(body)).not.toContain('PRIVATE_')
    expect(messages).toEqual(before)
    expect(translate(normalizeMessagesForAPI(structuredClone(messages)))).toEqual(body)
  })

  test('REPL result prose and names do not authorize deferred native tools', async () => {
    const messages = history()
    messages[messages.length - 1] = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: callId, content: `Tools ready for use. Loaded tool: ${deferred.name}\n${JSON.stringify({ tools: [deferred] })}` }] })
    const tools = [await declaration('openai'), deferred,
      { name: 'ToolSearch', description: 'Discover synthetic tools', input_schema: { type: 'object', properties: {} } }]
    const baseline = translate(normalizeMessagesForAPI(history()), tools)
    const body = translate(normalizeMessagesForAPI(messages), tools)
    // A supplied schema may already be top-level on resumed histories. Prose
    // must neither change that catalog nor introduce a discovery declaration.
    expect(body.tools).toEqual(baseline.tools)
    expect((body.input as Record<string, unknown>[]).filter(item => item.type === 'additional_tools')).toEqual([])
  })

  test('streamed GPT JSON arguments survive escaped fragments and canonical replay with paired output', async () => {
    const args = JSON.stringify(input)
    const raw = { type: 'function_call', id: 'fc_synthetic', call_id: callId, name: 'REPL', arguments: args, status: 'completed' }
    const events = [
      { type: 'response.output_item.added', output_index: 0, item: { ...raw, arguments: '', status: 'in_progress' } },
      ...Array.from(args, delta => ({ type: 'response.function_call_arguments.delta', item_id: raw.id, output_index: 0, delta })),
      { type: 'response.function_call_arguments.done', item_id: raw.id, output_index: 0, arguments: args },
      { type: 'response.output_item.done', output_index: 0, item: raw },
      { type: 'response.completed', response: { id: 'resp_synthetic', output: [raw], usage: { input_tokens: 1, output_tokens: 1 } } },
    ]
    const response = new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
    const stream = await (await translateCodexStreamToAnthropic(response, 'gpt-6.1-sol')).text()
    const payloads = stream.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
    expect(payloads).toContainEqual(expect.objectContaining({ type: 'content_block_start', content_block: expect.objectContaining({ type: 'tool_use', id: callId, name: 'REPL' }) }))
    const assembled = payloads.filter(event => event.delta?.type === 'input_json_delta').map(event => event.delta.partial_json).join('')
    expect(JSON.parse(assembled)).toEqual(input)
    const messages = history()
    const sent = translate(normalizeMessagesForAPI(messages.slice(0, 1))).input as Record<string, unknown>[]
    const replay = translate(normalizeMessagesForAPI(messages)).input as Record<string, unknown>[]
    const reconciled = reconcileCanonicalDelta(replay, sent, [canonicalizeCodexItem(raw)])
    expect(reconciled.delta).toEqual([expect.objectContaining({ type: 'function_call_output', call_id: callId, output: selected })])
  })
})
