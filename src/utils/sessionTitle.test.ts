import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'crypto'
import type { Message } from '../types/message.js'

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
let capturedOptions: any
let capturedTools: any[] = []
let capturedMessages: Message[] = []
let capturedOpenAIInput: Message[] | undefined
let codexResponseText = '{"title":"Fix login bug"}'

function requestText(messages: Message[] = capturedMessages): string {
  return messages
    .flatMap(message => {
      if (message.type !== 'user') return []
      const content = message.message.content
      return typeof content === 'string'
        ? [content]
        : content.flatMap(block => (block.type === 'text' ? [block.text] : []))
    })
    .join('\n')
}

beforeEach(async () => {
  capturedModel = undefined
  capturedProvider = undefined
  capturedOptions = undefined
  capturedTools = []
  capturedMessages = []
  capturedOpenAIInput = undefined
  codexResponseText = '{"title":"Fix login bug"}'
  await mock.module('src/utils/auth.js', () => ({
    ...actualAuth,
    isCodexSubscriber: () =>
      codexSubscriber === null ? realIsCodexSubscriber() : codexSubscriber,
  }))
  await mock.module('src/services/api/claude.js', () => ({
    ...actualClaude,
    queryModelWithoutStreaming: async ({
      options,
      tools,
      messages,
      openAIInstructionAssembly,
    }: any) => {
      capturedModel = options.model
      capturedProvider = options.provider
      capturedOptions = options
      capturedTools = tools
      capturedMessages = messages
      capturedOpenAIInput = openAIInstructionAssembly?.inputMessages
      return {
        type: 'assistant',
        uuid: randomUUID(),
        message: {
          content:
            options.provider === 'openai'
              ? [{ type: 'text', text: codexResponseText }]
              : [
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

describe('generateSessionTitle input budget', () => {
  test.each([false, true])(
    'bounds long title requests with Codex subscription %p',
    async isCodex => {
      codexSubscriber = isCodex
      const { generateSessionTitle } = await import('./sessionTitle.js')
      const original =
        'Fix slow startup\n' +
        'pasted details\n'.repeat(8000) +
        '\nKeep the login flow unchanged'
      const conversation = Object.freeze({ content: original })

      await generateSessionTitle(conversation.content, new AbortController().signal)

      const text = requestText()
      expect(text.length).toBe(4096)
      expect(text.startsWith('Fix slow startup\n')).toBe(true)
      expect(text).toContain('\n...\n')
      expect(text.endsWith('\nKeep the login flow unchanged')).toBe(true)
      expect(conversation.content).toBe(original)
      if (isCodex) {
        expect(capturedOpenAIInput).toBeDefined()
        expect(requestText(capturedOpenAIInput)).toBe(text)
      } else {
        expect(capturedOpenAIInput).toBeUndefined()
      }
    },
  )

  test.each(['fix the login bug', 'a'.repeat(4096)])(
    'preserves trimmed input within the budget (case %#)',
    async description => {
      codexSubscriber = false
      const { generateSessionTitle } = await import('./sessionTitle.js')
      await generateSessionTitle(`  ${description}  `, new AbortController().signal)
      expect(requestText()).toBe(description)
    },
  )

  test('does not split surrogate pairs at either multilingual excerpt boundary', async () => {
    codexSubscriber = false
    const { generateSessionTitle } = await import('./sessionTitle.js')
    const description =
      'a'.repeat(3071) + '🚀' + '中文'.repeat(4000) + '🌍' + 'ข'.repeat(1018)

    await generateSessionTitle(description, new AbortController().signal)

    const text = requestText()
    expect(text).toBe('a'.repeat(3071) + '\n...\n' + 'ข'.repeat(1018))
    expect(text.length).toBeLessThanOrEqual(4096)
    expect(Buffer.from(text, 'utf8').toString('utf8')).toBe(text)
  })

  test.each(['', ' \n\t '])(
    'skips empty input without calling a provider (case %#)',
    async description => {
      codexSubscriber = false
      const { generateSessionTitle } = await import('./sessionTitle.js')
      expect(
        await generateSessionTitle(description, new AbortController().signal),
      ).toBeNull()
      expect(capturedModel).toBeUndefined()
      expect(capturedMessages).toEqual([])
    },
  )
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
    expect(capturedTools).toEqual([])
    expect(capturedOptions.toolChoice).toBeUndefined()
    expect(capturedOptions.outputFormat).toEqual({
      type: 'json_schema',
      schema: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
        additionalProperties: false,
      },
    })
    expect(capturedOptions.effortValue).toBe('low')
  })

  test('rejects malformed native structured output on Codex', async () => {
    codexSubscriber = true
    codexResponseText = 'not json'
    const { generateSessionTitle } = await import('./sessionTitle.js')
    expect(
      await generateSessionTitle(
        'fix the login bug',
        new AbortController().signal,
      ),
    ).toBeNull()
  })

  test('keeps the Anthropic default off the Codex fork', async () => {
    codexSubscriber = false
    const { generateSessionTitle } = await import('./sessionTitle.js')
    const { getDefaultHaikuModel } = await import('./model/model.js')
    await generateSessionTitle('fix the login bug', new AbortController().signal)
    expect(capturedProvider).not.toBe('openai')
    expect(capturedModel).toBe(getDefaultHaikuModel())
    expect(capturedTools).toHaveLength(1)
    expect(capturedOptions.toolChoice).toEqual({
      type: 'tool',
      name: 'StructuredOutput',
    })
    expect(capturedOptions.outputFormat).toBeUndefined()
  })
})
