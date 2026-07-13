import { describe, expect, test } from 'bun:test'

import { formatBroadcastSummary, getSendMessageResultTone } from './UI.js'

describe('SendMessageTool UI', () => {
  test('renders failures prominently', () => {
    expect(
      getSendMessageResultTone({
        success: false,
        message: 'Agent "worker" is stopped and could not be resumed',
      }),
    ).toBe('error')
  })

  test('highlights successful resume messages', () => {
    expect(
      getSendMessageResultTone({
        success: true,
        message: 'Agent "worker" was stopped; resumed it in the background',
      }),
    ).toBe('success')
  })

  test('leaves normal queued messages quiet', () => {
    expect(
      getSendMessageResultTone({
        success: true,
        message: 'Message queued for delivery',
      }),
    ).toBeUndefined()
  })

  test('summarizes an all-success broadcast', () => {
    expect(
      formatBroadcastSummary({
        success: true,
        message: 'Message broadcast to 2 teammate(s): alice, carol',
        recipients: ['alice', 'carol'],
      }),
    ).toBe('Broadcast: 2 delivered')
  })

  test('summarizes a partial-failure broadcast including failed names', () => {
    expect(
      formatBroadcastSummary({
        success: false,
        message: 'Message broadcast to 2 of 3 teammate(s); failed: bob',
        recipients: ['alice', 'carol'],
        failed_recipients: [{ name: 'bob', error: 'disk full' }],
      }),
    ).toBe('Broadcast: 2 delivered, 1 failed (bob)')
  })
})
