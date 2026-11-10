import { describe, expect, test } from 'bun:test'

// Dynamic imports: loading coordinatorMode.js first trips a pre-existing
// circular-init issue in the tool-constant graph, so the tool pool module is
// imported first to prime it.
async function getSystemPrompt(): Promise<string> {
  await import('../tools.js')
  const { getCoordinatorSystemPrompt } = await import('./coordinatorMode.js')
  return getCoordinatorSystemPrompt()
}

describe('getCoordinatorSystemPrompt worker capabilities', () => {
  test('does not promise workers a Skill capability they do not have', async () => {
    const prompt = await getSystemPrompt()
    const { getPrompt } = await import('../tools/AgentTool/prompt.js')
    const agentPrompt = await getPrompt([], true, undefined, 'openai')

    // The shared Agent guidance owns the exception for explicitly granted Skill access.
    expect(prompt).toContain('subject to their role and runtime restrictions')
    expect(agentPrompt).toContain('Skill requires an explicit grant')
    expect(prompt).not.toContain('They do not have the Skill tool')
    expect(prompt).not.toContain('Delegate skill invocations')
    expect(prompt).not.toContain('project skills via the Skill')
  })
})
