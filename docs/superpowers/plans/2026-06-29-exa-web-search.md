# Exa-Powered WebSearch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Cat Code's provider-hosted `WebSearch` implementation with a small, provider-neutral Exa Search API-backed built-in tool for coding-agent research.

**Architecture:** Keep the existing public built-in tool name `WebSearch` because it is already registered, read-only, concurrency-safe, deferred through ToolSearch, allowed for async agents, and categorized in the read-only tool selector. Add a small co-located Exa helper under `src/tools/WebSearchTool/`, call Exa Search directly with `globalThis.fetch`, and keep the public tool contract provider-neutral by exposing search intent fields rather than Exa diagnostics or backend mode names.

**Tech Stack:** TypeScript, Bun tests, Zod, `globalThis.fetch`, Exa Search API `POST https://api.exa.ai/search` with `x-api-key`.

---

## Implementation Rules

- Do not implement the separate Exa `/contents` endpoint in this plan.
- Exa Search API's `contents` request field may be used for bounded highlights only; do not request full page `text` or summaries in v1.
- Do not add `exa-js` or any new dependency.
- Read `EXA_API_KEY` from `process.env.EXA_API_KEY` only.
- Do not add a new settings field for Exa.
- Do not add `EXA_API_KEY` to `SAFE_ENV_VARS` in `src/utils/managedEnvConstants.ts`.
- Do add `EXA_API_KEY` to the GitHub Actions subprocess secret scrub list in `src/utils/subprocessEnv.ts` so Bash, hooks, MCP stdio, LSP, and other child processes do not inherit it when subprocess scrubbing is enabled.
- Do not store the Exa API key in transcripts, logs, test snapshots, tool output, or debug text.
- Keep the public tool name `WebSearch`.
- Preserve `shouldDefer: true`, `isReadOnly() => true`, `isConcurrencySafe() => true`, tool-level permission behavior, Agent exposure, and transcript-search behavior.
- Keep WebSearch out of the auto-mode safe allowlist.
- Do not commit unless the user explicitly asks for commits. Commit commands in this plan are optional checkpoints only when that explicit authorization exists.

## Source Findings To Preserve

- `src/tools/WebSearchTool/WebSearchTool.ts` already defines `WebSearchTool` with `shouldDefer: true`, read-only behavior, concurrency-safe behavior, permission suggestions, and `extractSearchText() { return '' }`.
- `src/tools.ts` already imports and registers `WebSearchTool` in `getAllBaseTools()`.
- `src/constants/tools.ts` already includes `WEB_SEARCH_TOOL_NAME` in async-agent allowed tools.
- `src/components/agents/ToolSelector.tsx` already buckets `WebSearchTool.name` as read-only.
- `src/tools/ToolSearchTool/prompt.ts` defers tools with `shouldDefer === true` unless `alwaysLoad === true`.
- `src/services/tools/toolExecution.ts` already performs Zod input parsing, pre-tool hooks, permission checks, execution, post hooks, and user-safe tool errors.
- `src/services/tools/toolExecution.ts` suppresses logging/telemetry for Cat Code's own `AbortError`; `searchExa()` must throw that class for user cancellation instead of converting cancellation into a normal error.
- `src/services/tools/toolOrchestration.ts` already batches tools based on `isConcurrencySafe()`.
- `src/utils/privacyLevel.ts` exposes `isEssentialTrafficOnly()` for suppressing nonessential external traffic. Gating `WebSearch.isEnabled()` on it is intentionally stricter than `WebFetchTool` because web search is optional external research traffic.
- `src/utils/subprocessEnv.ts` strips known secrets from subprocess environments when `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is enabled; `EXA_API_KEY` belongs in that list.
- `src/utils/permissions/classifierDecision.ts` does not auto-allowlist `WebSearch`; keep it that way.
- The repo has `undici` installed, but existing API-client style uses `globalThis.fetch`; use raw fetch rather than adding the Exa SDK.

## File Structure

### Create

- `src/tools/WebSearchTool/exa.ts`
  - Owns Exa request construction, response parsing, timeout/cancellation handling, and stable secret-safe error messages.
  - Exports `_forTest` helpers for request mapping, response parsing, and timeout-specific execution tests.

- `src/utils/subprocessEnv.test.ts`
  - Covers `EXA_API_KEY` scrubbing from subprocess environments when the GitHub Actions scrub gate is enabled.

### Modify

- `src/tools/WebSearchTool/WebSearchTool.ts`
  - Replace hosted model web search with `searchExa()`.
  - Replace old hosted-search input fields with provider-neutral public fields.
  - Keep existing public tool name, permission path, deferred loading, read-only behavior, concurrency behavior, and transcript-search behavior.

- `src/tools/WebSearchTool/prompt.ts`
  - Update model-visible tool guidance for Exa-backed compact search.
  - Remove stale provider-hosted wording, US-only wording, and backend-provider assumptions.

- `src/tools/WebSearchTool/UI.tsx`
  - Render the new input fields and a result-count summary.

- `src/tools/WebSearchTool/WebSearchTool.test.ts`
  - Replace OpenAI-hosted-search tests with Exa mapping, parsing, error, cancellation, validation, lifecycle-preservation, and no-secret-leak tests.

- `src/utils/subprocessEnv.ts`
  - Add `EXA_API_KEY` to `GHA_SUBPROCESS_SCRUB`.

- `README.md`
  - Add a short operator note for configuring `EXA_API_KEY`, including that WebSearch is disabled under essential-traffic-only mode and that subprocess scrubbing protects the key in GitHub Actions scrub mode.

### Usually Do Not Modify

- `src/tools.ts`
  - No change because the tool name remains `WebSearch`.

- `src/constants/tools.ts`
  - No change because the tool name remains `WebSearch` and async-agent exposure is already name-based.

- `src/components/agents/ToolSelector.tsx`
  - No change because `WebSearchTool.name` remains in the read-only bucket.

- `src/services/api/codex-fetch-adapter.ts`
  - Do not remove hosted `web_search_20250305` translation. It is generic provider adapter behavior and may remain dormant after `WebSearchTool` stops emitting hosted `extraToolSchemas`.

- `package.json`
  - No change.

## Public Tool Contract

Input schema:

```ts
{
  query: string
  max_results?: number
  include_domains?: string[]
  exclude_domains?: string[]
  freshness?: 'day' | 'week' | 'month' | 'year' | 'any'
}
```

Defaults and bounds:

- `query`: trimmed non-empty string.
- `max_results`: default `5`, public Zod bound `1..10`, and internal clamp retained as defense in depth.
- `include_domains` / `exclude_domains`: optional, each bounded to 20 non-empty strings.
- `freshness`: default `any`, mapped to Exa `startPublishedDate` when set.
- Backend mode: hardcode Exa Search `type: 'auto'`; do not expose Exa mode names in the public tool schema.
- Highlights: always request bounded highlights through Exa Search `contents.highlights.maxCharacters`.

Output shape:

```ts
{
  query: string
  results: Array<{
    title: string
    url: string
    publishedDate?: string
    author?: string
    highlights?: string[]
  }>
  durationSeconds: number
}
```

Do not expose Exa `requestId`, `costDollars`, raw response bodies, API keys, or full page text in the output object. `toolExecution.ts` persists `toolUseResult`, so the output object must remain provider-neutral and compact.

---

### Task 1: Write Failing Tests For Exa Request Mapping

**Files:**
- Modify: `src/tools/WebSearchTool/WebSearchTool.test.ts`
- Later create: `src/tools/WebSearchTool/exa.ts`

- [ ] **Step 1: Replace hosted OpenAI tests with Exa mapping tests**

Delete the existing `applyOpenAIMocks()` helper and the `describe('WebSearchTool OpenAI support', ...)` block. Replace `src/tools/WebSearchTool/WebSearchTool.test.ts` with this starting test file:

```ts
import { afterEach, describe, expect, test } from 'bun:test'

