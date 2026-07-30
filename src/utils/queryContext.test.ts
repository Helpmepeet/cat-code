import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { fetchSystemPromptParts } from './queryContext.js'

const originalAgentMode = process.env.CLAUDE_CODE_AGENT_MODE
const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey ?? 'test-key'
})

afterEach(() => {
  if (originalAgentMode === undefined) {
    delete process.env.CLAUDE_CODE_AGENT_MODE
  } else {
    process.env.CLAUDE_CODE_AGENT_MODE = originalAgentMode
  }
  if (originalAnthropicApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY
  } else {
    process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
  }
})

async function buildPrompt(agentMode: string): Promise<string> {
  process.env.CLAUDE_CODE_AGENT_MODE = agentMode
  const { defaultSystemPrompt, agentModePromptSections } =
    await fetchSystemPromptParts({
      tools: [],
      mainLoopModel: 'claude-sonnet-4-6',
      additionalWorkingDirectories: [],
      mcpClients: [],
      customSystemPrompt: undefined,
    })

  return [...defaultSystemPrompt, ...(agentModePromptSections ?? [])].join('\n')
}

describe('fetchSystemPromptParts Agent Mode truthiness', () => {
  test.each(['yes', 'on', 'TRUE', '1', 'true'])(
    'includes Agent Mode doctrine when CLAUDE_CODE_AGENT_MODE=%s',
    async agentMode => {
      await expect(buildPrompt(agentMode)).resolves.toContain(
        'Agent Mode is the orchestration-focused chat session.',
      )
    },
  )

  test('keeps normal Doing-tasks and Actions sections for a falsy value', async () => {
    const prompt = await buildPrompt('false')

    expect(prompt).toContain('# Doing tasks')
    expect(prompt).toContain('# Executing actions with care')
  })

  test('Doing-tasks stays the discriminator now that Agent Mode also carries Actions', async () => {
    // Agent Mode gained the actions section on 2026-07-30 (risky-action consent
    // is a cross-mode invariant), so Actions no longer separates the two builds.
    const agentModePrompt = await buildPrompt('1')

    expect(agentModePrompt).toContain('# Executing actions with care')
    expect(agentModePrompt).not.toContain('# Doing tasks')
  })
})
