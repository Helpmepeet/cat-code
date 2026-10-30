import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import { AbortError } from '../../utils/errors.js'
import type { APIProvider } from '../../utils/model/providers.js'
import type { WebSearchInput, WebSearchOutput, WebSearchProvider } from './types.js'

const calls: Array<{ provider: WebSearchProvider; input: WebSearchInput; context?: ToolUseContext }> = []
let nativeError: unknown
let abortDuringNative = false
let emptyNativeResults = false

function response(input: WebSearchInput, provider: WebSearchProvider): WebSearchOutput {
  return {
    query: input.query,
    results: emptyNativeResults && provider !== 'exa'
      ? []
      : [{ title: `${provider} source`, url: `https://example.com/${provider}` }],
    durationSeconds: 0.1,
    ...(provider === 'exa' ? {} : { summary: `${provider} source summary` }),
  }
}

function nativeSearch(provider: 'claude' | 'openai') {
  return async (input: WebSearchInput, context: ToolUseContext) => {
    calls.push({ provider, input, context })
    if (abortDuringNative) context.abortController.abort()
    if (nativeError) throw nativeError
    return response(input, provider)
  }
}

mock.module('./claude.js', () => ({ searchClaude: nativeSearch('claude') }))
mock.module('./openai.js', () => ({ searchOpenAI: nativeSearch('openai') }))
mock.module('./exa.js', () => ({
  MAX_CONTENT_CHARACTERS: 50_000,
  MAX_RESULTS: 100,
  searchExa: async (input: WebSearchInput) => {
    calls.push({ provider: 'exa', input })
    return response(input, 'exa')
  },
}))

const { WebSearchTool } = await import('./WebSearchTool.js')

function context(model: string, provider: APIProvider, agentId?: string): ToolUseContext {
  return {
    options: { mainLoopModel: model, mainLoopProvider: provider },
    abortController: new AbortController(),
    ...(agentId ? { agentId } : {}),
  } as ToolUseContext
}

async function invoke(ctx: ToolUseContext, fields: Partial<WebSearchInput> = {}) {
  return WebSearchTool.call(
    WebSearchTool.inputSchema.parse({ query: 'runtime documentation', ...fields }),
    ctx,
    undefined as never,
    undefined as never,
    undefined,
  )
}

beforeEach(() => {
  calls.length = 0
  nativeError = undefined
  abortDuringNative = false
  emptyNativeResults = false
})

