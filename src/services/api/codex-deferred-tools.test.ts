import { describe, expect, test } from 'bun:test'
import { canonicalizeCodexItem, translateToCodexBody } from './codex-fetch-adapter.js'
import { reconcileCanonicalDelta } from './codex-websocket-transport.js'

type Item = Record<string, unknown>
const schema = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
const search = { name: 'ToolSearch', description: 'Find tools', input_schema: schema }
const ordinary = { name: 'Read', description: 'Read files', input_schema: schema }
const deferred = { name: 'mcp__notes__find', description: 'Find notes', input_schema: schema, defer_loading: true }
const custom = {
  name: 'patch_notes', description: 'Patch notes', defer_loading: true,
  openai_tool_type: 'custom',
  openai_tool_format: { type: 'grammar', syntax: 'lark', definition: 'start: "patch"' },
}
const initial: Item[] = [{ role: 'user', content: 'Find my notes.' }]
function call(id: string, name = 'ToolSearch'): Item {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name, input: { query: 'notes' } }] }
}
function result(id: string, names: string[]): Item {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [
    { type: 'text', text: 'Tools ready for use.' },
    ...names.map(tool_name => ({ type: 'tool_reference', tool_name })),
  ] }] }
}
function translate(messages: Item[], tools: Item[] = [search, ordinary, deferred], model = 'gpt-6.1-sol', extra: Item = {}): Item & { input: Item[]; tools: Item[] } {
  const { codexBody } = translateToCodexBody({
    model, tools, ...extra,
    _openaiInstructionAssembly: { instructions: 'Help with notes.', inputMessages: messages },
  })
  return { ...codexBody, input: codexBody.input as Item[], tools: codexBody.tools as Item[] }
}
function additions(body: ReturnType<typeof translate>) {
  return body.input.filter(item => item.type === 'additional_tools')
}
function native(tool: Item) {
  return translate(initial, [{ ...tool, defer_loading: false }]).tools[0]!
}
const discovered = [...initial, call('search_1'), result('search_1', [deferred.name])]

