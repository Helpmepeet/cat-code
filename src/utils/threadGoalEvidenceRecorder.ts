import { randomUUID } from 'crypto'
import { getSessionId } from '../bootstrap/state.js'
import { saveThreadGoal } from './sessionStorage.js'
import type { ThreadGoal } from './threadGoal.js'
import {
  appendThreadGoalEvidence,
  EMPTY_THREAD_GOAL_CONTRACT,
  digestThreadGoalCommand,
  digestThreadGoalEvidenceText,
  findCriteriaCoveredByCommand,
  hashThreadGoalContract,
  type ThreadGoalEvidence,
} from './threadGoalEvidence.js'
import { getThreadGoalWorkspaceFingerprint } from './threadGoalWorkspace.js'

/**
 * Turns a real command execution into goal evidence.
 *
 * The security-relevant property is what this does NOT do: it never runs
 * anything. It observes commands the model already executed through the normal
 * permission- and sandbox-checked tool path, so a natural-language goal grants
 * no execution authority it did not already have, and no new shell surface is
 * introduced.
 *
 * The verdict is the process's real exit code, and coverage is derived from
 * the user's own declared verifyCommand, so neither is the model's to write.
 * A model that wants credit for "the suite passes" has to actually run the
 * user's suite command and have it exit zero.
 */

export type ThreadGoalCommandOutcome = {
  command: string
  exitCode: number
  interrupted: boolean
  /** Combined output. Hashed immediately; never persisted. */
  output: string
}

/**
 * Record evidence for a finished command, if the current goal cares about it.
 *
 * Returns the evidence written, or null when nothing was recorded. Cheap to
 * call on every command: it exits before any IO unless the session has a goal
 * whose contract actually binds a criterion to this exact command.
 */
export async function recordThreadGoalCommandEvidence({
  goal,
  outcome,
  saveGoal = saveThreadGoal,
  now = () => Date.now(),
}: {
  goal: ThreadGoal | null
  outcome: ThreadGoalCommandOutcome
  saveGoal?: (goal: ThreadGoal) => void
  now?: () => number
}): Promise<ThreadGoalEvidence | null> {
  // Ordered cheapest-first. The workspace fingerprint costs three git
  // subprocesses, so it must never run for a session with no gated goal, which
  // is the overwhelmingly common case.
  // Tolerant read: this observes every Bash call in the process, including
  // ones made against goal-shaped state that did not come through
  // parseThreadGoal. A throw here would fail the user's command.
  const contract = goal?.contract ?? EMPTY_THREAD_GOAL_CONTRACT
  if (!goal || contract.criteria.length === 0) return null

  const coversCriterionIds = findCriteriaCoveredByCommand(
    contract,
    outcome.command,
  )
  if (coversCriterionIds.length === 0) return null

  // An interrupted command proves nothing either way. Recording it as a
  // failure would let a stray ctrl-c mark a criterion red.
  if (outcome.interrupted) return null

  const record: ThreadGoalEvidence = {
    evidenceId: randomUUID(),
    source: 'command',
    sourceDigest: digestThreadGoalCommand(outcome.command),
    // The label is the user's own declared command, not model-authored text,
    // so it is safe to show and did not come from the transcript.
    label:
      contract.criteria.find(c => coversCriterionIds.includes(c.id))
        ?.verifyCommand ?? '',
    sessionId: getSessionId(),
    contractDigest: hashThreadGoalContract(goal.objective, contract),
    workspaceFingerprint: await getThreadGoalWorkspaceFingerprint(),
    outcome: outcome.exitCode === 0 ? 'pass' : 'fail',
    exitCode: outcome.exitCode,
    outputDigest: digestThreadGoalEvidenceText(outcome.output),
    recordedAtMs: now(),
    coversCriterionIds,
  }

  saveGoal({
    ...goal,
    evidence: appendThreadGoalEvidence(goal.evidence ?? [], record),
    updatedAtMs: record.recordedAtMs,
  })

  return record
}
