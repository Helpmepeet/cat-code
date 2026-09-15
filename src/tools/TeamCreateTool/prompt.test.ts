import { describe, expect, test } from 'bun:test'
import { getPrompt } from './prompt.js'

describe('TeamCreate prompt', () => {
  test('points at the project agents directory the loader reads', () => {
    // markdownConfigLoader walks `.cat-code/<subdir>`, so `.claude/agents/`
    // named a directory nothing loads from.
    const prompt = getPrompt()

    expect(prompt).toContain('`.cat-code/agents/`')
    expect(prompt).not.toContain('.claude/agents/')
  })
})
