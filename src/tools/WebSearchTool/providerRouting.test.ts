import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { ToolUseContext } from '../../Tool.js';
import { AbortError } from '../../utils/errors.js';
import type { APIProvider } from '../../utils/model/providers.js';
import type { WebSearchInput, WebSearchOutput } from './types.js';
const calls: Array<{
  provider: 'claude' | 'openai';
  input: WebSearchInput;
  context: ToolUseContext;
}> = [];
let nativeError: unknown;
let abortDuringNative = false;
let emptyResults = false;
const originalFetch = globalThis.fetch;
const unexpectedFetch = mock(async () => { throw new Error('Unexpected non-native transport'); });
function nativeSearch(provider: 'claude' | 'openai') {
  return async (input: WebSearchInput, context: ToolUseContext): Promise<WebSearchOutput> => {
    calls.push({ provider, input, context });
    if (abortDuringNative)
      context.abortController.abort();
    if (nativeError)
      throw nativeError;
    return { query: input.query, results: emptyResults ? [] : [{ title: `${provider} source`, url: `https://example.com/${provider}` }], summary: `${provider} summary`, durationSeconds: 0.1 };
  };
}
mock.module('./claude.js', () => ({ searchClaude: nativeSearch('claude') }));
mock.module('./openai.js', () => ({ searchOpenAI: nativeSearch('openai') }));
const { WebSearchTool } = await import('./WebSearchTool.js');
function context(model: string, provider: APIProvider, agentId?: string): ToolUseContext {
  return { options: { mainLoopModel: model, mainLoopProvider: provider }, abortController: new AbortController(), ...(agentId ? { agentId } : {}) } as ToolUseContext;
}
async function invoke(ctx: ToolUseContext, fields: Partial<WebSearchInput> = {}) {
  return WebSearchTool.call(WebSearchTool.inputSchema.parse({ query: 'runtime documentation', ...fields }), ctx, undefined as never, undefined as never, undefined);
}
beforeEach(() => {
  calls.length = 0;
  nativeError = undefined;
  abortDuringNative = false;
  emptyResults = false;
  unexpectedFetch.mockClear();
  globalThis.fetch = unexpectedFetch as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; });
