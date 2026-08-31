import { describe, expect, test } from 'bun:test'
import { getBashPrompt } from './prompt.js'

describe('Bash prompt working-directory guidance', () => {
  test('distinguishes main-session persistence from agent-thread Bash calls', () => {
    for (const provider of ['firstParty', 'openai'] as const) {
      const prompt = getBashPrompt(provider)

      expect(prompt).toContain(
        "The main session's working directory persists between commands",
      )
      expect(prompt).toContain(
        'In agent threads, a `cd` applies only to the current Bash call',
      )
      expect(prompt).toContain(
        "the next call starts in the agent's assigned working directory",
      )
    }
  })
})

describe('Bash prompt commit authority', () => {
  test('honors an explicit repository commit workflow without authorizing push', () => {
    for (const provider of ['firstParty', 'openai'] as const) {
      const prompt = getBashPrompt(provider)

      expect(prompt).toContain(
        'loaded repository instructions explicitly require one as part of the workflow',
      )
      expect(prompt).toContain(
        'stage only the intended paths and do not push unless separately authorized',
      )
    }
  })
})

describe('Bash prompt git section', () => {
  test('ships the trimmed bullet form, not the long inline manual', () => {
    for (const provider of ['anthropic', 'openai'] as const) {
      const prompt = getBashPrompt(provider)

      expect(prompt).toContain('# Git\n')
      expect(prompt).toContain(
        'NEVER skip hooks (--no-verify, --no-gpg-sign) unless explicitly asked',
      )
      expect(prompt).toContain(
        'A failed pre-commit hook means the commit did NOT happen',
      )
      expect(prompt).toContain(
        'NEVER run destructive git commands (push --force, reset --hard, checkout ., restore ., clean -f, branch -D)',
      )
      expect(prompt).toContain(
        'Prefer staging specific named paths over `git add -A`',
      )
      expect(prompt).toContain(
        'Interactive git flags (-i, e.g. git rebase -i, git add -i) are not supported',
      )
      expect(prompt).toContain('Use the `gh` CLI for GitHub work')

      expect(prompt).not.toContain('Git Safety Protocol')
      expect(prompt).not.toContain('# Creating pull requests')
      expect(prompt).not.toContain('# Committing changes with git')
      expect(prompt).not.toContain('gh pr create')
      expect(prompt).not.toContain('HEREDOC')
    }
  })
})
