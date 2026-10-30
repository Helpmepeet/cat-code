import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { createAssistantMessage, createUserMessage, getAssistantMessageText } from '../../utils/messages.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import * as realClaudeApi from '../api/claude.js'
import * as realForkedAgent from '../../utils/forkedAgent.js'
import { formatCompactSummary, getCompactUserSummaryMessage } from './prompt.js'

let forkMessages: Message[]
let fallbackMessages: AssistantMessage[]
let cacheSharing: boolean
let fallbackCalls: number

const summaryStart = '<analysis>Drafting notes.</analysis>\n<summary>\n1. Constraints: never publish.\n2. Files: important.ts\n5. Tests: '
const summaryEnd = '36 passed.\n6. User requests\n7. Pending tasks\n8. Current work\n9. Next step\n</summary>'

function response(text: string): AssistantMessage {
  return createAssistantMessage({ content: [{ type: 'text', text, citations: [] }] })
}

function request() {
  const context = {
    options: {
      tools: [],
      mainLoopModel: 'gpt-6.1-sol',
      mainLoopProvider: 'openai',
      agentDefinitions: { activeAgents: [], allowedAgentTypes: [] },
      isNonInteractiveSession: true,
    },
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: { mode: 'default' } }),
  } as unknown as ToolUseContext
  return {
    messages: [],
    summaryRequest: createUserMessage({ content: 'Summarize the conversation.' }),
    appState: context.getAppState(),
    context,
    preCompactTokenCount: 100,
    cacheSafeParams: {
      systemPrompt: asSystemPrompt(['system']),
      userContext: {},
      systemContext: {},
      toolUseContext: context,
      forkContextMessages: [],
    } satisfies CacheSafeParams,
  }
}

function recoveryNotice(): Message {
  return { type: 'system', subtype: 'transport_recovery' } as Message
}

beforeEach(() => {
  cacheSharing = true
  fallbackCalls = 0
  forkMessages = []
  fallbackMessages = []
  mock.module('../analytics/growthbook.js', () => ({
    getFeatureValue_CACHED_MAY_BE_STALE: (key: string, fallback: unknown) =>
      key === 'tengu_compact_cache_prefix' ? cacheSharing : fallback,
  }))
  mock.module('../../utils/forkedAgent.js', () => ({
    ...realForkedAgent,
    runForkedAgent: async () => ({
      messages: forkMessages,
      totalUsage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }),
  }))
  mock.module('../api/claude.js', () => ({
    ...realClaudeApi,
    queryModelWithStreaming: async function* () {
      fallbackCalls++
      yield* fallbackMessages
    },
  }))
})

afterEach(() => {
  mock.restore()
})

