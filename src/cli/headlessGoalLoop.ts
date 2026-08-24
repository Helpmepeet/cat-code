import { getSessionId } from '../bootstrap/state.js'
import type { AppState } from '../state/AppState.js'
import type { Message } from '../types/message.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { saveThreadGoal } from '../utils/sessionStorage.js'
import { didThreadGoalTurnMakeProgress } from '../utils/threadGoal.js'
import { createThreadGoalDependencyCache } from '../utils/threadGoalDependencies.js'
import {
  createThreadGoalScheduler,
  type ThreadGoalRunningAttempt,
} from '../utils/threadGoalScheduler.js'
import { sumRealThreadGoalUsage } from '../utils/threadGoalUsage.js'
import { isRateLimitErrorMessage } from '../services/rateLimitMessages.js'
import { detectThreadGoalRepetition } from '../utils/threadGoalRepetition.js'
import { collectThreadGoalToolCalls } from '../utils/threadGoalToolCalls.js'

/**
 * The goal loop for headless (`-p`) runs.
 *
 * Headless previously executed one turn and exited, so `/goal` was interactive
 * behaviour that quietly did nothing here. This drives the SAME scheduler the
 * terminal, desktop, and web runtimes use, at headless's own idle boundary:
 * the point where the command queue has drained and no background task is
 * outstanding.
 *
 * It changes what a `-p` invocation can do, so it has an off switch. It is
 * only ever reachable when a goal is active, and a fresh `-p` session has no
 * goal unless the model created one or a resume restored one.
 */

/** Escape hatch for a caller that needs one-shot behaviour unconditionally. */
export const DISABLE_HEADLESS_GOAL_LOOP_ENV = 'CLAUDE_CODE_DISABLE_GOAL_LOOP'

export type HeadlessGoalLoop = {
  /**
   * The next continuation prompt, or null to finish the run.
   *
   * Call at the idle boundary. Settles the turn that just ended before
   * deciding, so the ceilings, stall detection, and budget stops that decision
   * depends on are already applied.
   */
  nextContinuation(messages: readonly Message[]): Promise<string | null>
}

export function createHeadlessGoalLoop({
  getAppState,
  setAppState,
}: {
  getAppState: () => AppState
  setAppState: (updater: (prev: AppState) => AppState) => void
}): HeadlessGoalLoop | null {
  if (isEnvTruthy(process.env[DISABLE_HEADLESS_GOAL_LOOP_ENV])) {
    return null
  }

  const dependencies = createThreadGoalDependencyCache()
  const chargedResponseIds = new Set<string>()
  let pendingPrompt: string | null = null
  let runningAttempt: ThreadGoalRunningAttempt | null = null
  let turnStartMs = Date.now()
  let idleSequence = 0
  // Where this turn's messages begin. Bounds the usage walk to the turn, so a
  // long run cannot re-charge responses that aged out of the charged ledger.
  let turnMessageStartIndex = 0

  const scheduler = createThreadGoalScheduler({
    ownerId: `headless:${getSessionId()}`,
    now: () => Date.now(),
    getGoal: () => getAppState().threadGoal ?? null,
    saveGoal: nextGoal => {
      saveThreadGoal(nextGoal)
      setAppState(prev =>
        prev.threadGoal?.goalId === nextGoal.goalId
          ? { ...prev, threadGoal: nextGoal }
          : prev,
      )
    },
    // Headless has no user typing alongside it: reaching the idle boundary IS
    // the whole gate. The caller only asks when the queue has drained.
    canStartAutomaticTurn: () => true,
    getUnresolvedDependencies: () => dependencies.read(),
    // Unlike the other runtimes, the scheduler cannot submit here: headless
    // owns its own queue. It captures the prompt instead and the caller
    // enqueues it, which keeps one scheduler deciding for every runtime.
    startTurn: ({ prompt }) => {
      pendingPrompt = prompt
      return true
    },
  })

  return {
    async nextContinuation(messages) {
      const goal = getAppState().threadGoal
      if (!goal) return null

      // Charge the turn that just ended before deciding anything, so a budget
      // or stall stop it triggers is already durable when the scheduler looks.
      const turnMessages = messages.slice(turnMessageStartIndex)
      const usage = sumRealThreadGoalUsage(turnMessages, chargedResponseIds)
      const toolUseCount = turnMessages.filter(
        message =>
          message.type === 'assistant' &&
          Array.isArray(message.message?.content) &&
          message.message.content.some(
            block => (block as { type?: string }).type === 'tool_use',
          ),
      ).length

      // How the turn ended, from the messages it produced. The terminal reads
      // the same signal; without it `failed` and `usage_limited` were
      // unreachable here.
      let turnFailed = false
      let turnUsageLimited = false
      for (const message of turnMessages) {
        if (
          message.type !== 'assistant' ||
          !('isApiErrorMessage' in message) ||
          !message.isApiErrorMessage
        ) {
          continue
        }
        turnFailed = true
        const text = Array.isArray(message.message?.content)
          ? message.message.content
              .map(block =>
                (block as { type?: string; text?: string }).type === 'text'
                  ? ((block as { text?: string }).text ?? '')
                  : '',
              )
              .join('')
          : ''
        // A usage limit is not flaky: retrying cannot clear it, so it stops
        // the goal outright rather than spending the retry allowance.
        if (isRateLimitErrorMessage(text)) turnUsageLimited = true
      }

      const repetition = detectThreadGoalRepetition({
        history: goal.callHistory ?? [],
        calls: collectThreadGoalToolCalls(turnMessages),
      })

      scheduler.settle({
        attempt: runningAttempt,
        goalId: goal.goalId,
        accounting: {
          usage,
          chargedResponseIds: usage.chargedResponseIds,
          contextGrowthTokens: 0,
          timeDeltaSeconds: Math.max(
            0,
            Math.floor((Date.now() - turnStartMs) / 1000),
          ),
          madeNoProgress:
            !didThreadGoalTurnMakeProgress({
              continuationKind: runningAttempt?.kind ?? null,
              toolUseCount,
            }) || repetition.repeatedEverything,
          callHistory: repetition.nextHistory,
          childAgentIds: dependencies.readChildAgentIds(),
          // Derived, not assumed. Hardcoding false made `failed` and
          // `usage_limited` unreachable on -p: a goal whose every turn errored
          // burned its whole ceiling, and a provider 429 was retried instead
          // of stopping.
          failed: turnFailed,
          providerUsageLimited: turnUsageLimited,
        },
      })
      for (const id of usage.chargedResponseIds) chargedResponseIds.add(id)
      runningAttempt = null
      // Advance on EVERY path, not just when a continuation is issued.
      // Otherwise turn 2 of a streaming -p run charged elapsed-since-start
      // again, and turn 3 again.
      turnStartMs = Date.now()
      turnMessageStartIndex = messages.length

      await dependencies.refresh()

      pendingPrompt = null
      idleSequence += 1
      await scheduler.wake({
        trigger: 'idle',
        sourceId: `headless-idle:${idleSequence}`,
      })

      if (!pendingPrompt) return null
      runningAttempt = scheduler.getRunningAttempt()
      return pendingPrompt
    },
  }
}