describe('native-only WebSearch routing', () => {
  test.each([
    ['claude-opus-5-5', 'firstParty', 'claude'], ['sonnet', 'firstParty', 'claude'], ['haiku', 'firstParty', 'claude'],
    ['gpt-6-astra', 'openai', 'openai'], ['gpt-6.1-sol', 'firstParty', 'openai'], ['gpt-6.1-terra', 'vertex', 'openai'],
    ['gpt-6-luna', 'bedrock', 'openai'], ['custom-gpt-route', 'openai', 'openai'], ['custom-vertex-model', 'vertex', 'claude'], ['custom-foundry-model', 'foundry', 'claude'],
  ] as const)('uses %s on %s through %s', async (model, provider, expected) => {
    const result = await invoke(context(model, provider));
    expect(calls.map(call => call.provider)).toEqual([expected]);
    expect(result.data.provider).toBe(expected);
    expect(result.data.results[0]?.url).toBe(`https://example.com/${expected}`);
    expect(unexpectedFetch).not.toHaveBeenCalled();
  });
  test('uses each worker context and observes model switches', async () => {
    const main = context('gpt-6.1-sol', 'openai');
    const claude = context('sonnet', 'firstParty', 'claude-worker'), gpt = context('gpt-6-luna', 'firstParty', 'gpt-worker');
    await invoke(main);
    await invoke(claude);
    await invoke(gpt);
    main.options.mainLoopModel = 'opus';
    main.options.mainLoopProvider = 'firstParty';
    await invoke(main);
    expect(calls.map(call => call.provider)).toEqual(['openai', 'claude', 'openai', 'claude']);
    expect(calls[1]?.context).toBe(claude);
    expect(calls[2]?.context).toBe(gpt);
  });
  test.each(['openai', 'firstParty'] as const)('propagates %s native failure without another search', async (provider) => {
    nativeError = new Error('Native provider unavailable');
    await expect(invoke(context(provider === 'openai' ? 'gpt-6.1-sol' : 'sonnet', provider))).rejects.toBe(nativeError);
    expect(calls.map(call => call.provider)).toEqual([provider === 'openai' ? 'openai' : 'claude']);
    expect(unexpectedFetch).not.toHaveBeenCalled();
  });
  test.each(['day', 'week', 'month', 'year'] as const)('rejects Claude freshness=%s before searching with an actionable error', async (freshness) => {
    await expect(invoke(context('sonnet', 'firstParty'), { freshness })).rejects.toThrow('Claude search does not support freshness');
    expect(calls).toEqual([]);
    expect(unexpectedFetch).not.toHaveBeenCalled();
  });
  test.each([
    ['sonnet', 'firstParty', { include_domains: ['example.com'], exclude_domains: ['blocked.example'] }, 'include_domains or exclude_domains'],
    ['gpt-6.1-sol', 'openai', { exclude_domains: ['blocked.example'] }, 'OpenAI search does not support exclude_domains'],
  ] satisfies Array<[
    string,
    APIProvider,
    Partial<WebSearchInput>,
    string
  ]>)('rejects unsupported filters for %s without searching', async (model, provider, options, message) => {
    await expect(invoke(context(model, provider), options)).rejects.toThrow(message);
    expect(calls).toEqual([]);
    expect(unexpectedFetch).not.toHaveBeenCalled();
  });
  test('keeps supported native filters on their own provider', async () => {
    await invoke(context('gpt-6.1-sol', 'openai'), { freshness: 'month', include_domains: ['example.com'] });
    await invoke(context('sonnet', 'firstParty'), { exclude_domains: ['blocked.example'] });
    await invoke(context('sonnet', 'firstParty'), { freshness: 'any', include_domains: ['example.com'] });
    expect(calls.map(call => call.provider)).toEqual(['openai', 'claude', 'claude']);
    expect(calls[0]?.input.freshness).toBe('month');
    expect(calls[1]?.input.exclude_domains).toEqual(['blocked.example']);
  });
  test('keeps the tool exposed on Bedrock but reports native search unavailable without switching accounts', async () => {
    await expect(invoke(context('custom-bedrock-model', 'bedrock'))).rejects.toThrow('Native web search is unavailable on Bedrock');
    expect(calls).toEqual([]);
    expect(unexpectedFetch).not.toHaveBeenCalled();
  });
  test('requires invoking context instead of choosing a global account', async () => {
    await expect(invoke({ abortController: new AbortController() } as ToolUseContext)).rejects.toThrow('invoking model');
    expect(calls).toEqual([]);
    expect(unexpectedFetch).not.toHaveBeenCalled();
  });
  test('returns valid empty native results without another search', async () => {
    emptyResults = true;
    expect((await invoke(context('gpt-6.1-sol', 'openai'))).data.results).toEqual([]);
    expect(calls.map(call => call.provider)).toEqual(['openai']);
    expect(unexpectedFetch).not.toHaveBeenCalled();
  });
  test.each(['before', 'during', 'late', 'error'] as const)('stops cancellation %s without another search', async (when) => {
    const ctx = context('gpt-6.1-sol', 'openai');
    if (when === 'before')
      ctx.abortController.abort();
    if (when === 'during') {
      abortDuringNative = true;
      nativeError = new Error('cancelled');
    }
    if (when === 'late')
      abortDuringNative = true;
    if (when === 'error')
      nativeError = new DOMException('cancelled', 'AbortError');
    await expect(invoke(ctx)).rejects.toBeInstanceOf(AbortError);
    expect(calls.map(call => call.provider)).toEqual(when === 'before' ? [] : ['openai']);
    expect(unexpectedFetch).not.toHaveBeenCalled();
  });
  test('returns complete operation time and delivers native provider, summary, URLs and progress', async () => {
    const clock = spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValue(2600);
    try {
      const progress: unknown[] = [];
      const output = await WebSearchTool.call({ query: 'native search' }, context('sonnet', 'firstParty'), undefined as never, undefined as never, event => progress.push(event));
      expect(output.data.durationSeconds).toBe(2.5);
      expect(WebSearchTool.outputSchema?.safeParse(output.data).success).toBe(true);
      expect(progress).toMatchObject([{ data: { type: 'query_update' } }, { data: { type: 'search_results_received', resultCount: 1 } }]);
      const formatted = WebSearchTool.mapToolResultToToolResultBlockParam(output.data, 'search');
      expect(formatted.content).toContain('Search provider: Claude');
      expect(formatted.content).toContain('https://example.com/claude');
      expect(formatted.content).toContain('Search summary:\nclaude summary');
    }
    finally {
      clock.mockRestore();
    }
  });
});
