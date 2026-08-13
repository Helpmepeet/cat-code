import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getBuiltInAgents } from './builtInAgents.js'
import { VERIFICATION_WHEN_TO_USE } from './built-in/verificationAgent.js'
import { getPrompt } from './prompt.js'

describe('Agent tool prompt in Agent Mode', () => {
  const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY
  const originalAgentMode = process.env.CLAUDE_CODE_AGENT_MODE
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

    if (originalAgentMode === undefined) {
      delete process.env.CLAUDE_CODE_AGENT_MODE
    } else {
      process.env.CLAUDE_CODE_AGENT_MODE = originalAgentMode
    }

    if (originalAgentListInMessages === undefined) {
      delete process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES
    } else {
      process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES =
        originalAgentListInMessages
    }
  })

  test('advertises normal-mode implementor and verification agent types', async () => {
    delete process.env.CLAUDE_CODE_AGENT_MODE
    process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES = 'false'

    const prompt = await getPrompt(
      getBuiltInAgents(),
      false,
      undefined,
      'openai',
      false,
    )

    expect(prompt).toContain('- implementor:')
    expect(prompt).toContain('- verification:')
    expect(prompt).toContain('Read-only async verification tools')
    expect(prompt).not.toContain(`- verification: ${VERIFICATION_WHEN_TO_USE} (Tools: All tools except`)
    expect(prompt).not.toContain('- agent-mode-coding-worker:')
    expect(prompt).not.toContain('- agent-mode-verifier:')
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

  test('omits ResumeAgent guidance when the invoker cannot resume agents', async () => {
    const withoutResume = await getPrompt(
      getBuiltInAgents(),
      false,
      undefined,
      'openai',
      false,
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
      false,
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
})
