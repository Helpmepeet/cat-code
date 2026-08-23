import { afterEach, describe, expect, test } from 'bun:test'
import {
  getAgentModeSystemPromptSections,
  getAgentModeWorkerControlGuidance,
  getSystemPrompt,
} from './prompts.js'
import {
  getGPTSessionGuidanceSection,
  getGPTToneAndStyleSection,
} from './promptStyles/gpt.js'
import { clearSystemPromptSections } from './systemPromptSections.js'

describe('Agent Mode dynamic prompt guidance', () => {
  test('uses the orchestrator prompt as the single owner of worker-first guidance', async () => {
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

      expect(prompt).toContain('## Delegation rules')
      expect(prompt).toContain('default to a coding worker')
      expect(prompt).toContain('AGENT MODE: Agent is available for bounded delegated work. Follow the Agent Mode doctrine above.')
      expect(prompt).not.toContain(
        'If the patch touches prompt, session-state, worker-control, or orchestration surfaces, use a coding worker even if it is still one file',
      )
      expect(prompt).toContain(
        'Agent Mode should feel different from normal chat because execution pressure moves outward sooner',
      )
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

      expect(prompt).toContain('before spawning more workers when prior workers may exist.')
      expect(prompt).toContain('after launching parallel workers so convergence is explicit')
      expect(prompt).toContain('synthesized only after actually using it')
      expect(prompt).toContain('no-longer-needed workers.')
      expect(prompt).toContain(
        'Worker-control tools available in this session: ListWorkers, WaitWorkers, GetWorkerResult, CancelWorker.',
      )
      expect(prompt).toContain('Follow the Worker control tools doctrine above.')
      expect(prompt).toContain('Do not both spawn Explore and then keep investigating the same area yourself')
      expect(prompt).toContain('Prefer worker handles over raw task IDs')
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

describe('Normal mode static delegation guidance', () => {
  test('suggests implementor and verification without Agent Mode worker doctrine', () => {
    expect(promptsSource).toContain('available-agent list includes implementor or verification')
    expect(promptsSource).not.toContain(
      'In normal mode, prefer a worker over main-thread execution for any implementation expected to touch multiple files',
    )
  })

  test('keeps routine review inline unless the user requests an independent review', () => {
    const reviewRule =
      'Do not spawn a subagent solely to review, verify, critique, or double-check your own work. Routine self-review should be done directly in the main thread. Use a subagent for an independent review only when the user explicitly requests one.'
    const delegationReasons =
      'Before spawning, require a concrete reason based on parallelism, context isolation, or explicit user request.'

    expect(promptsSource).toContain(reviewRule)
    expect(promptsSource).toContain(delegationReasons)

    const gptGuidance = getGPTSessionGuidanceSection(new Set(['Agent']), [])
    expect(gptGuidance).toContain(reviewRule)
    expect(gptGuidance).toContain(delegationReasons)
  })
})

describe('GPT read discipline guidance', () => {
  test('keeps dedicated-search guidance when embedded search is disabled', () => {
    const savedEmbeddedSearch = process.env.EMBEDDED_SEARCH_TOOLS
    delete process.env.EMBEDDED_SEARCH_TOOLS

    try {
      const guidance = getGPTSessionGuidanceSection(new Set(['Grep', 'Read']), [])

      expect(guidance).toContain('Grep to locate')
      expect(guidance).toContain('head_limit')
    } finally {
      if (savedEmbeddedSearch === undefined) {
        delete process.env.EMBEDDED_SEARCH_TOOLS
      } else {
        process.env.EMBEDDED_SEARCH_TOOLS = savedEmbeddedSearch
      }
    }
  })

  test('does not name removed search tools or their parameters in embedded-search builds', () => {
    const savedEmbeddedSearch = process.env.EMBEDDED_SEARCH_TOOLS
    const savedEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
    process.env.EMBEDDED_SEARCH_TOOLS = '1'
    delete process.env.CLAUDE_CODE_ENTRYPOINT

    try {
      const guidance = getGPTSessionGuidanceSection(
        new Set(['Bash', 'Read']),
        [],
      )

      expect(guidance).toContain('READ DISCIPLINE:')
      expect(guidance).toContain('`find` or `grep` via the Bash tool')
      expect(guidance).not.toContain('Grep')
      expect(guidance).not.toContain('Glob')
      expect(guidance).not.toContain('head_limit')
    } finally {
      if (savedEmbeddedSearch === undefined) {
        delete process.env.EMBEDDED_SEARCH_TOOLS
      } else {
        process.env.EMBEDDED_SEARCH_TOOLS = savedEmbeddedSearch
      }
      if (savedEntrypoint === undefined) {
        delete process.env.CLAUDE_CODE_ENTRYPOINT
      } else {
        process.env.CLAUDE_CODE_ENTRYPOINT = savedEntrypoint
      }
    }
  })

  test('Claude style does not carry the GPT read discipline rule', () => {
    expect(promptsSource).not.toContain('READ DISCIPLINE:')
  })
})

describe('GPT copyable text guidance', () => {
  test('distinguishes shell commands from copyable text', () => {
    const guidance = getGPTToneAndStyleSection()

    expect(guidance).toContain(
      'Shell commands are commands, not copyable text',
    )
    expect(guidance).toContain('```sh fenced code block')
  })
})

describe('mechanical prompt cleanup', () => {
  afterEach(() => {
    clearSystemPromptSections()
  })

  test('uses a provider-neutral transcript tool-result query and has no unused or stale prompt constants', async () => {
    const prompt = (await getSystemPrompt([], 'claude-opus-5')).join('\n')

    expect(prompt).toContain(`Grep '"tool_use_id":"'`)
    expect(prompt).not.toContain(`Grep '"tool_use_id":"call_'`)
    expect(promptsSource).not.toContain('CLAUDE_CODE_DOCS_MAP_URL')
    expect(promptsSource).not.toContain('FRONTIER_MODEL_NAME')
    expect(promptsSource).not.toContain('CLAUDE_4_5_OR_4_6_MODEL_IDS')
    expect(prompt).toContain(
      'The most recent Claude models are the Claude 5 family and Haiku 4.5',
    )
    expect(promptsSource).toContain(
      'In agent threads, a \\`cd\\` applies only to the current Bash call',
    )
  })

  test('transcript guidance names the search surface an embedded-search build actually has', async () => {
    const saved = {
      embedded: process.env.EMBEDDED_SEARCH_TOOLS,
      entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
    }
    process.env.EMBEDDED_SEARCH_TOOLS = '1'
    delete process.env.CLAUDE_CODE_ENTRYPOINT

    try {
      const prompt = (await getSystemPrompt([], 'claude-opus-5')).join('\n')
      const section = prompt.slice(prompt.indexOf('## Reading session transcripts'))

      expect(section).toContain('## Reading session transcripts')
      expect(section).toContain(`grep '"tool_use_id":"'`)
      expect(section).not.toContain('Grep')
      expect(section).not.toContain('Glob')
    } finally {
      if (saved.embedded === undefined) delete process.env.EMBEDDED_SEARCH_TOOLS
      else process.env.EMBEDDED_SEARCH_TOOLS = saved.embedded
      if (saved.entrypoint === undefined)
        delete process.env.CLAUDE_CODE_ENTRYPOINT
      else process.env.CLAUDE_CODE_ENTRYPOINT = saved.entrypoint
    }
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
      /systemPromptSection\(\s*'language',\s*NO_SECTION_INPUTS\s*,/g,
    )
    expect(optOuts?.length).toBe(2)
  })
})

describe('session guidance keying across the two prompt builds', () => {
  afterEach(() => {
    clearSystemPromptSections()
  })

  test('a GPT build is not served the Claude-style guidance cached before it', async () => {
    // session_guidance is the most heavily branched section: it selects among
    // four compute functions on (gpt x agentMode). Warm on Claude, then build
    // GPT. Under name-only keying the GPT build served the Claude text.
    const tools = [
      { name: 'Agent' },
      { name: 'AskUserQuestion' },
      { name: 'Bash' },
    ] as unknown as Parameters<typeof getSystemPrompt>[0]

    const claude = (await getSystemPrompt(tools, 'claude-opus-5')).join('\n')
    const gpt = (await getSystemPrompt(tools, 'gpt-5.6-terra')).join('\n')

    expect(claude).toContain('# Session-specific guidance')
    expect(gpt).toContain('# Session-Specific Guidance')
    expect(gpt).not.toContain('# Session-specific guidance')
  })
})
