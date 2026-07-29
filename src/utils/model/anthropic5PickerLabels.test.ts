import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('Anthropic 5 model picker labels', () => {
  test('shows each current Anthropic model version and keeps default Opus selectable', () => {
    const source = readFileSync(new URL('./modelOptions.ts', import.meta.url), 'utf8')

    expect(source).toContain("label: 'Sonnet 5'")
    expect(source).toContain("label: 'Opus 5'")
    expect(source).toContain("label: 'Fable 5'")
    expect(source).toContain("label: 'Haiku 4.5'")
    expect(source).toMatch(
      /premiumOptions\.push\(getOpus5Option\(\)\)\s*\n\s*premiumOptions\.push\(MaxSonnet5Option\)/,
    )
  })
})
