import { expect, test } from 'bun:test'
import { buildDebugExport } from './appModel.js'
import type { RawMessageSessionLog } from './rawMessageLog.js'

/**
 * Finding 9 (2026-08-19 transcript message-visibility review): the export puts a
 * COMPLETE projected transcript next to a raw dump that is capped per session,
 * so on a long session the two sections cover different spans. That is correct
 * behaviour and it read as a broken export, because nothing said so.
 */

function log(overrides: Partial<RawMessageSessionLog> = {}): RawMessageSessionLog {
  return {
    inputEnabled: true,
    messages: [{ type: 'result', subtype: 'success' }],
    retainedBytes: 42,
    truncated: false,
    error: null,
    messageBytes: [42],
    ...overrides,
  }
}

test('a truncated export says why its two sections disagree', () => {
  const text = buildDebugExport([], log({ truncated: true }))

  expect(text).toContain('Raw retention: TRUNCATED')
  expect(text).toContain(
    'Expect this section to be SHORTER than the projected transcript above.',
  )
  expect(text).toContain('capped per session')
  expect(text).toContain('not a bug')
})

// Nothing disagrees when the whole log survives, so the explanation would be
// noise. The complete branch stays byte-identical to what it always emitted.
test('a complete export adds nothing', () => {
  const text = buildDebugExport([], log())

  expect(text).toContain('Raw retention: complete')
  expect(text).not.toContain('Expect this section to be SHORTER')
  expect(text).toContain(
    'Raw retention: complete (42 UTF-8 JSON bytes retained)\n\n```json',
  )
})
