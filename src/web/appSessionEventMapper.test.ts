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
          uuid: '00000000-0000-4000-8000-000000000001',
          event: {
            type: 'message_start',
            message: { usage: {} },
          },
        },
      }),
    ).toEqual([])

    const deltaEvent: AppSessionEvent = {
      type: 'message',
      message: {
        type: 'stream_event',
        uuid: '00000000-0000-4000-8000-000000000002',
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

  test('clears stream state after result errors before later assistant text', () => {
    const mapper = createAppSessionEventMapper({
      createId: () => 'assistant-stream-1',
    })

    expect(
      mapper.map({
        type: 'message',
        message: {
          type: 'stream_event',
          uuid: '00000000-0000-4000-8000-000000000003',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'partial' },
          },
        },
      }),
    ).toEqual([
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

    expect(
      mapper.map({
        type: 'message',
        message: {
          type: 'assistant',
          uuid: 'assistant-after-result-error',
          message: {
            content: [{ type: 'text', text: 'next assistant' }],
          },
        },
      }),
    ).toEqual([
      {
        type: 'message.append',
        message: {
          id: 'assistant-after-result-error',
          role: 'assistant',
          content: 'next assistant',
          sdkType: 'assistant',
        },
      },
    ])
  })

  test('clears stream state after abort before later assistant text', () => {
    const mapper = createAppSessionEventMapper({
      createId: () => 'assistant-stream-1',
    })

    expect(
      mapper.map({
        type: 'message',
        message: {
          type: 'stream_event',
          uuid: '00000000-0000-4000-8000-000000000004',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'partial' },
          },
        },
      }),
    ).toEqual([
      {
        type: 'message.delta',
        id: 'assistant-stream-1',
        delta: 'partial',
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

    expect(
      mapper.map({
        type: 'message',
        message: {
          type: 'assistant',
          uuid: 'assistant-after-abort',
          message: {
            content: [{ type: 'text', text: 'next assistant' }],
          },
        },
      }),
    ).toEqual([
      {
        type: 'message.append',
        message: {
          id: 'assistant-after-abort',
          role: 'assistant',
          content: 'next assistant',
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

  test('ignores non-diagnostic system messages in phase 1', () => {
    const mapper = createAppSessionEventMapper({ createId: () => 'generated-1' })

    expect(
      mapper.map({
        type: 'message',
        message: {
          type: 'system',
          subtype: 'post_turn_summary',
          uuid: 'summary-1',
          content: 'internal content',
          summary: 'internal summary',
        },
      }),
    ).toEqual([])
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
        type: 'permission.resolved',
        request: {
          requestId: 'perm-1',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Bash',
            input: { command: 'pwd' },
            tool_use_id: 'toolu_1',
          },
        },
        response: {
          behavior: 'allow',
          updatedInput: { command: 'pwd' },
        },
      }),
    ).toEqual([
      {
        type: 'permission.resolved',
        requestId: 'perm-1',
        response: {
          behavior: 'allow',
          updatedInput: { command: 'pwd' },
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
