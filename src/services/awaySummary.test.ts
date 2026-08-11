import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// generateAwaySummary used to compute its model via getSmallFastModel(),
// which always resolves to the Anthropic Haiku default regardless of the
// active provider - the same bug fixed in src/utils/sessionTitle.ts. On a
// Codex-only account this sent the recap request to the wrong provider and
// it silently failed. Mock isCodexSubscriber() to flip providers, and
// capture the model/provider queryModelWithoutStreaming actually receives.

let codexSubscriber: boolean | null = null

const actualAuth = await import('../utils/auth.js')
const realIsCodexSubscriber = actualAuth.isCodexSubscriber

const actualClaude = await import('./api/claude.js')

let capturedModel: string | undefined
let capturedProvider: string | undefined

beforeEach(async () => {
  capturedModel = undefined
  capturedProvider = undefined
  await mock.module('src/utils/auth.js', () => ({
    ...actualAuth,
    isCodexSubscriber: () =>
      codexSubscriber === null ? realIsCodexSubscriber() : codexSubscriber,
  }))
  await mock.module('src/services/api/claude.js', () => ({
    ...actualClaude,
    queryModelWithoutStreaming: async ({ options }: any) => {
      capturedModel = options.model
      capturedProvider = options.provider
      return {
        type: 'assistant',
        uuid: 'assistant-uuid',
        message: {
          content: [{ type: 'text', text: 'Picking up where you left off.' }],
        },
      }
    },
  }))
})

afterEach(() => {
  codexSubscriber = null
  mock.restore()
})

describe('generateAwaySummary provider routing', () => {
  test('routes to the Codex-compatible model on a Codex subscription', async () => {
    codexSubscriber = true
    const { generateAwaySummary } = await import('./awaySummary.js')
    const { createUserMessage } = await import('../utils/messages.js')
    const summary = await generateAwaySummary(
      [createUserMessage({ content: 'fix the login bug' })],
      new AbortController().signal,
    )
    expect(summary).toBe('Picking up where you left off.')
    expect(capturedProvider).toBe('openai')
    expect(capturedModel).toBe('gpt-5.6-luna')
  })

  test('keeps the Anthropic default off the Codex fork', async () => {
    codexSubscriber = false
    const { generateAwaySummary } = await import('./awaySummary.js')
    const { createUserMessage } = await import('../utils/messages.js')
    const { getDefaultHaikuModel } = await import('../utils/model/model.js')
    await generateAwaySummary(
      [createUserMessage({ content: 'fix the login bug' })],
      new AbortController().signal,
    )
    expect(capturedProvider).not.toBe('openai')
    expect(capturedModel).toBe(getDefaultHaikuModel())
  })
})
