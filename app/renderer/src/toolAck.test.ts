import { describe, expect, test } from 'bun:test'
import { parseToolAck } from './toolAck.js'

describe('parseToolAck', () => {
  test('reads ResumeAgent’s real success payload as an exact ack', () => {
    const ack = parseToolAck(
      JSON.stringify({
        success: true,
        message:
          'Resumed "@Ramanujan" in the background. Previous context: ~105k / 372k tokens (28%).',
      }),
    )

    expect(ack).not.toBeNull()
    expect(ack?.ok).toBe(true)
    expect(ack?.exact).toBe(true)
    expect(ack?.message).toContain('~105k / 372k tokens (28%)')
  })

  test('carries a failed ack that rode a SUCCESSFUL tool call', () => {
    // ResumeAgentTool.tsx:123-129 — unknown agent, `success:false`, yet the tool
    // call itself completed, so the row status is 'success'. The two must not be
    // conflated; this is the case the card exists to surface.
    const ack = parseToolAck(
      JSON.stringify({
        success: false,
        message: 'No subagent found for "@Ramanujon".',
      }),
    )

    expect(ack?.ok).toBe(false)
    expect(ack?.exact).toBe(true)
  })

  test('an ack with extra fields parses but is NOT exact', () => {
    // SendMessage's MessageOutput adds an optional `routing`. The peek may show
    // the sentence (it hides nothing); replacing the body would drop `routing`.
    const ack = parseToolAck(
      JSON.stringify({
        success: true,
        message: 'Delivered to "@Turing".',
        routing: { sender: 'leader', target: 'Turing' },
      }),
    )

    expect(ack?.ok).toBe(true)
    expect(ack?.exact).toBe(false)
  })

  test('returns null for every shape that is not an ack', () => {
    const notAcks = [
      '',
      'plain stdout, not JSON at all',
      '{unclosed',
      JSON.stringify(null),
      JSON.stringify([{ success: true, message: 'in an array' }]),
      JSON.stringify({ success: true }), // no message
      JSON.stringify({ message: 'no success flag' }),
      JSON.stringify({ success: 'true', message: 'success is a string' }),
      JSON.stringify({ success: true, message: '' }), // empty message
      JSON.stringify({ success: true, message: 42 }),
      // Skill/Config/TaskUpdate: a `success` boolean but no `message` field.
      JSON.stringify({ success: true, taskId: '4', updatedFields: ['status'] }),
    ]

    for (const content of notAcks) {
      expect(parseToolAck(content)).toBeNull()
    }
  })
})
