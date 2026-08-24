import { describe, expect, test } from 'bun:test'
import { createThreadGoal, type ThreadGoal } from './threadGoal.js'
import {
  buildThreadGoalEvidenceBundle,
  MAX_THREAD_GOAL_JUDGE_ATTEMPTS,
  planThreadGoalJudgement,
  runThreadGoalJudge,
  selectThreadGoalJudgeCriteria,
  type ThreadGoalJudgeVerdict,
} from './threadGoalJudge.js'
import {
  evaluateThreadGoalCriteria,
  hashThreadGoalContract,
} from './threadGoalEvidence.js'

const FINGERPRINT = 'workspace-1'

function goalWith(
  criteria: {
    id: string
    description: string
    required?: boolean
    verifyCommand?: string
  }[],
  evidence: ThreadGoal['evidence'] = [],
): ThreadGoal {
  const base = createThreadGoal('session-1', 'ship the migration', undefined, 100)
  return {
    ...base,
    contract: {
      criteria: criteria.map(c => ({
        id: c.id,
        description: c.description,
        required: c.required !== false,
        ...(c.verifyCommand ? { verifyCommand: c.verifyCommand } : {}),
      })),
      constraints: [],
      boundaries: [],
      stopConditions: [],
    },
    evidence,
  }
}

function passingEvidence(goal: ThreadGoal, criterionId: string) {
  return {
    evidenceId: 'ev-' + criterionId,
    source: 'command' as const,
    sourceDigest: 'digest',
    label: 'check',
    sessionId: 'session-1',
    contractDigest: hashThreadGoalContract(goal.objective, goal.contract),
    workspaceFingerprint: FINGERPRINT,
    outcome: 'pass' as const,
    exitCode: 0,
    outputDigest: 'out',
    recordedAtMs: 200,
    coversCriterionIds: [criterionId],
  }
}

describe('what the judge is asked about', () => {
  test('a criterion with a verify command is never handed to the judge', () => {
    // Letting a semantic opinion override an exit code is the inversion this
    // whole design exists to prevent.
    const goal = goalWith([
      { id: 'tests', description: 'suite passes', verifyCommand: 'bun test' },
      { id: 'guide', description: 'the guide explains the change' },
    ])
    const { needsJudge } = planThreadGoalJudgement(goal, FINGERPRINT)

    expect(needsJudge.map(s => s.criterion.id)).toEqual(['guide'])
  })

  test('nothing is asked when deterministic evidence already settled it', () => {
    const goal = goalWith([
      { id: 'tests', description: 'suite passes', verifyCommand: 'bun test' },
    ])
    const proven = goalWith(
      [{ id: 'tests', description: 'suite passes', verifyCommand: 'bun test' }],
      [passingEvidence(goal, 'tests')],
    )

    expect(planThreadGoalJudgement(proven, FINGERPRINT).needsJudge).toEqual([])
  })

  test('optional criteria are not judged', () => {
    const goal = goalWith([
      { id: 'nice-to-have', description: 'polish', required: false },
    ])
    expect(planThreadGoalJudgement(goal, FINGERPRINT).needsJudge).toEqual([])
  })
})

describe('the evidence bundle', () => {
  test('it carries evidence records, not the maker narrative', () => {
    const goal = goalWith([{ id: 'guide', description: 'the guide explains it' }])
    const withEvidence = { ...goal, evidence: [passingEvidence(goal, 'guide')] }
    const states = evaluateThreadGoalCriteria({
      contract: withEvidence.contract,
      evidence: withEvidence.evidence,
      contractDigest: hashThreadGoalContract(
        withEvidence.objective,
        withEvidence.contract,
      ),
      workspaceFingerprint: FINGERPRINT,
    })

    const bundle = buildThreadGoalEvidenceBundle(withEvidence, states, {
      contractDigest: hashThreadGoalContract(
        withEvidence.objective,
        withEvidence.contract,
      ),
      workspaceFingerprint: FINGERPRINT,
    })

    expect(bundle.objective).toBe('ship the migration')
    expect(bundle.evidence[0]).toMatchObject({ outcome: 'pass', exitCode: 0 })
  })

  test('stale evidence is withheld from the judge', () => {
    // Otherwise a semantic opinion could rehabilitate evidence the
    // deterministic gate already ruled stale.
    const goal = goalWith([{ id: 'guide', description: 'x' }])
    const withStale = {
      ...goal,
      evidence: [
        { ...passingEvidence(goal, 'guide'), contractDigest: 'an-old-contract' },
        {
          ...passingEvidence(goal, 'guide'),
          evidenceId: 'ev-moved',
          workspaceFingerprint: 'workspace-moved',
        },
      ],
    }

    const bundle = buildThreadGoalEvidenceBundle(withStale, [], {
      contractDigest: hashThreadGoalContract(goal.objective, goal.contract),
      workspaceFingerprint: FINGERPRINT,
    })

    expect(bundle.evidence).toEqual([])
  })

  test('no raw command output can reach the judge', () => {
    // Evidence stores digests, so there is nothing to leak into a model call.
    const goal = goalWith([{ id: 'guide', description: 'x' }])
    const withEvidence = { ...goal, evidence: [passingEvidence(goal, 'guide')] }
    const bundle = buildThreadGoalEvidenceBundle(withEvidence, [], {
      contractDigest: hashThreadGoalContract(goal.objective, goal.contract),
      workspaceFingerprint: FINGERPRINT,
    })

    const serialised = JSON.stringify(bundle)
    expect(serialised).not.toContain('outputDigest')
    expect(serialised).not.toContain('workspaceFingerprint')
  })
})

