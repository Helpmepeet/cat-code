import { describe, expect, test } from 'bun:test'

import { createUserMessage } from '../../utils/messages.js'
import {
  projectProviderFacingMessages,
  userMessageToMessageParam,
} from './claude.js'

const creationOrigin = {
  kind: 'peer' as const,
  name: 'Tanzanite',
  appSessionId: 'app-tanzanite',
  creationPrompt: true as const,
}

describe('peer creation message API projection', () => {
  test('puts the creator and reply channel beside the first instruction', () => {
    const message = createUserMessage({
      content: 'Debate local-first storage and send me your conclusion.',
      origin: creationOrigin,
    })

    expect(userMessageToMessageParam(message, false, false)).toEqual({
      role: 'user',
      content:
        'Tanzanite created this session and sent the instruction below. ' +
        'This is a peer handoff, and Tanzanite is the audience for this task. ' +
        'If you respond to this instruction, use SendToPeer to reply to ' +
        'Tanzanite; ordinary assistant text stays only in this tab and does ' +
        'not reach Tanzanite.\n\n' +
        'Debate local-first storage and send me your conclusion.',
    })
    expect(message.message.content).toBe(
      'Debate local-first storage and send me your conclusion.',
    )
  })

  test('projects the same handoff into the GPT provider message assembly', () => {
    const message = createUserMessage({
      content: 'Debate local-first storage and send me your conclusion.',
      origin: creationOrigin,
    })

    const [projected] = projectProviderFacingMessages([message])
    expect(projected?.message.content).toContain(
      'Tanzanite is the audience for this task',
    )
    expect(projected?.message.content).toContain(
      'use SendToPeer to reply to Tanzanite',
    )
    expect(message.message.content).toBe(
      'Debate local-first storage and send me your conclusion.',
    )
  })

  test('leaves direct and ordinary peer messages unchanged', () => {
    const direct = createUserMessage({ content: 'Explain the tradeoff.' })
    const peer = createUserMessage({
      content:
        '<cross-session-message from="Tanzanite">\nReply now.\n</cross-session-message>',
      origin: {
        kind: 'peer',
        name: 'Tanzanite',
        appSessionId: 'app-tanzanite',
      },
    })

    expect(userMessageToMessageParam(direct, false, false).content).toBe(
      'Explain the tradeoff.',
    )
    expect(userMessageToMessageParam(peer, false, false).content).toBe(
      '<cross-session-message from="Tanzanite">\nReply now.\n</cross-session-message>',
    )
    expect(projectProviderFacingMessages([direct, peer])).toEqual([direct, peer])
  })

  test('preserves content blocks when projecting a cacheable message', () => {
    const message = createUserMessage({
      content: [{ type: 'text', text: 'Review this attachment.' }],
      origin: creationOrigin,
    })

    const projected = userMessageToMessageParam(message, true, false)
    expect(projected.role).toBe('user')
    expect(projected.content).toEqual([
      {
        type: 'text',
        text:
          'Tanzanite created this session and sent the instruction below. ' +
          'This is a peer handoff, and Tanzanite is the audience for this task. ' +
          'If you respond to this instruction, use SendToPeer to reply to ' +
          'Tanzanite; ordinary assistant text stays only in this tab and does ' +
          'not reach Tanzanite.',
      },
      {
        type: 'text',
        text: 'Review this attachment.',
      },
    ])
    expect(message.message.content).toEqual([
      { type: 'text', text: 'Review this attachment.' },
    ])
  })
})
