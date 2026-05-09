import { beforeEach, describe, expect, mock, test } from 'bun:test'

beforeEach(() => {
  mock.restore()
})

async function applyOpenAIMocks() {
  const realProviders = await import('src/utils/model/providers.js')
  const realModel = await import('src/utils/model/model.js')

  await mock.module('src/utils/model/providers.js', () => ({
    ...realProviders,
    getAPIProvider: () => 'openai',
    resolveRequestProvider: () => 'openai',
  }))
  await mock.module('src/utils/model/model.js', () => ({
    ...realModel,
    getMainLoopModel: () => 'gpt-5.4',
    getSmallFastModel: () => 'gpt-5.4-mini',
  }))
}

describe('WebSearchTool OpenAI support', () => {
  test('rejects blocked_domains on OpenAI because OpenAI hosted web_search only supports allowed_domains', async () => {
    await applyOpenAIMocks()

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
    await applyOpenAIMocks()

    const { WebSearchTool } = await import('./WebSearchTool.js')

    expect(WebSearchTool.isEnabled?.()).toBe(true)
  })
})