describe('compaction summary response assembly', () => {
  test('keeps the summary prefix after a transport continuation', async () => {
    const first = response(summaryStart)
    const last = response(summaryEnd)
    forkMessages = [first, recoveryNotice(), last]
    const { streamCompactSummary } = await import('./compact.js')
    const result = await streamCompactSummary(request())
    const text = getAssistantMessageText(result)!
    const installed = getCompactUserSummaryMessage(text, false, undefined, false, 'openai')

    expect(formatCompactSummary(text)).toBe(formatCompactSummary(summaryStart + summaryEnd))
    expect(installed).toContain('1. Constraints: never publish.')
    expect(installed).toContain('2. Files: important.ts')
    expect(installed).toContain('5. Tests: 36 passed.')
    expect(installed).toContain('9. Next step')
    expect(installed).not.toContain('Drafting notes.')
    expect(installed).not.toContain('</summary>')
    expect(result.uuid).toBe(last.uuid)
    expect(getAssistantMessageText(first)).toBe(summaryStart.trim())
    expect(getAssistantMessageText(last)).toBe(summaryEnd)
    expect(fallbackCalls).toBe(0)
  })

  test('preserves whitespace and text split inside a word across two recoveries', async () => {
    forkMessages = [
      response('<summary>Never pub'),
      recoveryNotice(),
      response('lish.\nKeep '),
      recoveryNotice(),
      response(' the pending work.</summary>'),
    ]
    const { streamCompactSummary } = await import('./compact.js')
    const result = await streamCompactSummary(request())
    expect(getAssistantMessageText(result)).toBe('<summary>Never publish.\nKeep  the pending work.</summary>')
    expect(fallbackCalls).toBe(0)
  })

  test('assembles separate text content blocks around thinking-only messages', async () => {
    forkMessages = [
      response('<analysis>Notes.</analysis>'),
      createAssistantMessage({ content: [{ type: 'thinking', thinking: 'private', signature: 'sig' }] }),
      response('<summary>Preserved '),
      response('constraint.</summary>'),
    ]
    const { streamCompactSummary } = await import('./compact.js')
    const result = await streamCompactSummary(request())
    expect(formatCompactSummary(getAssistantMessageText(result)!)).toBe('Summary:\nPreserved constraint.')
    expect(getAssistantMessageText(result)).not.toContain('private')
  })

  test('uses a complete replacement summary if the continuation restarts it', async () => {
    forkMessages = [response(summaryStart), recoveryNotice(), response('<summary>Complete replacement.</summary>')]
    const { streamCompactSummary } = await import('./compact.js')
    const result = await streamCompactSummary(request())
    expect(formatCompactSummary(getAssistantMessageText(result)!)).toBe('Summary:\nComplete replacement.')
    expect(fallbackCalls).toBe(0)
  })

  test('does not accept a prefix when continuation ends with a typed error', async () => {
    const failure = response('Request timed out')
    failure.isApiErrorMessage = true
    forkMessages = [response('<summary>Do not install this prefix.'), recoveryNotice(), failure]
    fallbackMessages = [failure]
    const { streamCompactSummary } = await import('./compact.js')
    const result = await streamCompactSummary(request())
    expect(result.isApiErrorMessage).toBe(true)
    expect(getAssistantMessageText(result)).toBe('Request timed out')
    expect(fallbackCalls).toBe(1)
  })

  test.each(['API Error: connection failed', 'Prompt is too long'])(
    'does not hide a terminal legacy error behind earlier text: %s',
    async text => {
      forkMessages = [response('Earlier partial text.'), recoveryNotice(), response(text)]
      const { streamCompactSummary } = await import('./compact.js')
      expect(getAssistantMessageText(await streamCompactSummary(request()))).toBe(text)
    },
  )

  test.each([
    'Only the suffix.</summary>',
    '<summary>Only the prefix.',
    '<analysis>Unfinished drafting notes.',
    '<summary></summary>',
  ])('rejects incomplete tagged output instead of returning it: %s', async text => {
    forkMessages = [response(text)]
    fallbackMessages = [response(text)]
    const { streamCompactSummary, ERROR_MESSAGE_INCOMPLETE_RESPONSE } = await import('./compact.js')
    await expect(streamCompactSummary(request())).rejects.toThrow(ERROR_MESSAGE_INCOMPLETE_RESPONSE)
    expect(fallbackCalls).toBe(1)
  })

  test('assembles the direct streaming fallback without losing earlier blocks', async () => {
    cacheSharing = false
    fallbackMessages = [response(summaryStart), response(summaryEnd)]
    const { streamCompactSummary } = await import('./compact.js')
    const result = await streamCompactSummary(request())
    expect(formatCompactSummary(getAssistantMessageText(result)!)).toBe(formatCompactSummary(summaryStart + summaryEnd))
    expect(fallbackCalls).toBe(1)
  })

  test('keeps untagged single-response summaries compatible', async () => {
    forkMessages = [response('A plain-text summary with the pending work.')]
    const { streamCompactSummary } = await import('./compact.js')
    expect(getAssistantMessageText(await streamCompactSummary(request()))).toBe('A plain-text summary with the pending work.')
    expect(fallbackCalls).toBe(0)
  })
})
