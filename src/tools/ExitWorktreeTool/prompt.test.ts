import { describe, expect, test } from 'bun:test'
import { getExitWorktreeToolPrompt } from './prompt.js'

describe('ExitWorktree prompt', () => {
  test('frames exit as apply, discard, or keep isolated result', () => {
    const prompt = getExitWorktreeToolPrompt()

    expect(prompt).toContain('isolated result')
    expect(prompt).toContain('apply, discard, or keep decision support')
    expect(prompt).toContain('Do not make the user manage cleanup mechanics')
    expect(prompt).toContain('Confirm before discarding non-empty work')
  })
})
