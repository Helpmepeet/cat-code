import { describe, expect, test } from 'bun:test'

import { buildMessages, buildUserContent } from './bridge-claude-subscription.ts'

describe('bridge Claude subscription prompt caching', () => {
  test('keeps short candidate-eval prompts as plain text', () => {
    const prompt = 'Solve the following problem step by step.\n\nWhat is 2 + 2?'

    expect(buildUserContent(prompt, true)).toBe(prompt)
  })

  test('adds one cache breakpoint to a long reusable first-user prefix', () => {
    const prefix = `${'stable prefix '.repeat(700)}\n\n`
    const firstPrompt = `${prefix}first problem`
    const secondPrompt = `${prefix}second problem`

    const messages = buildMessages([
      { role: 'user', content: firstPrompt },
      { role: 'user', content: secondPrompt },
    ])

    expect(messages).not.toBeNull()
    const firstContent = messages?.[0]?.content
    const secondContent = messages?.[1]?.content
    expect(Array.isArray(firstContent)).toBe(true)
    expect(Array.isArray(secondContent)).toBe(false)
    if (!Array.isArray(firstContent)) {
      throw new Error('first message content was not split into blocks')
    }
    expect(firstContent).toHaveLength(2)
    expect(firstContent[0]).toMatchObject({
      type: 'text',
      text: prefix,
      cache_control: { type: 'ephemeral' },
    })
    expect(firstContent[1]).toMatchObject({
      type: 'text',
      text: 'first problem',
    })
  })
})
