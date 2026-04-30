/**
 * Standalone verification for Codex tool-call call-ID continuity.
 * Run with: bun run scripts/test-codex-stream-tool-call-ids.ts
 */
import {
  translateCodexStreamToAnthropic,
  translateToCodexBody,
} from '../src/services/api/codex-fetch-adapter.js'

type SSEEvent = {
  event: string
  data: Record<string, unknown>
}

function sseLine(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function makeResponse(events: Array<Record<string, unknown>>): Response {
  const body = events.map(sseLine).join('') + 'data: [DONE]\n\n'
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

async function readSSE(response: Response): Promise<SSEEvent[]> {
  const text = await response.text()
  return text
    .split('\n\n')
    .map(chunk => chunk.trim())
    .filter(Boolean)
    .flatMap(chunk => {
      const lines = chunk.split('\n')
      const eventLine = lines.find(line => line.startsWith('event: '))
      const dataLine = lines.find(line => line.startsWith('data: '))
      if (!eventLine || !dataLine) return []
      return [{
        event: eventLine.slice(7),
        data: JSON.parse(dataLine.slice(6)) as Record<string, unknown>,
      }]
    })
}

function fail(message: string): never {
  console.error(`X FAIL  ${message}`)
  process.exit(1)
}

function expect(condition: unknown, message: string): void {
  if (!condition) fail(message)
}

function makeAnthropicBody(inputMessages: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    model: 'gpt-5.3-codex',
    _openaiInstructionAssembly: {
      instructions: 'Return tool results only.',
      inputMessages,
    },
  }
}

function getCodexInput(inputMessages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return (translateToCodexBody(makeAnthropicBody(inputMessages)).codexBody.input || []) as Array<
    Record<string, unknown>
  >
}

function expectThrows(fn: () => unknown, pattern: RegExp, message: string): void {
  try {
    fn()
    fail(`${message}: expected throw`)
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    expect(pattern.test(text), `${message}: got ${text}`)
  }
}

const requestInput = getCodexInput([
  {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'call_weather',
        name: 'get_weather',
        input: { city: 'Paris' },
      },
    ],
  },
  {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'call_weather',
        content: 'Sunny',
      },
    ],
  },
])

const requestFunctionCall = requestInput.find(item => item.type === 'function_call')
const requestFunctionOutput = requestInput.find(item => item.type === 'function_call_output')
expect(requestFunctionCall, 'expected request translation to emit function_call')
expect(requestFunctionOutput, 'expected request translation to emit function_call_output')
expect(
  requestFunctionCall!.call_id === 'call_weather',
  `expected function_call call_id=call_weather, got ${String(requestFunctionCall!.call_id)}`,
)
expect(
  requestFunctionOutput!.call_id === 'call_weather',
  `expected function_call_output call_id=call_weather, got ${String(requestFunctionOutput!.call_id)}`,
)

const fallbackRequestInput = getCodexInput([
  {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'call_only_pending',
        name: 'get_weather',
        input: { city: 'Paris' },
      },
    ],
  },
  {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        content: 'Sunny',
      },
    ],
  },
])
const fallbackOutput = fallbackRequestInput.find(item => item.type === 'function_call_output')
expect(
  fallbackOutput?.call_id === 'call_only_pending',
  `expected missing tool_use_id to reuse sole pending call_id, got ${String(fallbackOutput?.call_id)}`,
)

expectThrows(
  () =>
    getCodexInput([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_weather',
            name: 'get_weather',
            input: { city: 'Paris' },
          },
          {
            type: 'tool_use',
            id: 'call_time',
            name: 'get_time',
            input: { timezone: 'UTC' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            content: 'Ambiguous result',
          },
        ],
      },
    ]),
  /cannot pair tool_result without tool_use_id: 2 pending function_call items remain/i,
  'expected ambiguous missing tool_use_id to fail',
)

expectThrows(
  () =>
    getCodexInput([
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            content: 'Orphan result',
          },
        ],
      },
    ]),
  /cannot pair tool_result without tool_use_id: no pending function_call remains/i,
  'expected orphan tool_result without tool_use_id to fail',
)

