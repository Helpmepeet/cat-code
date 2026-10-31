import { describe, expect, mock, test } from 'bun:test'
import {
  resetCodexLeaseManagerForTest,
  seedCodexLeaseForTest,
  getCodexLeaseForOwner,
} from '../services/api/codexAccountLeaseManager.js'
import {
  resetCodexAccountPoolForTest,
  seedCodexAccountPoolForTest,
} from '../services/api/codexAccountPool.js'
import {
  CodexAccountCapError,
  translateToCodexBody,
} from '../services/api/codex-fetch-adapter.js'
import {
  getSessionSettingsCache,
  resetSettingsCache,
  setSessionSettingsCache,
} from './settings/settingsCache.js'

let capturedBody: Record<string, unknown> | null = null
let capturedClientArgs: Record<string, unknown> | null = null
let createResponse = async () => ({
  content: [],
  usage: {},
  _request_id: 'req_test',
})

mock.module('../services/api/client.js', () => ({
  getAnthropicClient: async (args: Record<string, unknown>) => {
    capturedClientArgs = args
    return {
      beta: {
        messages: {
          create: async (body: Record<string, unknown>) => {
            capturedBody = body
            return createResponse()
          },
        },
      },
    }
  },
}))

mock.module('../services/api/claude.js', () => ({
  getAPIMetadata: () => ({}),
  queryHaiku: async () => ({ message: { content: [] } }),
}))

function resetCaptures() {
  capturedBody = null
  capturedClientArgs = null
  createResponse = async () => ({
    content: [],
    usage: {},
    _request_id: 'req_test',
  })
  resetCodexLeaseManagerForTest()
  resetCodexAccountPoolForTest()
}

