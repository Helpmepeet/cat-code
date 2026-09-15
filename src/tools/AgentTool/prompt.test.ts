import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getBuiltInAgents } from './builtInAgents.js'
import { VERIFICATION_AGENT, VERIFICATION_WHEN_TO_USE } from './built-in/verificationAgent.js'
import { getPrompt } from './prompt.js'

describe('Agent tool prompt', () => {
  const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY
  const originalAgentListInMessages =
    process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES

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

    if (originalAgentListInMessages === undefined) {
      delete process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES
    } else {
      process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES =
        originalAgentListInMessages
    }
  })

  test('advertises normal-mode implementor and verification agent types', async () => {
    process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = 'false'

    const prompt = await getPrompt(
      getBuiltInAgents(),
      false,
      undefined,
      'openai',
    )

    expect(prompt).toContain('- implementor:')
    expect(prompt).toContain('- verification:')
    expect(prompt).toContain('Read-only async verification tools')
    expect(prompt).not.toContain(`- verification: ${VERIFICATION_WHEN_TO_USE} (Tools: All tools except`)
  })

  test('gates normal-mode worker control guidance by caller capabilities', async () => {
    const withoutResume = await getPrompt(
      getBuiltInAgents(),
      false,
      undefined,
      'openai',
      {
        canSendMessage: true,
        canResumeAgent: false,
        canSpawnAgent: false,
        canStopTask: false,
      },
    )
    expect(withoutResume).not.toContain('use ResumeAgent')
    expect(withoutResume).not.toContain('use TaskStop')

    const topLevel = await getPrompt(
      getBuiltInAgents(),
      false,
      undefined,
      'openai',
      {
        canSendMessage: true,
        canResumeAgent: true,
        canSpawnAgent: true,
        canStopTask: true,
      },
    )
    expect(topLevel).toContain('use ResumeAgent')
    expect(topLevel).toContain(
      'use TaskStop with `task_id` set to the `agentId` returned by Agent',
    )
    expect(topLevel).toContain('SendMessage does not cancel it')
  })

  test('does not claim background is required for parallel spawns on GPT', async () => {
    // AgentTool.isConcurrencySafe() is true and toolOrchestration runs a
    // concurrency-safe block as one concurrent batch, so foreground agents
    // emitted in the same turn already run in parallel.
    for (const provider of ['openai', 'anthropic'] as const) {
      const prompt = await getPrompt(
        getBuiltInAgents(),
        false,
        undefined,
        provider,
      )

      expect(prompt).toContain('**Foreground vs background**')
      expect(prompt).not.toContain('REQUIRED for true parallel execution')
      expect(prompt).not.toContain('each with run_in_background: true')
      expect(prompt).toContain(
        `send a single message with multiple ${'Agent'} tool use content blocks. For example`,
      )
    }
  })

  test('routes the "class Foo" example to a content searcher, not Glob', async () => {
    for (const provider of ['openai', 'anthropic'] as const) {
      const prompt = await getPrompt(
        getBuiltInAgents(),
        false,
        undefined,
        provider,
      )

      expect(prompt).toContain(
        'searching for a specific class definition like "class Foo", use the Grep tool',
      )
      expect(prompt).not.toContain(
        'searching for a specific class definition like "class Foo", use the Glob tool',
      )
    }
  })

  test('carries capability-aware delegation boundaries into both caller modes', async () => {
    for (const provider of ['openai', 'anthropic'] as const) {
      for (const isCoordinator of [false, true]) {
        const prompt = await getPrompt([], isCoordinator, undefined, provider)

        expect(prompt).toContain('same capability tier or stronger')
        expect(prompt).toContain('For a weaker worker, narrow the assignment')
        expect(prompt).toContain('Do not infer capability from price alone')
        expect(prompt).toContain('does not expand permissions or the assigned scope')
        expect(prompt).not.toContain('Never delegate understanding')
        expect(prompt).not.toContain('include file paths, line numbers, what specifically to change')
      }
    }
  })

  test('verification keeps evidence, required checks, and verdict contracts across providers', () => {
    for (const mainLoopModel of ['gpt-6-astra', 'gpt-5.6-sol', 'claude-opus-5']) {
      const context = {
        toolUseContext: { options: { mainLoopModel } },
      } as Parameters<typeof VERIFICATION_AGENT.getSystemPrompt>[0]
      const prompt = VERIFICATION_AGENT.getSystemPrompt(context)

      expect(prompt).toContain('Run applicable project-required checks')
      expect(prompt).toContain('Do not create, modify, or delete project files')
      expect(prompt).toContain('Do not claim execution or success from source inspection alone')
      expect(prompt).toContain('an unrelated baseline failure')
      expect(prompt).toContain('PARTIAL: required evidence is missing')
      expect(prompt.match(/^VERDICT: (PASS|FAIL|PARTIAL)$/gm)).toEqual([
        'VERDICT: PASS', 'VERDICT: FAIL', 'VERDICT: PARTIAL',
      ])
      expect(prompt).not.toContain('Test suite results are context, not evidence')
      expect(prompt).not.toContain('At least one adversarial probe has been executed')
      expect(prompt).not.toContain('Failing tests are an automatic FAIL')
    }
  })

})
