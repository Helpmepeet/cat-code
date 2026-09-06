import { afterEach, describe, expect, test } from 'bun:test'
import {
  getAgentModeSystemPromptSections,
  getAgentModeWorkerControlGuidance,
  getSystemPrompt,
} from './prompts.js'
import {
  getGPTIntroSection,
  getGPTToneAndStyleSection,
  getGPTUsingToolsSection,
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

  // A requested review is the task itself, not a candidate for delegation. The
  // 2026-08-17 wording only covered "your own work", so a review the session was
  // ASSIGNED fell outside it and was relayed whole to one subagent.
  test('keeps a requested review inline unless the user asks for another agent', () => {
    const reviewRule =
      'Do not spawn a subagent solely to review, verify, critique, or double-check work, whether it is your own or the task the user gave you. Use a review subagent only when the user explicitly asks for another agent; "adversarial", "cold" and "audit" name a method to apply, not a second agent.'
    const delegationReasons =
      'Before spawning, require a concrete reason based on parallelism, context isolation, or explicit user request.'

    expect(promptsSource).toContain(reviewRule)
    expect(promptsSource).toContain(delegationReasons)

    const gptGuidance = getGPTUsingToolsSection(new Set(['Agent']))
    expect(gptGuidance).toContain(reviewRule)
    expect(gptGuidance).toContain(delegationReasons)
  })
})

describe('GPT read discipline guidance', () => {
  test('keeps dedicated-search guidance when embedded search is disabled', () => {
    const savedEmbeddedSearch = process.env.EMBEDDED_SEARCH_TOOLS
    delete process.env.EMBEDDED_SEARCH_TOOLS

    try {
      const guidance = getGPTUsingToolsSection(new Set(['Grep', 'Read']))

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
      const guidance = getGPTUsingToolsSection(new Set(['Bash', 'Read']))

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

describe('GPT section boundaries', () => {
  afterEach(() => {
    clearSystemPromptSections()
  })

  // Each rule has one home. Before the redraw, session guidance carried the
  // proceed/confirm rule, the investigation rule, and the whole delegation
  // block, so an assembly that drops session guidance lost them and the
  // always-present actions section never stated when to proceed alone.
  test('the GPT assembly files each moved rule under the section that owns it', async () => {
    const tools = [
      { name: 'Agent' },
      { name: 'AskUserQuestion' },
      { name: 'Bash' },
      { name: 'Read' },
      { name: 'Grep' },
      { name: 'Apply_patch' },
    ] as unknown as Parameters<typeof getSystemPrompt>[0]

    const prompt = (await getSystemPrompt(tools, 'gpt-5.6-terra')).join('\n')
    const sectionNamed = (heading: string) => {
      const start = prompt.indexOf(`${heading}\n`)
      expect(start).toBeGreaterThan(-1)
      const next = prompt.indexOf('\n# ', start + 1)
      return next === -1 ? prompt.slice(start) : prompt.slice(start, next)
    }

    const actions = sectionNamed('# Acting and Asking')
    expect(actions).toContain('ACT OR ASK:')
    expect(actions).toContain('REQUEST SCOPE:')

    const usingTools = sectionNamed('# Using Your Tools')
    expect(usingTools).toContain('READ DISCIPLINE:')
    expect(usingTools).toContain('AGENT TOOL:')

    const sessionGuidance = sectionNamed('# Session-Specific Guidance')
    expect(sessionGuidance).not.toContain('ACT OR ASK')
    expect(sessionGuidance).not.toContain('INVESTIGATION:')
    expect(sessionGuidance).not.toContain('READ DISCIPLINE:')
    expect(sessionGuidance).not.toContain('AGENT TOOL:')
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

describe('well-known URL homepages', () => {
  test('allows only a directly relevant public service root homepage', async () => {
    const claudePrompt = (await getSystemPrompt([], 'claude-opus-5')).join('\n')
    const gptIntro = getGPTIntroSection(null)
    const rule =
      "You may navigate to a well-known public service's exact root homepage when it directly fits the user's request."
    const boundary =
      'Never infer a deeper path, video link, playlist, search-result URL, account page, purchase page, or another domain.'

    expect(claudePrompt).toContain(rule)
    expect(claudePrompt).toContain(boundary)
    expect(gptIntro).toContain(rule)
    expect(gptIntro).toContain(boundary)
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

describe('session transcript guidance scope', () => {
  afterEach(() => {
    clearSystemPromptSections()
  })

  const transcriptSection = async () => {
    const prompt = (await getSystemPrompt([], 'claude-opus-5')).join('\n')
    const start = prompt.indexOf('## Reading session transcripts')
    expect(start).toBeGreaterThan(-1)
    return prompt.slice(start)
  }

  test('names what the raw files are for instead of offering them as a general way to read sessions', async () => {
    // Desktop sessions carry a tool for reading another session, which resolves
    // who the caller may read, bounds the output, and redacts. This section is
    // in the same prompt and its recipes reach the same bytes with none of
    // that, so it has to say what it is for and defer where a tool exists.
    const section = await transcriptSection()

    expect(section).toContain('forensics on a session id you were given')
    expect(section).toContain('subagents you spawned')
    expect(section).toContain('call that tool')
  })

  test('tells the model to resolve by id rather than to search for sessions it was not pointed at', async () => {
    // The resolve recipe globs every workspace, so without this the shortest
    // route to "what is that other session doing" is a glob over all of them.
    const section = await transcriptSection()

    expect(section).toContain('resolve by id')
    expect(section).toContain('you were not given')
  })

  test('keeps the recipes the real uses need', async () => {
    const section = await transcriptSection()

    expect(section).toContain('~/.cat-code/projects/')
    expect(section).toContain('subagents/agent-')
    expect(section).toContain('.meta.json')
    expect(section).toContain(`Grep '"tool_use_id":"'`)
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
    // into a live mid-session switch. Both prompt builds must opt out, and
    // they now share one registration in buildDynamicPromptSections, so a
    // second registration would mean the duplication came back.
    const registrations = promptsSource.match(/systemPromptSection\(\s*'language',/g)
    expect(registrations?.length).toBe(1)
    const optOuts = promptsSource.match(
      /systemPromptSection\(\s*'language',\s*NO_SECTION_INPUTS\s*,/g,
    )
    expect(optOuts?.length).toBe(1)
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
