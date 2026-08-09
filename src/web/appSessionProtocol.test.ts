import { describe, expect, test } from 'bun:test'
import {
  appClientMessageSchema,
  appServerMessageSchema,
} from './appSessionProtocol.js'

describe('app session web protocol', () => {
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
        prompt: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'A',
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

  test('accepts ready, ack, error, and event envelopes', () => {
    expect(
      appServerMessageSchema.parse({
        type: 'app.ready',
        protocolVersion: 1,
        inputEnabled: true,
        activeTurn: false,
        abort: { status: 'idle' },
        goalSnapshot: null,
        pendingPermissionRequests: [],
      }),
    ).toMatchObject({ type: 'app.ready', inputEnabled: true })

    expect(
      appServerMessageSchema.parse({
        type: 'app.ack',
        requestId: 'submit-1',
      }),
    ).toEqual({ type: 'app.ack', requestId: 'submit-1' })

    expect(
      appServerMessageSchema.parse({
        type: 'app.error',
        requestId: 'submit-1',
        code: 'turn_already_running',
        message: 'Session turn already running',
        retryable: true,
      }),
    ).toMatchObject({ type: 'app.error', retryable: true })

    expect(
      appServerMessageSchema.parse({
        type: 'app.event',
        event: {
          type: 'abort.status',
          abort: { status: 'requested', reason: 'stop' },
        },
      }),
    ).toMatchObject({ type: 'app.event' })
  })

  test('rejects malformed server messages', () => {
    expect(() =>
      appServerMessageSchema.parse({
        type: 'app.ready',
        protocolVersion: 1,
        inputEnabled: true,
        abort: { status: 'idle' },
        pendingPermissionRequests: [],
      }),
    ).toThrow()

    expect(() =>
      appServerMessageSchema.parse({
        type: 'app.ready',
        protocolVersion: 1,
        inputEnabled: true,
        activeTurn: false,
        abort: { status: 'idle' },
        goalSnapshot: null,
        pendingPermissionRequests: [undefined],
      }),
    ).toThrow()

    expect(() =>
      appServerMessageSchema.parse({
        type: 'app.event',
        event: {
          type: 'goal.snapshot',
        },
      }),
    ).toThrow()

    expect(() =>
      appServerMessageSchema.parse({
        type: 'app.event',
        event: {
          type: 'permission.requested',
        },
      }),
    ).toThrow()

    expect(() =>
      appServerMessageSchema.parse({
        type: 'app.event',
        event: {
          type: 'permission.resolved',
          requestId: 'perm-1',
          response: { behavior: 'allow' },
        },
      }),
    ).toThrow()
  })
})
