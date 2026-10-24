import { expect, test } from 'bun:test'
import { createAssistantMessage } from '../../utils/messages.js'
import { assistantMessageToMessageParam } from './claude.js'

for (const addCache of [false, true]) test(`Anthropic request omits Codex phase while preserving stored history (cache slot ${addCache})`, () => {
  const block = { type: 'text' as const, text: 'The answer.', citations: [], phase: 'final_answer' as const }
  const message = createAssistantMessage({ content: [block] })
  const request = assistantMessageToMessageParam(message, addCache, false)
  expect(request.content).toEqual([{ type: 'text', text: 'The answer.', citations: [] }])
  expect(message.message.content).toEqual([block])
})
