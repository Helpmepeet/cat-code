import { describe, expect, test } from 'bun:test'
import type { AppSessionEvent } from '../app-runtime/sessionEvents.js'
import { createAppSessionEventMapper } from './appSessionEventMapper.js'

describe('createAppSessionEventMapper', () => {
  test('maps assistant text blocks to append messages', () => {
    const mapper = createAppSessionEventMapper({ createId: () => 'generated-1' })
    const event: AppSessionEvent = {
      type: 'message',
      message: {
        type: 'assistant',
        uuid: 'assistant-1',
        message: {
          content: [
            { type: 'text', text: 'hello' },
            { type: 'text', text: ' world' },
          ],
        },
      },
    }

    expect(mapper.map(event)).toEqual([
      {
        type: 'message.append',
        message: {
          id: 'assistant-1',
          role: 'assistant',
          content: 'hello world',
          sdkType: 'assistant',
        },
      },
    ])
  })

  test('ignores tool-only assistant messages in phase 1', () => {
    const mapper = createAppSessionEventMapper({ createId: () => 'generated-1' })
    const event: AppSessionEvent = {
      type: 'message',
      message: {
        type: 'assistant',
        uuid: 'assistant-tool-only',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }],
        },
      },
    }

    expect(mapper.map(event)).toEqual([])
  })

  test('maps stream text deltas and replaces the streamed row with the final assistant text', () => {
    const mapper = createAppSessionEventMapper({
      createId: () => 'assistant-stream-1',
    })

    expect(
      mapper.map({
        type: 'message',
        message: {
          type: 'stream_event',
          uuid: 'stream-start',
          event: {
            type: 'message_start',
            message: { usage: {} },
          },
        },
      } as AppSessionEvent),
    ).toEqual([])

    const deltaEvent: AppSessionEvent = {
      type: 'message',
      message: {
        type: 'stream_event',
        uuid: 'stream-1',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'partial' },
        },
      },
    }

    expect(mapper.map(deltaEvent)).toEqual([
      {
        type: 'message.delta',
        id: 'assistant-stream-1',
        delta: 'partial',
      },
    ])

    expect(
      mapper.map({
        type: 'message',
        message: {
          type: 'assistant',
          uuid: 'assistant-final',
          message: {
            content: [{ type: 'text', text: 'partial final' }],
          },
        },
      }),
    ).toEqual([
      {
        type: 'message.replace',
        message: {
          id: 'assistant-stream-1',
          role: 'assistant',
          content: 'partial final',
          sdkType: 'assistant',
        },
      },
    ])
  })

  test('maps visible system diagnostics to system messages', () => {
    const mapper = createAppSessionEventMapper({ createId: () => 'generated-1' })
    const event: AppSessionEvent = {
      type: 'message',
      message: {
        type: 'system',
        subtype: 'cat_code_account_diagnostic',
        uuid: 'diag-1',
        user_message: 'Account temporarily unavailable.',
      },
    }

    expect(mapper.map(event)).toEqual([
      {
        type: 'message.append',
        message: {
          id: 'diag-1',
          role: 'system',
          content: 'Account temporarily unavailable.',
          sdkType: 'system',
          sdkSubtype: 'cat_code_account_diagnostic',
        },
      },
    ])
  })

  test('maps result errors but ignores success results', () => {
    const mapper = createAppSessionEventMapper({ createId: () => 'generated-1' })

    expect(
      mapper.map({
        type: 'message',
        message: {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'done',
        },
      }),
    ).toEqual([])

    expect(
      mapper.map({
        type: 'message',
        message: {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: 'failed',
        },
      }),
    ).toEqual([
      {
        type: 'message.append',
        message: {
          id: 'result-error',
          role: 'system',
          content: 'failed',
          sdkType: 'result',
          sdkSubtype: 'error_during_execution',
        },
      },
    ])
  })

  test('passes goal, permission, and abort events through as browser events', () => {
    const mapper = createAppSessionEventMapper({ createId: () => 'generated-1' })

    expect(
      mapper.map({
        type: 'goal.snapshot',
        snapshot: null,
      }),
    ).toEqual([{ type: 'goal.snapshot', snapshot: null }])

    expect(
      mapper.map({
        type: 'permission.requested',
        request: {
          requestId: 'perm-1',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Bash',
            input: { command: 'pwd' },
            tool_use_id: 'toolu_1',
          },
        },
      }),
    ).toEqual([
      {
        type: 'permission.requested',
        request: {
          requestId: 'perm-1',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Bash',
            input: { command: 'pwd' },
            tool_use_id: 'toolu_1',
          },
        },
      },
    ])

    expect(
      mapper.map({
        type: 'abort.status',
        abort: { status: 'requested', reason: 'stop' },
      }),
    ).toEqual([
      { type: 'abort.status', abort: { status: 'requested', reason: 'stop' } },
    ])
  })
})
