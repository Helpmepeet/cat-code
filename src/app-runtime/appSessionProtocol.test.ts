import { describe, expect, test } from 'bun:test'
import { appClientMessageSchema } from './appSessionProtocol.js'

describe('app session protocol', () => {
  test('rejects oversized image, aggregate, count and UTF-8 text budgets', () => {
    const image = (length = 4) => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(length) },
    })
    for (const prompt of [
      [image(5 * 1024 * 1024 + 4)],
      [image(5 * 1024 * 1024), image(5 * 1024 * 1024), image()],
      Array.from({ length: 6 }, () => image()),
      '界'.repeat(32 * 1024 + 1),
      [image(), { type: 'text', text: '界'.repeat(32 * 1024) }, { type: 'text', text: 'x' }],
      [{ ...image(), extra: 'x'.repeat(1024 * 1024) }],
    ]) {
      expect(appClientMessageSchema.safeParse({
        type: 'app.submit', requestId: 'budget', prompt,
      }).success).toBe(false)
    }
  })

  test('accepts two large inline images without spending the text budget', () => {
    const image = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(2 * 1024 * 1024) },
    }
    expect(appClientMessageSchema.safeParse({
      type: 'app.submit',
      requestId: 'large-images',
      prompt: [image, image, { type: 'text', text: 'a'.repeat(96 * 1024) }],
    }).success).toBe(true)
  })

  test('accepts submit, abort, ping, and permission response messages', () => {
    expect(
      appClientMessageSchema.parse({
        type: 'app.submit',
        requestId: 'submit-1',
        prompt: 'hello',
      }),
    ).toEqual({
      type: 'app.submit',
      requestId: 'submit-1',
      prompt: 'hello',
    })

    expect(
      appClientMessageSchema.parse({
        type: 'app.abort',
        requestId: 'abort-1',
        reason: 'user clicked stop',
      }),
    ).toMatchObject({ type: 'app.abort', requestId: 'abort-1' })

    expect(
      appClientMessageSchema.parse({
        type: 'app.ping',
        nonce: 'nonce-1',
      }),
    ).toEqual({ type: 'app.ping', nonce: 'nonce-1' })

    expect(
      appClientMessageSchema.parse({
        type: 'permission.response',
        requestId: 'perm-1',
        response: {
          behavior: 'allow',
          updatedInput: { command: 'pwd' },
        },
      }),
    ).toMatchObject({
      type: 'permission.response',
      requestId: 'perm-1',
      response: { behavior: 'allow' },
    })
  })

  test('rejects malformed client messages', () => {
    expect(() =>
      appClientMessageSchema.parse({
        type: 'app.submit',
        prompt: '',
      }),
    ).toThrow()

    expect(() =>
      appClientMessageSchema.parse({
        type: 'permission.response',
        requestId: 'perm-1',
        response: { behavior: 'allow' },
      }),
    ).toThrow()
  })

  test('accepts bounded image prompts and rejects malformed image blocks', () => {
    const prompt = [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'AAAA',
        },
      },
      { type: 'text', text: 'What is in this image?' },
    ]
    expect(
      appClientMessageSchema.parse({
        type: 'app.submit',
        requestId: 'submit-image',
        prompt,
      }),
    ).toMatchObject({ type: 'app.submit', prompt })

    expect(() =>
      appClientMessageSchema.parse({
        type: 'app.submit',
        requestId: 'submit-image',
        prompt: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'not base64!',
            },
          },
        ],
      }),
    ).toThrow()
    expect(() =>
      appClientMessageSchema.parse({
        type: 'app.submit',
        requestId: 'submit-image',
        prompt: [{ type: 'text', text: 'array text only' }],
      }),
    ).toThrow()
  })
})