describe('Exa WebSearch request mapping', () => {
  afterEach(() => {
    delete process.env.EXA_API_KEY
  })

  test('maps default input to a compact Exa Search request', async () => {
    const { _forTest } = await import('./exa.js')

    expect(
      _forTest.buildExaSearchRequest(
        { query: 'bun fetch timeout docs' },
        new Date('2026-06-29T12:00:00.000Z'),
      ),
    ).toEqual({
      query: 'bun fetch timeout docs',
      numResults: 5,
      type: 'auto',
      contents: { highlights: { maxCharacters: 500 } },
    })
  })

  test('trims query text before sending to Exa', async () => {
    const { _forTest } = await import('./exa.js')

    expect(
      _forTest.buildExaSearchRequest({ query: '  React 19 docs  ' }).query,
    ).toBe('React 19 docs')
  })

  test('defensively clamps max_results to the Cat Code v1 limit', async () => {
    const { _forTest } = await import('./exa.js')

    expect(
      _forTest.buildExaSearchRequest({ query: 'low', max_results: 0 })
        .numResults,
    ).toBe(1)
    expect(
      _forTest.buildExaSearchRequest({ query: 'high', max_results: 100 })
        .numResults,
    ).toBe(10)
  })

  test('maps include and exclude domains to Exa field names', async () => {
    const { _forTest } = await import('./exa.js')

    expect(
      _forTest.buildExaSearchRequest({
        query: 'react use docs',
        include_domains: ['react.dev'],
        exclude_domains: ['w3schools.com'],
      }),
    ).toMatchObject({
      includeDomains: ['react.dev'],
      excludeDomains: ['w3schools.com'],
    })
  })

  test('maps freshness to startPublishedDate', async () => {
    const { _forTest } = await import('./exa.js')

    expect(
      _forTest.buildExaSearchRequest(
        { query: 'node release notes', freshness: 'week' },
        new Date('2026-06-29T12:00:00.000Z'),
      ).startPublishedDate,
    ).toBe('2026-06-22T12:00:00.000Z')
  })
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
cd /Users/pt/cat-code && bun test src/tools/WebSearchTool/WebSearchTool.test.ts
```

Expected: FAIL because `src/tools/WebSearchTool/exa.ts` does not exist yet.

- [ ] **Step 3: Optional commit checkpoint if explicitly authorized**

Only if the user has explicitly asked for commits, run:

```bash
cd /Users/pt/cat-code && git add src/tools/WebSearchTool/WebSearchTool.test.ts && git commit -m "$(cat <<'EOF'
test: cover Exa web search request mapping
EOF
)"
```

---

### Task 2: Add The Exa Helper With Request Mapping

**Files:**
- Create: `src/tools/WebSearchTool/exa.ts`
- Test: `src/tools/WebSearchTool/WebSearchTool.test.ts`

- [ ] **Step 1: Create the Exa helper types and mapping logic**

Create `src/tools/WebSearchTool/exa.ts` with this initial implementation:

```ts
export type WebSearchFreshness = 'day' | 'week' | 'month' | 'year' | 'any'

export type WebSearchInput = {
  query: string
  max_results?: number
  include_domains?: string[]
  exclude_domains?: string[]
  freshness?: WebSearchFreshness
}

export type WebSearchResult = {
  title: string
  url: string
  publishedDate?: string
  author?: string
  highlights?: string[]
}

export type WebSearchOutput = {
  query: string
  results: WebSearchResult[]
  durationSeconds: number
}

type ExaSearchRequest = {
  query: string
  numResults: number
  type: 'auto'
  contents: { highlights: { maxCharacters: number } }
  includeDomains?: string[]
  excludeDomains?: string[]
  startPublishedDate?: string
}

const DEFAULT_MAX_RESULTS = 5
const MAX_RESULTS = 10
const MAX_HIGHLIGHT_CHARACTERS = 500
const FRESHNESS_DAYS: Record<Exclude<WebSearchFreshness, 'any'>, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
}

function clampMaxResults(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_RESULTS
  return Math.max(1, Math.min(MAX_RESULTS, value))
}

function startPublishedDateForFreshness(
  freshness: WebSearchFreshness | undefined,
  now: Date,
): string | undefined {
  if (!freshness || freshness === 'any') return undefined
  const days = FRESHNESS_DAYS[freshness]
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  return start.toISOString()
}

function compactDomains(domains: string[] | undefined): string[] | undefined {
  if (!domains?.length) return undefined
  const compacted = domains.map(domain => domain.trim()).filter(Boolean)
  return compacted.length > 0 ? compacted : undefined
}

function withoutUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as T
}

function buildExaSearchRequest(
  input: WebSearchInput,
  now = new Date(),
): ExaSearchRequest {
  return withoutUndefined({
    query: input.query.trim(),
    numResults: clampMaxResults(input.max_results),
    type: 'auto',
    contents: { highlights: { maxCharacters: MAX_HIGHLIGHT_CHARACTERS } },
    includeDomains: compactDomains(input.include_domains),
    excludeDomains: compactDomains(input.exclude_domains),
    startPublishedDate: startPublishedDateForFreshness(input.freshness, now),
  })
}