describe('judge failure is never success', () => {
  test('a malformed verdict retries, then reports unavailable', async () => {
    let calls = 0
    const outcome = await runThreadGoalJudge({
      bundle: { objective: 'x', criteria: [{ id: 'guide', description: 'y' }], evidence: [] },
      judge: async () => {
        calls++
        return null
      },
    })

    expect(outcome).toEqual({ status: 'unavailable' })
    expect(calls).toBe(MAX_THREAD_GOAL_JUDGE_ATTEMPTS)
  })

  test('a throwing judge is bounded, not retried forever', async () => {
    let calls = 0
    const outcome = await runThreadGoalJudge({
      bundle: { objective: 'x', criteria: [{ id: 'guide', description: 'y' }], evidence: [] },
      judge: async () => {
        calls++
        throw new Error('transport died')
      },
    })

    expect(outcome).toEqual({ status: 'unavailable' })
    expect(calls).toBe(MAX_THREAD_GOAL_JUDGE_ATTEMPTS)
  })

  test('silence on a criterion is not assent', async () => {
    const outcome = await runThreadGoalJudge({
      bundle: {
        objective: 'x',
        criteria: [
          { id: 'guide', description: 'y' },
          { id: 'notes', description: 'z' },
        ],
        evidence: [],
      },
      judge: async () => [
        { criterionId: 'guide', verdict: 'proven', reason: 'covered' },
      ] as ThreadGoalJudgeVerdict[],
    })

    expect(outcome).toEqual({ status: 'not-proven', criterionIds: ['notes'] })
  })

  test('the judge cannot widen its own remit', async () => {
    const outcome = await runThreadGoalJudge({
      bundle: { objective: 'x', criteria: [{ id: 'guide', description: 'y' }], evidence: [] },
      judge: async () =>
        [
          { criterionId: 'guide', verdict: 'proven', reason: 'covered' },
          // Nobody asked about this one.
          { criterionId: 'tests', verdict: 'proven', reason: 'covered' },
        ] as ThreadGoalJudgeVerdict[],
    })

    expect(outcome).toEqual({ status: 'proven', criterionIds: ['guide'] })
  })

  test('a clean pass on everything asked is proven', async () => {
    const outcome = await runThreadGoalJudge({
      bundle: { objective: 'x', criteria: [{ id: 'guide', description: 'y' }], evidence: [] },
      judge: async () =>
        [
          { criterionId: 'guide', verdict: 'proven', reason: 'covered' },
        ] as ThreadGoalJudgeVerdict[],
    })

    expect(outcome).toEqual({ status: 'proven', criterionIds: ['guide'] })
  })

  test('a transient failure followed by an answer succeeds within the bound', async () => {
    let calls = 0
    const outcome = await runThreadGoalJudge({
      bundle: { objective: 'x', criteria: [{ id: 'guide', description: 'y' }], evidence: [] },
      judge: async () => {
        calls++
        if (calls === 1) return null
        return [
          { criterionId: 'guide', verdict: 'proven', reason: 'covered' },
        ] as ThreadGoalJudgeVerdict[]
      },
    })

    expect(outcome).toEqual({ status: 'proven', criterionIds: ['guide'] })
  })
})

describe('selection guards', () => {
  test('a verdict for a criterion outside the contract is ignored', () => {
    const goal = goalWith([{ id: 'guide', description: 'x' }])
    const states = evaluateThreadGoalCriteria({
      contract: {
        criteria: [
          { id: 'guide', description: 'x', required: true },
          { id: 'ghost', description: 'not in the goal', required: true },
        ],
        constraints: [],
        boundaries: [],
        stopConditions: [],
      },
      evidence: [],
      contractDigest: 'd',
      workspaceFingerprint: FINGERPRINT,
    })

    expect(
      selectThreadGoalJudgeCriteria(goal, states).map(s => s.criterion.id),
    ).toEqual(['guide'])
  })
})
