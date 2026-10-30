import { afterEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { WebSearchTool } from './WebSearchTool.js';
import { getWebSearchPrompt } from './prompt.js';
import { renderToolResultMessage, renderToolUseMessage } from './UI.js';
function collectReactText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean')
    return '';
  if (typeof node === 'string' || typeof node === 'number')
    return String(node);
  if (Array.isArray(node))
    return node.map(collectReactText).join('');
  if (React.isValidElement(node))
    return collectReactText((node.props as {
      children?: React.ReactNode;
    }).children);
  return '';
}
const originalEnv = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env))
    if (!(key in originalEnv))
      delete process.env[key];
  Object.assign(process.env, originalEnv);
});
describe('native WebSearch public contract', () => {
  test('preserves lifecycle properties', () => {
    expect(WebSearchTool.name).toBe('WebSearch');
    expect(WebSearchTool.shouldDefer).toBe(true);
    expect(WebSearchTool.isReadOnly({ query: 'docs' })).toBe(true);
    expect(WebSearchTool.isConcurrencySafe({ query: 'docs' })).toBe(true);
    expect(WebSearchTool.extractSearchText?.({ query: 'docs', results: [], durationSeconds: 0 })).toBe('');
  });
  test('honors essential-traffic-only mode', () => {
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    expect(WebSearchTool.isEnabled()).toBe(false);
  });
  test.each([undefined, '', 'unused-legacy-key'])('keeps native search registered regardless of a legacy key (%s)', key => {
    delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
    if (key === undefined)
      delete process.env.EXA_API_KEY;
    else
      process.env.EXA_API_KEY = key;
    expect(WebSearchTool.isEnabled()).toBe(true);
  });
  test('keeps the receiving permission boundary', async () => {
    const { isAutoModeAllowlistedTool } = await import('../../utils/permissions/classifierDecision.js');
    expect(isAutoModeAllowlistedTool('WebSearch')).toBe(false);
    await expect(WebSearchTool.checkPermissions({ query: 'docs' }, {} as never)).resolves.toMatchObject({ behavior: 'passthrough', suggestions: [{ type: 'addRules', rules: [{ toolName: 'WebSearch' }], behavior: 'allow', destination: 'localSettings' }] });
  });
  test('accepts native fields and rejects retired options and invalid bounds', () => {
    expect(WebSearchTool.inputSchema.parse({ query: '  docs  ', include_domains: ['example.com'], max_results: 100, freshness: 'month' })).toMatchObject({ query: 'docs', max_results: 100 });
    expect(WebSearchTool.inputSchema.safeParse({ query: 'docs', exclude_domains: ['example.org'] }).success).toBe(true);
    for (const fields of [{ mode: 'extended' }, { content: 'text' }, { max_characters: 8000 }, { max_results: 0 }, { max_results: 101 }, { legacy_domain_filter: ['example.com'] }]) {
      expect(WebSearchTool.inputSchema.safeParse({ query: 'docs', ...fields }).success).toBe(false);
    }
  });
  test('formats native sources and summaries without implying full-page reads', () => {
    const result = WebSearchTool.mapToolResultToToolResultBlockParam({ query: 'docs', durationSeconds: 0.1, provider: 'claude', summary: 'A generated summary.', results: [{ title: 'Docs', url: 'https://example.com/docs', publishedDate: '2026-10-30', author: 'Maintainer', highlights: ['A source excerpt.'] }] }, 'search');
    expect(result.content).toContain('Search provider: Claude');
    expect(result.content).toContain('URL: https://example.com/docs');
    expect(result.content).toContain('Highlights:\n- A source excerpt.');
    expect(result.content).toContain('Search summary:\nA generated summary.');
    expect(result.content).not.toContain('Page text:');
  });
  test.each(['openai', 'firstParty', 'vertex', 'foundry', 'bedrock'] as const)('describes native-only capabilities on %s', provider => {
    const prompt = getWebSearchPrompt(provider);
    expect(prompt).not.toContain('Exa');
    expect(prompt).toContain('no automatic backend substitution');
    expect(prompt).toContain('A summary is not a directly read page');
    expect(prompt).toContain('Cite only sources actually returned or read');
    if (provider === 'openai')
      expect(prompt).toContain('freshness are supported; exclude_domains is not supported');
    else if (provider === 'bedrock')
      expect(prompt).toContain('Native web search is unavailable');
    else
      expect(prompt).toContain('Omit freshness');
  });
  test('renders native input and still renders older saved input fields', () => {
    expect(renderToolUseMessage({ query: 'current docs', max_results: 3, include_domains: ['example.com'] }, { verbose: true })).toBe('"current docs", max results: 3, only including domains: example.com');
    expect(renderToolUseMessage({ query: 'old search', content: 'text', max_characters: 8000, mode: 'extended' }, { verbose: true })).toBe('"old search", extended, content: text, characters per result: 8000');
  });
  test.each(['claude', 'openai', 'exa'] as const)('renders %s result metadata, including historical providers', provider => {
    const text = collectReactText(renderToolResultMessage({ query: 'docs', provider, durationSeconds: 0.25, results: [{ title: 'Docs', url: 'https://example.com/' }] }));
    expect(text).toContain('Found 1 result in 250ms');
    expect(text).toContain(provider === 'claude' ? '(Claude)' : provider === 'openai' ? '(OpenAI)' : '(Exa)');
  });
});