export const _forTest = {
  buildExaSearchRequest,
}
```

- [ ] **Step 2: Run the focused test and verify mapping tests pass**

Run:

```bash
cd /Users/pt/cat-code && bun test src/tools/WebSearchTool/WebSearchTool.test.ts
```

Expected: PASS for request mapping tests.

- [ ] **Step 3: Optional commit checkpoint if explicitly authorized**

Only if the user has explicitly asked for commits, run:

```bash
cd /Users/pt/cat-code && git add src/tools/WebSearchTool/exa.ts src/tools/WebSearchTool/WebSearchTool.test.ts && git commit -m "$(cat <<'EOF'
feat: map WebSearch input to Exa Search requests
EOF
)"
```

---

### Task 3: Add Exa Response Parsing Tests

**Files:**
- Modify: `src/tools/WebSearchTool/WebSearchTool.test.ts`
- Modify: `src/tools/WebSearchTool/exa.ts`

- [ ] **Step 1: Add response parsing tests**

Append these tests to `src/tools/WebSearchTool/WebSearchTool.test.ts`:

```ts
describe('Exa WebSearch response parsing', () => {
  test('parses compact result fields and ignores Exa diagnostics and full text', async () => {
    const { _forTest } = await import('./exa.js')

    const parsed = _forTest.parseExaSearchResponse(
      {
        results: [
          {
            title: 'Exa Search API docs',
            url: 'https://docs.exa.ai/reference/search',
            publishedDate: '2026-01-01T00:00:00.000Z',
            author: 'Exa',
            highlights: [
              'POST /search accepts query and numResults.',
              'This second highlight is retained.',
              'This third highlight is retained.',
              'This fourth highlight is dropped by Cat Code.',
            ],
            text: 'Full page text should be ignored even if Exa returns it.',
            summary: 'Summary should be ignored in v1.',
            requestId: 'nested_ignored',
          },
        ],
        requestId: 'req_ignored',
        costDollars: { total: 0.001 },
      },
      'Exa docs',
      0.25,
      5,
    )

    expect(parsed).toEqual({
      query: 'Exa docs',
      durationSeconds: 0.25,
      results: [
        {
          title: 'Exa Search API docs',
          url: 'https://docs.exa.ai/reference/search',
          publishedDate: '2026-01-01T00:00:00.000Z',
          author: 'Exa',
          highlights: [
            'POST /search accepts query and numResults.',
            'This second highlight is retained.',
            'This third highlight is retained.',
          ],
        },
      ],
    })
  })

  test('drops non-http result URLs', async () => {
    const { _forTest } = await import('./exa.js')

    expect(
      _forTest.parseExaSearchResponse(
        {
          results: [
            { title: 'Bad', url: 'javascript:alert(1)' },
            { title: 'Good', url: 'https://example.com/docs' },
          ],
        },
        'safe urls',
        0.1,
        5,
      ).results,
    ).toEqual([{ title: 'Good', url: 'https://example.com/docs' }])
  })

  test('caps parsed results to the requested max', async () => {
    const { _forTest } = await import('./exa.js')

    expect(
      _forTest.parseExaSearchResponse(
        {
          results: [
            { title: 'One', url: 'https://example.com/1' },
            { title: 'Two', url: 'https://example.com/2' },
          ],
        },
        'cap',
        0.1,
        1,
      ).results,
    ).toEqual([{ title: 'One', url: 'https://example.com/1' }])
  })

  test('returns an empty results array for empty Exa results', async () => {
    const { _forTest } = await import('./exa.js')

    expect(
      _forTest.parseExaSearchResponse(
        { results: [], requestId: 'req_empty' },
        'unlikely query',
        0.1,
        5,
      ),
    ).toEqual({
      query: 'unlikely query',
      durationSeconds: 0.1,
      results: [],
    })
  })

  test('rejects malformed Exa responses', async () => {
    const { _forTest } = await import('./exa.js')

    expect(() =>
      _forTest.parseExaSearchResponse({ results: 'not-array' }, 'bad', 0.1, 5),
    ).toThrow('Exa search returned an unexpected response.')
  })
})
```

- [ ] **Step 2: Add stable status error tests**

Append these tests to the same file:

```ts
describe('Exa WebSearch error handling', () => {
  test('formats status errors without echoing response bodies', async () => {
    const { _forTest } = await import('./exa.js')

    expect(_forTest.formatExaStatusError(400)).toBe(
      'Exa rejected the search request with HTTP 400.',
    )
    expect(_forTest.formatExaStatusError(401)).toBe(
      'Exa authentication failed with HTTP 401. Check EXA_API_KEY.',
    )
    expect(_forTest.formatExaStatusError(402)).toBe(
      'Exa search is unavailable because Exa credits or budget are exhausted (HTTP 402).',
    )
    expect(_forTest.formatExaStatusError(403)).toBe(
      'Exa search access is forbidden with HTTP 403. Check the Exa account and API key permissions.',
    )
    expect(_forTest.formatExaStatusError(429)).toBe(
      'Exa rate limit exceeded with HTTP 429. Try again later or use fewer searches.',
    )
    expect(_forTest.formatExaStatusError(500)).toBe(
      'Exa search failed with HTTP 500.',
    )
  })
})
```

- [ ] **Step 3: Run the focused test and verify it fails**

Run:

```bash
cd /Users/pt/cat-code && bun test src/tools/WebSearchTool/WebSearchTool.test.ts
```

Expected: FAIL because response parsing and status error helpers are not implemented yet.

- [ ] **Step 4: Optional commit checkpoint if explicitly authorized**

Only if the user has explicitly asked for commits, run:

```bash
cd /Users/pt/cat-code && git add src/tools/WebSearchTool/WebSearchTool.test.ts && git commit -m "$(cat <<'EOF'
test: cover Exa web search parsing and errors
EOF
)"
```

---

### Task 4: Implement Response Parsing And Stable Error Formatting

**Files:**
- Modify: `src/tools/WebSearchTool/exa.ts`
- Test: `src/tools/WebSearchTool/WebSearchTool.test.ts`

- [ ] **Step 1: Extend `exa.ts` with parser constants and helpers**

Add these helpers to `src/tools/WebSearchTool/exa.ts` below `buildExaSearchRequest()`:

```ts
const MAX_HIGHLIGHTS_PER_RESULT = 3

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0,
  )
  const capped = strings.slice(0, MAX_HIGHLIGHTS_PER_RESULT)
  return capped.length > 0 ? capped : undefined
}

function parseHttpUrl(value: unknown): string | undefined {
  const raw = optionalString(value)
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

function parseExaSearchResponse(
  body: unknown,
  query: string,
  durationSeconds: number,
  resultLimit: number,
): WebSearchOutput {
  if (!body || typeof body !== 'object') {
    throw new Error('Exa search returned an unexpected response.')
  }

  const record = body as Record<string, unknown>
  if (!Array.isArray(record.results)) {
    throw new Error('Exa search returned an unexpected response.')
  }

  const results: WebSearchResult[] = record.results.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const result = item as Record<string, unknown>
    const title = optionalString(result.title)
    const url = parseHttpUrl(result.url)
    if (!title || !url) return []

    const publishedDate = optionalString(result.publishedDate)
    const author = optionalString(result.author)
    const highlights = optionalStringArray(result.highlights)

    return [
      {
        title,
        url,
        ...(publishedDate ? { publishedDate } : {}),
        ...(author ? { author } : {}),
        ...(highlights ? { highlights } : {}),
      },
    ]
  }).slice(0, clampMaxResults(resultLimit))

  return {
    query,
    results,
    durationSeconds,
  }
}

