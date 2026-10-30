import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import {
  getCodexLeaseForOwner,
  resetCodexLeaseManagerForTest,
  seedCodexLeaseForTest,
} from '../../services/api/codexAccountLeaseManager.js'
import {
  getPoolStatus,
  resetCodexAccountPoolForTest,
  seedCodexAccountPoolForTest,
  type PoolAccount,
} from '../../services/api/codexAccountPool.js'
import type { CodexCredentialLifecycle } from '../../services/api/codexCredentialLifecycle.js'
import type { CodexCredentialUseOptions } from '../../services/api/codexCredentialUse.js'
import { searchOpenAI } from './openai.js'

const originalFetch = globalThis.fetch
const accounts: PoolAccount[] = ['main', 'worker'].map(id => ({
  accountId: `search-${id}`,
  accessToken: `test-access-${id}`,
  refreshToken: `test-refresh-${id}`,
  expiresAt: Date.now() + 60 * 60_000,
  credentialGeneration: 1,
  credentialGenerationState: 'lifecycle_bound',
  source: 'config',
  status: 'healthy',
  lastUsedAt: 0,
}))

function credentialUse(state: 'credentialed' | 'signed_out' = 'credentialed'): CodexCredentialUseOptions {
  return {
    lifecycle: {
      read(accountId: string) {
        return {
          status: 'valid',
          record: {
            version: 1,
            accountId,
            credentialGeneration: 1,
            state,
            operationId: 'search-test',
            operationKind: 'login',
            changedAt: '2026-10-30T00:00:00Z',
          },
        }
      },
      async withTransaction(_id: string, _options: unknown, callback: (permit: never) => unknown) {
        return callback({} as never)
      },
    } as unknown as CodexCredentialLifecycle,
  }
}

function context(agentId?: string, credentials = credentialUse()): ToolUseContext {
  return {
    agentId,
    options: { mainLoopModel: 'gpt-6.1-terra', mainLoopProvider: 'openai' },
    abortController: new AbortController(),
    codexCredentialUse: credentials,
  } as unknown as ToolUseContext
}

beforeEach(() => {
  resetCodexLeaseManagerForTest()
  seedCodexAccountPoolForTest({ accounts, activeAccountId: 'search-main' })
})

afterEach(() => {
  globalThis.fetch = originalFetch
  resetCodexLeaseManagerForTest()
  resetCodexAccountPoolForTest()
})

