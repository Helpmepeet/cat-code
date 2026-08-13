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
import { CodexAccountCapError } from '../services/api/codex-fetch-adapter.js'

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
        },
        {
          accountId: 'backup-account',
          accessToken: 'backup-token',
          refreshToken: 'backup-refresh',
          expiresAt: Date.now() + 60_000,
          source: 'config',
          status: 'healthy',
          lastUsedAt: 0,
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
