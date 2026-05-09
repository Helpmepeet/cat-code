# OpenAI Native Web Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Cat Code agents on the OpenAI/Codex provider able to use the existing `WebSearch` tool through OpenAI's native hosted `web_search` Responses API tool.

**Architecture:** Keep one user-facing Cat Code tool named `WebSearch`. Preserve the current Anthropic implementation for Claude-like providers, and teach the OpenAI/Codex adapter to translate the existing Anthropic server-tool schema emitted by `WebSearchTool.call()` into OpenAI's hosted `web_search` tool for the nested search request. Normalize OpenAI `web_search_call` output items into Anthropic-style `server_tool_use` and `web_search_tool_result` stream blocks so the existing `WebSearchTool` result parser and UI continue to work.

**Tech Stack:** TypeScript, Bun test runner, Anthropic Messages stream compatibility layer, OpenAI/Codex Responses API adapter, Ink terminal UI.

---

## Current State and Constraints

- `src/tools/WebSearchTool/WebSearchTool.ts` already implements a Cat Code `WebSearch` tool, but `isEnabled()` returns `false` for the OpenAI provider.
- The existing `WebSearchTool.call()` performs a nested model request with `extraToolSchemas: [{ type: 'web_search_20250305', name: 'web_search', ... }]`.
- `src/services/api/claude.ts` passes `extraToolSchemas` through the normal request `tools` array.
- `src/services/api/codex-fetch-adapter.ts` currently translates every incoming tool schema into an OpenAI `function` or `custom` tool, so Anthropic `web_search_20250305` would be sent incorrectly as a function tool.
- OpenAI native web search must be sent as a hosted Responses tool: `{ type: 'web_search' }`.
- OpenAI supports `filters.allowed_domains`; do not add `blocked_domains` support for OpenAI unless it is separately verified.
- OpenAI defaults to live web access when `external_web_access` is omitted, so this implementation must set `external_web_access` explicitly.
- The repository has a dirty working tree at plan-writing time. Implementation workers must avoid touching unrelated changes.

## File Structure

- Modify: `src/services/api/codex-fetch-adapter.ts`
  - Recognize Anthropic hosted web-search tool schemas.
  - Emit OpenAI hosted `web_search` tool specs instead of function specs.
  - Preserve `include: ['reasoning.encrypted_content', 'web_search_call.action.sources']` without overwriting either include value.
  - Translate OpenAI `web_search_call` output items into Anthropic-compatible stream blocks.
- Modify: `src/services/api/codex-fetch-adapter.test.ts`
  - Cover request-body translation for OpenAI hosted web search.
  - Cover include merging with reasoning.
  - Cover stream translation from `web_search_call` plus sources into `server_tool_use` and `web_search_tool_result` blocks.
- Modify: `src/tools/WebSearchTool/WebSearchTool.ts`
  - Enable `WebSearch` for the OpenAI provider.
  - Reject `blocked_domains` on OpenAI/Codex because OpenAI native web search only has verified `allowed_domains` support.
  - Keep Anthropic/Vertex/Foundry behavior unchanged.
- Create: `src/tools/WebSearchTool/WebSearchTool.test.ts`
  - Cover OpenAI enablement and OpenAI-specific blocked-domain validation.
- Modify only if needed after tests expose a continuation issue: `src/services/api/codex-websocket-transport.ts`
  - Preserve `web_search_call` output items for WebSocket continuation. The current fallback clone path likely already preserves them.
- Modify only if needed after UI verification: `src/tools/WebSearchTool/UI.tsx`
  - No planned change. Existing UI renders the normalized result count.

---

### Task 1: Translate Anthropic WebSearch Schema to OpenAI Hosted Tool

**Files:**
- Modify: `src/services/api/codex-fetch-adapter.ts:307-371`
- Modify: `src/services/api/codex-fetch-adapter.ts:650-745`
- Test: `src/services/api/codex-fetch-adapter.test.ts`

- [ ] **Step 1: Write the failing request translation test**

Add this test after the existing `translateToCodexBody preserves function tool strictness and custom tool metadata` test in `src/services/api/codex-fetch-adapter.test.ts`:

