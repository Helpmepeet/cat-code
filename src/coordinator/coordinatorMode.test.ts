import { describe, expect, test } from 'bun:test'

import { SKILL_TOOL_NAME } from '../tools/SkillTool/constants.js'

// Dynamic imports: loading coordinatorMode.js first trips a pre-existing
// circular-init issue in the tool-constant graph (same one noted in
// rolePrompts.test.ts), so the tool pool module is imported first to prime it.
async function getSystemPrompt(): Promise<string> {
  await import('../tools.js')
  const { getCoordinatorSystemPrompt } = await import('./coordinatorMode.js')
  return getCoordinatorSystemPrompt()
}

describe('getCoordinatorSystemPrompt worker capabilities', () => {
  test('does not promise workers a Skill capability they do not have', async () => {
    const prompt = await getSystemPrompt()

    // Skill is withheld from async workers by default, and every coordinator
    // worker runs async, so delegating skill invocations cannot work.
    expect(prompt).toContain(`They do not have the ${SKILL_TOOL_NAME} tool`)
    expect(prompt).not.toContain('Delegate skill invocations')
    expect(prompt).not.toContain(`project skills via the ${SKILL_TOOL_NAME}`)
  })
})
