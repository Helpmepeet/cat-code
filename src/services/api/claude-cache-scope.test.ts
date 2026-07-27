import { describe, expect, test } from 'bun:test'

import { shouldSkipGlobalSystemPromptCache } from './claude.js'

describe('Anthropic global prompt cache ordering', () => {
  test('keeps system blocks out of global scope when built-in tools precede them', () => {
    expect(
      shouldSkipGlobalSystemPromptCache({
        useGlobalCacheFeature: true,
        toolCount: 1,
        extraToolSchemaCount: 0,
        hasAdvisor: false,
      }),
    ).toBe(true)
  })

  test('also covers extra and advisor tool definitions', () => {
    expect(
      shouldSkipGlobalSystemPromptCache({
        useGlobalCacheFeature: true,
        toolCount: 0,
        extraToolSchemaCount: 1,
        hasAdvisor: false,
      }),
    ).toBe(true)
    expect(
      shouldSkipGlobalSystemPromptCache({
        useGlobalCacheFeature: true,
        toolCount: 0,
        extraToolSchemaCount: 0,
        hasAdvisor: true,
      }),
    ).toBe(true)
  })

  test('allows global system scope only when it is a true prefix', () => {
    expect(
      shouldSkipGlobalSystemPromptCache({
        useGlobalCacheFeature: true,
        toolCount: 0,
        extraToolSchemaCount: 0,
        hasAdvisor: false,
      }),
    ).toBe(false)
    expect(
      shouldSkipGlobalSystemPromptCache({
        useGlobalCacheFeature: false,
        toolCount: 3,
        extraToolSchemaCount: 0,
        hasAdvisor: false,
      }),
    ).toBe(false)
  })
})
