import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Source-shape guard for the single-scheduler rule.
 *
 * The terminal REPL is an Ink component with no headless render path, so its
 * continuation wiring cannot be exercised by a behavioural test here. What CAN
 * be pinned is the property the rule is about: the REPL reports idle and runs
 * what it is asked to, and holds no continuation policy of its own. The
 * scheduler's actual decisions are covered in threadGoalScheduler.test.ts.
 */
const REPL_SOURCE = readFileSync(
  join(import.meta.dir, 'REPL.tsx'),
  'utf8',
)

describe('the terminal owns no second goal scheduler', () => {
  test('it creates exactly one shared scheduler', () => {
    const created = REPL_SOURCE.match(/createThreadGoalScheduler\(/g) ?? []
    expect(created).toHaveLength(1)
  })

  test('it does not decide continuation itself', () => {
    // getThreadGoalContinuationAction was the REPL-local decision function.
    // It is deleted; re-importing anything like it re-splits the loop.
    expect(REPL_SOURCE).not.toContain('getThreadGoalContinuationAction')
    expect(REPL_SOURCE).not.toContain('threadGoalController')
  })

  test('it does not render continuation prompts', () => {
    // Prompt text is part of the loop's contract. If the terminal renders its
    // own, the runtimes drift apart in exactly the way that is hard to notice.
    expect(REPL_SOURCE).not.toContain('renderThreadGoalContinuationPrompt')
    expect(REPL_SOURCE).not.toContain('renderThreadGoalBudgetLimitPrompt')
  })

  test('it does not charge the goal itself', () => {
    // One charging path lives in the scheduler. A second here is how the
    // terminal's accounting drifted from every other runtime's before.
    expect(REPL_SOURCE).not.toContain('accountThreadGoalTurn')
    expect(REPL_SOURCE).not.toContain('persistAccountedThreadGoal')
  })

  test('it settles every finished turn through the scheduler', () => {
    expect(REPL_SOURCE).toContain('goalSchedulerRef.current!.settle({')
    expect(REPL_SOURCE).toContain('.wake({ trigger, sourceId:')
  })

  test('it keeps no in-memory stall counter', () => {
    // The v1 stall count was a React ref, so a restart cleared it and the
    // supposedly-abandoned loop resumed.
    expect(REPL_SOURCE).not.toContain('goalContinuationStallCount')
  })
})
