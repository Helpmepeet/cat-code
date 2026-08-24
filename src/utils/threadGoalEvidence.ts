import { hashContent } from './hash.js'

/**
 * Criterion-linked evidence and the deterministic completion gate.
 *
 * Completion used to be a maker assertion: the model audited its own work in
 * prose and called update_goal. This module makes it a control-plane
 * transition instead. The model may propose that a criterion is covered; what
 * decides is whether fresh, passing evidence recorded by the RUNTIME covers
 * every required criterion.
 *
 * Two rules shape everything here:
 *
 * 1. The verdict is never the model's to write. Evidence carries an outcome
 *    derived from a real execution, and `coversCriterionIds` is the only field
 *    a maker's claim influences. Claiming coverage of a criterion that does
 *    not exist proves nothing, because coverage is intersected with the
 *    contract rather than trusted.
 *
 * 2. Nothing raw is persisted. A command line can carry a token and command
 *    output can carry private diagnostics, and evidence is projected to the
 *    desktop, so only digests and a caller-sanitised label are stored.
 */

export type ThreadGoalCriterion = {
  id: string
  description: string
  /** A required criterion blocks completion until it is proven. */
  required: boolean
}

/**
 * The structured half of a goal. Optional: a goal created from a plain
 * objective has no contract and keeps the pre-existing completion behaviour,
 * so adding this cannot retroactively block goals already in flight.
 */
export type ThreadGoalContract = {
  criteria: ThreadGoalCriterion[]
  constraints: string[]
  boundaries: string[]
  stopConditions: string[]
}

export const EMPTY_THREAD_GOAL_CONTRACT: ThreadGoalContract = {
  criteria: [],
  constraints: [],
  boundaries: [],
  stopConditions: [],
}

export type ThreadGoalEvidenceOutcome = 'pass' | 'fail'

export type ThreadGoalEvidence = {
  evidenceId: string
  /** What produced this record. */
  source: 'command' | 'artifact' | 'worker'
  /**
   * Digest of what ran, not what ran. Enough to tell two verifiers apart and
   * to notice one was swapped, without persisting a command line that may
   * carry a credential.
   */
  sourceDigest: string
  /** Short caller-sanitised label for display. Never raw output. */
  label: string
  sessionId: string
  /**
   * Digest of the contract this was recorded against. An objective or criteria
   * edit changes it, which is what makes evidence for the old contract stale.
   */
  contractDigest: string
  /** Workspace state when it ran. */
  workspaceFingerprint: string
  outcome: ThreadGoalEvidenceOutcome
  exitCode?: number
  /** Digest of the output, never the output itself. */
  outputDigest: string
  recordedAtMs: number
  /** Criteria this record is claimed to cover. Intersected with the contract. */
  coversCriterionIds: string[]
}

/**
 * How many evidence records a goal keeps.
 *
 * Bounded because the goal is a single durable record replayed on every
 * session load. Oldest records are dropped first; a dropped PASS simply
 * returns its criterion to unverified, which fails closed.
 */
export const MAX_THREAD_GOAL_EVIDENCE = 128

export function hashThreadGoalContract(
  objective: string,
  contract: ThreadGoalContract,
): string {
  return hashContent(
    JSON.stringify({
      objective,
      criteria: contract.criteria
        .map(c => `${c.id}:${c.required ? 'req' : 'opt'}:${c.description}`)
        .sort(),
      constraints: [...contract.constraints].sort(),
      boundaries: [...contract.boundaries].sort(),
      stopConditions: [...contract.stopConditions].sort(),
    }),
  )
}

export function digestThreadGoalEvidenceText(text: string): string {
  return hashContent(text)
}

export type ThreadGoalCriterionVerdict = 'proven' | 'failed' | 'unverified'

export type ThreadGoalCriterionState = {
  criterion: ThreadGoalCriterion
  verdict: ThreadGoalCriterionVerdict
  /** Evidence that decided the verdict, newest first. */
  evidenceIds: string[]
}

