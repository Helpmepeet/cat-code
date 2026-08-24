import type { ThreadGoal } from './threadGoal.js'
import {
  evaluateThreadGoalCriteria,
  hashThreadGoalContract,
  type ThreadGoalCriterionState,
} from './threadGoalEvidence.js'

/**
 * An independent check for the criteria deterministic evidence cannot decide.
 *
 * Scope is deliberately narrow. Deterministic gates run first and are
 * authoritative: anything a command can prove is proven by a command, and the
 * judge is never asked about it. What is left is the criterion no exit code
 * can settle, such as "the migration guide explains the breaking change".
 *
 * Three properties matter more than the judgement itself:
 *
 * 1. It sees an EVIDENCE BUNDLE, not the maker's closing narrative. Judging
 *    the maker's own summary is how a persuasive but false completion passes.
 * 2. It can never authorize success on its own failure. A malformed or
 *    unavailable verdict is `verification_unavailable`, which blocks, and
 *    never an implicit "continue" or "done".
 * 3. It is bounded. Retries are capped, and exhausting them stops the goal
 *    rather than spending turns while the component that decides is down.
 */

export type ThreadGoalJudgeVerdict = {
  criterionId: string
  /** The judge may only ever prove or refuse. It cannot mark a goal complete. */
  verdict: 'proven' | 'not-proven'
  /** Closed vocabulary, never model prose reaching a user surface. */
  reason: 'covered' | 'insufficient-evidence' | 'contradicted'
}

/**
 * Retries before a judge is declared unavailable.
 *
 * Small on purpose. A judge that cannot answer twice is not going to answer,
 * and the failure mode to avoid is burning the goal's turn budget waiting for
 * the component whose whole job is to stop it.
 */
export const MAX_THREAD_GOAL_JUDGE_ATTEMPTS = 2

/**
 * The criteria a judge should be asked about.
 *
 * Exactly those that are required, still unverified, and have NO verify
 * command bound. A criterion with a command is the deterministic gate's
 * business; handing it to a judge would let a semantic opinion override a red
 * exit code, which is the inversion this whole design exists to prevent.
 */
export function selectThreadGoalJudgeCriteria(
  goal: ThreadGoal,
  criterionStates: readonly ThreadGoalCriterionState[],
): ThreadGoalCriterionState[] {
  return criterionStates.filter(
    state =>
      state.criterion.required &&
      state.verdict === 'unverified' &&
      state.criterion.verifyCommand === undefined &&
      goal.contract.criteria.some(c => c.id === state.criterion.id),
  )
}

/**
 * The bundle a judge is allowed to see.
 *
 * Evidence records carry digests rather than raw command output, so this
 * cannot leak credentials or private diagnostics into a model call. The
 * objective and criteria are user-authored. Nothing here is the maker's
 * account of its own work.
 */
export type ThreadGoalEvidenceBundle = {
  objective: string
  criteria: { id: string; description: string }[]
  evidence: {
    label: string
    outcome: 'pass' | 'fail'
    exitCode?: number
    coversCriterionIds: string[]
    recordedAtMs: number
  }[]
}

/**
 * Build the bundle for a judge.
 *
 * Only FRESH evidence is included. Showing the judge a record from a previous
 * contract or a different workspace state would let a semantic opinion
 * rehabilitate evidence the deterministic gate had already ruled stale, which
 * is precisely the guarantee that stale evidence cannot complete a changed
 * goal.
 */
export function buildThreadGoalEvidenceBundle(
  goal: ThreadGoal,
  criterionStates: readonly ThreadGoalCriterionState[],
  freshness: { contractDigest: string; workspaceFingerprint: string },
): ThreadGoalEvidenceBundle {
  return {
    objective: goal.objective,
    criteria: criterionStates.map(state => ({
      id: state.criterion.id,
      description: state.criterion.description,
    })),
    evidence: goal.evidence
      .filter(
        record =>
          record.contractDigest === freshness.contractDigest &&
          record.workspaceFingerprint === freshness.workspaceFingerprint,
      )
      .map(record => ({
        label: record.label,
        outcome: record.outcome,
        ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
        coversCriterionIds: record.coversCriterionIds,
        recordedAtMs: record.recordedAtMs,
      })),
  }
}

export type ThreadGoalJudgeOutcome =
  | { status: 'proven'; criterionIds: string[] }
  | { status: 'not-proven'; criterionIds: string[] }
  | { status: 'unavailable' }

export type ThreadGoalJudgeCall = (
  bundle: ThreadGoalEvidenceBundle,
) => Promise<ThreadGoalJudgeVerdict[] | null>

/**
 * Run the judge with bounded retry and fail-closed semantics.
 *
 * `judge` returns null for a malformed or failed call. Exhausting attempts
 * returns `unavailable`, which the caller must treat as blocking. It is never
 * turned into an implicit pass, and never into an unbounded continuation.
 */
export async function runThreadGoalJudge({
  bundle,
  judge,
  maxAttempts = MAX_THREAD_GOAL_JUDGE_ATTEMPTS,
}: {
  bundle: ThreadGoalEvidenceBundle
  judge: ThreadGoalJudgeCall
  maxAttempts?: number
}): Promise<ThreadGoalJudgeOutcome> {
  const requested = new Set(bundle.criteria.map(c => c.id))

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let verdicts: ThreadGoalJudgeVerdict[] | null = null
    try {
      verdicts = await judge(bundle)
    } catch {
      verdicts = null
    }
    if (!verdicts) continue

    // Verdicts for criteria nobody asked about are discarded: the judge does
    // not get to widen its own remit.
    const scoped = verdicts.filter(v => requested.has(v.criterionId))

    const proven = scoped
      .filter(v => v.verdict === 'proven')
      .map(v => v.criterionId)
    const notProven = [...requested].filter(id => !proven.includes(id))

    // Silence is not assent. A criterion the judge did not answer for stays
    // unproven rather than defaulting through.
    return notProven.length > 0
      ? { status: 'not-proven', criterionIds: notProven }
      : { status: 'proven', criterionIds: proven }
  }

  return { status: 'unavailable' }
}

/**
 * Whether a goal still needs a judge at all.
 *
 * Returns the criteria to ask about, or an empty list when deterministic
 * evidence already settled everything. The common case is empty, and no model
 * call should happen then.
 */
export function planThreadGoalJudgement(goal: ThreadGoal, workspaceFingerprint: string): {
  criterionStates: ThreadGoalCriterionState[]
  needsJudge: ThreadGoalCriterionState[]
} {
  const criterionStates = evaluateThreadGoalCriteria({
    contract: goal.contract,
    evidence: goal.evidence,
    contractDigest: hashThreadGoalContract(goal.objective, goal.contract),
    workspaceFingerprint,
  })
  return {
    criterionStates,
    needsJudge: selectThreadGoalJudgeCriteria(goal, criterionStates),
  }
}
