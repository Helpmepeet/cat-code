import { describe, expect, test } from 'bun:test'
import { getEnterWorktreeToolPrompt } from './prompt.js'

describe('EnterWorktree prompt', () => {
  test('frames worktrees as isolated execution backends', () => {
    const prompt = getEnterWorktreeToolPrompt()

    expect(prompt).toContain('isolated workspace for this attempt')
    expect(prompt).toContain('main workspace stays untouched')
    expect(prompt).toContain('Agent Mode')
    expect(prompt).toContain('Do not ask the user to remember the worktree path or branch')
  })
})
