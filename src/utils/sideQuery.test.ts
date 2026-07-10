import { describe, expect, mock, test } from 'bun:test'

let capturedBody: Record<string, unknown> | null = null
let capturedClientArgs: Record<string, unknown> | null = null

mock.module('../services/api/client.js', () => ({
  getAnthropicClient: async (args: Record<string, unknown>) => {
    capturedClientArgs = args
    return {
      beta: {
        messages: {
          create: async (body: Record<string, unknown>) => {
            capturedBody = body
            return { content: [], usage: {}, _request_id: 'req_test' }
          },
        },
      },
    }
  },
}))

mock.module('../services/api/claude.js', () => ({
  getAPIMetadata: () => ({}),
}))

function resetCaptures() {
  capturedBody = null
  capturedClientArgs = null
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
})
