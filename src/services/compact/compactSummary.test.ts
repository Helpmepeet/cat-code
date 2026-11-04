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
let streamingRetries: boolean
let fallbackCalls: number
let forkRequests: Parameters<typeof realForkedAgent.runForkedAgent>[0][]
let fallbackRequests: Parameters<typeof realClaudeApi.queryModelWithStreaming>[0][]
let fallbackResponses: AssistantMessage[][] | undefined

const summaryStart = '<analysis>Drafting notes.</analysis>\n<summary>\n1. Constraints: never publish.\n2. Files: important.ts\n5. Tests: '
const summaryEnd = '36 passed.\n6. User requests\n7. Pending tasks\n8. Current work\n9. Next step\n</summary>'

function response(text: string): AssistantMessage {
  return createAssistantMessage({ content: [{ type: 'text', text, citations: [] }] })
}

function request(requireSummaryBlock = false) {
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
    messages: [] as Message[],
    summaryRequest: createUserMessage({
      content: requireSummaryBlock
        ? 'Summarize the conversation inside <summary></summary> tags.'
        : 'Summarize the conversation.',
    }),
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
  streamingRetries = false
  fallbackCalls = 0
  forkRequests = []
  fallbackRequests = []
  fallbackResponses = undefined
  forkMessages = []
  fallbackMessages = []
  mock.module('../analytics/growthbook.js', () => ({
    getFeatureValue_CACHED_MAY_BE_STALE: (key: string, fallback: unknown) =>
      key === 'tengu_compact_cache_prefix'
        ? cacheSharing
        : key === 'tengu_compact_streaming_retry'
          ? streamingRetries
          : fallback,
  }))
  mock.module('../../utils/forkedAgent.js', () => ({
    ...realForkedAgent,
    runForkedAgent: async (params: Parameters<typeof realForkedAgent.runForkedAgent>[0]) => {
      forkRequests.push(params)
      return {
        messages: forkMessages,
        totalUsage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }
    },
  }))
  mock.module('../api/claude.js', () => ({
    ...realClaudeApi,
    queryModelWithStreaming: async function* (params: Parameters<typeof realClaudeApi.queryModelWithStreaming>[0]) {
      fallbackRequests.push(params)
      const responses = fallbackResponses?.[fallbackCalls] ?? fallbackMessages
      fallbackCalls++
      yield* responses
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

  test.each([
    "I'll continue fixing the bug.",
    '<summary>Only the prefix.',
    '<summary>   </summary>',
  ])('corrects a malformed tagged-request fork once: %s', async text => {
    forkMessages = [response(text)]
    fallbackMessages = [response('<summary>Tests passed. Report the result.</summary>')]
    const params = request(true)
    const originalRequest = params.summaryRequest
    const { streamCompactSummary } = await import('./compact.js')

    const result = await streamCompactSummary(params)

    expect(getAssistantMessageText(result)).toContain('Tests passed.')
    expect(forkRequests).toHaveLength(1)
    expect(fallbackCalls).toBe(1)
    expect(JSON.stringify(fallbackRequests[0]!.messages)).toContain(
      'Your previous response did not contain a complete, nonempty summary.',
    )
    expect(params.summaryRequest).toBe(originalRequest)
    expect(JSON.stringify(originalRequest)).not.toContain('Your previous response')
  })

  test('corrects a direct streaming response once without enabling transport retries', async () => {
    cacheSharing = false
    fallbackResponses = [
      [response("I'll continue fixing the bug.")],
      [response('<summary>Fix complete. Tests pending.</summary>')],
    ]
    const { streamCompactSummary } = await import('./compact.js')
    expect(getAssistantMessageText(await streamCompactSummary(request(true)))).toBe(
      '<summary>Fix complete. Tests pending.</summary>',
    )
    expect(fallbackCalls).toBe(2)
    expect(JSON.stringify(fallbackRequests[0]!.messages)).not.toContain('Your previous response')
    expect(JSON.stringify(fallbackRequests[1]!.messages)).toContain('Your previous response')
  })

  test.each([true, false])('fails closed after one correction with cache sharing %s', async sharing => {
    cacheSharing = sharing
    streamingRetries = true
    forkMessages = [response("I'll keep working.")]
    fallbackMessages = [response('<summary></summary>')]
    const params = request(true)
    params.messages.push(createUserMessage({ content: 'Never publish the credentials.' }))
    const originalMessages = [...params.messages]
    const { streamCompactSummary, ERROR_MESSAGE_INCOMPLETE_RESPONSE } = await import('./compact.js')

    await expect(streamCompactSummary(params)).rejects.toThrow(ERROR_MESSAGE_INCOMPLETE_RESPONSE)
    expect(fallbackCalls).toBe(sharing ? 1 : 2)
    expect(params.messages).toEqual(originalMessages)
    expect(JSON.stringify(params.messages)).toContain('Never publish the credentials.')
  })

  test('accepts a complete tagged summary without a retry', async () => {
    forkMessages = [response('<analysis>Notes.</analysis><summary>Tests passed.</summary>')]
    const { streamCompactSummary } = await import('./compact.js')
    expect(getAssistantMessageText(await streamCompactSummary(request(true)))).toContain(
      '<summary>Tests passed.</summary>',
    )
    expect(forkRequests).toHaveLength(1)
    expect(fallbackCalls).toBe(0)
  })

  test.each([true, false])('corrects text-free output with cache sharing %s', async sharing => {
    cacheSharing = sharing
    const thinkingOnly = createAssistantMessage({
      content: [{ type: 'thinking', thinking: 'Drafting.', signature: 'sig' }],
    })
    forkMessages = [thinkingOnly]
    fallbackResponses = sharing
      ? [[response('<summary>Tests pending.</summary>')]]
      : [[thinkingOnly], [response('<summary>Tests pending.</summary>')]]
    const { streamCompactSummary } = await import('./compact.js')
    expect(getAssistantMessageText(await streamCompactSummary(request(true)))).toBe(
      '<summary>Tests pending.</summary>',
    )
    expect(fallbackCalls).toBe(sharing ? 1 : 2)
    expect(JSON.stringify(fallbackRequests.at(-1)!.messages)).toContain('Your previous response')
  })

  test('does not retry a typed API error as a malformed summary', async () => {
    cacheSharing = false
    const failure = response('Request timed out')
    failure.isApiErrorMessage = true
    fallbackMessages = [failure]
    const { streamCompactSummary } = await import('./compact.js')
    expect((await streamCompactSummary(request(true))).isApiErrorMessage).toBe(true)
    expect(fallbackCalls).toBe(1)
    expect(JSON.stringify(fallbackRequests[0]!.messages)).not.toContain('Your previous response')
  })

  test.each([true, false])('does not start requests after cancellation with cache sharing %s', async sharing => {
    cacheSharing = sharing
    const params = request(true)
    params.context.abortController.abort()
    const { streamCompactSummary } = await import('./compact.js')
    await expect(streamCompactSummary(params)).rejects.toThrow()
    expect(forkRequests).toHaveLength(0)
    expect(fallbackCalls).toBe(0)
  })
})
