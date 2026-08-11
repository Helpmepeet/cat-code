import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// generateTitleAndBranch used to compute its model via getSmallFastModel(),
// which always resolves to the Anthropic Haiku default regardless of the
// active provider - the same bug fixed in src/utils/sessionTitle.ts. On a
// Codex-only account this sent the CCR title/branch request to the wrong
// provider and it silently fell back to a truncated description + generic
// branch name. Mock isCodexSubscriber() to flip providers, and capture the
// model/provider queryModelWithoutStreaming actually receives.

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
        uuid: 'assistant-uuid',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_test',
              name: 'StructuredOutput',
              input: { title: 'Fix login bug', branch: 'claude/fix-login-bug' },
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

describe('generateTitleAndBranch provider routing', () => {
  test('routes to the Codex-compatible model on a Codex subscription', async () => {
    codexSubscriber = true
    const { generateTitleAndBranch } = await import('./teleport.js')
    const result = await generateTitleAndBranch(
      'fix the login bug',
      new AbortController().signal,
    )
    expect(result).toEqual({
      title: 'Fix login bug',
      branchName: 'claude/fix-login-bug',
    })
    expect(capturedProvider).toBe('openai')
    expect(capturedModel).toBe('gpt-5.6-luna')
  })

  test('keeps the Anthropic default off the Codex fork', async () => {
    codexSubscriber = false
    const { generateTitleAndBranch } = await import('./teleport.js')
    const { getDefaultHaikuModel } = await import('./model/model.js')
    await generateTitleAndBranch('fix the login bug', new AbortController().signal)
    expect(capturedProvider).not.toBe('openai')
    expect(capturedModel).toBe(getDefaultHaikuModel())
  })
})