```ts
test('translateToCodexBody sends Anthropic web search schema as OpenAI hosted web_search', () => {
  const { codexBody } = translateToCodexBody({
    model: 'claude-sonnet-4-6',
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
        allowed_domains: ['openai.com', 'platform.openai.com'],
        max_uses: 8,
      },
    ],
    _openaiInstructionAssembly: {
      instructions: 'test instructions',
      inputMessages: [],
    },
  })

  expect(codexBody.tools).toEqual([
    {
      type: 'web_search',
      external_web_access: true,
      search_context_size: 'medium',
      filters: {
        allowed_domains: ['openai.com', 'platform.openai.com'],
      },
    },
  ])
  expect(codexBody.include).toEqual(['web_search_call.action.sources'])
})
```

- [ ] **Step 2: Write the failing include-merging test**

Add this test immediately after the previous test:

```ts
test('translateToCodexBody merges web search sources include with reasoning include', () => {
  const { codexBody } = translateToCodexBody({
    model: 'claude-sonnet-4-6',
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 8,
      },
    ],
    output_config: { effort: 'low' },
    _openaiInstructionAssembly: {
      instructions: 'test instructions',
      inputMessages: [],
    },
  })

  expect(codexBody.reasoning).toEqual({ effort: 'low', summary: 'auto' })
  expect(codexBody.include).toEqual([
    'reasoning.encrypted_content',
    'web_search_call.action.sources',
  ])
})
```

- [ ] **Step 3: Run the new tests and verify they fail**

Run:

```bash
bun test src/services/api/codex-fetch-adapter.test.ts --test-name-pattern "web search"
```

Expected: FAIL because `translateTools()` currently emits a `function` tool for `web_search`, and `codexBody.include` does not include `web_search_call.action.sources`.

- [ ] **Step 4: Add hosted web-search tool typing and translation helpers**

In `src/services/api/codex-fetch-adapter.ts`, extend the `AnthropicTool` interface around `src/services/api/codex-fetch-adapter.ts:323`:

```ts
interface AnthropicTool {
  type?: string
  name: string
  description?: string
  input_schema?: Record<string, unknown>
  strict?: boolean
  openai_tool_type?: 'function' | 'custom'
  openai_tool_format?: {
    type: 'grammar'
    syntax: 'lark'
    definition: string
  }
  allowed_domains?: string[]
  blocked_domains?: string[]
  max_uses?: number
}
```

Add these helpers above `translateTools()`:

```ts
const OPENAI_WEB_SEARCH_SOURCES_INCLUDE = 'web_search_call.action.sources'

function isAnthropicHostedWebSearchTool(tool: AnthropicTool): boolean {
  return tool.type === 'web_search_20250305' && tool.name === 'web_search'
}

function translateHostedWebSearchTool(
  tool: AnthropicTool,
): Record<string, unknown> {
  const translated: Record<string, unknown> = {
    type: 'web_search',
    external_web_access: true,
    search_context_size: 'medium',
  }

  if (Array.isArray(tool.allowed_domains) && tool.allowed_domains.length > 0) {
    translated.filters = { allowed_domains: tool.allowed_domains }
  }

  return translated
}

function addCodexInclude(
  codexBody: Record<string, unknown>,
  value: string,
): void {
  const current = Array.isArray(codexBody.include)
    ? codexBody.include.filter((item): item is string => typeof item === 'string')
    : []
  if (!current.includes(value)) {
    current.push(value)
  }
  codexBody.include = current
}
```

- [ ] **Step 5: Route Anthropic hosted web search through the new translator**

Replace the current `translateTools()` body with this structure:

```ts
function translateTools(anthropicTools: AnthropicTool[]): Array<Record<string, unknown>> {
  return anthropicTools
    .filter(tool => tool.name !== SYNTHETIC_OUTPUT_TOOL_NAME)
    .map(tool => {
      if (isAnthropicHostedWebSearchTool(tool)) {
        return translateHostedWebSearchTool(tool)
      }

      if (tool.openai_tool_type === 'custom' && tool.openai_tool_format) {
        return {
          type: 'custom',
          name: tool.name,
          description: tool.description || '',
          format: tool.openai_tool_format,
        }
      }

      return {
        type: 'function',
        name: tool.name,
        description: tool.description || '',
        parameters: tool.input_schema || { type: 'object', properties: {} },
        strict: tool.strict ?? null,
      }
    })
}
```

- [ ] **Step 6: Add the web-search sources include without overwriting reasoning include**

In `translateToCodexBody()`, replace the existing tool assignment around `src/services/api/codex-fetch-adapter.ts:668` with a local `translatedTools` variable:

