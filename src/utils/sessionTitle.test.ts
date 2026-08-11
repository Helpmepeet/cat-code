import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'crypto'

// generateSessionTitle used to compute its model via getSmallFastModel(),
// which always resolves to the Anthropic Haiku default. On a Codex-only
// account (no Anthropic credentials) every title request was therefore sent
// to the wrong provider, failed, and was silently swallowed by the catch
// block below - new Codex sessions kept the cwd-fallback label forever. The
// fix routes through getSmallFastModelForProvider() instead. Mock
// isCodexSubscriber() to flip providers, and capture the model/provider
// queryModelWithoutStreaming actually receives.

let codexSubscriber: boolean | null = null

const actualAuth = await import('./auth.js')
const realIsCodexSubscriber = actualAuth.isCodexSubscriber

const actualClaude = await import('../services/api/claude.js')

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
        uuid: randomUUID(),
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_test',
              name: 'StructuredOutput',
              input: { title: 'Fix login bug' },
            },
          ],
        },
      }
    },
  }))
})

afterEach(() => {
  codexSubscriber = null
  mock.restore()
})

describe('generateSessionTitle provider routing', () => {
  test('routes to the Codex-compatible model on a Codex subscription', async () => {
    codexSubscriber = true
    const { generateSessionTitle } = await import('./sessionTitle.js')
    const title = await generateSessionTitle(
      'fix the login bug',
      new AbortController().signal,
    )
    expect(title).toBe('Fix login bug')
    expect(capturedProvider).toBe('openai')
    expect(capturedModel).toBe('gpt-5.6-luna')
  })

  test('keeps the Anthropic default off the Codex fork', async () => {
    codexSubscriber = false
    const { generateSessionTitle } = await import('./sessionTitle.js')
    const { getDefaultHaikuModel } = await import('./model/model.js')
    await generateSessionTitle('fix the login bug', new AbortController().signal)
    expect(capturedProvider).not.toBe('openai')
    expect(capturedModel).toBe(getDefaultHaikuModel())
  })
})
