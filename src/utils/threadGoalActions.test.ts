import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import {
  getSessionId,
  getSessionProjectDir,
  switchSession,
} from '../bootstrap/state.js'
import { asSessionId } from '../types/ids.js'
import {
  createThreadGoal,
  updateThreadGoalStatus,
  type ThreadGoal,
} from './threadGoal.js'

import {
  applyThreadGoalTransition,
  clearThreadGoalAction,
  createThreadGoalAction,
  setThreadGoalContractAction,
  updateThreadGoalStatusAction,
} from './threadGoalActions.js'

// No module mocking here on purpose. `withSession` points the session at a
// temp project dir, so the real `updateSessionObjective` runs against it.
// Stubbing it would have been a second file in this suite mocking
// `agent-mode/sessionState.js`, and `mock.module` is process-global: the last
// registration in a run wins and silently disarms the others.
//
// These tests therefore assert the goal state each action owns, NOT the Agent
// Mode objective write. That write no-ops for a session with no existing
// state file, so asserting it here would prove nothing about either.

const originalSessionId = getSessionId()
const originalProjectDir = getSessionProjectDir()
const tempDirs: string[] = []

afterEach(() => {
  switchSession(asSessionId(originalSessionId), originalProjectDir)
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function withSession(): string {
  const dir = mkdtempSync(join(tmpdir(), 'goal-actions-'))
  tempDirs.push(dir)
  const sessionId = randomUUID()
  switchSession(asSessionId(sessionId), dir)
  return sessionId
}

function context(goal: ThreadGoal | null) {
  let state = { threadGoal: goal }
  return {
    getAppState: () => state,
    setAppState: (updater: (prev: typeof state) => typeof state) => {
      state = updater(state)
    },
    read: () => state.threadGoal,
  }
}

describe('the compare-and-swap transition', () => {
  test('a decision made against the current revision commits', async () => {
    const sessionId = withSession()
    const goal = createThreadGoal(sessionId, 'finish the migration', undefined, 100)
    const ctx = context(goal)

    const result = await applyThreadGoalTransition({
      context: ctx,
      goalId: goal.goalId,
      to: 'paused',
      reason: 'user_paused',
      actor: 'user',
      expectedRevision: goal.revision,
      nowMs: 200,
    })

    expect(result.ok).toBe(true)
    expect(result.code).toBe('ok')
    expect(ctx.read()!.status).toBe('paused')
  })

  test('a decision made against an older revision is rejected as stale', async () => {
    // This is the fence: a continuation decided before the user paused, edited,
    // or replaced the goal must not commit against the goal that replaced it.
    const sessionId = withSession()
    const goal = createThreadGoal(sessionId, 'finish the migration', undefined, 100)
    const ctx = context(goal)
    const staleRevision = goal.revision

    // Someone else moves the goal first.
    await applyThreadGoalTransition({
      context: ctx,
      goalId: goal.goalId,
      to: 'paused',
      reason: 'user_paused',
      actor: 'user',
      nowMs: 200,
    })

    const late = await applyThreadGoalTransition({
      context: ctx,
      goalId: goal.goalId,
      to: 'complete',
      reason: 'agent_reported_complete',
      actor: 'agent',
      expectedRevision: staleRevision,
      nowMs: 300,
    })

    expect(late.ok).toBe(false)
    expect(late.code).toBe('stale')
    // The goal the late writer would have overwritten is untouched.
    expect(ctx.read()!.status).toBe('paused')
  })

  test('a cleared goal reports missing rather than resurrecting itself', async () => {
    const sessionId = withSession()
    const goal = createThreadGoal(sessionId, 'finish the migration', undefined, 100)
    const ctx = context(null)

    const result = await applyThreadGoalTransition({
      context: ctx,
      goalId: goal.goalId,
      to: 'complete',
      reason: 'agent_reported_complete',
      actor: 'agent',
      nowMs: 200,
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('missing')
    expect(ctx.read()).toBeNull()
  })

  test('a transition naming a different goal cannot commit against this one', async () => {
    const sessionId = withSession()
    const goal = createThreadGoal(sessionId, 'finish the migration', undefined, 100)
    const ctx = context(goal)

    const result = await applyThreadGoalTransition({
      context: ctx,
      goalId: 'some-other-goal',
      to: 'complete',
      reason: 'agent_reported_complete',
      actor: 'agent',
      nowMs: 200,
    })

    expect(result.code).toBe('missing')
    expect(ctx.read()!.status).toBe('active')
  })

  test('an illegal transition is refused with the reason the caller needs', async () => {
    const sessionId = withSession()
    const complete = updateThreadGoalStatus(
      createThreadGoal(sessionId, 'done already', undefined, 100),
      'complete',
      'agent_reported_complete',
      200,
    )
    const ctx = context(complete)

    const result = await applyThreadGoalTransition({
      context: ctx,
      goalId: complete.goalId,
      to: 'active',
      reason: 'user_resumed',
      actor: 'agent',
      nowMs: 300,
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('terminal')
    expect(ctx.read()!.status).toBe('complete')
  })

  test('omitting the expected revision skips only the staleness check', async () => {
    // A user control action on live state has no gap between decision and
    // write, so it has nothing to fence. It still cannot make an illegal move.
    const sessionId = withSession()
    const complete = updateThreadGoalStatus(
      createThreadGoal(sessionId, 'done already', undefined, 100),
      'complete',
      'agent_reported_complete',
      200,
    )
    const ctx = context(complete)

    const result = await applyThreadGoalTransition({
      context: ctx,
      goalId: complete.goalId,
      to: 'active',
      reason: 'user_resumed',
      actor: 'agent',
      nowMs: 300,
    })

    expect(result.ok).toBe(false)
  })
})

describe('goal control actions', () => {
  test('creating a goal installs it as the session goal', async () => {
    withSession()
    const ctx = context(null)

    const goal = await createThreadGoalAction({
      context: ctx,
      objective: 'finish the migration',
      tokenBudget: 5_000,
      nowMs: 100,
    })

    expect(goal.objective).toBe('finish the migration')
    expect(goal.tokenBudget).toBe(5_000)
    expect(ctx.read()!.goalId).toBe(goal.goalId)
    expect(ctx.read()!.status).toBe('active')
    expect(ctx.read()!.revision).toBe(goal.revision)
  })

  test('clearing a goal drops it from state entirely', async () => {
    const sessionId = withSession()
    const goal = createThreadGoal(sessionId, 'finish the migration', undefined, 100)
    const ctx = context(goal)

    await clearThreadGoalAction({ context: ctx, goal })

    expect(ctx.read()).toBeNull()
  })

  test('a direct status write still honours transition authority', async () => {
    const sessionId = withSession()
    const complete = updateThreadGoalStatus(
      createThreadGoal(sessionId, 'done already', undefined, 100),
      'complete',
      'agent_reported_complete',
      200,
    )
    const ctx = context(complete)

    const result = await updateThreadGoalStatusAction({
      context: ctx,
      goal: complete,
      status: 'active',
      reason: 'user_resumed',
      actor: 'agent',
      objective: complete.objective,
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('terminal')
  })

  test('editing the contract bumps the revision, which is what expires evidence', async () => {
    const sessionId = withSession()
    const goal = createThreadGoal(sessionId, 'finish the migration', undefined, 100)
    const ctx = context(goal)

    const next = await setThreadGoalContractAction({
      context: ctx,
      goal,
      contract: {
        criteria: [
          {
            id: 'tests',
            description: 'the suite passes',
            required: true,
            verifyCommand: 'bun test',
          },
        ],
        constraints: [],
        boundaries: [],
        stopConditions: [],
      },
    })

    expect(next.revision).toBe(goal.revision + 1)
    expect(next.contract.criteria).toHaveLength(1)
    expect(ctx.read()!.contract.criteria[0]!.id).toBe('tests')
  })
})