describe('OpenAI search account and transport boundary', () => {
  test.each([
    { agentId: undefined, expectedAccount: 'search-main' },
    { agentId: 'search-worker-agent', expectedAccount: 'search-worker' },
  ])('uses the invoking owner account: $expectedAccount', async ({ agentId, expectedAccount }) => {
    if (agentId) {
      seedCodexLeaseForTest({ ownerId: agentId, ownerType: 'subagent', ownerLabel: 'Worker', accountId: 'search-worker' })
    }
    let requestedBody: Record<string, unknown> | undefined
    let requestedHeaders: Headers | undefined
    globalThis.fetch = (async (url, init) => {
      expect(String(url)).toBe('https://chatgpt.com/backend-api/codex/alpha/search')
      requestedHeaders = new Headers(init?.headers)
      requestedBody = JSON.parse(String(init?.body))
      return Response.json({
        output: 'A source excerpt with citation turn0search0.',
        encrypted_output: 'private-provider-carrier',
        results: [
          { type: 'text_result', url: 'https://example.com/docs', title: 'Docs', snippet: 'A useful source excerpt.' },
          { type: 'text_result', url: 'https://example.com/docs', title: 'Duplicate' },
          { type: 'text_result', url: 'javascript:alert(1)', title: 'Unsafe link' },
          { type: 'future_variant', url: 'https://example.org/reference', title: 'Reference' },
        ],
      })
    }) as unknown as typeof globalThis.fetch

    const result = await searchOpenAI({ query: '  current docs  ', include_domains: ['example.com'], freshness: 'week', max_results: 2 }, context(agentId))
    expect(requestedHeaders?.get('chatgpt-account-id')).toBe(expectedAccount)
    expect(requestedHeaders?.get('authorization')).toBe(`Bearer test-access-${agentId ? 'worker' : 'main'}`)
    expect(requestedBody).toMatchObject({
      model: 'gpt-6.1-terra',
      commands: { search_query: [{ q: 'current docs', domains: ['example.com'], recency: 7 }] },
      settings: { external_web_access: true, allowed_callers: ['direct'] },
    })
    expect(result).toMatchObject({
      query: 'current docs',
      provider: 'openai',
      summary: 'A source excerpt with citation turn0search0.',
      results: [
        { title: 'Docs', url: 'https://example.com/docs', highlights: ['A useful source excerpt.'] },
        { title: 'Reference', url: 'https://example.org/reference' },
      ],
    })
    expect(JSON.stringify(result)).not.toContain('private-provider-carrier')
    if (agentId) expect(getCodexLeaseForOwner(agentId)?.accountId).toBe('search-worker')
  })

  test.each([
    { dto: { output: 'Legacy source (https://example.com/docs)\nAn excerpt.' }, expected: 1 },
    { dto: { output: 'Unrelated link (https://example.com/docs)', results: [] }, expected: 0 },
  ])('supports older plaintext responses while preserving explicit empty results', async ({ dto, expected }) => {
    globalThis.fetch = (async () => Response.json(dto)) as unknown as typeof globalThis.fetch
    const result = await searchOpenAI({ query: 'docs' }, context())
    expect(result.results).toHaveLength(expected)
    if (expected) expect(result.results[0]).toEqual({ title: 'Legacy source', url: 'https://example.com/docs' })
  })

  test('refuses a signed-out credential before sending a request', async () => {
    let calls = 0
    globalThis.fetch = (async () => { calls++; return Response.json({}) }) as unknown as typeof globalThis.fetch
    await expect(searchOpenAI({ query: 'docs' }, context(undefined, credentialUse('signed_out')))).rejects.toThrow('credential lifecycle state')
    expect(calls).toBe(0)
  })

  test('a search rate limit does not cap the model accounts', async () => {
    globalThis.fetch = (async () => new Response(null, {
      status: 429,
      headers: { 'x-should-retry': 'false' },
    })) as unknown as typeof globalThis.fetch
    await expect(searchOpenAI({ query: 'docs' }, context())).rejects.toThrow()
    expect(getPoolStatus().accounts.map(account => account.status)).toEqual(['healthy', 'healthy'])
  })

  test('cancellation stops a pending request and remains an abort error', async () => {
    const owner = context()
    let requestStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => { requestStarted = resolve })
    globalThis.fetch = ((_url, init) => {
      requestStarted?.()
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })
    }) as unknown as typeof globalThis.fetch
    const pending = searchOpenAI({ query: 'docs' }, owner)
    await started
    owner.abortController.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('cancellation during credential locking cannot initiate a later send', async () => {
    const credentials = credentialUse()
    let unlocked: (() => void) | undefined
    let locked: (() => void) | undefined
    const gate = new Promise<void>(resolve => { unlocked = resolve })
    const entered = new Promise<void>(resolve => { locked = resolve })
    credentials.lifecycle!.withTransaction = async (_id, _options, callback) => {
      locked?.()
      await gate
      return callback({} as never)
    }
    const owner = context(undefined, credentials)
    let sends = 0
    globalThis.fetch = (async () => {
      sends++
      return Response.json({ output: 'Too late', results: [] })
    }) as unknown as typeof globalThis.fetch
    const pending = searchOpenAI({ query: 'docs' }, owner)
    await entered
    owner.abortController.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    unlocked?.()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(sends).toBe(0)
  })

  test('bounds response bytes before decoding and keeps provider errors private', async () => {
    globalThis.fetch = (async () => new Response('small body', {
      headers: { 'content-length': String(2 * 1024 * 1024 + 1) },
    })) as unknown as typeof globalThis.fetch
    await expect(searchOpenAI({ query: 'docs' }, context())).rejects.toThrow('size limit')

    globalThis.fetch = (async () => new Response('test-access-main should never appear in an error', { status: 400 })) as unknown as typeof globalThis.fetch
    const failure = await searchOpenAI({ query: 'docs' }, context()).catch(error => error)
    expect(String(failure)).toContain('OpenAI web search request failed')
    expect(String(failure)).not.toContain('test-access-main')
  })

  test.each([
    { payload: '{bad json', message: 'invalid JSON' },
    { payload: JSON.stringify({ output: 'partial', results: {} }), message: 'invalid response' },
  ])('rejects invalid backend responses: $message', async ({ payload, message }) => {
    globalThis.fetch = (async () => new Response(payload)) as unknown as typeof globalThis.fetch
    await expect(searchOpenAI({ query: 'docs' }, context())).rejects.toThrow(message)
  })
})