```ts
const translatedTools = anthropicTools.length > 0
  ? translateTools(anthropicTools)
  : []
const hasHostedWebSearch = translatedTools.some(tool => tool.type === 'web_search')

if (translatedTools.length > 0) {
  codexBody.tools = translatedTools
}
```

Then replace the direct reasoning include assignment around `src/services/api/codex-fetch-adapter.ts:742`:

```ts
addCodexInclude(codexBody, 'reasoning.encrypted_content')
```

Finally, before `return { codexBody, codexModel }`, add:

```ts
if (hasHostedWebSearch) {
  addCodexInclude(codexBody, OPENAI_WEB_SEARCH_SOURCES_INCLUDE)
}
```

- [ ] **Step 7: Run the request translation tests and verify they pass**

Run:

```bash
bun test src/services/api/codex-fetch-adapter.test.ts --test-name-pattern "web search"
```

Expected: PASS for the two new request-body tests.

- [ ] **Step 8: Run the existing tool translation test**

Run:

```bash
bun test src/services/api/codex-fetch-adapter.test.ts --test-name-pattern "strictness"
```

Expected: PASS. Existing function and custom tool translation must remain unchanged.

- [ ] **Step 9: Commit this task if commits are authorized for the execution session**

Run only after the user has authorized commits for the implementation session:

```bash
git add src/services/api/codex-fetch-adapter.ts src/services/api/codex-fetch-adapter.test.ts
git commit -m "feat: translate codex web search tool"
```

---

### Task 2: Normalize OpenAI Web Search Stream Items

**Files:**
- Modify: `src/services/api/codex-fetch-adapter.ts:895-1608`
- Test: `src/services/api/codex-fetch-adapter.test.ts`

- [ ] **Step 1: Write the failing stream translation test**

Add this test near the existing `translateCodexStreamToAnthropic normalizes custom Apply_patch tool calls` test in `src/services/api/codex-fetch-adapter.test.ts`:

```ts
test('translateCodexStreamToAnthropic converts OpenAI web_search_call into Anthropic server tool blocks', async () => {
  const codexResponse = new Response(
    [
      'event: response.output_item.done',
      `data: ${JSON.stringify({
        type: 'response.output_item.done',
        item: {
          id: 'ws_123',
          type: 'web_search_call',
          status: 'completed',
          action: {
            type: 'search',
            query: 'OpenAI Responses web_search',
            sources: [
              {
                type: 'url',
                title: 'Web search - OpenAI API',
                url: 'https://platform.openai.com/docs/guides/tools-web-search',
              },
            ],
          },
        },
      })}`,
      '',
      'event: response.output_text.delta',
      `data: ${JSON.stringify({
        type: 'response.output_text.delta',
        delta: 'OpenAI supports hosted web search.',
      })}`,
      '',
      'event: response.output_item.done',
      `data: ${JSON.stringify({
        type: 'response.output_item.done',
        item: {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'OpenAI supports hosted web search.',
              annotations: [
                {
                  type: 'url_citation',
                  start_index: 17,
                  end_index: 35,
                  title: 'Web search - OpenAI API',
                  url: 'https://platform.openai.com/docs/guides/tools-web-search',
                },
              ],
            },
          ],
          status: 'completed',
        },
      })}`,
      '',
      'event: response.completed',
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            input_tokens_details: { cached_tokens: 0 },
          },
        },
      })}`,
      '',
    ].join('\n'),
    {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    },
  )

  const anthropicResponse = await translateCodexStreamToAnthropic(
    codexResponse,
    'gpt-5.4',
  )
  const body = await anthropicResponse.text()

  expect(body).toContain('"type":"server_tool_use"')
  expect(body).toContain('"id":"ws_123"')
  expect(body).toContain('"name":"web_search"')
  expect(body).toContain('"type":"input_json_delta"')
  expect(body).toContain('OpenAI Responses web_search')
  expect(body).toContain('"type":"web_search_tool_result"')
  expect(body).toContain('Web search - OpenAI API')
  expect(body).toContain('https://platform.openai.com/docs/guides/tools-web-search')
  expect(body).toContain('OpenAI supports hosted web search.')
  expect(body).toContain('"stop_reason":"end_turn"')
})
```

- [ ] **Step 2: Run the stream translation test and verify it fails**

Run:

```bash
bun test src/services/api/codex-fetch-adapter.test.ts --test-name-pattern "web_search_call"
```

Expected: FAIL because `processCodexEvents()` currently ignores `web_search_call` output items.

- [ ] **Step 3: Add OpenAI web-search normalization helpers**

In `src/services/api/codex-fetch-adapter.ts`, add these helpers near `emitTextBlock()`:

```ts
function readWebSearchAction(
  item: Record<string, unknown>,
): {
  query: string
  input: Record<string, unknown>
  sources: Array<{ title: string; url: string }>
} {
  const action = item.action as Record<string, unknown> | undefined
  const actionType = typeof action?.type === 'string' ? action.type : 'other'
  const query =
    typeof action?.query === 'string'
      ? action.query
      : Array.isArray(action?.queries)
        ? action.queries.filter((q): q is string => typeof q === 'string').join('; ')
        : typeof action?.url === 'string'
          ? action.url
          : ''

  const sources = Array.isArray(action?.sources)
    ? action.sources.flatMap(source => {
        if (typeof source !== 'object' || source === null) return []
        const record = source as Record<string, unknown>
        const url = typeof record.url === 'string' ? record.url : ''
        if (!url) return []
        const title = typeof record.title === 'string' && record.title.length > 0
          ? record.title
          : url
        return [{ title, url }]
      })
    : []

  const input: Record<string, unknown> = { type: actionType }
  if (query) input.query = query
  if (Array.isArray(action?.queries)) input.queries = action.queries
  if (typeof action?.url === 'string') input.url = action.url
  if (typeof action?.pattern === 'string') input.pattern = action.pattern

  return { query, input, sources }
}

