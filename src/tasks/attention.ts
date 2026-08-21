/**
 * Which delegated task states mean the session is waiting on the user.
 *
 * One owner on purpose. Two surfaces read these and must agree: the footer
 * pill (`src/tasks/pillLabel.ts`) and live session status
 * (`src/utils/tuiSessionStatus.ts`). They disagreed once already, because the
 * status side spelled the blocked check out again behind a terminal-status
 * guard that a blocked handoff can never pass, so the pill read "needs input"
 * while the tab read idle for the same task.
 *
 * Parameters are structural rather than the concrete task states. `TaskState`
 * widens to `any` (`src/tasks/types.ts` imports two modules that are not on
 * disk), so naming the fields here is what keeps these checked at all.
 */

/**
 * The agent ended its turn by handing a question back: it is finished running,
 * and the user still owes it an answer.
 *
 * This is ALWAYS a terminal task. `completeAgentTask`
 * (`src/tasks/LocalAgentTask/LocalAgentTask.tsx`) is the only writer of
 * `handoffStatus` and sets `status: 'completed'` in the same object literal,
 * so any caller that tests a terminal guard first will never reach this.
 */
export function isBlockedLocalAgent(task: {
  handoffStatus?: 'done' | 'blocked'
}): boolean {
  return task.handoffStatus === 'blocked'
}

/**
 * Remote ultraplan phases that stop and wait for the user. `undefined` means
 * the plan is still running.
 *
 * Written as an explicit list rather than `!== undefined` so that adding a
 * third phase does not silently promote it to an attention state at both call
 * sites at once.
 */
export function isUltraplanAttentionPhase(
  phase: 'needs_input' | 'plan_ready' | undefined,
): boolean {
  return phase === 'needs_input' || phase === 'plan_ready'
}

/**
 * The teammate paused for plan approval and cannot continue without one.
 *
 * Note the footer pill does NOT currently surface this state, while session
 * status does. That difference is observed, not designed: nothing was found
 * stating the pill should stay silent here.
 */
export function isTeammateAwaitingPlanApproval(task: {
  awaitingPlanApproval?: boolean
}): boolean {
  return task.awaitingPlanApproval === true
}