function formatExaStatusError(status: number): string {
  if (status === 400) {
    return 'Exa rejected the search request with HTTP 400.'
  }
  if (status === 401) {
    return 'Exa authentication failed with HTTP 401. Check EXA_API_KEY.'
  }
  if (status === 402) {
    return 'Exa search is unavailable because Exa credits or budget are exhausted (HTTP 402).'
  }
  if (status === 403) {
    return 'Exa search access is forbidden with HTTP 403. Check the Exa account and API key permissions.'
  }
  if (status === 429) {
    return 'Exa rate limit exceeded with HTTP 429. Try again later or use fewer searches.'
  }
  return `Exa search failed with HTTP ${status}.`
}
```

Update `_forTest`:

```ts
export const _forTest = {
  buildExaSearchRequest,
  formatExaStatusError,
  parseExaSearchResponse,
}
```

- [ ] **Step 2: Run the focused test and verify parsing/error tests pass**

Run:

```bash
cd /Users/pt/cat-code && bun test src/tools/WebSearchTool/WebSearchTool.test.ts
```

Expected: PASS for mapping, parsing, and error helper tests.

- [ ] **Step 3: Optional commit checkpoint if explicitly authorized**

Only if the user has explicitly asked for commits, run:

```bash
cd /Users/pt/cat-code && git add src/tools/WebSearchTool/exa.ts src/tools/WebSearchTool/WebSearchTool.test.ts && git commit -m "$(cat <<'EOF'
feat: parse Exa web search responses safely
EOF
)"
```

---

### Task 5: Add Exa Fetch Execution With Timeout And Cancellation

**Files:**
- Modify: `src/tools/WebSearchTool/exa.ts`
- Modify: `src/tools/WebSearchTool/WebSearchTool.test.ts`

- [ ] **Step 1: Add fetch, status, timeout, and cancellation tests**

Append these tests to `src/tools/WebSearchTool/WebSearchTool.test.ts`:

```ts
describe('Exa WebSearch fetch execution', () => {
  const originalFetch = globalThis.fetch
  const originalEnv = { ...process.env }

  afterEach(() => {
    globalThis.fetch = originalFetch
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, originalEnv)
  })

  test('requires EXA_API_KEY', async () => {
    const { searchExa } = await import('./exa.js')

    await expect(
      searchExa({ query: 'missing key' }, new AbortController().signal),
    ).rejects.toThrow(
      'EXA_API_KEY is not set. Set it in the shell environment before using WebSearch.',
    )
  })

  test('posts to Exa Search with x-api-key auth', async () => {
    process.env.EXA_API_KEY = 'test-exa-key'
    const requests: Array<{ url: string; init: RequestInit }> = []
    globalThis.fetch = (async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} })
      return new Response(
        JSON.stringify({
          results: [{ title: 'Docs', url: 'https://docs.example.com' }],
          requestId: 'req_ignored',
          costDollars: { total: 0.001 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof globalThis.fetch

    const { searchExa } = await import('./exa.js')
    const result = await searchExa(
      { query: 'docs', max_results: 3 },
      new AbortController().signal,
    )

    expect(result).toEqual({
      query: 'docs',
      durationSeconds: expect.any(Number),
      results: [{ title: 'Docs', url: 'https://docs.example.com' }],
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://api.exa.ai/search')
    const headers = requests[0]?.init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('test-exa-key')
    expect(headers.authorization).toBeUndefined()
    expect(JSON.parse(String(requests[0]?.init.body))).toMatchObject({
      query: 'docs',
      numResults: 3,
      type: 'auto',
    })
  })

  test('formats 402 without echoing response text', async () => {
    process.env.EXA_API_KEY = 'test-exa-key'
    globalThis.fetch = (async () =>
      new Response('secret account diagnostic', { status: 402 })) as typeof globalThis.fetch

    const { searchExa } = await import('./exa.js')

    await expect(
      searchExa({ query: 'credits' }, new AbortController().signal),
    ).rejects.toThrow(
      'Exa search is unavailable because Exa credits or budget are exhausted (HTTP 402).',
    )
  })

  test('turns malformed JSON into a safe response error', async () => {
    process.env.EXA_API_KEY = 'test-exa-key'
    globalThis.fetch = (async () =>
      new Response('{', { status: 200 })) as typeof globalThis.fetch

    const { searchExa } = await import('./exa.js')

    await expect(
      searchExa({ query: 'bad json' }, new AbortController().signal),
    ).rejects.toThrow('Exa search returned an unexpected response.')
  })

  test('preserves caller cancellation as Cat Code AbortError before fetch starts', async () => {
    const { AbortError } = await import('../../utils/errors.js')
    const { searchExa } = await import('./exa.js')
    process.env.EXA_API_KEY = 'test-exa-key'
    const controller = new AbortController()
    controller.abort()

    await expect(searchExa({ query: 'cancelled' }, controller.signal)).rejects.toBeInstanceOf(AbortError)
  })

  test('preserves caller cancellation as Cat Code AbortError while fetch is pending', async () => {
    const { AbortError } = await import('../../utils/errors.js')
    const { searchExa } = await import('./exa.js')
    process.env.EXA_API_KEY = 'test-exa-key'
    const controller = new AbortController()

    globalThis.fetch = (async (_url, init) => {
      controller.abort()
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal
        signal.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        })
      })
    }) as typeof globalThis.fetch

    await expect(searchExa({ query: 'cancelled' }, controller.signal)).rejects.toBeInstanceOf(AbortError)
  })

  test('classifies internal timeout separately from caller cancellation', async () => {
    const { _forTest } = await import('./exa.js')
    process.env.EXA_API_KEY = 'test-exa-key'
    globalThis.fetch = (async (_url, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal
        signal.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        })
      })
    }) as typeof globalThis.fetch

    await expect(
      _forTest.searchExaWithTimeoutMs(
        { query: 'timeout' },
        new AbortController().signal,
        1,
      ),
    ).rejects.toThrow('Exa search timed out after 20s.')
  })
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
cd /Users/pt/cat-code && bun test src/tools/WebSearchTool/WebSearchTool.test.ts
```

Expected: FAIL because `searchExa()` and timeout-specific test helper are not implemented yet.

- [ ] **Step 3: Implement `searchExa()` with cancellation preservation**

Add these imports and constants to `src/tools/WebSearchTool/exa.ts`:

```ts
import { AbortError, isAbortError } from '../../utils/errors.js'

const EXA_SEARCH_URL = 'https://api.exa.ai/search'
const EXA_SEARCH_TIMEOUT_MS = 20_000
```

Add the key helper:

```ts
function getExaApiKey(): string {
  const apiKey = process.env.EXA_API_KEY?.trim()
  if (!apiKey) {
    throw new Error(
      'EXA_API_KEY is not set. Set it in the shell environment before using WebSearch.',
    )
  }
  return apiKey
}
```

Add `searchExa()` and its testable timeout variant:

```ts
export async function searchExa(
  input: WebSearchInput,
  signal: AbortSignal,
): Promise<WebSearchOutput> {
  return searchExaWithTimeoutMs(input, signal, EXA_SEARCH_TIMEOUT_MS)
}