function emitOpenAIWebSearchCall(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  index: number,
  item: Record<string, unknown>,
): number {
  const id = typeof item.id === 'string' && item.id.length > 0
    ? item.id
    : `ws_${Date.now()}`
  const { input, sources } = readWebSearchAction(item)

  controller.enqueue(
    encoder.encode(
      formatSSE('content_block_start', JSON.stringify({
        type: 'content_block_start',
        index,
        content_block: {
          type: 'server_tool_use',
          id,
          name: 'web_search',
          input: {},
        },
      })),
    ),
  )
  controller.enqueue(
    encoder.encode(
      formatSSE('content_block_delta', JSON.stringify({
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(input),
        },
      })),
    ),
  )
  controller.enqueue(
    encoder.encode(
      formatSSE('content_block_stop', JSON.stringify({
        type: 'content_block_stop',
        index,
      })),
    ),
  )

  const resultIndex = index + 1
  controller.enqueue(
    encoder.encode(
      formatSSE('content_block_start', JSON.stringify({
        type: 'content_block_start',
        index: resultIndex,
        content_block: {
          type: 'web_search_tool_result',
          tool_use_id: id,
          content: sources,
        },
      })),
    ),
  )
  controller.enqueue(
    encoder.encode(
      formatSSE('content_block_stop', JSON.stringify({
        type: 'content_block_stop',
        index: resultIndex,
      })),
    ),
  )

  return resultIndex + 1
}
```

- [ ] **Step 4: Call the helper from `processCodexEvents()`**

In the `response.output_item.done` branch around `src/services/api/codex-fetch-adapter.ts:1386`, add an `else if` before the `message` branch:

```ts
} else if (item?.type === 'web_search_call') {
  closeAllOpenReasoningBlocks()
  if (currentTextBlockStarted) {
    noteVisibleOutput()
    controller.enqueue(
      encoder.encode(
        formatSSE('content_block_stop', JSON.stringify({
          type: 'content_block_stop',
          index: contentBlockIndex,
        })),
      ),
    )
    contentBlockIndex++
    currentTextBlockStarted = false
  }

  noteVisibleOutput()
  contentBlockIndex = emitOpenAIWebSearchCall(
    controller,
    encoder,
    contentBlockIndex,
    item,
  )
```

Do not set `hadToolCalls = true` for `web_search_call`. OpenAI hosted web search is server-side, so downstream Anthropic-compatible stop reason should remain `end_turn` unless there are real client function/custom tool calls.

- [ ] **Step 5: Add no-op handling for lifecycle events so diagnostics stay intentional**

In `processCodexEvents()`, before the final unhandled path, add a branch for these event types:

```ts
else if (
  eventType === 'response.web_search_call.in_progress' ||
  eventType === 'response.web_search_call.searching' ||
  eventType === 'response.web_search_call.completed'
) {
  // Lifecycle events are visible in raw_event_types diagnostics. The finalized
  // response.output_item.done item carries the action and sources we need for
  // Anthropic-compatible content blocks.
}
```

- [ ] **Step 6: Run the stream translation test and verify it passes**

Run:

```bash
bun test src/services/api/codex-fetch-adapter.test.ts --test-name-pattern "web_search_call"
```

Expected: PASS.

- [ ] **Step 7: Run the broader adapter test file**

Run:

```bash
bun test src/services/api/codex-fetch-adapter.test.ts
```

Expected: PASS for all tests in `codex-fetch-adapter.test.ts`.

- [ ] **Step 8: Commit this task if commits are authorized for the execution session**

Run only after the user has authorized commits for the implementation session:

```bash
git add src/services/api/codex-fetch-adapter.ts src/services/api/codex-fetch-adapter.test.ts
git commit -m "feat: normalize codex web search results"
```

---

### Task 3: Enable WebSearch for OpenAI/Codex Safely

**Files:**
- Modify: `src/tools/WebSearchTool/WebSearchTool.ts:25-36`
- Modify: `src/tools/WebSearchTool/WebSearchTool.ts:168-193`
- Modify: `src/tools/WebSearchTool/WebSearchTool.ts:235-253`
- Create: `src/tools/WebSearchTool/WebSearchTool.test.ts`

- [ ] **Step 1: Write the failing OpenAI validation test**

Create `src/tools/WebSearchTool/WebSearchTool.test.ts` with this content:

```ts
import { beforeEach, describe, expect, mock, test } from 'bun:test'

beforeEach(() => {
  mock.restore()
})

describe('WebSearchTool OpenAI support', () => {
  test('rejects blocked_domains on OpenAI because OpenAI hosted web_search only supports allowed_domains', async () => {
    await mock.module('src/utils/model/providers.js', () => ({
      getAPIProvider: () => 'openai',
      resolveRequestProvider: () => 'openai',
    }))
    await mock.module('src/utils/model/model.js', () => ({
      getMainLoopModel: () => 'gpt-5.4',
      getSmallFastModel: () => 'gpt-5.4-mini',
    }))

    const { WebSearchTool } = await import('./WebSearchTool.js')

    const result = await WebSearchTool.validateInput?.({
      query: 'OpenAI web search',
      blocked_domains: ['example.com'],
    })

    expect(result).toEqual({
      result: false,
      message:
        'Error: blocked_domains is not supported for OpenAI/Codex web search; use allowed_domains instead',
      errorCode: 3,
    })
  })

  test('enables WebSearch on OpenAI provider', async () => {
    await mock.module('src/utils/model/providers.js', () => ({
      getAPIProvider: () => 'openai',
      resolveRequestProvider: () => 'openai',
    }))
    await mock.module('src/utils/model/model.js', () => ({
      getMainLoopModel: () => 'gpt-5.4',
      getSmallFastModel: () => 'gpt-5.4-mini',
    }))

    const { WebSearchTool } = await import('./WebSearchTool.js')

    expect(WebSearchTool.isEnabled?.()).toBe(true)
  })
})
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```bash
bun test src/tools/WebSearchTool/WebSearchTool.test.ts
```

Expected: FAIL because `WebSearchTool.isEnabled()` currently returns `false` for OpenAI and `validateInput()` does not reject OpenAI `blocked_domains`.

- [ ] **Step 3: Update the schema description for blocked domains**

In `src/tools/WebSearchTool/WebSearchTool.ts`, change the `blocked_domains` description around `src/tools/WebSearchTool/WebSearchTool.ts:32`:

```ts
blocked_domains: z
  .array(z.string())
  .optional()
  .describe('Never include search results from these domains. Not supported on OpenAI/Codex.'),
```

- [ ] **Step 4: Enable the tool for OpenAI provider**

In `WebSearchTool.isEnabled()`, add the OpenAI branch after the `firstParty` branch:

```ts
// OpenAI/Codex uses the Responses API hosted web_search tool through the
// Codex adapter. The Cat Code WebSearch tool remains the user-facing wrapper.
if (provider === 'openai') {
  return true
}
```

Keep the existing Vertex and Foundry branches unchanged.

- [ ] **Step 5: Reject OpenAI blocked-domain requests before calling the adapter**

In `validateInput(input)`, after the existing allowed-plus-blocked validation, add:

```ts
if (getAPIProvider() === 'openai' && blocked_domains?.length) {
  return {
    result: false,
    message:
      'Error: blocked_domains is not supported for OpenAI/Codex web search; use allowed_domains instead',
    errorCode: 3,
  }
}
```

- [ ] **Step 6: Run the new WebSearchTool tests and verify they pass**

Run:

```bash
bun test src/tools/WebSearchTool/WebSearchTool.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run the existing AgentTool tests that depend on tool availability**

Run:

```bash
bun test src/tools/AgentTool/AgentTool.test.ts
```

Expected: PASS. If tool-list snapshots fail because OpenAI now includes `WebSearch`, update only the expected tool list assertions directly related to provider-specific availability.

- [ ] **Step 8: Commit this task if commits are authorized for the execution session**

Run only after the user has authorized commits for the implementation session:

```bash
git add src/tools/WebSearchTool/WebSearchTool.ts src/tools/WebSearchTool/WebSearchTool.test.ts src/tools/AgentTool/AgentTool.test.ts
git commit -m "feat: enable web search for codex"
```

---

### Task 4: Verify WebSocket Request and Continuation Behavior

**Files:**
- Modify: `src/services/api/codex-websocket-transport.test.ts`
- Modify only if the test fails for a real normalization gap: `src/services/api/codex-websocket-transport.ts:620-659`

- [ ] **Step 1: Write a WebSocket preservation test**

Add this test after `second turn normalizes prior function-call output items before continuation matching` in `src/services/api/codex-websocket-transport.test.ts`:

```ts
test('second turn preserves prior web_search_call output items for continuation matching', async () => {
  installFakeWs()
  await ensureWebSocketSession(CONV_ID, AUTH)

  const turn1Input = [{ role: 'user', content: 'search the web' }]
  fakeWs.responses = [
    {
      type: 'response.output_item.done',
      item: {
        id: 'ws_123',
        type: 'web_search_call',
        status: 'completed',
        action: {
          type: 'search',
          query: 'OpenAI web_search',
          sources: [
            {
              type: 'url',
              title: 'OpenAI docs',
              url: 'https://platform.openai.com/docs/guides/tools-web-search',
            },
          ],
        },
      },
    },
    completedEvent('resp_001'),
  ]
  await collectEvents(streamTurnViaWebSocket(
    CONV_ID,
    { instructions: 'sys', input: turn1Input, reasoning: { effort: 'high' } },
    AUTH,
    1,
  ))

  const priorWebSearchCall = {
    id: 'ws_123',
    type: 'web_search_call',
    status: 'completed',
    action: {
      type: 'search',
      query: 'OpenAI web_search',
      sources: [
        {
          type: 'url',
          title: 'OpenAI docs',
          url: 'https://platform.openai.com/docs/guides/tools-web-search',
        },
      ],
    },
  }
  const turn2Input = [
    { role: 'user', content: 'search the web' },
    priorWebSearchCall,
    { role: 'user', content: 'next' },
  ]
  fakeWs.responses = [completedEvent('resp_002')]
  await collectEvents(streamTurnViaWebSocket(
    CONV_ID,
    { instructions: 'sys', input: turn2Input, reasoning: { effort: 'high' } },
    AUTH,
    3,
  ))

  const sent = fakeWs.getSent()
  expect(sent).toHaveLength(2)
  expect(sent[1]!.previous_response_id).toBe('resp_001')
  expect(sent[1]!.input).toEqual([{ role: 'user', content: 'next' }])
})
```

- [ ] **Step 2: Run the WebSocket preservation test**

Run:

```bash
bun test src/services/api/codex-websocket-transport.test.ts --test-name-pattern "web_search_call"
```

Expected: PASS with the current `normalizeCompletedOutputItem()` fallback. If it fails, continue to Step 3. If it passes, skip Step 3.

- [ ] **Step 3: Add explicit web_search_call normalization only if needed**

If Step 2 fails because field ordering or extra provider fields make continuation matching unstable, add this branch to `normalizeCompletedOutputItem()` before the final `return cloneJsonValue(item)`:

```ts
if (item.type === 'web_search_call') {
  return {
    ...(typeof item.id === 'string' ? { id: item.id } : {}),
    type: 'web_search_call',
    ...(typeof item.status === 'string' ? { status: item.status } : {}),
    ...(item.action && typeof item.action === 'object'
      ? { action: cloneJsonValue(item.action) }
      : {}),
  }
}
```

Then rerun:

```bash
bun test src/services/api/codex-websocket-transport.test.ts --test-name-pattern "web_search_call"
```

Expected: PASS.

- [ ] **Step 4: Run the full WebSocket transport test file**

Run:

```bash
bun test src/services/api/codex-websocket-transport.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit this task if commits are authorized for the execution session**

Run only after the user has authorized commits for the implementation session:

```bash
git add src/services/api/codex-websocket-transport.ts src/services/api/codex-websocket-transport.test.ts
git commit -m "test: cover codex web search continuation"
```

If Step 3 was skipped and only the test file changed, stage only `src/services/api/codex-websocket-transport.test.ts`.

---

### Task 5: End-to-End Adapter Test for WebSearchTool Nested Call Path

**Files:**
- Modify: `src/services/api/codex-fetch-adapter.test.ts`
- Modify only if test exposes a bug: `src/services/api/codex-fetch-adapter.ts`

- [ ] **Step 1: Write an HTTP-path integration test for a nested WebSearch request**

Add this test near the other `createCodexFetch` tests in `src/services/api/codex-fetch-adapter.test.ts`:

```ts
test('createCodexFetch sends hosted web_search and returns normalized web search stream blocks on HTTP path', async () => {
  const accessToken = createAccessToken('acct_test_web_search')
  const originalFetch = globalThis.fetch
  const fetchCalls: Array<{ input: RequestInfo | URL, init?: RequestInit }> = []

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ input, init })

    return new Response(
      [
        'event: response.output_item.done',
        `data: ${JSON.stringify({
          type: 'response.output_item.done',
          item: {
            id: 'ws_456',
            type: 'web_search_call',
            status: 'completed',
            action: {
              type: 'search',
              query: 'OpenAI native web search',
              sources: [
                {
                  type: 'url',
                  title: 'OpenAI web search docs',
                  url: 'https://platform.openai.com/docs/guides/tools-web-search',
                },
              ],
            },
          },
        })}`,
        '',
        'event: response.completed',
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            usage: {
              input_tokens: 10,
              output_tokens: 4,
              input_tokens_details: { cached_tokens: 0 },
            },
          },
        })}`,
        '',
      ].join('\n'),
      {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      },
    )
  }) as unknown as typeof globalThis.fetch

  try {
    _markStickyHttpFallbackForTest('conv_web_search_http', 'test')
    const response = await createCodexFetch(accessToken, 'conv_web_search_http')(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          tools: [
            {
              type: 'web_search_20250305',
              name: 'web_search',
              allowed_domains: ['platform.openai.com'],
              max_uses: 8,
            },
          ],
          _openaiInstructionAssembly: {
            instructions: 'Perform a web search.',
            inputMessages: [{ role: 'user', content: 'search docs' }],
          },
        }),
      },
    )

    const requestBody = JSON.parse(String(fetchCalls[0]?.init?.body))
    expect(requestBody.tools).toEqual([
      {
        type: 'web_search',
        external_web_access: true,
        search_context_size: 'medium',
        filters: { allowed_domains: ['platform.openai.com'] },
      },
    ])
    expect(requestBody.include).toEqual(['web_search_call.action.sources'])

    const body = await response.text()
    expect(body).toContain('"type":"server_tool_use"')
    expect(body).toContain('"type":"web_search_tool_result"')
    expect(body).toContain('OpenAI web search docs')
    expect(body).toContain('https://platform.openai.com/docs/guides/tools-web-search')
  } finally {
    globalThis.fetch = originalFetch
    resetCodexCacheContext()
  }
})
```

- [ ] **Step 2: Run the integration test**

Run:

```bash
bun test src/services/api/codex-fetch-adapter.test.ts --test-name-pattern "hosted web_search"
```

Expected: PASS after Tasks 1 and 2.

- [ ] **Step 3: Fix any discovered request/stream mismatch**

If the test fails, inspect the exact assertion failure and adjust only the failing translation path:

```bash
bun test src/services/api/codex-fetch-adapter.test.ts --test-name-pattern "hosted web_search"
```

Expected after the focused fix: PASS.

- [ ] **Step 4: Commit this task if commits are authorized for the execution session**

Run only after the user has authorized commits for the implementation session:

```bash
git add src/services/api/codex-fetch-adapter.ts src/services/api/codex-fetch-adapter.test.ts
git commit -m "test: cover codex hosted web search path"
```

---

### Task 6: Full Verification and Stale Reference Search

**Files:**
- No planned source changes.
- Possible test expectation updates only if earlier tasks identify provider-specific tool list snapshots.

- [ ] **Step 1: Run focused tests**

Run:

```bash
bun test src/services/api/codex-fetch-adapter.test.ts src/services/api/codex-websocket-transport.test.ts src/tools/WebSearchTool/WebSearchTool.test.ts src/tools/AgentTool/AgentTool.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the development build required by this repo**

