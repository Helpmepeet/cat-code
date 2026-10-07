import { afterEach, describe, expect, test } from 'bun:test'
import { getEnterPlanModeToolPrompt } from './prompt.js'

describe('EnterPlanMode tool prompt', () => {
  const originalUserType = process.env.USER_TYPE

  afterEach(() => {
    if (originalUserType === undefined) {
      delete process.env.USER_TYPE
    } else {
      process.env.USER_TYPE = originalUserType
    }
  })

  test('ships the plan-sparingly wording to every user type', () => {
    // The external-only variant used to tell the model to prefer plan mode for
    // most implementation work, contradicting ACT OR ASK in the GPT
    // system prompt. There is one variant now.
    delete process.env.USER_TYPE
    const external = getEnterPlanModeToolPrompt()
    process.env.USER_TYPE = 'ant'
    const ant = getEnterPlanModeToolPrompt()

    // The "What Happens" section is still gated separately
    // (isPlanModeInterviewPhaseEnabled), so the two are not byte-identical.
    for (const prompt of [external, ant]) {
      expect(prompt).toContain(
        'Use this tool when a task has genuine ambiguity about the right approach',
      )
      expect(prompt).toContain(
        'Do not enter plan mode merely because a task is nontrivial or touches several files',
      )
      expect(prompt).toContain(
        'If the intent is clear and the next steps are reversible, proceed',
      )
      expect(prompt).not.toContain('err on the side of planning')
      expect(prompt).not.toContain('**Prefer using EnterPlanMode**')
      expect(prompt).toContain('Research and explanation do not require plan mode or delegation')
      expect(prompt).toContain('Entering plan mode requires user approval')
    }
  })
})
