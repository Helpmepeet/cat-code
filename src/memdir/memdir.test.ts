import { describe, expect, test } from 'bun:test'
import {
  MAX_ENTRYPOINT_BYTES,
  MAX_ENTRYPOINT_LINES,
  truncateEntrypointContent,
} from './memdir.js'

const WARNING_MARKER = '\n\n> WARNING:'

function bodyOf(content: string): string {
  const at = content.indexOf(WARNING_MARKER)
  return at === -1 ? content : content.slice(0, at)
}

describe('truncateEntrypointContent byte cap', () => {
  test('leaves an ASCII index under both caps untouched', () => {
    const raw = Array.from(
      { length: 50 },
      (_, i) => `- [Topic ${i}](topic_${i}.md): one-line hook`,
    ).join('\n')

    const result = truncateEntrypointContent(raw)

    expect(result.content).toBe(raw)
    expect(result.wasLineTruncated).toBe(false)
    expect(result.wasByteTruncated).toBe(false)
    expect(result.byteCount).toBe(Buffer.byteLength(raw, 'utf-8'))
  })

  test('cuts an oversized ASCII index at the last newline before the cap', () => {
    // 150 lines of 200 chars: over the byte cap, under the line cap.
    const raw = Array.from({ length: 150 }, () => 'a'.repeat(200)).join('\n')
    expect(raw.length).toBeGreaterThan(MAX_ENTRYPOINT_BYTES)

    const result = truncateEntrypointContent(raw)
    const body = bodyOf(result.content)

    expect(result.wasLineTruncated).toBe(false)
    expect(result.wasByteTruncated).toBe(true)
    expect(result.byteCount).toBe(30_149)
    // Last newline at or before byte 25000 sits at index 24923 (line 124 of 150).
    expect(body).toBe(raw.slice(0, 24_923))
    expect(body.split('\n')).toHaveLength(124)
  })

  test('truncates a multi-byte index whose code-unit length is under the cap', () => {
    // 100 lines of 100 CJK chars: 10,000 code units but 30,000 bytes.
    const raw = Array.from({ length: 100 }, () => '長'.repeat(100)).join('\n')
    expect(raw.length).toBeLessThan(MAX_ENTRYPOINT_BYTES)
    expect(raw.split('\n').length).toBeLessThan(MAX_ENTRYPOINT_LINES)

    const result = truncateEntrypointContent(raw)
    const body = bodyOf(result.content)

    expect(result.wasByteTruncated).toBe(true)
    expect(result.byteCount).toBe(30_099)
    expect(Buffer.byteLength(body, 'utf-8')).toBeLessThanOrEqual(
      MAX_ENTRYPOINT_BYTES,
    )
    // Last newline at or before byte 25000 ends line 83 of 100.
    expect(body.split('\n')).toHaveLength(83)
    expect(body).toBe(raw.split('\n').slice(0, 83).join('\n'))
    expect(body).not.toInclude('�')
    // The size the user is shown is the real byte count, not code units.
    expect(result.content).toInclude('29.4KB')
  })

  test('does not split a multi-byte character when the cut lands mid-sequence', () => {
    // One newline-free line of 3-byte chars: 25000 is not a multiple of 3, so
    // the byte cap falls inside a character.
    const raw = '長'.repeat(10_000)

    const result = truncateEntrypointContent(raw)
    const body = bodyOf(result.content)

    expect(result.wasByteTruncated).toBe(true)
    expect(result.byteCount).toBe(30_000)
    expect(body).not.toInclude('�')
    expect(body).toBe('長'.repeat(8_333))
    expect(Buffer.byteLength(body, 'utf-8')).toBe(24_999)
  })
})
