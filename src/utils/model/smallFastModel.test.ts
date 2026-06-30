import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// getSmallFastModelForProvider() routes cheap secondary calls (WebFetch
// post-processing, session titles, hook evaluations) to the GPT mini on the
// Codex/OpenAI fork, where the Anthropic Haiku default has no working
// credentials. It branches on isCodexSubscriber(), so we mock auth.js to flip
// that without needing real Codex tokens or an OpenAI session.

let codexSubscriber = false

beforeEach(async () => {
  const actualAuth = await import('../auth.js')
  await mock.module('src/utils/auth.js', () => ({
    ...actualAuth,
    isCodexSubscriber: () => codexSubscriber,
  }))
})

afterEach(() => {
  codexSubscriber = false
  delete process.env.ANTHROPIC_SMALL_FAST_MODEL
  mock.restore()
})

describe('getSmallFastModelForProvider', () => {
  test('returns the GPT mini on the Codex fork', async () => {
    codexSubscriber = true
    const { getSmallFastModelForProvider } = await import('./model.js')
    expect(getSmallFastModelForProvider()).toBe('gpt-5.4-mini')
  })

  test('falls back to the Anthropic Haiku default off the Codex fork', async () => {
    codexSubscriber = false
    const { getSmallFastModelForProvider, getDefaultHaikuModel } = await import(
      './model.js'
    )
    expect(getSmallFastModelForProvider()).toBe(getDefaultHaikuModel())
  })

  test('respects ANTHROPIC_SMALL_FAST_MODEL on the non-Codex path', async () => {
    codexSubscriber = false
    process.env.ANTHROPIC_SMALL_FAST_MODEL = 'claude-custom-small'
    const { getSmallFastModelForProvider } = await import('./model.js')
    expect(getSmallFastModelForProvider()).toBe('claude-custom-small')
  })

  test('ignores ANTHROPIC_SMALL_FAST_MODEL on the Codex fork', async () => {
    codexSubscriber = true
    process.env.ANTHROPIC_SMALL_FAST_MODEL = 'claude-custom-small'
    const { getSmallFastModelForProvider } = await import('./model.js')
    expect(getSmallFastModelForProvider()).toBe('gpt-5.4-mini')
  })
})