const parallelToolCallEvents = [
  {
    type: 'response.output_item.added',
    output_index: 0,
    item: {
      type: 'function_call',
      id: 'fc_item_1',
      call_id: 'call_weather',
      name: 'get_weather',
      arguments: '',
    },
  },
  {
    type: 'response.output_item.added',
    output_index: 1,
    item: {
      type: 'function_call',
      id: 'fc_item_2',
      call_id: 'call_time',
      name: 'get_time',
      arguments: '',
    },
  },
  {
    type: 'response.function_call_arguments.delta',
    item_id: 'fc_item_2',
    delta: '{"timezone":"UTC"',
  },
  {
    type: 'response.function_call_arguments.delta',
    item_id: 'fc_item_1',
    delta: '{"city":"Paris"',
  },
  {
    type: 'response.function_call_arguments.delta',
    item_id: 'fc_item_2',
    delta: '}',
  },
  {
    type: 'response.function_call_arguments.done',
    item_id: 'fc_item_2',
    arguments: '{"timezone":"UTC"}',
  },
  {
    type: 'response.function_call_arguments.delta',
    item_id: 'fc_item_1',
    delta: '}',
  },
  {
    type: 'response.function_call_arguments.done',
    item_id: 'fc_item_1',
    arguments: '{"city":"Paris"}',
  },
  {
    type: 'response.output_item.done',
    item: {
      type: 'function_call',
      id: 'fc_item_2',
      call_id: 'call_time',
      name: 'get_time',
      arguments: '{"timezone":"UTC"}',
    },
  },
  {
    type: 'response.output_item.done',
    item: {
      type: 'function_call',
      id: 'fc_item_1',
      call_id: 'call_weather',
      name: 'get_weather',
      arguments: '{"city":"Paris"}',
    },
  },
  {
    type: 'response.completed',
    response: {
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    },
  },
] satisfies Array<Record<string, unknown>>

const translated = await translateCodexStreamToAnthropic(
  makeResponse(parallelToolCallEvents),
  'gpt-5.3-codex',
)
const events = await readSSE(translated)

const toolStarts = events.filter(
  event =>
    event.event === 'content_block_start' &&
    event.data.content_block &&
    (event.data.content_block as Record<string, unknown>).type === 'tool_use',
)
expect(toolStarts.length === 2, `expected 2 tool_use starts, got ${toolStarts.length}`)

const firstToolStart = toolStarts[0]!.data
const secondToolStart = toolStarts[1]!.data
expect(
  (firstToolStart.content_block as Record<string, unknown>).id === 'call_weather',
  'first tool_use start should keep call_weather id',
)
expect(
  (secondToolStart.content_block as Record<string, unknown>).id === 'call_time',
  'second tool_use start should keep call_time id',
)

const jsonDeltas = events.filter(
  event =>
    event.event === 'content_block_delta' &&
    event.data.delta &&
    (event.data.delta as Record<string, unknown>).type === 'input_json_delta',
)
expect(jsonDeltas.length === 4, `expected 4 input_json_delta events, got ${jsonDeltas.length}`)

const deltasByIndex = new Map<number, string[]>()
for (const event of jsonDeltas) {
  const index = event.data.index as number
  const delta = (event.data.delta as Record<string, unknown>).partial_json as string
  deltasByIndex.set(index, [...(deltasByIndex.get(index) || []), delta])
}

expect(
  JSON.stringify(deltasByIndex.get(0)) === JSON.stringify(['{"city":"Paris"', '}']),
  `tool block 0 deltas were mispaired: ${JSON.stringify(deltasByIndex.get(0))}`,
)
expect(
  JSON.stringify(deltasByIndex.get(1)) === JSON.stringify(['{"timezone":"UTC"', '}']),
  `tool block 1 deltas were mispaired: ${JSON.stringify(deltasByIndex.get(1))}`,
)

const toolStops = events.filter(event => event.event === 'content_block_stop')
const stoppedIndexes = toolStops.map(event => event.data.index as number)
expect(
  stoppedIndexes.includes(0) && stoppedIndexes.includes(1),
  `expected tool block stops for indexes 0 and 1, got ${JSON.stringify(stoppedIndexes)}`,
)

const messageDelta = events.find(event => event.event === 'message_delta')
expect(messageDelta, 'expected message_delta event')
expect(
  (messageDelta!.data.delta as Record<string, unknown>).stop_reason === 'tool_use',
  'expected stop_reason=tool_use when tool calls are present',
)

console.log('PASS  Codex request/stream tool-call continuity stays paired by call_id/item_id')
