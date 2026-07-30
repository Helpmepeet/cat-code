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