Run:

```bash
bun run build:dev:full
```

Expected: PASS. Use this command, not `bun run build` and not `./cli`, unless the user explicitly asks otherwise.

- [ ] **Step 3: Search for stale assumptions about OpenAI web search being unavailable**

Run:

```bash
rg -n "OpenAI.*web search|Codex.*web search|WebSearch.*openai|web_search_20250305|web_search_call|blocked_domains|allowed_domains" src docs README.md CLAUDE.md AGENTS.md
```

Expected: Review all matches. Update only references that became stale because this implementation made OpenAI/Codex `WebSearch` available.

- [ ] **Step 4: Search for accidental blocked-domain support claims**

Run:

```bash
rg -n "blocked_domains|blocked domains|block.*domain" src/tools/WebSearchTool src/services/api docs README.md CLAUDE.md AGENTS.md
```

Expected: OpenAI/Codex-facing docs or prompts must not claim verified `blocked_domains` support. Anthropic-specific references may remain.

- [ ] **Step 5: Check git diff for unrelated changes**

Run:

```bash
git diff -- src/services/api/codex-fetch-adapter.ts src/services/api/codex-fetch-adapter.test.ts src/services/api/codex-websocket-transport.ts src/services/api/codex-websocket-transport.test.ts src/tools/WebSearchTool/WebSearchTool.ts src/tools/WebSearchTool/WebSearchTool.test.ts src/tools/AgentTool/AgentTool.test.ts
```