/**
 * Whether a record still describes current reality.
 *
 * Freshness is keyed on the contract digest and the workspace fingerprint, NOT
 * on the goal's `revision`. Revision bumps on every accounting write, so a
 * revision-keyed rule would expire all evidence after a single turn and no
 * goal could ever complete. What genuinely invalidates a test result is the
 * objective changing under it or the workspace moving beneath it.
 */
function isFresh(
  evidence: ThreadGoalEvidence,
  contractDigest: string,
  workspaceFingerprint: string,
): boolean {
  return (
    evidence.contractDigest === contractDigest &&
    evidence.workspaceFingerprint === workspaceFingerprint
  )
}

/**
 * Resolve every criterion's verdict from the ledger.
 *
 * A criterion is `proven` only when fresh passing evidence explicitly covers
 * it. A fresh failing record makes it `failed`. Everything else, including a
 * criterion covered only by stale evidence, is `unverified` — which fails
 * closed rather than reading as success.
 */
export function evaluateThreadGoalCriteria({
  contract,
  evidence,
  contractDigest,
  workspaceFingerprint,
}: {
  contract: ThreadGoalContract
  evidence: readonly ThreadGoalEvidence[]
  contractDigest: string
  workspaceFingerprint: string
}): ThreadGoalCriterionState[] {
  const criterionIds = new Set(contract.criteria.map(c => c.id))

  return contract.criteria.map(criterion => {
    // Newest first, and only records that both cover this criterion and are
    // still fresh. Coverage is intersected with the contract, so a record
    // naming a criterion that does not exist contributes nothing.
    const relevant = evidence
      .filter(
        record =>
          record.coversCriterionIds.includes(criterion.id) &&
          criterionIds.has(criterion.id) &&
          isFresh(record, contractDigest, workspaceFingerprint),
      )
      .slice()
      .sort((a, b) => b.recordedAtMs - a.recordedAtMs)

    if (relevant.length === 0) {
      return { criterion, verdict: 'unverified', evidenceIds: [] }
    }

    // The newest fresh record decides. A later green genuinely supersedes an
    // earlier red at the same workspace state; the reverse is a regression.
    const decisive = relevant[0]!
    return {
      criterion,
      verdict: decisive.outcome === 'pass' ? 'proven' : 'failed',
      evidenceIds: relevant.map(record => record.evidenceId),
    }
  })
}

/**
 * `criterionIds` is present on BOTH outcomes (empty when allowed) so callers
 * can read it without narrowing: the root tsconfig runs `strict: false`, where
 * a union discriminated on a boolean does not reliably expose the other arm's
 * fields. Same reason as threadGoalState.ts.
 */
export type ThreadGoalCompletionCheck = {
  allowed: boolean
  reason:
    | 'no_contract'
    | 'all_required_proven'
    | 'required_gate_failed'
    | 'unverified_criteria'
  /** Criteria that caused a refusal; empty when allowed. */
  criterionIds: string[]
}

/**
 * Decide whether the control plane may accept a completion.
 *
 * A goal with no criteria returns `no_contract`: this gate is additive, and a
 * goal created from a plain objective must keep behaving as it did. Everything
 * else fails closed, and a red required gate outranks an unverified one so the
 * reported reason is the more actionable of the two.
 */
export function evaluateThreadGoalCompletion({
  contract,
  evidence,
  contractDigest,
  workspaceFingerprint,
}: {
  contract: ThreadGoalContract
  evidence: readonly ThreadGoalEvidence[]
  contractDigest: string
  workspaceFingerprint: string
}): ThreadGoalCompletionCheck {
  const required = contract.criteria.filter(c => c.required)
  if (required.length === 0) {
    return { allowed: true, reason: 'no_contract', criterionIds: [] }
  }

  const states = evaluateThreadGoalCriteria({
    contract,
    evidence,
    contractDigest,
    workspaceFingerprint,
  })
  const requiredStates = states.filter(state => state.criterion.required)

  const failed = requiredStates.filter(state => state.verdict === 'failed')
  if (failed.length > 0) {
    return {
      allowed: false,
      reason: 'required_gate_failed',
      criterionIds: failed.map(state => state.criterion.id),
    }
  }

  const unverified = requiredStates.filter(
    state => state.verdict === 'unverified',
  )
  if (unverified.length > 0) {
    return {
      allowed: false,
      reason: 'unverified_criteria',
      criterionIds: unverified.map(state => state.criterion.id),
    }
  }

  return { allowed: true, reason: 'all_required_proven', criterionIds: [] }
}

