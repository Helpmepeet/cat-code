import { afterEach, describe, expect, test } from 'bun:test'

import { meetsAvailabilityRequirement } from '../commands.js'
import {
  resetStateForTests,
  setIsInteractive,
  setSessionProvider,
} from '../bootstrap/state.js'
import fastCommand from '../commands/fast/index.js'
import usageCommand from '../commands/usage/index.js'
import {
  getFastModeUnavailableReason,
  getFastModeModelDisplay,
  getFastModeModel,
  isFastModeSupportedByModel,
  prefetchFastModeStatus,
} from './fastMode.js'

describe('fast mode', () => {
  afterEach(() => {
    setSessionProvider(null)
    resetStateForTests()
  })

  test('supports Codex GPT models', () => {
    expect(isFastModeSupportedByModel('gpt-5.5')).toBe(true)
    expect(isFastModeSupportedByModel('gpt-5.4')).toBe(true)
    expect(isFastModeSupportedByModel('gpt-5.4-mini')).toBe(false)
  })

  test('uses a Codex fast model for Codex/OpenAI provider sessions', () => {
    setSessionProvider('openai')

    expect(getFastModeModel()).toBe('gpt-5.5')
    expect(getFastModeModelDisplay()).toBe('GPT-5.5')
  })

  test('is available for Codex/OpenAI provider sessions', () => {
    setIsInteractive(true)
    setSessionProvider('openai')

    expect(getFastModeUnavailableReason()).toBeNull()
  })

  test('does not require Anthropic org prefetch for Codex/OpenAI provider sessions', async () => {
    setIsInteractive(true)
    setSessionProvider('openai')

    await prefetchFastModeStatus()

    expect(getFastModeUnavailableReason()).toBeNull()
  })

  test('exposes the fast command for Codex/OpenAI provider sessions without Anthropic auth', () => {
    const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
    const originalOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
    const originalOauthTokenFd =
      process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
    const originalAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN

    try {
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
      delete process.env.ANTHROPIC_AUTH_TOKEN
      setIsInteractive(true)
      setSessionProvider('openai')

      expect(meetsAvailabilityRequirement(fastCommand)).toBe(true)
      expect(
        meetsAvailabilityRequirement({
          ...fastCommand,
          availability: ['claude-ai', 'openai'],
        }),
      ).toBe(true)
    } finally {
      process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
      process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOauthToken
      process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR = originalOauthTokenFd
      process.env.ANTHROPIC_AUTH_TOKEN = originalAnthropicAuthToken
    }
  })

  test('/usage is visible for Codex/OpenAI provider sessions', () => {
    setIsInteractive(true)
    setSessionProvider('openai')

    expect(usageCommand.availability).toEqual(['claude-ai', 'openai'])
    expect(meetsAvailabilityRequirement(usageCommand)).toBe(true)
  })
})