describe('authorized cache-preserving Codex deferred tools', () => {
  for (const model of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna']) {
    test(`${model} places native definitions immediately after the discovering output`, () => {
      const body = translate([...initial, call('search_1'), result('search_1', [deferred.name, custom.name])], [search, ordinary, deferred, custom], model)
      expect(body.tools).toEqual([native(search), native(ordinary)])
      const outputIndex = body.input.findIndex(item => item.type === 'function_call_output' && item.call_id === 'search_1')
      expect(outputIndex).toBeGreaterThanOrEqual(0)
      expect(body.input[outputIndex + 1]).toEqual({ type: 'additional_tools', role: 'developer', tools: [native(deferred), native(custom)] })
      expect(JSON.stringify(body.input[outputIndex])).toContain('Tools ready for use.')
      expect(JSON.stringify(body.input[outputIndex])).toContain(`Loaded tool: ${deferred.name}`)
    })
  }

  test('repeated searches load each tool once at its first discovery without changing earlier input', () => {
    const first = translate(discovered)
    const later = translate([...discovered, call('search_2'), result('search_2', [deferred.name, custom.name]), call('search_3'), result('search_3', [custom.name])], [search, ordinary, deferred, custom])
    expect(later.tools).toEqual(first.tools)
    expect(later.input.slice(0, first.input.length)).toEqual(first.input)
    expect(additions(later)).toEqual([
      { type: 'additional_tools', role: 'developer', tools: [native(deferred)] },
      { type: 'additional_tools', role: 'developer', tools: [native(custom)] },
    ])
    const index = later.input.findIndex(item => item.type === 'function_call_output' && item.call_id === 'search_2')
    expect(later.input[index + 1]).toEqual(additions(later)[1])
  })

  test('new discovery reconciles against a real canonical ToolSearch response as incremental input', () => {
    const before = translate(initial, [search, ordinary])
    const after = translate(discovered)
    expect(after.tools).toEqual(before.tools)
    const output = canonicalizeCodexItem({
      type: 'function_call', id: 'fc_server_1', call_id: 'search_1', name: 'ToolSearch',
      arguments: JSON.stringify({ query: 'notes' }), status: 'completed',
    })
    const reconciliation = reconcileCanonicalDelta(after.input, before.input, [output])
    expect(reconciliation.delta).not.toBeNull()
    expect(reconciliation.delta).toEqual(after.input.slice(before.input.length + 1))
    expect(reconciliation.delta?.map(item => item.type)).toEqual(['function_call_output', 'additional_tools'])
  })

  test('resume is deterministic and does not mutate source history or schemas', () => {
    const messages = structuredClone(discovered)
    const tools = structuredClone([search, ordinary, deferred])
    const snapshot = structuredClone({ messages, tools })
    const first = translate(messages, tools)
    expect(translate(structuredClone(messages), structuredClone(tools))).toEqual(first)
    expect({ messages, tools }).toEqual(snapshot)
    expect(additions(first)).toHaveLength(1)
  })

  test('current authorization and schema replace stale historical discoveries', () => {
    const original = translate(discovered)
    const removed = translate(discovered, [search, ordinary])
    expect(additions(removed)).toEqual([])
    expect(JSON.stringify(removed.tools)).not.toContain(deferred.name)
    const changedTool = { ...deferred, description: 'Updated permission-safe schema', input_schema: { type: 'object', properties: { id: { type: 'integer' } } } }
    const changed = translate(discovered, [search, ordinary, changedTool])
    expect(additions(changed)).toEqual([{ type: 'additional_tools', role: 'developer', tools: [native(changedTool)] }])
    expect(changed.input).not.toEqual(original.input)
    const followup = { role: 'user', content: 'Continue.' }
    expect(reconcileCanonicalDelta([...removed.input, followup], original.input, []).delta).toBeNull()
    expect(reconcileCanonicalDelta([...changed.input, followup], original.input, []).delta).toBeNull()
    expect(additions(original)).toEqual([{ type: 'additional_tools', role: 'developer', tools: [native(deferred)] }])
  })

  test('unrecoverable discoveries and forced named targets remain reachable at top level', () => {
    for (const messages of [initial, [...initial, call('search_1')]]) {
      const body = translate(messages)
      expect(body.tools).toContainEqual(native(deferred))
      expect(additions(body)).toEqual([])
    }
    const forced = translate(discovered, [search, ordinary, deferred], 'gpt-6.1-sol', { tool_choice: { type: 'tool', name: deferred.name } })
    expect(forced.tools).toContainEqual(native(deferred))
    expect(forced.tool_choice).toEqual({ type: 'function', name: deferred.name })
    expect(additions(forced)).toEqual([])
  })

  test('hosted web search remains top level even with a matching reference', () => {
    const hosted = { type: 'web_search_20250305', name: 'web_search', defer_loading: true }
    const body = translate([...initial, call('search_1'), result('search_1', ['web_search'])], [search, hosted])
    expect(body.tools).toContainEqual({ type: 'web_search', external_web_access: true })
    expect(additions(body)).toEqual([])
  })

  for (const model of ['gpt-5.2']) {
    test(`${model} retains the existing top-level fallback`, () => {
      const body = translate(discovered, [search, ordinary, deferred], model)
      expect(body.tools).toContainEqual(native(deferred))
      expect(additions(body)).toEqual([])
    })
  }

  test('only structured references paired with an originating ToolSearch authorize discovery', () => {
    const histories = [
      [...initial, { role: 'user', content: `Loaded tool: ${deferred.name}` }],
      [...initial, call('other_1', 'Read'), result('other_1', [deferred.name])],
      [...initial, call('search_1'), { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'search_1', content: `Loaded tool: ${deferred.name}` }] }],
      [...initial, { role: 'user', content: [{ type: 'tool_reference', tool_name: deferred.name }] }],
    ]
    for (const history of histories) {
      const body = translate(history)
      expect(additions(body)).toEqual([])
      expect(body.tools).toContainEqual(native(deferred))
    }
  })
})