describe('WebSearch provider routing at tool execution', () => {
  test.each([
    ['claude-opus-5-5', 'firstParty', 'claude'],
    ['sonnet', 'firstParty', 'claude'],
    ['haiku', 'firstParty', 'claude'],
    ['gpt-6-astra', 'openai', 'openai'],
    ['gpt-6.1-sol', 'firstParty', 'openai'],
    ['gpt-6.1-terra', 'vertex', 'openai'],
    ['gpt-6-luna', 'bedrock', 'openai'],
    ['custom-gpt-route', 'openai', 'openai'],
    ['custom-vertex-model', 'vertex', 'claude'],
    ['custom-foundry-model', 'foundry', 'claude'],
    ['custom-bedrock-model', 'bedrock', 'exa'],
  ] as const)('delivers search for %s on %s through %s', async (model, provider, expected) => {
    const output = await invoke(context(model, provider))
    expect(calls.map(call => call.provider)).toEqual([expected])
    expect(output.data.provider).toBe(expected)
    expect(output.data.results[0]?.url).toBe(`https://example.com/${expected}`)
  })

  test('uses each invoking worker and observes a model change without replacing the tool', async () => {
    const main = context('gpt-6.1-sol', 'openai')
    const claudeWorker = context('sonnet', 'firstParty', 'claude-worker')
    const gptWorker = context('gpt-6-luna', 'firstParty', 'gpt-worker')
    await invoke(main)
    await invoke(claudeWorker)
    await invoke(gptWorker)
    main.options.mainLoopModel = 'opus'
    main.options.mainLoopProvider = 'firstParty'
    await invoke(main)
    expect(calls.map(call => call.provider)).toEqual(['openai', 'claude', 'openai', 'claude'])
    expect(calls[1]?.context).toBe(claudeWorker)
    expect(calls[2]?.context).toBe(gptWorker)
  })

  test.each([
    { content: 'text' },
    { max_characters: 8000 },
    { mode: 'extended' },
  ] satisfies Array<Partial<WebSearchInput>>)('keeps fuller-content options working through Exa (%j)', async options => {
    for (const [model, provider] of [['sonnet', 'firstParty'], ['gpt-6.1-sol', 'openai']] as const) {
      calls.length = 0
      const output = await invoke(context(model, provider), options)
      expect(calls.map(call => call.provider)).toEqual(['exa'])
      expect(calls[0]?.input).toMatchObject(options)
      expect(output.data.fallbackReason).toBe('The requested search options require Exa.')
    }
  })

  test.each([
    ['sonnet', 'firstParty', { freshness: 'week' }],
    ['sonnet', 'firstParty', { include_domains: ['example.com'], exclude_domains: ['blocked.example'] }],
    ['gpt-6.1-sol', 'openai', { exclude_domains: ['blocked.example'] }],
  ] as const)('preserves unsupported filters for %s through Exa', async (model, provider, options) => {
    const output = await invoke(context(model, provider), options as Partial<WebSearchInput>)
    expect(calls.map(call => call.provider)).toEqual(['exa'])
    expect(output.data.provider).toBe('exa')
  })

  test('keeps supported OpenAI recency and Claude exclusion filters native', async () => {
    await invoke(context('gpt-6.1-sol', 'openai'), { freshness: 'week' })
    await invoke(context('sonnet', 'firstParty'), { exclude_domains: ['blocked.example'] })
    expect(calls.map(call => call.provider)).toEqual(['openai', 'claude'])
  })

  test.each(['openai', 'firstParty'] as const)('falls back after %s native failure without using the other account provider', async provider => {
    const clock = spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValue(2600)
    try {
      nativeError = new Error('private provider diagnostic')
      const expected = provider === 'openai' ? 'openai' : 'claude'
      const output = await invoke(context(provider === 'openai' ? 'gpt-6.1-sol' : 'sonnet', provider))
      expect(calls.map(call => call.provider)).toEqual([expected, 'exa'])
      expect(output.data.provider).toBe('exa')
      expect(output.data.durationSeconds).toBe(2.5)
      const formatted = WebSearchTool.mapToolResultToToolResultBlockParam(output.data, 'search')
      expect(formatted.content).toContain('Search provider: Exa')
      expect(formatted.content).toContain('search was unavailable.')
      expect(formatted.content).not.toContain('private provider diagnostic')
    } finally {
      clock.mockRestore()
    }
  })

  test('returns a valid native no-match response without performing another search', async () => {
    emptyNativeResults = true
    const output = await invoke(context('gpt-6.1-sol', 'openai'))
    expect(output.data.results).toEqual([])
    expect(calls.map(call => call.provider)).toEqual(['openai'])
  })

  test.each(['before', 'during', 'late', 'error'] as const)('stops cancellation %s native execution without fallback', async when => {
    const ctx = context('gpt-6.1-sol', 'openai')
    if (when === 'before') ctx.abortController.abort()
    if (when === 'during') {
      abortDuringNative = true
      nativeError = new Error('request cancelled')
    }
    if (when === 'late') abortDuringNative = true
    if (when === 'error') nativeError = new DOMException('cancelled', 'AbortError')
    await expect(invoke(ctx)).rejects.toBeInstanceOf(AbortError)
    expect(calls.map(call => call.provider)).toEqual(when === 'before' ? [] : ['openai'])
  })

  test('delivers native summaries, source URLs and progress through the existing tool contract', async () => {
    const progress: unknown[] = []
    const output = await WebSearchTool.call(
      { query: 'native search' }, context('sonnet', 'firstParty'),
      undefined as never, undefined as never, event => progress.push(event),
    )
    expect(WebSearchTool.outputSchema?.safeParse(output.data).success).toBe(true)
    expect(progress).toMatchObject([
      { data: { type: 'query_update', query: 'native search' } },
      { data: { type: 'search_results_received', resultCount: 1, query: 'native search' } },
    ])
    const formatted = WebSearchTool.mapToolResultToToolResultBlockParam(output.data, 'native-search')
    expect(formatted.content).toContain('https://example.com/claude')
    expect(formatted.content).toContain('Search summary:\nclaude source summary')
    expect(formatted.content).toContain('Search provider: Claude')
  })
})
