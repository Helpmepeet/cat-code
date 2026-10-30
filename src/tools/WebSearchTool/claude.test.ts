import { afterEach, describe, expect, mock, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ToolUseContext } from '../../Tool.js'
import * as realAuth from '../../utils/auth.js'
import * as realMessages from '../../utils/messages.js'
import * as realClaudeApi from '../../services/api/claude.js'

let subscription = true
const accessToken = 'isolated-claude-search-test-token'
const getClaudeAIOAuthTokens = mock(() => ({ accessToken, expiresAt: Date.now() + 60_000 }))
mock.module('../../utils/auth.js', () => ({
  ...realAuth,
  getClaudeAIOAuthTokens,
  isClaudeAISubscriber: () => subscription,
}))
let apiEvents: unknown[] = []
const queryModelWithStreaming = mock(async function* (_input: unknown) {
  for (const event of apiEvents) yield event
})
mock.module('../../services/api/claude.js', () => ({ ...realClaudeApi, queryModelWithStreaming }))
mock.module('../../utils/messages.js', () => ({
  ...realMessages,
  createUserMessage: (input: unknown) => ({ type: 'user', ...input as object }),
}))

const { searchClaude } = await import('./claude.js')
const originalEnv = { ...process.env }
const directories: string[] = []

function context(provider = 'firstParty', model = 'claude-sonnet-5-5'): ToolUseContext {
  return {
    options: { mainLoopModel: model, mainLoopProvider: provider, isNonInteractiveSession: true },
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: { mode: 'dontAsk' } }),
    agentId: 'search-worker',
  } as unknown as ToolUseContext
}

async function fakeCli(program: string): Promise<{ directory: string; capture: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'claude-search-test-'))
  directories.push(directory)
  const executable = join(directory, 'fake-claude')
  const capture = join(directory, 'capture.json')
  await writeFile(executable, `#!${process.execPath}\n${program.replaceAll('CAPTURE_PATH', JSON.stringify(capture))}`)
  await chmod(executable, 0o700)
  process.env.CLAUDE_CLI_PATH = executable
  return { directory, capture }
}

function successfulEvents(content: string, result = 'Useful source summary.'): string {
  return [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'search-1', name: 'WebSearch', input: { query: 'q' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'search-1', content }] } },
    { type: 'result', subtype: 'success', is_error: false, result },
  ].map(event => JSON.stringify(event)).join('\n')
}

afterEach(async () => {
  subscription = true
  apiEvents = []
  queryModelWithStreaming.mockClear()
  getClaudeAIOAuthTokens.mockClear()
  for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name]
  Object.assign(process.env, originalEnv)
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('Claude subscription search process boundary', () => {
  test('uses an isolated WebSearch-only CLI, preserves the worker model, and returns bounded source links', async () => {
    const output = successfulEvents('Links: [{"title":"Official docs","url":"https://example.com/docs"},{"title":"Another source","url":"https://example.org/"}]')
    const { capture } = await fakeCli(`
      import { writeFile } from 'fs/promises';
      const stdin = await Bun.stdin.text();
      await writeFile(CAPTURE_PATH, JSON.stringify({args: process.argv.slice(2), config: process.env.CLAUDE_CONFIG_DIR, hasToken: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN), hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY), stdin}));
      console.log(${JSON.stringify(output)});
    `)
    process.env.ANTHROPIC_API_KEY = 'must-not-reach-cli'
    const result = await searchClaude({ query: '  official docs  ', include_domains: ['example.com'], max_results: 1 }, context())
    expect(result).toMatchObject({ query: 'official docs', provider: 'claude', results: [{ title: 'Official docs', url: 'https://example.com/docs' }], summary: 'Useful source summary.' })
    const captured = JSON.parse(await readFile(capture, 'utf8'))
    expect(captured).toMatchObject({ hasToken: true, hasApiKey: false, stdin: '' })
    expect(captured.args).toEqual(expect.arrayContaining(['--tools', 'WebSearch', '--no-session-persistence', '--model', 'claude-sonnet-5-5', '--safe-mode']))
    expect(captured.args.join(' ')).not.toContain(accessToken)
    expect(await Bun.file(captured.config).exists()).toBe(false)
  })

  test('requires a completed search instead of treating an ordinary model answer as search success', async () => {
    await fakeCli(`console.log(${JSON.stringify(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'I already know this.' }))});`)
    await expect(searchClaude({ query: 'q' }, context())).rejects.toThrow('did not complete a search')
  })

  test('does not expose credentials echoed by the child in result fields', async () => {
    const output = successfulEvents(`Links: [{"title":"${accessToken}","url":"https://example.com/"}]`, accessToken)
    await fakeCli(`console.log(${JSON.stringify(output)});`)
    const result = await searchClaude({ query: 'q' }, context())
    expect(result.results[0]?.title).toBe('[redacted]')
    expect(result.summary).toBe('[redacted]')
    expect(JSON.stringify(result)).not.toContain(accessToken)
  })

  test('aborting a running child kills it and rejects as cancellation', async () => {
    const { capture } = await fakeCli(`import { writeFile } from 'fs/promises'; await writeFile(CAPTURE_PATH, String(process.pid)); setInterval(() => {}, 1000);`)
    const toolContext = context()
    const pending = searchClaude({ query: 'q' }, toolContext)
    let pid = 0
    for (let attempt = 0; attempt < 100 && !pid; attempt++) {
      pid = Number(await readFile(capture, 'utf8').catch(() => '0'))
      if (!pid) await Bun.sleep(10)
    }
    expect(pid).toBeGreaterThan(0)
    toolContext.abortController.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(() => process.kill(pid, 0)).toThrow()
  })
})

describe('Claude Messages search boundary', () => {
  test.each([
    { provider: 'vertex', model: 'claude-sonnet-4-6' },
    { provider: 'firstParty', model: 'claude-sonnet-5-5' },
  ])('normalizes server search results with compatible tool choice on $provider/$model and the invoking agent owner', async ({ provider, model }) => {
    subscription = false
    apiEvents = [{ type: 'assistant', message: { content: [
      { type: 'server_tool_use', name: 'web_search', id: 'srv-1' },
      { type: 'web_search_tool_result', tool_use_id: 'srv-1', content: [{ type: 'web_search_result', title: 'Cloud docs', url: 'https://example.com/cloud', encrypted_content: 'not-readable-page-text' }] },
      { type: 'text', text: 'A source-backed summary.' },
    ] } }]
    const result = await searchClaude({ query: 'cloud docs', exclude_domains: ['example.org'] }, context(provider, model))
    expect(result).toMatchObject({ provider: 'claude', results: [{ title: 'Cloud docs', url: 'https://example.com/cloud' }], summary: 'A source-backed summary.' })
    expect(JSON.stringify(result)).not.toContain('not-readable-page-text')
    const request = queryModelWithStreaming.mock.calls[0]?.[0] as { options: Record<string, unknown> }
    expect(request.options).toMatchObject({ provider, model, agentId: 'search-worker', toolChoice: { type: 'auto' }, extraToolSchemas: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1, blocked_domains: ['example.org'] }] })
    expect(getClaudeAIOAuthTokens).not.toHaveBeenCalled()
  })

  test('server-side tool errors remain failures for the shared fallback router', async () => {
    subscription = false
    apiEvents = [{ type: 'assistant', message: { content: [{ type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'unavailable' } }] } }]
    await expect(searchClaude({ query: 'q' }, context())).rejects.toThrow('returned an error')
  })
})