Expected: Every changed line should trace directly to OpenAI/Codex native web search support or its tests.

- [ ] **Step 6: Commit final verification changes if commits are authorized for the execution session**

Run only after the user has authorized commits for the implementation session and only if there are additional verification-driven edits:

```bash
git add src/services/api/codex-fetch-adapter.ts src/services/api/codex-fetch-adapter.test.ts src/services/api/codex-websocket-transport.ts src/services/api/codex-websocket-transport.test.ts src/tools/WebSearchTool/WebSearchTool.ts src/tools/WebSearchTool/WebSearchTool.test.ts src/tools/AgentTool/AgentTool.test.ts
git commit -m "test: verify codex web search support"
```

---

## Manual Smoke Test

After automated verification passes, run a local dev build and start Cat Code in an OpenAI/Codex profile. Ask:

```text
Search the web for the current OpenAI Responses API web_search docs and summarize the request shape with sources.
```

Expected behavior:

- The model can choose the Cat Code `WebSearch` tool.
- Permission flow uses the normal `WebSearch` tool permission behavior.
- The nested Codex request sends `tools: [{ type: 'web_search', external_web_access: true, ... }]`.
- The UI shows `Searching: ...` or a completed `Did N searches ...` WebSearch result.
- The final answer includes sources.

If the Codex backend rejects `web_search` for the selected account or model, report the raw HTTP status and provider error. Do not silently fall back to `WebFetch`, because fetching a known URL is not true internet search.

---

## Self-Review

**Spec coverage:**
- Native OpenAI request shape is covered by Task 1.
- OpenAI stream and result shape are covered by Task 2.
- Agent/user-facing availability is covered by Task 3.
- WebSocket continuation is covered by Task 4.
- End-to-end Codex adapter behavior is covered by Task 5.
- Verification and stale reference search are covered by Task 6.

**Placeholder scan:**
- The plan contains no `TBD`, no unconstrained "add appropriate handling", and no code step that says to write tests without including test code.

**Type consistency:**
- `OPENAI_WEB_SEARCH_SOURCES_INCLUDE`, `isAnthropicHostedWebSearchTool`, `translateHostedWebSearchTool`, `addCodexInclude`, `readWebSearchAction`, and `emitOpenAIWebSearchCall` are defined before use.
- Test payloads use OpenAI `web_search_call`, `action.sources`, and `url_citation` shapes consistently.
- The normalized Anthropic stream blocks use the existing `server_tool_use`, `input_json_delta`, and `web_search_tool_result` shapes that `WebSearchTool.call()` already consumes.
