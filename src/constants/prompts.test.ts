import { describe, expect, test } from 'bun:test'
import {
  getAgentModeSystemPromptSections,
  getAgentModeWorkerControlGuidance,
} from './prompts.js'

describe('Agent Mode dynamic prompt guidance', () => {
  test('includes stronger worker-first guidance for GPT Agent Mode too', async () => {
    const originalOpenAiApiKey = process.env.OPENAI_API_KEY
    const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
    process.env.OPENAI_API_KEY = originalOpenAiApiKey ?? 'test-key'
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
        'gpt-5.5',
        [],
        [],
      )
      const prompt = sections.join('\n')

      expect(prompt).toContain('default execution path for bounded investigation, implementation, and verification slices')
      expect(prompt).toContain('After spawning Explore workers, avoid overlapping repo reads and searches')
      expect(prompt).toContain('If the work is more than a tiny single-file pass, push execution to a worker')
      expect(prompt).toContain('If Explore already owns a question, do not keep doing the same search on the main thread.')
    } finally {
      if (originalOpenAiApiKey === undefined) {
        delete process.env.OPENAI_API_KEY
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiApiKey
      }
      if (originalAnthropicApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
      }
    }
  })

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

      expect(prompt).toContain('before redundant spawning.')
      expect(prompt).toContain('so convergence is explicit.')
      expect(prompt).toContain('synthesized only after')
      expect(prompt).toContain('no-longer-needed workers.')
      expect(prompt).toContain('If Explore already owns a question, do not keep doing the same search on the main thread.')
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
