import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getPrompt } from './prompt.js'

describe('Agent tool prompt in Agent Mode', () => {
  const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey ?? 'test-key'
    process.env.OPENAI_API_KEY = originalOpenAiApiKey ?? 'test-key'
  })

  afterEach(() => {
    if (originalAnthropicApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
    }

    if (originalOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiApiKey
    }
  })

  test('makes worker-first execution and verifier use more concrete at runtime', async () => {
    const prompt = await getPrompt([], false, undefined, 'openai', true)

    expect(prompt).toContain('prefer a worker over main-thread execution for any implementation expected to touch multiple files')
    expect(prompt).toContain('If the patch touches prompt, session-state, worker-control, or orchestration surfaces, use a coding worker even if it is still one file')
    expect(prompt).toContain('After launching Explore on a question, do not keep doing the same search on the main thread')
    expect(prompt).toContain('A real implementation phase should usually belong to a coding worker, not the orchestrator')
    expect(prompt).toContain('If a coding worker changed more than one file, or changed prompt, session-state, worker-control, or orchestration behavior, use an independent verification worker by default')
    expect(prompt).toContain('prompt, session-state, worker-control, or orchestration behavior changed')
  })
})
