import { afterEach, describe, expect, test } from 'bun:test'
import {
  getAgentModeSystemPromptSections,
  getAgentModeWorkerControlGuidance,
  getSystemPrompt,
} from './prompts.js'
import { clearSystemPromptSections } from './systemPromptSections.js'

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
        'gpt-5.6-terra',
        [],
        [],
      )
      const prompt = sections.join('\n')

      expect(prompt).toContain('default execution path for bounded investigation, implementation, and verification slices')
      expect(prompt).toContain('After spawning Explore workers, avoid overlapping repo reads and searches')
      expect(prompt).toContain('If the work is more than a tiny single-file pass, push execution to a worker')
      expect(prompt).toContain('If the patch touches prompt, session-state, worker-control, or orchestration surfaces, use a coding worker even if it is still one file')
      expect(prompt).toContain('Agent Mode should feel more aggressive than normal chat by moving execution outward sooner')
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
      expect(prompt).toContain('Do not both spawn Explore and then keep investigating the same area yourself')
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

const promptsSource = await Bun.file(
  new URL('./prompts.ts', import.meta.url),
).text()

const gptPromptSource = await Bun.file(
  new URL('./promptStyles/gpt.ts', import.meta.url),
).text()

describe('Agent Mode static delegation guidance', () => {
  test('keeps the non-GPT static using-tools section aligned with v2.3 worker defaults', () => {
    expect(promptsSource).toContain('If the patch touches prompt, session-state, worker-control, or orchestration surfaces, use a coding worker even if it is still one file.')
    expect(promptsSource).toContain('A real implementation phase should usually belong to a coding worker, not the orchestrator.')
    expect(promptsSource).toContain('If a coding worker changed more than one file, or changed prompt, session-state, worker-control, or orchestration behavior, use an independent verification worker by default.')
  })

  test('keeps the GPT static delegation section aligned with v2.3 worker defaults', () => {
    expect(gptPromptSource).toContain('If the patch touches prompt, session-state, worker-control, or orchestration surfaces, use a coding worker even if it is still one file.')
    expect(gptPromptSource).toContain('A real implementation phase should usually belong to a coding worker, not the orchestrator.')
    expect(gptPromptSource).toContain('If a coding worker changed more than one file, or changed prompt, session-state, worker-control, or orchestration behavior, use an independent verification worker by default.')
  })
})

describe('Normal mode static delegation guidance', () => {
  test('suggests implementor and verification without Agent Mode worker doctrine', () => {
    expect(promptsSource).toContain('available-agent list includes implementor or verification')
    expect(gptPromptSource).toContain('available-agent list includes implementor or verification')
    expect(promptsSource).not.toContain(
      'In normal mode, prefer a worker over main-thread execution for any implementation expected to touch multiple files',
    )
  })
})

describe('GPT read discipline guidance', () => {
  test('GPT style tells the model to locate then read narrowly and avoid head_limit:0', () => {
    expect(gptPromptSource).toContain('READ DISCIPLINE:')
    expect(gptPromptSource).toContain('never pass head_limit:0')
  })

  test('Claude style does not carry the GPT read discipline rule', () => {
    expect(promptsSource).not.toContain('READ DISCIPLINE:')
  })
})

describe('system prompt section cache keying', () => {
  const withCleanPromptEnv = async (run: () => Promise<void>) => {
    const saved = {
      simple: process.env.CLAUDE_CODE_SIMPLE,
      agentMode: process.env.CLAUDE_CODE_AGENT_MODE,
    }
    delete process.env.CLAUDE_CODE_SIMPLE
    delete process.env.CLAUDE_CODE_AGENT_MODE
    try {
      await run()
    } finally {
      if (saved.simple === undefined) delete process.env.CLAUDE_CODE_SIMPLE
      else process.env.CLAUDE_CODE_SIMPLE = saved.simple
      if (saved.agentMode === undefined)
        delete process.env.CLAUDE_CODE_AGENT_MODE
      else process.env.CLAUDE_CODE_AGENT_MODE = saved.agentMode
    }
  }

  afterEach(() => {
    clearSystemPromptSections()
  })

  test('a provider switch after the cache is warm rebuilds the environment section', async () => {
    // The confirmed A2-i sequence: /context warms the registry on the session
    // model, then `/model gpt-*` switches provider before the first turn. Under
    // name-only keying the GPT turn served the cached Anthropic text.
    await withCleanPromptEnv(async () => {
      const anthropic = (await getSystemPrompt([], 'claude-opus-5')).join('\n')
      const openai = (await getSystemPrompt([], 'gpt-5.6-terra')).join('\n')

      expect(anthropic).toContain('running through the Anthropic provider')
      expect(openai).toContain('running through the OpenAI Codex provider')
    })
  })

  test('a build with additional working directories is not served the cache-warming build without them', async () => {
    // A2-i-b: /context used to warm env_info_simple with partial arguments.
    await withCleanPromptEnv(async () => {
      const withoutDirs = (await getSystemPrompt([], 'claude-opus-5')).join('\n')
      const withDirs = (
        await getSystemPrompt([], 'claude-opus-5', ['/tmp/cat-code-extra-dir'])
      ).join('\n')

      expect(withoutDirs).not.toContain('/tmp/cat-code-extra-dir')
      expect(withDirs).toContain('Additional working directories')
      expect(withDirs).toContain('/tmp/cat-code-extra-dir')
    })
  })
})

describe('language section caching contract', () => {
  test('language stays out of the section key so it applies to new sessions only', () => {
    // H2 ruling: keying language would silently turn "applies next session"
    // into a live mid-session switch. Both prompt builds must opt out.
    const optOuts = promptsSource.match(
      /systemPromptSection\('language', NO_SECTION_INPUTS,/g,
    )
    expect(optOuts?.length).toBe(2)
  })
})