/**
 * Whether a failed gate needs re-running.
 *
 * A red gate whose workspace fingerprint still matches cannot have become
 * green, so the recorded failure can be replayed instead of paying for the
 * command again.
 */
export function findReplayableThreadGoalFailure({
  evidence,
  sourceDigest,
  contractDigest,
  workspaceFingerprint,
}: {
  evidence: readonly ThreadGoalEvidence[]
  sourceDigest: string
  contractDigest: string
  workspaceFingerprint: string
}): ThreadGoalEvidence | null {
  const matches = evidence
    .filter(
      record =>
        record.sourceDigest === sourceDigest &&
        record.outcome === 'fail' &&
        isFresh(record, contractDigest, workspaceFingerprint),
    )
    .sort((a, b) => b.recordedAtMs - a.recordedAtMs)
  return matches[0] ?? null
}

export function appendThreadGoalEvidence(
  existing: readonly ThreadGoalEvidence[],
  record: ThreadGoalEvidence,
): ThreadGoalEvidence[] {
  const next = [...existing, record]
  return next.length > MAX_THREAD_GOAL_EVIDENCE
    ? next.slice(next.length - MAX_THREAD_GOAL_EVIDENCE)
    : next
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

export function parseThreadGoalContract(input: unknown): ThreadGoalContract {
  if (!input || typeof input !== 'object') return EMPTY_THREAD_GOAL_CONTRACT
  const c = input as Record<string, unknown>
  const criteria = Array.isArray(c.criteria)
    ? c.criteria.flatMap((entry): ThreadGoalCriterion[] => {
        if (!entry || typeof entry !== 'object') return []
        const candidate = entry as Record<string, unknown>
        if (
          !isNonEmptyString(candidate.id) ||
          !isNonEmptyString(candidate.description)
        ) {
          return []
        }
        return [
          {
            id: candidate.id,
            description: candidate.description,
            // Unreadable criteria default to REQUIRED. A criterion that
            // silently became optional is how a gate stops gating.
            required: candidate.required !== false,
          },
        ]
      })
    : []

  return {
    criteria,
    constraints: readStringArray(c.constraints),
    boundaries: readStringArray(c.boundaries),
    stopConditions: readStringArray(c.stopConditions),
  }
}

const EVIDENCE_SOURCES = ['command', 'artifact', 'worker'] as const

export function parseThreadGoalEvidence(input: unknown): ThreadGoalEvidence[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((entry): ThreadGoalEvidence[] => {
    if (!entry || typeof entry !== 'object') return []
    const c = entry as Record<string, unknown>
    if (
      !isNonEmptyString(c.evidenceId) ||
      !isNonEmptyString(c.sourceDigest) ||
      !isNonEmptyString(c.contractDigest) ||
      !isNonEmptyString(c.workspaceFingerprint) ||
      !isNonEmptyString(c.outputDigest) ||
      !(EVIDENCE_SOURCES as readonly unknown[]).includes(c.source) ||
      (c.outcome !== 'pass' && c.outcome !== 'fail') ||
      !Number.isInteger(c.recordedAtMs)
    ) {
      return []
    }
    return [
      {
        evidenceId: c.evidenceId,
        source: c.source as ThreadGoalEvidence['source'],
        sourceDigest: c.sourceDigest,
        label: typeof c.label === 'string' ? c.label : '',
        sessionId: typeof c.sessionId === 'string' ? c.sessionId : '',
        contractDigest: c.contractDigest,
        workspaceFingerprint: c.workspaceFingerprint,
        outcome: c.outcome,
        ...(Number.isInteger(c.exitCode) ? { exitCode: c.exitCode as number } : {}),
        outputDigest: c.outputDigest,
        recordedAtMs: c.recordedAtMs as number,
        coversCriterionIds: readStringArray(c.coversCriterionIds),
      },
    ]
  })
}
