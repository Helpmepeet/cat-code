import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'
import { assistantMessageToMessageParam, userMessageToMessageParam } from './claude.js'

const originalApiKey = process.env.ANTHROPIC_API_KEY
beforeEach(() => {
  // Cache-control selection needs an auth mode, not a real account or request.
  process.env.ANTHROPIC_API_KEY = 'serialization-test-key'
})
afterEach(() => {
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = originalApiKey
})

for (const addCache of [false, true]) test(`Anthropic request omits Codex phase while preserving stored history (cache slot ${addCache})`, () => {
  const block = { type: 'text' as const, text: 'The answer.', citations: [], phase: 'final_answer' as const }
  const message = createAssistantMessage({ content: [block] })
  const request = assistantMessageToMessageParam(message, addCache, false)
  expect(request.content).toEqual([{ type: 'text', text: 'The answer.', citations: [] }])
  expect(message.message.content).toEqual([block])
})

for (const replay of [false, true]) {
  for (const addCache of [false, true]) {
    for (const enablePromptCaching of [false, true]) {
      test(`Anthropic Agent result omits nested phase (replay ${replay}, cache slot ${addCache}, caching ${enablePromptCaching})`, () => {
        const result = {
          type: 'tool_result' as const,
          tool_use_id: 'agent-review',
          is_error: false,
          content: [
            { type: 'text' as const, text: 'Review complete.', citations: [], phase: 'final_answer' },
            { type: 'text' as const, text: 'Checking.', phase: 'commentary' },
            { type: 'text' as const, text: 'agentId: reviewer\nmodel: gpt-6.1-sol' },
            { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'image-data' } },
          ],
        }
        const original = createUserMessage({ content: [result] })
        const message = replay ? JSON.parse(JSON.stringify(original)) as typeof original : original
        const before = JSON.stringify(message)
        const request = userMessageToMessageParam(message, addCache, enablePromptCaching)
        expect(request.content).toEqual([{
          ...result,
          content: [
            { type: 'text', text: 'Review complete.', citations: [] },
            { type: 'text', text: 'Checking.' },
            result.content[2],
            result.content[3],
          ],
          ...(addCache && enablePromptCaching ? { cache_control: expect.any(Object) } : {}),
        }])
        expect(JSON.stringify(message)).toBe(before)
        expect(JSON.stringify(request)).not.toContain('"phase"')
        // Repeated serialization of restored history must remain safe too.
        expect(userMessageToMessageParam(message, addCache, enablePromptCaching)).toEqual(request)
      })
    }
  }
}
