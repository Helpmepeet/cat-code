import { describe, expect, test } from 'bun:test'
import {
  getAgentModeSystemPromptSections,
  getAgentModeWorkerControlGuidance,
} from './prompts.js'

describe('Agent Mode dynamic prompt guidance', () => {
  test('includes worker-control guidance when worker-control tools are present', async () => {
    const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey ?? 'test-key'

    try {
      const sections = await getAgentModeSystemPromptSections(
        [
          { name: 'Agent' },
          { name: 'ListWorkers' },
          { name: 'WaitWorkers' },
          { name: 'GetWorkerResult' },
          { name: 'CancelWorker' },
        ] as any,
        'claude-sonnet-4-6',
        [],
        [],
      )
      const prompt = sections.join('\n')

      expect(prompt).toContain('Worker control:')
      expect(prompt).toContain('before redundant spawning.')
      expect(prompt).toContain('so convergence is explicit.')
      expect(prompt).toContain('mark results synthesized only after using them.')
      expect(prompt).toContain('no-longer-needed workers.')
      expect(prompt).toContain('Use worker handles instead of raw task IDs')
    } finally {
      if (originalAnthropicApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
      }
    }
  })

  test('omits worker-control guidance when worker-control tools are absent', async () => {
    expect(getAgentModeWorkerControlGuidance(new Set(['Agent']))).toBeNull()
  })
})
