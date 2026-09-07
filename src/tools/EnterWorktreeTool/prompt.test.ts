import { describe, expect, test } from 'bun:test'
import { getEnterWorktreeToolPrompt } from './prompt.js'

describe('EnterWorktree prompt', () => {
  test('frames worktrees as isolated execution backends', () => {
    const prompt = getEnterWorktreeToolPrompt()

    expect(prompt).toContain('isolated workspace for this attempt')
    expect(prompt).toContain('main workspace untouched')
    expect(prompt).toContain('Use isolation for parallel edits')
    expect(prompt).toContain('Do not ask the user to remember the worktree path or branch')
  })

  test('names the directory worktree.ts actually creates', () => {
    // The prompt said `.claude/worktrees/`; worktreesDir() joins
    // `.cat-code/worktrees`.
    const prompt = getEnterWorktreeToolPrompt()

    expect(prompt).toContain('.cat-code/worktrees/')
    expect(prompt).not.toContain('.claude/worktrees/')
  })
})
