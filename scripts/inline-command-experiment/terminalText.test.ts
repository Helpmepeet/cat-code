import { describe, expect, test } from 'bun:test'
import { interpretTerminal } from './terminalText.js'

describe('bounded terminal output for model context', () => {
  test('interprets overwritten progress and colors rather than stripping escapes', async () => {
    const result = await interpretTerminal(['progress 100%', '\r\x1b[2K\x1b[32mdone\x1b[0m\r\n'])
    expect(result.text).toBe('done')
    expect(result.rawTruncated).toBe(false)
  })

  test('handles split cursor commands and UTF-8 bytes', async () => {
    const bytes = Buffer.from('first\r\nsecond\x1b[1A\r\x1b[2K猫\r\n')
    const result = await interpretTerminal([...bytes].map(byte => Uint8Array.of(byte)))
    expect(result.text).toBe('猫\nsecond')
  })

  test('preserves wrapping without introducing hard newlines', async () => {
    const result = await interpretTerminal(['1234567890abcdefghij!'], { columns: 10 })
    expect(result.text).toBe('1234567890abcdefghij!')
  })

  test('discards clipboard, hyperlinks, shell markers and terminal query replies', async () => {
    const result = await interpretTerminal([
      '\x1b]52;c;c2VjcmV0\x07',
      '\x1b]8;;file:///not-opened\x07label\x1b]8;;\x07',
      '\x1b]133;D;0\x07\x1b]633;E;fake;nonce\x07',
      '\x1b[6n',
    ])
    expect(result.text).toBe('label')
    expect(result.discardedResponseBytes).toBe(0)
  })

  test('returns to normal screen after an alternate-screen program', async () => {
    const result = await interpretTerminal(['before\r\n\x1b[?1049hprogram\x1b[?1049lafter'])
    expect(result.text).toBe('before\nafter')
    expect(result.bufferType).toBe('normal')
  })

  test('retains bounded scrollback and reports raw/text overflow separately', async () => {
    const result = await interpretTerminal(['a\r\nb\r\nc\r\nd\r\ne\r\nf'], { rows: 2, scrollback: 1 })
    expect(result.retainedLines).toBeLessThanOrEqual(3)
    expect(result.text).toBe('d\ne\nf')
    expect(result.historyTruncated).toBe(true)
    const raw = await interpretTerminal(['1234567890', 'hidden'], { maxRawBytes: 10 })
    expect(raw.rawBytes).toBe(10)
    expect(raw.rawTruncated).toBe(true)
    expect(raw.text).toBe('1234567890')
    const text = await interpretTerminal(['猫猫猫'], { maxTextBytes: 7 })
    expect(text.text).toBe('猫猫')
    expect(text.textTruncated).toBe(true)
    expect(Buffer.byteLength(text.text)).toBeLessThanOrEqual(7)
  })

  test('rejects geometry and limits outside the experiment budgets', async () => {
    for (const options of [{ columns: 100_000 }, { rows: -1 }, { scrollback: 10_000 }, { maxRawBytes: Infinity }, { maxTextBytes: 0 }]) {
      await expect(interpretTerminal(['anything'], options)).rejects.toThrow('Invalid')
    }
  })
})
