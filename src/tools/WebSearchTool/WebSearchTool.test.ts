import { afterEach, describe, expect, test } from 'bun:test'
import * as React from 'react'

function collectReactText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') {
    return ''
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(collectReactText).join('')
  }
  if (React.isValidElement(node)) {
    return collectReactText(
      (node.props as { children?: React.ReactNode }).children,
    )
  }
  return ''
}

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

  test('caps returned highlight text to the compact request bound', async () => {
    const { _forTest } = await import('./exa.js')
    const oversizedHighlight = 'x'.repeat(1200)

    expect(
      _forTest.parseExaSearchResponse(
        {
          results: [
            {
              title: 'Oversized highlight',
              url: 'https://example.com/docs',
              highlights: [oversizedHighlight],
            },
          ],
        },
        'bounded highlights',
        0.1,
        1,
      ).results[0]?.highlights,
    ).toEqual(['x'.repeat(500)])
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
      results: [{ title: 'Docs', url: 'https://docs.example.com/' }],
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
      new Response('secret account diagnostic', {
        status: 402,
      })) as typeof globalThis.fetch

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

    await expect(
      searchExa({ query: 'cancelled' }, controller.signal),
    ).rejects.toBeInstanceOf(AbortError)
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

    await expect(
      searchExa({ query: 'cancelled' }, controller.signal),
    ).rejects.toBeInstanceOf(AbortError)
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

  test('does not wait for status response bodies before throwing stable errors', async () => {
    const { _forTest } = await import('./exa.js')
    process.env.EXA_API_KEY = 'test-exa-key'
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('secret diagnostic'))
          },
        }),
        { status: 402 },
      )) as typeof globalThis.fetch

    const result = await Promise.race([
      _forTest
        .searchExaWithTimeoutMs(
          { query: 'status body hang' },
          new AbortController().signal,
          10,
        )
        .then(
          () => 'resolved',
          (error: Error) => error.message,
        ),
      new Promise(resolve => setTimeout(() => resolve('still pending'), 100)),
    ])

    expect(result).toBe(
      'Exa search is unavailable because Exa credits or budget are exhausted (HTTP 402).',
    )
  })

  test('applies internal timeout while reading response JSON', async () => {
    const { _forTest } = await import('./exa.js')
    process.env.EXA_API_KEY = 'test-exa-key'
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{'))
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof globalThis.fetch

    const result = await Promise.race([
      _forTest
        .searchExaWithTimeoutMs(
          { query: 'json body hang' },
          new AbortController().signal,
          10,
        )
        .then(
          () => 'resolved',
          (error: Error) => error.message,
        ),
      new Promise(resolve => setTimeout(() => resolve('still pending'), 100)),
    ])

    expect(result).toBe('Exa search timed out after 20s.')
  })

  test('preserves caller cancellation while reading response JSON', async () => {
    const { AbortError } = await import('../../utils/errors.js')
    const { _forTest } = await import('./exa.js')
    process.env.EXA_API_KEY = 'test-exa-key'
    const controller = new AbortController()
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          start(streamController) {
            streamController.enqueue(new TextEncoder().encode('{'))
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof globalThis.fetch

    setTimeout(() => controller.abort(), 10)

    const result = await Promise.race([
      _forTest
        .searchExaWithTimeoutMs({ query: 'json cancel' }, controller.signal, 1000)
        .then(
          () => 'resolved',
          (error: Error) => error,
        ),
      new Promise(resolve => setTimeout(() => resolve('still pending'), 100)),
    ])

    expect(result).toBeInstanceOf(AbortError)
  })
})

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
    expect(
      WebSearchTool.extractSearchText?.({
        query: 'docs',
        results: [],
        durationSeconds: 0,
      }),
    ).toBe('')
  })

  test('keeps WebSearch disabled under essential-traffic-only mode', async () => {
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    process.env.EXA_API_KEY = 'exa-test-key'
    const { WebSearchTool } = await import('./WebSearchTool.js')

    expect(WebSearchTool.isEnabled()).toBe(false)
  })

  test('keeps WebSearch enabled when the Exa key is present', async () => {
    process.env.EXA_API_KEY = 'exa-test-key'
    const { WebSearchTool } = await import('./WebSearchTool.js')

    expect(WebSearchTool.isEnabled()).toBe(true)
  })

  // The key is only read at call time (`exa.ts` `getExaApiKey`), so an
  // unkeyed install used to advertise the tool and then throw on the model's
  // first use of it. Disabled is the honest state.
  test('disables WebSearch when no Exa key is set', async () => {
    delete process.env.EXA_API_KEY
    const { WebSearchTool } = await import('./WebSearchTool.js')

    expect(WebSearchTool.isEnabled()).toBe(false)
  })

  test('treats a blank Exa key as absent', async () => {
    process.env.EXA_API_KEY = '   '
    const { WebSearchTool } = await import('./WebSearchTool.js')

    expect(WebSearchTool.isEnabled()).toBe(false)
  })

  test('keeps WebSearch out of the auto-mode safe allowlist', async () => {
    const { WEB_SEARCH_TOOL_NAME } = await import('./prompt.js')
    const { isAutoModeAllowlistedTool } = await import(
      '../../utils/permissions/classifierDecision.js'
    )

    expect(isAutoModeAllowlistedTool(WEB_SEARCH_TOOL_NAME)).toBe(false)
  })

  test('keeps the existing tool-level permission suggestion', async () => {
    const { WebSearchTool } = await import('./WebSearchTool.js')
    const { WEB_SEARCH_TOOL_NAME } = await import('./prompt.js')

    await expect(
      WebSearchTool.checkPermissions({ query: 'docs' }, {} as never),
    ).resolves.toMatchObject({
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

  test('accepts provider-neutral input fields and rejects invalid bounds/unknown legacy field', async () => {
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
      WebSearchTool.inputSchema.safeParse({ query: 'bad', max_results: 0 })
        .success,
    ).toBe(false)
    expect(
      WebSearchTool.inputSchema.safeParse({ query: 'bad', max_results: 11 })
        .success,
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

    expect(result.content).toContain(
      'Web search results for query: "Exa API docs"',
    )
    expect(result.content).toContain('1. Search API')
    expect(result.content).toContain('URL: https://docs.exa.ai/reference/search')
    expect(result.content).toContain('Use numResults to limit results.')
    expect(result.content).not.toContain('costDollars')
    expect(result.content).not.toContain('requestId')
  })
})

describe('WebSearchTool Exa prompt and UI', () => {
  test('describes compact Exa-era results and removes stale hosted-search wording', async () => {
    const { getLocalMonthYear } = await import('../../constants/common.js')
    const { getWebSearchPrompt } = await import('./prompt.js')

    const prompt = getWebSearchPrompt()

    expect(prompt).toContain(
      'Search the web and use compact results to inform responses.',
    )
    expect(prompt).toContain(
      'Use this for current documentation, package/API references, GitHub or repository docs, changelogs, issue/error lookup, and general web research.',
    )
    expect(prompt).toContain(
      'Results include titles, URLs, dates when available, authors when available, and bounded highlights. Full page text and summaries are not returned in v1.',
    )
    expect(prompt).toContain(
      'Use include_domains when the relevant site is known, such as official docs or GitHub repository documentation.',
    )
    expect(prompt).toContain('Use freshness when recency matters.')
    expect(prompt).toContain(
      'After answering the user\'s question, include a "Sources:" section at the end of your response when WebSearch results informed the answer.',
    )
    expect(prompt).toContain(
      'list relevant URLs from the search results as markdown hyperlinks: [Title](URL).',
    )
    expect(prompt).toContain(
      'Do not cite sources that were not returned by WebSearch or otherwise read with a tool.',
    )
    expect(prompt).toContain(
      'Domain filtering supports include_domains and exclude_domains.',
    )
    expect(prompt).toContain(
      'Freshness supports day, week, month, year, or any.',
    )
    expect(prompt).toContain(
      `The current month is ${getLocalMonthYear()}. Use the current year when searching for recent information, documentation, changelogs, or current events.`,
    )
    expect(prompt).not.toContain('formatted as search result blocks')
    expect(prompt).not.toContain('automatically within a single API call')
    expect(prompt).not.toContain('Web search is only available in the US')
    expect(prompt).not.toContain('include or block specific websites')
  })

  test('renders verbose public Exa input fields', async () => {
    const { renderToolUseMessage } = await import('./UI.js')

    expect(
      renderToolUseMessage(
        {
          query: 'React changelog',
          max_results: 3,
          freshness: 'month',
          include_domains: ['react.dev', 'github.com'],
          exclude_domains: ['w3schools.com'],
        },
        { verbose: true },
      ),
    ).toBe(
      '"React changelog", max results: 3, freshness: month, only including domains: react.dev, github.com, excluding domains: w3schools.com',
    )

    expect(
      renderToolUseMessage(
        {
          query: 'React docs',
          freshness: 'any',
        },
        { verbose: true },
      ),
    ).toBe('"React docs"')
  })

  test('renders Exa result count instead of hosted-search count', async () => {
    const { renderToolResultMessage } = await import('./UI.js')

    const text = collectReactText(
      renderToolResultMessage({
        query: 'Exa docs',
        durationSeconds: 0.25,
        results: [
          {
            title: 'Search API',
            url: 'https://docs.exa.ai/reference/search',
            highlights: ['Use numResults.'],
          },
          {
            title: 'Changelog',
            url: 'https://docs.exa.ai/changelog',
          },
        ],
      }),
    )

    expect(text).toContain('Found 2 results in 250ms')
    expect(text).not.toContain('Did 2 searches')
  })
})
