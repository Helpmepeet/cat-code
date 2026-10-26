import { afterEach, describe, expect, spyOn, test } from 'bun:test'
// Match application load order before importing built-in agent prompts.
import '../../../tools.js'
import * as auth from '../../../utils/auth.js'
import * as settings from '../../../utils/settings/settings.js'
import { getDefaultSonnetModel } from '../../../utils/model/model.js'
import { resolveAgentModel } from '../../../utils/model/agent.js'
import { GenerateImageTool } from '../../GenerateImageTool/GenerateImageTool.js'
import { CLAUDE_CODE_GUIDE_AGENT } from './claudeCodeGuideAgent.js'

const originalOverride = process.env.CLAUDE_CODE_SUBAGENT_MODEL

afterEach(() => {
  if (originalOverride === undefined) delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  else process.env.CLAUDE_CODE_SUBAGENT_MODEL = originalOverride
})

function prompt(model: string, provider: 'firstParty' | 'openai'): string {
  return CLAUDE_CODE_GUIDE_AGENT.getSystemPrompt({
    toolUseContext: {
      options: {
        commands: [],
        agentDefinitions: { activeAgents: [] },
        mcpClients: [],
        mainLoopModel: model,
        mainLoopProvider: provider,
      },
    },
  } as Parameters<typeof CLAUDE_CODE_GUIDE_AGENT.getSystemPrompt>[0])
}

describe('credential-compatible guide and image availability', () => {
  test('rechecks account availability instead of retaining import-time state', () => {
    const credentials = spyOn(auth, 'hasCodexTokens').mockReturnValue(false)
    try {
      expect(CLAUDE_CODE_GUIDE_AGENT.model).toBe(getDefaultSonnetModel())
      expect(GenerateImageTool.isEnabled()).toBe(false)
      credentials.mockReturnValue(true)
      expect(CLAUDE_CODE_GUIDE_AGENT.model).toBe('gpt-6-luna')
      expect(GenerateImageTool.isEnabled()).toBe(true)
      credentials.mockReturnValue(false)
      expect(CLAUDE_CODE_GUIDE_AGENT.model).toBe(getDefaultSonnetModel())
      expect(GenerateImageTool.isEnabled()).toBe(false)
    } finally {
      credentials.mockRestore()
    }
  })

  test('uses the resolved worker route for tool and environment override prompts', () => {
    const credentials = spyOn(auth, 'hasCodexTokens').mockReturnValue(true)
    const thirdParty = spyOn(auth, 'isUsing3PServices').mockReturnValue(false)
    const userSettings = spyOn(settings, 'getSettings_DEPRECATED').mockReturnValue({})
    try {
      delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
      const parent = 'claude-sonnet-5-5'
      const pinned = resolveAgentModel(CLAUDE_CODE_GUIDE_AGENT.model, parent, undefined, 'default', 'firstParty')
      expect(pinned.provider).toBe('openai')
      expect(prompt(pinned.model, 'openai')).toContain('TASK: help users understand')
      const overridden = resolveAgentModel(CLAUDE_CODE_GUIDE_AGENT.model, parent, 'sonnet', 'default', 'firstParty')
      expect(overridden.provider).toBe('firstParty')
      expect(prompt(overridden.model, 'firstParty')).toContain('Your primary responsibility')
      process.env.CLAUDE_CODE_SUBAGENT_MODEL = parent
      const envRoute = resolveAgentModel(CLAUDE_CODE_GUIDE_AGENT.model, parent, 'gpt-6-luna', 'default', 'firstParty')
      expect(envRoute.model).toBe(parent)
      expect(envRoute.provider).toBe('firstParty')
      expect(prompt(envRoute.model, 'firstParty')).toContain('Your primary responsibility')
      credentials.mockReturnValue(false)
      delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
      const fallback = resolveAgentModel(CLAUDE_CODE_GUIDE_AGENT.model, parent, undefined, 'default', 'firstParty')
      expect(fallback.provider).toBe('firstParty')
      expect(prompt(fallback.model, 'firstParty')).toContain('Your primary responsibility')
    } finally {
      credentials.mockRestore()
      thirdParty.mockRestore()
      userSettings.mockRestore()
    }
  })
})
