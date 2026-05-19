import { describe, expect, test } from 'bun:test'

import { getSendMessageResultTone } from './UI.js'

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
})