async function searchExaWithTimeoutMs(
  input: WebSearchInput,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<WebSearchOutput> {
  if (signal.aborted) {
    throw new AbortError('WebSearch was cancelled.')
  }

  const apiKey = getExaApiKey()
  const abortController = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    abortController.abort()
  }, timeoutMs)

  const onAbort = () => abortController.abort()
  signal.addEventListener('abort', onAbort, { once: true })

  const start = performance.now()
  try {
    const request = buildExaSearchRequest(input)
    const response = await globalThis.fetch(EXA_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(request),
      signal: abortController.signal,
    })

    const durationSeconds = (performance.now() - start) / 1000
    if (!response.ok) {
      await response.text().catch(() => '')
      throw new Error(formatExaStatusError(response.status))
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new Error('Exa search returned an unexpected response.')
    }

    return parseExaSearchResponse(
      body,
      input.query.trim(),
      durationSeconds,
      request.numResults,
    )
  } catch (error) {
    if (signal.aborted) {
      throw new AbortError('WebSearch was cancelled.')
    }
    if (timedOut && isAbortError(error)) {
      throw new Error('Exa search timed out after 20s.')
    }
    if (error instanceof Error && error.message.startsWith('Exa ')) {
      throw error
    }
    if (error instanceof Error && error.message === 'Exa search returned an unexpected response.') {
      throw error
    }
    throw new Error('Exa search failed. Check your network connection.')
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', onAbort)
  }
}
```

Update `_forTest`:

```ts
export const _forTest = {
  buildExaSearchRequest,
  formatExaStatusError,
  parseExaSearchResponse,
  searchExaWithTimeoutMs,
}
```

- [ ] **Step 4: Run the focused test and verify fetch tests pass**

Run:

```bash
cd /Users/pt/cat-code && bun test src/tools/WebSearchTool/WebSearchTool.test.ts
```

Expected: PASS for helper tests.

- [ ] **Step 5: Optional commit checkpoint if explicitly authorized**

Only if the user has explicitly asked for commits, run:

```bash
cd /Users/pt/cat-code && git add src/tools/WebSearchTool/exa.ts src/tools/WebSearchTool/WebSearchTool.test.ts && git commit -m "$(cat <<'EOF'
feat: call Exa Search from WebSearch helper
EOF
)"
```

---

### Task 6: Rewire `WebSearchTool` To Use Exa

**Files:**
- Modify: `src/tools/WebSearchTool/WebSearchTool.ts`
- Test: `src/tools/WebSearchTool/WebSearchTool.test.ts`

- [ ] **Step 1: Add tool lifecycle and integration tests**

Append these tests to `src/tools/WebSearchTool/WebSearchTool.test.ts`:

```ts
describe('WebSearchTool Exa integration', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, originalEnv)
  })

  test('preserves public tool lifecycle properties', async () => {
    const { WebSearchTool } = await import('./WebSearchTool.js')
    const { WEB_SEARCH_TOOL_NAME } = await import('./prompt.js')

    expect(WebSearchTool.name).toBe(WEB_SEARCH_TOOL_NAME)
    expect(WebSearchTool.name).toBe('WebSearch')
    expect(WebSearchTool.shouldDefer).toBe(true)
    expect(WebSearchTool.isReadOnly({ query: 'docs' })).toBe(true)
    expect(WebSearchTool.isConcurrencySafe({ query: 'docs' })).toBe(true)
    expect(WebSearchTool.extractSearchText?.({ query: 'docs', results: [], durationSeconds: 0 })).toBe('')
  })

  test('keeps WebSearch disabled under essential-traffic-only mode', async () => {
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    const { WebSearchTool } = await import('./WebSearchTool.js')

    expect(WebSearchTool.isEnabled()).toBe(false)
  })

  test('keeps WebSearch enabled by default', async () => {
    const { WebSearchTool } = await import('./WebSearchTool.js')

    expect(WebSearchTool.isEnabled()).toBe(true)
  })

  test('keeps WebSearch out of the auto-mode safe allowlist', async () => {
    const { WEB_SEARCH_TOOL_NAME } = await import('./prompt.js')
    const { isAutoModeAllowlistedTool } = await import('../../utils/permissions/classifierDecision.js')

    expect(isAutoModeAllowlistedTool(WEB_SEARCH_TOOL_NAME)).toBe(false)
  })

  test('keeps the existing tool-level permission suggestion', async () => {
    const { WebSearchTool } = await import('./WebSearchTool.js')
    const { WEB_SEARCH_TOOL_NAME } = await import('./prompt.js')

    await expect(WebSearchTool.checkPermissions({ query: 'docs' }, {} as never)).resolves.toMatchObject({
      behavior: 'passthrough',
      suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: WEB_SEARCH_TOOL_NAME }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ],
    })
  })

  test('accepts provider-neutral input fields and rejects invalid bounds', async () => {
    const { WebSearchTool } = await import('./WebSearchTool.js')

    expect(
      WebSearchTool.inputSchema.safeParse({
        query: 'latest TypeScript changelog',
        max_results: 3,
        include_domains: ['typescriptlang.org'],
        exclude_domains: ['example.com'],
        freshness: 'month',
      }).success,
    ).toBe(true)

    expect(
      WebSearchTool.inputSchema.safeParse({ query: 'bad', max_results: 0 }).success,
    ).toBe(false)
    expect(
      WebSearchTool.inputSchema.safeParse({ query: 'bad', max_results: 11 }).success,
    ).toBe(false)
    expect(
      WebSearchTool.inputSchema.safeParse({
        query: 'bad',
        legacy_domain_filter: ['example.com'],
      }).success,
    ).toBe(false)
  })

  test('formats compact model-facing search results without Exa diagnostics', async () => {
    const { WebSearchTool } = await import('./WebSearchTool.js')

    const result = WebSearchTool.mapToolResultToToolResultBlockParam(
      {
        query: 'Exa API docs',
        durationSeconds: 0.1,
        results: [
          {
            title: 'Search API',
            url: 'https://docs.exa.ai/reference/search',
            publishedDate: '2026-01-01T00:00:00.000Z',
            author: 'Exa',
            highlights: ['Use numResults to limit results.'],
          },
        ],
      },
      'toolu_123',
    )

    expect(result.content).toContain('Web search results for query: "Exa API docs"')
    expect(result.content).toContain('1. Search API')
    expect(result.content).toContain('URL: https://docs.exa.ai/reference/search')
    expect(result.content).toContain('Use numResults to limit results.')
    expect(result.content).not.toContain('costDollars')
    expect(result.content).not.toContain('requestId')
  })
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
cd /Users/pt/cat-code && bun test src/tools/WebSearchTool/WebSearchTool.test.ts
```

Expected: FAIL because `WebSearchTool.ts` still uses hosted web search and old fields.

- [ ] **Step 3: Remove hosted-search imports from `WebSearchTool.ts`**

Remove these imports from `src/tools/WebSearchTool/WebSearchTool.ts`:

```ts
import type {
  BetaContentBlock,
  BetaWebSearchTool20250305,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { getAPIProvider, resolveRequestProvider } from 'src/utils/model/providers.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { queryModelWithStreaming } from '../../services/api/claude.js'
import { logError } from '../../utils/log.js'
import { createUserMessage } from '../../utils/messages.js'
import { getMainLoopModel, getSmallFastModel } from '../../utils/model/model.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
```

Add these imports:

```ts
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import { searchExa, type WebSearchOutput, type WebSearchResult } from './exa.js'
```

- [ ] **Step 4: Replace the input schema**

Replace the current input schema with:

```ts
const inputSchema = lazySchema(() =>
  z.strictObject({
    query: z.string().trim().min(1).describe('The search query to use'),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe('Maximum number of results. Defaults to 5. Must be between 1 and 10.'),
    include_domains: z
      .array(z.string().trim().min(1))
      .max(20)
      .optional()
      .describe('Only include search results from these domains.'),
    exclude_domains: z
      .array(z.string().trim().min(1))
      .max(20)
      .optional()
      .describe('Exclude search results from these domains.'),
    freshness: z
      .enum(['day', 'week', 'month', 'year', 'any'])
      .optional()
      .describe('Published-date freshness filter. Defaults to any.'),
  }),
)
```

- [ ] **Step 5: Replace output schema and exported types**

Replace the hosted-search `searchResultSchema` and old `outputSchema` with:

```ts
const searchResultSchema = lazySchema(() =>
  z.object({
    title: z.string().describe('The title of the search result'),
    url: z.string().describe('The URL of the search result'),
    publishedDate: z.string().optional().describe('Published date when Exa provides it'),
    author: z.string().optional().describe('Author when Exa provides it'),
    highlights: z.array(z.string()).optional().describe('Relevant highlights'),
  }),
)

export type SearchResult = WebSearchResult

const outputSchema = lazySchema(() =>
  z.object({
    query: z.string().describe('The search query that was executed'),
    results: z.array(searchResultSchema()).describe('Compact web search results'),
    durationSeconds: z.number().describe('Time taken to complete the search operation'),
  }),
)

type OutputSchema = ReturnType<typeof outputSchema>
export type Output = WebSearchOutput
```

- [ ] **Step 6: Replace `isEnabled()`**

Replace provider-gated `isEnabled()` with:

```ts
isEnabled() {
  return !isEssentialTrafficOnly()
},
```

- [ ] **Step 7: Delete hosted-search-specific `validateInput()`**

Delete the old `validateInput()` implementation entirely. The strict Zod schema now rejects empty queries, unknown hosted-search fields, invalid enum values, non-integer `max_results`, out-of-range `max_results`, and over-large domain arrays before tool-specific validation runs.

- [ ] **Step 8: Replace `call()`**

Replace the hosted model call with:

```ts
async call(input, context, _canUseTool, _parentMessage, onProgress) {
  const toolUseID = context.toolUseId ?? `web-search-${Date.now()}`

  onProgress?.({
    toolUseID,
    data: {
      type: 'query_update',
      query: input.query,
    },
  })

  const output = await searchExa(input, context.abortController.signal)

  onProgress?.({
    toolUseID,
    data: {
      type: 'search_results_received',
      resultCount: output.results.length,
      query: input.query,
    },
  })

  return { data: output }
},
```

- [ ] **Step 9: Replace `mapToolResultToToolResultBlockParam()`**

Replace the old hosted-result formatter with:

```ts
mapToolResultToToolResultBlockParam(output, toolUseID) {
  const { query, results } = output

  let formattedOutput = `Web search results for query: "${query}"\n\n`

  if (results.length === 0) {
    formattedOutput += 'No results found.\n\n'
  } else {
    results.forEach((result, index) => {
      formattedOutput += `${index + 1}. ${result.title}\n`
      formattedOutput += `URL: ${result.url}\n`
      if (result.publishedDate) {
        formattedOutput += `Published: ${result.publishedDate}\n`
      }
      if (result.author) {
        formattedOutput += `Author: ${result.author}\n`
      }
      if (result.highlights?.length) {
        formattedOutput += 'Highlights:\n'
        result.highlights.forEach(highlight => {
          formattedOutput += `- ${highlight}\n`
        })
      }
      formattedOutput += '\n'
    })
  }

  formattedOutput +=
    'REMINDER: Cite relevant source URLs from the WebSearch results using markdown hyperlinks.'

  return {
    tool_use_id: toolUseID,
    type: 'tool_result',
    content: formattedOutput.trim(),
  }
},
```

- [ ] **Step 10: Keep transcript search indexing behavior**

Keep this method on `WebSearchTool`:

```ts
extractSearchText() {
  return ''
},
```

Reason: `renderToolResultMessage()` still displays only compact UI chrome like `Found 5 results in 420ms`. The model-facing result text includes URLs and highlights that are not rendered in the transcript UI. Returning `''` avoids phantom transcript-search matches for hidden result text.

- [ ] **Step 11: Run the focused test and verify tool integration passes**

Run:

```bash
cd /Users/pt/cat-code && bun test src/tools/WebSearchTool/WebSearchTool.test.ts
```

Expected: PASS for WebSearch tool tests.

- [ ] **Step 12: Optional commit checkpoint if explicitly authorized**

Only if the user has explicitly asked for commits, run:

```bash
cd /Users/pt/cat-code && git add src/tools/WebSearchTool/WebSearchTool.ts src/tools/WebSearchTool/WebSearchTool.test.ts && git commit -m "$(cat <<'EOF'
feat: power WebSearch with Exa Search
EOF
)"
```

---

### Task 7: Update WebSearch Prompt And UI

**Files:**
- Modify: `src/tools/WebSearchTool/prompt.ts`
- Modify: `src/tools/WebSearchTool/UI.tsx`
- Test: `src/tools/WebSearchTool/WebSearchTool.test.ts`

- [ ] **Step 1: Update the model-facing prompt**

Replace `getWebSearchPrompt()` content in `src/tools/WebSearchTool/prompt.ts` with text equivalent to:

```ts
export function getWebSearchPrompt(): string {
  const currentMonthYear = getLocalMonthYear()
  return `
- Search the web and use compact results to inform responses.
- Use this for current documentation, package/API references, GitHub or repository docs, changelogs, issue/error lookup, and general web research.
- Results include titles, URLs, dates when available, authors when available, and bounded highlights. Full page text and summaries are not returned in v1.
- Use targeted queries. For recent docs or current events, include the current year when it helps.
- Use include_domains when the relevant site is known, such as official docs or GitHub repository documentation.
- Use freshness when recency matters.

CRITICAL REQUIREMENT - You MUST follow this:
  - After answering the user's question, include a "Sources:" section at the end of your response when WebSearch results informed the answer.
  - In the Sources section, list relevant URLs from the search results as markdown hyperlinks: [Title](URL).
  - Do not cite sources that were not returned by WebSearch or otherwise read with a tool.

Usage notes:
  - Domain filtering supports include_domains and exclude_domains.
  - Freshness supports day, week, month, year, or any.
  - The current month is ${currentMonthYear}. Use the current year when searching for recent information, documentation, changelogs, or current events.
`
}
```

- [ ] **Step 2: Update UI input rendering**

Change `renderToolUseMessage()` in `src/tools/WebSearchTool/UI.tsx` so the input type includes:

```ts
Partial<{
  query: string
  include_domains?: string[]
  exclude_domains?: string[]
  max_results?: number
  freshness?: string
}>
```

Update verbose rendering to append:

```ts
if (typeof max_results === 'number') {
  message += `, max results: ${max_results}`
}
if (freshness && freshness !== 'any') {
  message += `, freshness: ${freshness}`
}
if (include_domains && include_domains.length > 0) {
  message += `, only including domains: ${include_domains.join(', ')}`
}
if (exclude_domains && exclude_domains.length > 0) {
  message += `, excluding domains: ${exclude_domains.join(', ')}`
}
```

- [ ] **Step 3: Update result rendering**

Replace `getSearchSummary()` and `renderToolResultMessage()` logic so the UI says result count, not hosted-search count:

```ts
function getResultCount(results: (SearchResult | null | undefined)[]): number {
  return results.filter(Boolean).length
}

