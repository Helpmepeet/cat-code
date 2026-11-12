import { describe, expect, test } from 'bun:test'
import {
  buildMemoryLines,
  MAX_ENTRYPOINT_BYTES,
  MAX_ENTRYPOINT_LINES,
  truncateEntrypointContent,
} from './memdir.js'
import { TYPES_SECTION_COMBINED } from './memoryTypes.js'

const WARNING_MARKER = '\n\n> WARNING:'

function bodyOf(content: string): string {
  const at = content.indexOf(WARNING_MARKER)
  return at === -1 ? content : content.slice(0, at)
}

describe('memory admission prompt contract', () => {
  const variants = [
    {
      name: 'individual with an index',
      prompt: () => buildMemoryLines('auto memory', '/memories/').join('\n'),
    },
    {
      name: 'individual without an index',
      prompt: () =>
        buildMemoryLines('auto memory', '/memories/', undefined, true).join(
          '\n',
        ),
    },
    {
      name: 'combined private/team taxonomy',
      prompt: () => TYPES_SECTION_COMBINED.join('\n'),
    },
  ]

  for (const variant of variants) {
    test(`${variant.name} applies admission and attribution to all types`, () => {
      const prompt = variant.prompt()
      const admissionAt = prompt.indexOf('## Before saving any memory')
      const typesAt = prompt.indexOf('## Types of memory')
      const admission = prompt.slice(admissionAt, typesAt)

      expect(admissionAt).toBeGreaterThanOrEqual(0)
      expect(typesAt).toBeGreaterThan(admissionAt)
      expect(prompt.match(/## Before saving any memory/g)).toHaveLength(1)
      expect(admission).toContain('For every memory type')
      expect(admission).toContain('future usefulness is unclear, do not save')
      expect(admission).toContain('who said it, when it applies')
      expect(admission).toContain('any reason the user gave')
      expect(admission).toContain('Keep conditional guidance conditional')
      expect(admission).toContain('user explicitly stated')
      expect(admission).toContain('Label any interpretation as an inference')
      expect(admission).toContain('not a user statement')
      expect(admission).toContain('uncertain inferences')
      expect(admission).toContain('Casual approval or lack of pushback')
      expect(admission).toContain('not, by itself, evidence')
      expect(
        prompt.match(/<name>(user|feedback|project|reference)<\/name>/g),
      ).toHaveLength(4)
      expect(prompt).not.toContain('accepting an unusual choice without pushback')
      expect(prompt).toContain('does not save: approval of this PR alone')
      expect(prompt).toContain('user: for future refactors in this area')
      expect(prompt).toContain('Reason: the user finds split reviews harder')
    })
  }

  for (const skipIndex of [false, true]) {
    test(`individual prompt preserves existing safeguards (skipIndex=${skipIndex})`, () => {
      const prompt = buildMemoryLines(
        'auto memory',
        '/memories/',
        undefined,
        skipIndex,
      ).join('\n')

      expect(prompt).toContain('If the user explicitly asks you to remember')
      expect(prompt).toContain('If they ask you to forget')
      expect(prompt).toContain('These exclusions apply even when the user')
      expect(prompt).toContain(
        'When the future scope is unclear, keep it turn-scoped',
      )
      expect(prompt).toContain('including every trigger qualifier')
      expect(prompt).toContain('compare it with existing memories for conflicts')
      expect(prompt).toContain('preserve any non-overlapping conditions')
      expect(prompt).toContain('proceed as if MEMORY.md were empty')
      expect(prompt).toContain('verify first')
      expect(prompt).toContain('type: {{user, feedback, project, reference}}')
    })
  }
})

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
