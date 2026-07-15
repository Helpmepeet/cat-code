import { describe, expect, test } from 'bun:test'
// Establishes the same module load order the running app uses before any
// built-in agent module is imported standalone; importing an agent module
// first (bypassing this) hits a pre-existing TDZ in the tool-prompt import
// graph (e.g. GrepTool/prompt.ts, FileWriteTool/prompt.ts) that production
// never reaches because tools.ts always loads first at startup.
import '../../../tools.js'
import type { BuiltInAgentDefinition } from '../loadAgentsDir.js'
import { EXPLORE_AGENT } from './exploreAgent.js'
import { GENERAL_PURPOSE_AGENT } from './generalPurposeAgent.js'
import { IMPLEMENTOR_AGENT } from './implementorAgent.js'
import { MAP_ROUTING_GUIDANCE } from './mapRoutingGuidance.js'
import { PLAN_AGENT } from './planAgent.js'

const ROUTING_AGENTS = [
  GENERAL_PURPOSE_AGENT,
  PLAN_AGENT,
  IMPLEMENTOR_AGENT,
] as const

function renderPrompt(
  agent: BuiltInAgentDefinition,
  model: string,
  provider: 'firstParty' | 'openai',
): string {
  return agent.getSystemPrompt({
    toolUseContext: {
      options: {
        mainLoopModel: model,
        mainLoopProvider: provider,
      },
    },
  } as Parameters<BuiltInAgentDefinition['getSystemPrompt']>[0])
}

describe('built-in agent map routing guidance', () => {
  test('renders the shared contract in both provider branches of every routing agent', () => {
    for (const agent of ROUTING_AGENTS) {
      const openaiPrompt = renderPrompt(agent, 'gpt-5.6-luna', 'openai')
      const anthropicPrompt = renderPrompt(
        agent,
        'claude-sonnet-4-6',
        'firstParty',
      )

      expect(openaiPrompt).not.toBe(anthropicPrompt)
      expect(openaiPrompt).toContain(MAP_ROUTING_GUIDANCE)
      expect(anthropicPrompt).toContain(MAP_ROUTING_GUIDANCE)
    }
  })

  test('keeps project conventions out of both Explore provider branches', () => {
    expect(EXPLORE_AGENT.omitClaudeMd).toBe(true)
    expect(
      renderPrompt(EXPLORE_AGENT, 'gpt-5.6-luna', 'openai'),
    ).not.toContain(MAP_ROUTING_GUIDANCE)
    expect(
      renderPrompt(EXPLORE_AGENT, 'claude-sonnet-4-6', 'firstParty'),
    ).not.toContain(MAP_ROUTING_GUIDANCE)
  })

  test('guidance is portable while preserving conditional map-first routing', () => {
    expect(MAP_ROUTING_GUIDANCE).not.toContain('docs/maps/WORKSPACE_MAP.md')
    expect(MAP_ROUTING_GUIDANCE).toContain("current project's own guidance")
    expect(MAP_ROUTING_GUIDANCE).toContain('establish a map-first workflow')
    expect(MAP_ROUTING_GUIDANCE).toContain(
      'exact owner files or a focused map',
    )
    expect(MAP_ROUTING_GUIDANCE).toContain('skip any workspace router')
    expect(MAP_ROUTING_GUIDANCE).toContain('source is authoritative')
  })
})