export function renderToolResultMessage(output: Output): React.ReactNode {
  const resultCount = getResultCount(output.results ?? [])
  const timeDisplay =
    output.durationSeconds >= 1
      ? `${Math.round(output.durationSeconds)}s`
      : `${Math.round(output.durationSeconds * 1000)}ms`

  return (
    <Box justifyContent="space-between" width="100%">
      <MessageResponse height={1}>
        <Text>
          Found {resultCount} result{resultCount !== 1 ? 's' : ''} in {timeDisplay}
        </Text>
      </MessageResponse>
    </Box>
  )
}
```

- [ ] **Step 4: Run the focused test**

Run:

```bash
cd /Users/pt/cat-code && bun test src/tools/WebSearchTool/WebSearchTool.test.ts
```

Expected: PASS.

- [ ] **Step 5: Optional commit checkpoint if explicitly authorized**

Only if the user has explicitly asked for commits, run:

```bash
cd /Users/pt/cat-code && git add src/tools/WebSearchTool/prompt.ts src/tools/WebSearchTool/UI.tsx src/tools/WebSearchTool/WebSearchTool.test.ts && git commit -m "$(cat <<'EOF'
chore: update WebSearch prompt and UI for Exa
EOF
)"
```

---

### Task 8: Scrub `EXA_API_KEY` From Subprocess Environments

**Files:**
- Modify: `src/utils/subprocessEnv.ts`
- Create: `src/utils/subprocessEnv.test.ts`

- [ ] **Step 1: Write the subprocess scrub test**

Create `src/utils/subprocessEnv.test.ts` with:

```ts
import { afterEach, describe, expect, test } from 'bun:test'