describe('sideQuery', () => {
  test('Fast Auto mode reviews apply only to supported GPT review calls, independently of chat speed', async () => {
    const originalSettings = getSessionSettingsCache()
    const originalDisabled = process.env.CLAUDE_CODE_DISABLE_FAST_MODE
    const originalApiKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'synthetic-test-key'
    ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO =
      { VERSION: 'test' }
    const { sideQuery } = await import('./sideQuery.js')
    const cases = [
      { enabled: undefined, chatFast: true, fast: false },
      { enabled: false, chatFast: true, fast: false },
      { enabled: true, chatFast: false, fast: true },
      { enabled: true, chatFast: true, fast: true },
      { enabled: true, chatFast: false, source: 'insights' as const, fast: false },
      { enabled: true, chatFast: true, model: 'claude-sonnet-4-6', fast: false },
      { enabled: true, chatFast: false, model: 'gpt-custom-unsupported', fast: false },
      { enabled: true, chatFast: false, disabled: true, fast: false },
    ]
    try {
      for (const entry of cases) {
        resetCaptures()
        process.env.CLAUDE_CODE_DISABLE_FAST_MODE = entry.disabled ? '1' : '0'
        setSessionSettingsCache({
          settings: { autoModeFastMode: entry.enabled, fastMode: entry.chatFast },
          errors: [],
        })
        const model = entry.model ?? 'gpt-6-luna'
        await sideQuery({
          model,
          provider: model.startsWith('gpt-') ? 'openai' : 'firstParty',
          messages: [{ role: 'user', content: 'Review this synthetic command.' }],
          skipSystemPromptPrefix: true,
          querySource: entry.source ?? 'auto_mode',
          thinking: false,
          reasoningEffort: 'medium',
        })
        expect(capturedBody).not.toBeNull()
        expect(capturedBody?.speed).toBe(entry.fast ? 'fast' : undefined)
        expect(capturedBody?.thinking).toEqual({ type: 'disabled' })
        expect(capturedBody?.output_config).toEqual({ effort: 'medium' })
        if (model.startsWith('gpt-')) {
          const { codexBody } = translateToCodexBody(capturedBody!)
          expect(codexBody.service_tier).toBe(entry.fast ? 'priority' : undefined)
        }
      }
    } finally {
      resetSettingsCache()
      if (originalSettings) setSessionSettingsCache(originalSettings)
      if (originalDisabled === undefined) delete process.env.CLAUDE_CODE_DISABLE_FAST_MODE
      else process.env.CLAUDE_CODE_DISABLE_FAST_MODE = originalDisabled
      if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = originalApiKey
    }
  })

  test('includes OpenAI instruction assembly for Codex-routed requests', async () => {
    resetCaptures()
    process.env.ANTHROPIC_API_KEY = 'test-key'
    ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO =
      { VERSION: 'test' }
    const { sideQuery } = await import('./sideQuery.js')

    await sideQuery({
      model: 'gpt-5.6-terra',
      system: 'Use structured output.',
      messages: [{ role: 'user', content: 'Summarize this.' }],
      skipSystemPromptPrefix: true,
      querySource: 'insights',
    })

    expect(capturedBody).not.toBeNull()
    expect(capturedClientArgs).toMatchObject({
      maxRetries: 0,
      codexLeaseOwnerId: 'main-thread',
      codexLeaseOwnerType: 'main',
    })
    expect(capturedBody).toMatchObject({
      _openaiInstructionAssembly: {
        inputMessages: [{ role: 'user', content: 'Summarize this.' }],
      },
    })
    expect(
      (
        capturedBody?._openaiInstructionAssembly as
          | { instructions?: string }
          | undefined
      )?.instructions,
    ).toContain('Use structured output.')
  })

  test('respects explicit provider override for Claude models', async () => {
    resetCaptures()
    process.env.ANTHROPIC_API_KEY = 'test-key'
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO =
      { VERSION: 'test' }
    try {
      const { sideQuery } = await import('./sideQuery.js')

      await sideQuery({
        model: 'claude-opus-4-6',
        provider: 'firstParty',
        system: 'Extract facets.',
        messages: [{ role: 'user', content: 'Session transcript here.' }],
        skipSystemPromptPrefix: true,
        querySource: 'insights',
      })

      expect(capturedBody).not.toBeNull()
      expect(capturedBody?._openaiInstructionAssembly).toBeUndefined()
      expect(capturedClientArgs).toMatchObject({ provider: 'firstParty' })
    } finally {
      delete process.env.CLAUDE_CODE_USE_OPENAI
    }
  })

  test('forwards provider override even when openai is the session preference', async () => {
    resetCaptures()
    process.env.ANTHROPIC_API_KEY = 'test-key'
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO =
      { VERSION: 'test' }
    try {
      const { sideQuery } = await import('./sideQuery.js')

      await sideQuery({
        model: 'claude-sonnet-4-6',
        provider: 'firstParty',
        system: 'Generate section insight.',
        messages: [{ role: 'user', content: 'Aggregated data.' }],
        skipSystemPromptPrefix: true,
        querySource: 'insights',
      })

      expect(capturedBody).not.toBeNull()
      expect(capturedBody?._openaiInstructionAssembly).toBeUndefined()
      expect(capturedClientArgs).toMatchObject({ provider: 'firstParty' })
    } finally {
      delete process.env.CLAUDE_CODE_USE_OPENAI
    }
  })

  test('uses the existing subagent lease and fails over Codex side queries on a cap', async () => {
    resetCaptures()
    ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO =
      { VERSION: 'test' }
    seedCodexAccountPoolForTest({
      activeAccountId: 'primary-account',
      accounts: [
        {
          accountId: 'primary-account',
          accessToken: 'primary-token',
          refreshToken: 'primary-refresh',
          expiresAt: Date.now() + 60_000,
          source: 'config',
          status: 'healthy',
          lastUsedAt: 0,
          credentialGeneration: 0,
          credentialGenerationState: 'legacy_unbound',
        },
        {
          accountId: 'backup-account',
          accessToken: 'backup-token',
          refreshToken: 'backup-refresh',
          expiresAt: Date.now() + 60_000,
          source: 'config',
          status: 'healthy',
          lastUsedAt: 0,
          credentialGeneration: 0,
          credentialGenerationState: 'legacy_unbound',
        },
      ],
    })
    seedCodexLeaseForTest({
      ownerId: 'memory-agent',
      ownerType: 'subagent',
      ownerLabel: 'Memory agent',
      accountId: 'primary-account',
    })

    let attempts = 0
    createResponse = async () => {
      attempts += 1
      if (attempts === 1) {
        throw new CodexAccountCapError('primary-account')
      }
      return { content: [], usage: {}, _request_id: 'req_failover' }
    }
    const { sideQuery } = await import('./sideQuery.js')

    await sideQuery({
      model: 'gpt-5.6-terra',
      messages: [{ role: 'user', content: 'Find memories.' }],
      skipSystemPromptPrefix: true,
      querySource: 'memdir_relevance',
      agentId: 'memory-agent',
      maxRetries: 0,
    })

    expect(attempts).toBe(2)
    expect(capturedClientArgs).toMatchObject({
      maxRetries: 0,
      codexLeaseOwnerId: 'memory-agent',
      codexLeaseOwnerType: 'subagent',
    })
    expect(getCodexLeaseForOwner('memory-agent')?.accountId).toBe(
      'backup-account',
    )
  })
})
