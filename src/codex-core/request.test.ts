import { describe, expect, test } from 'bun:test'

import { CodexCoreError } from './errors.js'
import {
  buildCodexCoreRequest,
  normalizeCodexCoreMessages,
} from './request.js'

describe('codex-core request builder', () => {
  test('supports legacy input and builds a replayable message list', () => {
    const request = buildCodexCoreRequest(
      {
        accountProfile: 'acct',
        model: 'gpt-5.6-terra',
        input: 'hello',
        systemPrompt: 'Be concise.',
      },
      'gpt-5.6-terra',
      'conv_123',
    )

    expect(request.conversationId).toBe('conv_123')
    expect(request.messagesForNextTurn).toEqual([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'hello' },
    ])
    expect(request.requestBody).toMatchObject({
      model: 'gpt-5.6-terra',
      stream: true,
      _openaiInstructionAssembly: {
        instructions: 'Be concise.',
        inputMessages: [{ role: 'user', content: 'hello' }],
      },
    })
  })

  test('preserves message order and separates instruction prefixes', () => {
    const request = buildCodexCoreRequest(
      {
        accountProfile: 'acct',
        model: 'gpt-5.6-terra',
        messages: [
          { role: 'system', content: 'System A' },
          { role: 'developer', content: 'Developer B' },
          { role: 'user', content: 'Question 1' },
          { role: 'assistant', content: 'Answer 1' },
          { role: 'user', content: 'Question 2' },
        ],
      },
      'gpt-5.6-terra',
      'conv_456',
    )

    expect(request.messagesForNextTurn).toEqual([
      { role: 'system', content: 'System A' },
      { role: 'developer', content: 'Developer B' },
      { role: 'user', content: 'Question 1' },
      { role: 'assistant', content: 'Answer 1' },
      { role: 'user', content: 'Question 2' },
    ])
    expect(request.requestBody).toMatchObject({
      _openaiInstructionAssembly: {
        instructions: 'System A',
        developerContext: 'Developer B',
        inputMessages: [
          { role: 'user', content: 'Question 1' },
          { role: 'assistant', content: 'Answer 1' },
          { role: 'user', content: 'Question 2' },
        ],
      },
    })
  })

  test('rejects invalid message combinations and empty content', () => {
    expect(() =>
      normalizeCodexCoreMessages({
        input: 'hello',
        messages: [{ role: 'user', content: 'world' }],
      }),
    ).toThrow(CodexCoreError)

    expect(() =>
      normalizeCodexCoreMessages({
        messages: [{ role: 'assistant', content: '   ' }],
      }),
    ).toThrow('must be a non-empty string')

    expect(() =>
      buildCodexCoreRequest(
        {
          accountProfile: 'acct',
          model: 'gpt-5.6-terra',
          messages: [{ role: 'assistant', content: 'answer first' }],
        },
        'gpt-5.6-terra',
        'conv_bad',
      ),
    ).toThrow('must start with a user message')
  })
})