import { subprocessEnv } from './subprocessEnv.js'

const originalEnv = { ...process.env }

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
}

describe('subprocessEnv', () => {
  afterEach(() => {
    restoreEnv()
  })

  test('scrubs EXA_API_KEY from subprocesses when scrub mode is enabled', () => {
    process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1'
    process.env.EXA_API_KEY = 'secret-exa-key'
    process.env.INPUT_EXA_API_KEY = 'secret-input-exa-key'

    const env = subprocessEnv()

    expect(env.EXA_API_KEY).toBeUndefined()
    expect(env.INPUT_EXA_API_KEY).toBeUndefined()
    expect(process.env.EXA_API_KEY).toBe('secret-exa-key')
  })
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
cd /Users/pt/cat-code && bun test src/utils/subprocessEnv.test.ts
```

Expected: FAIL because `EXA_API_KEY` is not scrubbed yet.

- [ ] **Step 3: Add `EXA_API_KEY` to `GHA_SUBPROCESS_SCRUB`**

In `src/utils/subprocessEnv.ts`, add `EXA_API_KEY` beside the auth credentials:

```ts
  // Third-party research provider auth — Cat Code reads it in-process only
  'EXA_API_KEY',
```

Place it in the existing `GHA_SUBPROCESS_SCRUB` array near the Anthropic/provider auth entries, not in `SAFE_ENV_VARS`.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
cd /Users/pt/cat-code && bun test src/utils/subprocessEnv.test.ts
```

Expected: PASS.

- [ ] **Step 5: Optional commit checkpoint if explicitly authorized**

Only if the user has explicitly asked for commits, run:

```bash
cd /Users/pt/cat-code && git add src/utils/subprocessEnv.ts src/utils/subprocessEnv.test.ts && git commit -m "$(cat <<'EOF'
fix: scrub Exa API key from subprocesses
EOF
)"
```

---

### Task 9: Add Minimal Operator Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a WebSearch operator note**

Add this short subsection near README provider/authentication documentation:

```md
### Web Search

`WebSearch` uses the Exa Search API for provider-neutral web research.
Set `EXA_API_KEY` in the shell environment before starting Cat Code:

```bash
export EXA_API_KEY="..."
cat-code
```

Web search is disabled when `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set.
In GitHub Actions subprocess-scrub mode, Cat Code keeps `EXA_API_KEY` available to the main process but removes it from Bash, hooks, MCP stdio servers, LSP servers, and other child processes.
```

- [ ] **Step 2: Run a docs sanity check**

Run:

```bash
cd /Users/pt/cat-code && git diff --check -- README.md
```

Expected: PASS.

- [ ] **Step 3: Optional commit checkpoint if explicitly authorized**

Only if the user has explicitly asked for commits, run:

```bash
cd /Users/pt/cat-code && git add README.md && git commit -m "$(cat <<'EOF'
docs: document Exa WebSearch configuration
EOF
)"
```

---

### Task 10: Search For Active Stale Hosted-WebSearch References

**Files:**
- Inspect and possibly modify: `src/tools/WebSearchTool/WebSearchTool.ts`
- Inspect and possibly modify: `src/tools/WebSearchTool/WebSearchTool.test.ts`
- Inspect and possibly modify: `src/tools/WebSearchTool/UI.tsx`
- Inspect and possibly modify: `src/tools/WebSearchTool/prompt.ts`
- Inspect only unless clearly active/stale: `src/services/api/codex-fetch-adapter.ts`
- Inspect only unless clearly active/stale: `src/services/api/codex-fetch-adapter.test.ts`
- Inspect and possibly modify active model-facing docs/prompts that mention `WebSearch`

- [ ] **Step 1: Search the active WebSearch tool directory**

Run:

```bash
cd /Users/pt/cat-code && rg "web_search_20250305|allowed_domains|blocked_domains|OpenAI/Codex web search|Web search is only available in the US|applyOpenAIMocks|WebSearchTool OpenAI support" src/tools/WebSearchTool
```

Expected: no matches.

If there are matches, update the matching file so active WebSearch code, tests, UI, and prompts use Exa-era fields and language.

- [ ] **Step 2: Preserve generic hosted-search adapter references**

Run:

```bash
cd /Users/pt/cat-code && rg "web_search_20250305|allowed_domains|blocked_domains" src/services/api/codex-fetch-adapter.ts src/services/api/codex-fetch-adapter.test.ts
```

Expected: matches may remain because `codex-fetch-adapter.ts` still translates Anthropic hosted web-search schemas generically. Do not delete that adapter behavior in this change.

- [ ] **Step 3: Check active model-facing WebSearch references**

Run:

```bash
cd /Users/pt/cat-code && rg "WebSearch|web search" README.md CLAUDE.md AGENTS.md docs/maps src/constants src/tools -g "*.ts" -g "*.tsx" -g "*.md"
```

Only update active operator docs, routing docs, and model-facing prompt text that claims `WebSearch` depends on Anthropic/OpenAI/Vertex/Foundry hosted search. Do not mechanically rewrite historical plans, generic Anthropic/Codex adapter documentation, or legitimate provider-adapter tests.

- [ ] **Step 4: Optional commit checkpoint if explicitly authorized**

Only if the user has explicitly asked for commits, run:

```bash
cd /Users/pt/cat-code && git add src/tools/WebSearchTool README.md && git commit -m "$(cat <<'EOF'
chore: remove stale hosted WebSearch references
EOF
)"
```

Before running that command, narrow the `git add` paths to only files actually changed.

---

### Task 11: Focused Validation And Manual Smoke

**Files:**
- Validate changed files only.

- [ ] **Step 1: Run WebSearch tests**

Run:

```bash
cd /Users/pt/cat-code && bun test src/tools/WebSearchTool/WebSearchTool.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run subprocess scrub tests**

Run:

```bash
cd /Users/pt/cat-code && bun test src/utils/subprocessEnv.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run Codex adapter tests if the adapter was touched**

Only if `src/services/api/codex-fetch-adapter.ts` or `src/services/api/codex-fetch-adapter.test.ts` changed, run:

```bash
cd /Users/pt/cat-code && bun test src/services/api/codex-fetch-adapter.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run docs whitespace check if README changed**

Run:

```bash
cd /Users/pt/cat-code && git diff --check -- README.md docs/superpowers/plans/2026-06-29-exa-web-search.md
```

Expected: PASS.

- [ ] **Step 5: Run the documented build gate**

Run:

```bash
cd /Users/pt/cat-code && bun run build:dev:full
```

Expected: PASS and prints the `./cli-dev --version` output at the end.

- [ ] **Step 6: Run a manual smoke only if an Exa key exists**

If `EXA_API_KEY` is set in the current shell and `./cli-dev` exists, run:

```bash
cd /Users/pt/cat-code && EXA_API_KEY="$EXA_API_KEY" ./cli-dev --tools WebSearch --allowedTools WebSearch --max-turns 3 -p 'Use WebSearch to search for "Exa Search API POST /search numResults includeDomains" with max_results 3. Summarize the result and include Sources.'
```

Expected:

- `WebSearch` runs without any Anthropic/OpenAI provider-hosted web-search support.
- Output includes compact search results with URLs and bounded highlights.
- Final answer cites URLs.
- No API key appears in stdout, tool result text, debug output, or transcript-visible output.

- [ ] **Step 7: Check for secret leakage in changed code and tests**

Run:

```bash
cd /Users/pt/cat-code && rg "secret-exa-key|test-exa-key|EXA_API_KEY" src/tools/WebSearchTool src/utils/subprocessEnv.ts src/utils/subprocessEnv.test.ts README.md
```

Expected:

- Test fixture strings may appear only in tests.
- `EXA_API_KEY` may appear in `exa.ts`, subprocess scrub code/tests, and README documentation.
- No real key appears anywhere.

---

### Task 12: Final Change Impact Checklist

**Files:**
- Inspect changed files and relevant registries/docs.

- [ ] **Step 1: Check tool registration impact**

Confirm no registration change is needed:

```bash
cd /Users/pt/cat-code && rg "WebSearchTool|WEB_SEARCH_TOOL_NAME" src/tools.ts src/constants/tools.ts src/components/agents/ToolSelector.tsx src/tools/ToolSearchTool/prompt.ts
```

Expected:

- `src/tools.ts` still imports/registers `WebSearchTool`.
- `src/constants/tools.ts` still includes `WEB_SEARCH_TOOL_NAME` for async agents.
- `src/components/agents/ToolSelector.tsx` still buckets `WebSearchTool.name` as read-only.
- `src/tools/ToolSearchTool/prompt.ts` still defers `shouldDefer` tools.

- [ ] **Step 2: Check no dependency change is present**

Run:

```bash
cd /Users/pt/cat-code && git diff -- package.json bun.lockb
```

Expected: empty diff.

- [ ] **Step 3: Check no safe env allowlist was expanded**

Run:

```bash
cd /Users/pt/cat-code && rg "EXA_API_KEY" src/utils/managedEnvConstants.ts src/utils/managedEnv.ts src/utils/settings
```

Expected: no matches.

- [ ] **Step 4: Check subprocess scrub includes the Exa key**

Run:

```bash
cd /Users/pt/cat-code && rg "EXA_API_KEY" src/utils/subprocessEnv.ts src/utils/subprocessEnv.test.ts
```

Expected: `EXA_API_KEY` appears in the scrub list and focused scrub test.

- [ ] **Step 5: Check final WebSearch diff**

Run:

```bash
cd /Users/pt/cat-code && git diff -- src/tools/WebSearchTool
```

Expected:

- Exa helper exists.
- `WebSearchTool.ts` uses `searchExa()`.
- Prompt/UI/tests are updated.
- No hosted-search call path remains inside `src/tools/WebSearchTool/`.
- Exa Search requests ask for bounded highlights only; they do not request full `text`, summaries, or the separate `/contents` endpoint.
- Exa `requestId`, `costDollars`, and raw error response bodies are not exposed in output.
- Cancellation throws Cat Code `AbortError`, while internal timeout throws a stable timeout message.

- [ ] **Step 6: Optional final commit if explicitly authorized**

Only if the user has explicitly asked for commits and all required validation passed, run:

```bash
cd /Users/pt/cat-code && git add README.md src/tools/WebSearchTool/exa.ts src/tools/WebSearchTool/WebSearchTool.ts src/tools/WebSearchTool/prompt.ts src/tools/WebSearchTool/UI.tsx src/tools/WebSearchTool/WebSearchTool.test.ts src/utils/subprocessEnv.ts src/utils/subprocessEnv.test.ts && git commit -m "$(cat <<'EOF'
feat: add Exa-backed WebSearch
EOF
)"
```

---

## Self-Review

### Spec Coverage

- Exa Search API is used as the v1 backend through `POST /search`.
- Auth uses `x-api-key` via `EXA_API_KEY`.
- Provider neutrality is preserved by keeping built-in `WebSearch` independent of OpenAI/Anthropic hosted web-search tools and by hiding Exa backend modes and diagnostics from the public output.
- The tool is read-only and concurrency-safe by preserving existing flags.
- Deferred loading is preserved with `shouldDefer: true` and no registration rename.
- Default results are cost-controlled with `max_results` default `5`, public bound `1..10`, and internal clamp.
- Deep Exa modes, the separate Exa Contents endpoint, Agent API, Deep Search, Monitors, Websets, and Answer endpoint are excluded from v1.
- Exa Search's `contents` request field is limited to bounded highlights; v1 does not request full page `text` or summaries.
- Missing key, 400, 401, 402, 403, 429, timeout, caller cancellation, network failure, malformed response, and empty results are covered with stable secret-safe behavior.
- Freshness maps to `startPublishedDate`.
- Domain filters map to `includeDomains` and `excludeDomains`.
- Returned URLs are limited to HTTP(S), results are capped to requested max, and highlights are count/character bounded.
- `EXA_API_KEY` is not added to `SAFE_ENV_VARS`, but is added to subprocess scrubbing.
- Tests cover mapping, parsing, missing key, fetch auth, status errors, timeout, cancellation, lifecycle preservation, permission preservation, privacy gating, auto-mode allowlist preservation, subprocess scrubbing, and no secret leakage.
- Validation includes focused Bun tests, stale active-reference searches, docs whitespace checks, build gate, and optional manual smoke.

### Placeholder Scan

This plan intentionally avoids placeholders such as TBD, TODO, and "add appropriate error handling." Each task includes specific files, concrete code or command blocks, and expected results.

### Type Consistency

The planned public tool input fields are consistently named:

- `query`
- `max_results`
- `include_domains`
- `exclude_domains`
- `freshness`

The planned Exa request fields are consistently named:

- `query`
- `numResults`
- `type`
- `contents`
- `includeDomains`
- `excludeDomains`
- `startPublishedDate`

The planned output type is consistently `WebSearchOutput` with `results: WebSearchResult[]`, no Exa diagnostics, and no full page text.
