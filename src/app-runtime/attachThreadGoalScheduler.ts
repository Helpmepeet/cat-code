import type { AppSessionController } from './AppSessionController.js'
import type { AppSessionEvent } from './sessionEvents.js'
import { isRateLimitErrorMessage } from '../services/rateLimitMessages.js'
import type { ThreadGoal } from '../utils/threadGoal.js'
import {
  createThreadGoalScheduler,
  type ThreadGoalRunningAttempt,
  type ThreadGoalScheduler,
} from '../utils/threadGoalScheduler.js'
import {
  EMPTY_THREAD_GOAL_USAGE_DELTA,
  type ThreadGoalUsageDelta,
} from '../utils/threadGoalUsage.js'
import { createThreadGoalDependencyCache } from '../utils/threadGoalDependencies.js'
import {
  detectThreadGoalRepetition,
  type ThreadGoalToolCall,
} from '../utils/threadGoalRepetition.js'

/**
 * Drives the shared goal scheduler from an AppSessionController.
 *
 * This is the adapter that gives the desktop, web, and headless runtimes the
 * same goal loop the terminal has. It is deliberately built on the controller's
 * EVENT STREAM alone, with no reference to QueryEngine internals, so any
 * adapter that satisfies AppSessionControllerAdapter gets the loop for free.
 *
 * It owns no policy: schedulability, wake idempotency, attempt fencing, and
 * charging all live in threadGoalScheduler.ts. What lives here is the
 * translation between one runtime's events and that scheduler's ports.
 */

type TurnUsageTotals = {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
}

const EMPTY_TOTALS: TurnUsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
}

function readCumulativeUsage(value: unknown): TurnUsageTotals | null {
  if (!value || typeof value !== 'object') return null
  const usage = value as Record<string, unknown>
  const num = (key: string): number => {
    const raw = usage[key]
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
  }
  return {
    inputTokens: num('input_tokens') + num('cache_creation_input_tokens'),
    outputTokens: num('output_tokens'),
    cachedInputTokens: num('cache_read_input_tokens'),
  }
}

/**
 * Turn usage from two cumulative snapshots.
 *
 * `result.usage` is the engine's running total for the LIFE of its QueryEngine
 * instance, not the turn, so the turn's cost is the difference. A decrease
 * means the engine was replaced (a resume mints a fresh instance starting at
 * zero), in which case the new total IS the delta rather than a negative
 * number to clamp away.
 */
export function diffCumulativeTurnUsage(
  previous: TurnUsageTotals,
  current: TurnUsageTotals,
): ThreadGoalUsageDelta {
  const restarted =
    current.inputTokens < previous.inputTokens ||
    current.outputTokens < previous.outputTokens
  const base = restarted ? EMPTY_TOTALS : previous

  const inputTokens = Math.max(0, current.inputTokens - base.inputTokens)
  const outputTokens = Math.max(0, current.outputTokens - base.outputTokens)
  const cachedInputTokens = Math.max(
    0,
    current.cachedInputTokens - base.cachedInputTokens,
  )

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    billableTokens: inputTokens + outputTokens,
    responseCount: inputTokens + outputTokens > 0 ? 1 : 0,
  }
}

export type AttachThreadGoalSchedulerOptions = {
  controller: Pick<AppSessionController, 'subscribe' | 'submit'>
  /** Stable per-session id written into the attempt lease. */
  ownerId: string
  getGoal(): ThreadGoal | null
  saveGoal(goal: ThreadGoal): void
  isAgentMode?(): boolean
  hasExternalScheduler?(): boolean
  now?(): number
}

export type ThreadGoalSchedulerAttachment = {
  scheduler: ThreadGoalScheduler
  detach(): void
}

export function attachThreadGoalScheduler({
  controller,
  ownerId,
  getGoal,
  saveGoal,
  isAgentMode,
  hasExternalScheduler,
  now = () => Date.now(),
}: AttachThreadGoalSchedulerOptions): ThreadGoalSchedulerAttachment {
  let activeTurn = false
  let idleSequence = 0
  // Refreshed at turn boundaries, which is exactly when the set of
  // outstanding work can have changed.
  const dependencies = createThreadGoalDependencyCache()

  // Per-turn state, reset at every turn start.
  let turnAttempt: ThreadGoalRunningAttempt | null = null
  let turnGoalId: string | null = null
  let turnStartMs = 0
  let turnToolUseCount = 0
  // Tool calls this turn, joined by tool_use id so a call's identity includes
  // the result it produced. Without the result, re-running a check that now
  // passes would look like repetition.
  const turnToolUses = new Map<string, { toolName: string; input: unknown }>()
  const turnToolResults = new Map<string, unknown>()
  let turnFailed = false
  let turnUsageLimited = false
  let turnUsage: ThreadGoalUsageDelta = EMPTY_THREAD_GOAL_USAGE_DELTA
  let cumulativeUsage: TurnUsageTotals = EMPTY_TOTALS

  const scheduler = createThreadGoalScheduler({
    ownerId,
    now,
    getGoal,
    saveGoal,
    // The controller refuses a second concurrent turn itself, so "no turn is
    // running" is the whole gate here. There is no queued-input or dialog
    // concept on this path: a client submit simply wins the race by starting
    // the turn first, which this then observes.
    canStartAutomaticTurn: () => !activeTurn,
    getUnresolvedDependencies: () => dependencies.read(),
    ...(isAgentMode ? { isAgentMode } : {}),
    ...(hasExternalScheduler ? { hasExternalScheduler } : {}),
    startTurn: ({ prompt }) => {
      // Fire and forget: submit resolves when the TURN ends, and awaiting it
      // would keep the wake in flight for the whole turn. Failures surface as
      // the turn ending with no result, which settle already handles.
      void Promise.resolve(
        controller.submit(prompt, { isMeta: true }),
      ).catch(() => {})
      return true
    },
  })

  function beginTurn(): void {
    turnAttempt = scheduler.getRunningAttempt()
    turnGoalId = getGoal()?.goalId ?? null
    turnStartMs = now()
    turnToolUseCount = 0
    turnToolUses.clear()
    turnToolResults.clear()
    turnFailed = false
    turnUsageLimited = false
    turnUsage = EMPTY_THREAD_GOAL_USAGE_DELTA
  }

  function endTurn(): void {
    const attempt = turnAttempt
    const goalId = turnGoalId
    turnAttempt = null
    turnGoalId = null

    // Only calls whose result arrived are judged: a call still in flight has
    // no identity yet, and guessing one would produce false repetitions.
    const calls: ThreadGoalToolCall[] = []
    for (const [id, use] of turnToolUses) {
      if (!turnToolResults.has(id)) continue
      calls.push({
        toolName: use.toolName,
        input: use.input,
        result: turnToolResults.get(id),
      })
    }
    const goalNow = getGoal()
    const repetition = detectThreadGoalRepetition({
      history: goalNow?.callHistory ?? [],
      calls,
    })

    if (goalId) {
      scheduler.settle({
        attempt,
        goalId,
        accounting: {
          usage: turnUsage,
          // The response ledger is only needed where overlapping walks of one
          // message array can double-charge. This path derives usage from a
          // monotonic total, so there is nothing to dedupe.
          chargedResponseIds: [],
          contextGrowthTokens: 0,
          timeDeltaSeconds: Math.max(
            0,
            Math.floor((now() - turnStartMs) / 1000),
          ),
          // A turn that only reproduced calls it had already made, with the
          // same results, advanced nothing even though it used tools.
          madeNoProgress:
            attempt !== null &&
            (turnToolUseCount === 0 || repetition.repeatedEverything),
          callHistory: repetition.nextHistory,
          childAgentIds: dependencies.readChildAgentIds(),
          failed: turnFailed,
          providerUsageLimited: turnUsageLimited,
        },
      })
    }

    idleSequence += 1
    // Refresh BEFORE waking: the turn that just ended is the most likely thing
    // to have spawned or resolved a dependency.
    void dependencies.refresh().then(() =>
      scheduler.wake({ trigger: 'idle', sourceId: `idle:${idleSequence}` }),
    )
  }

  function observeMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return
    const sdk = message as Record<string, unknown>

    if (sdk.type === 'assistant_error') {
      turnFailed = true
      if (
        sdk.status === 429 ||
        (typeof sdk.error === 'string' && isRateLimitErrorMessage(sdk.error))
      ) {
        turnUsageLimited = true
      }
      return
    }

    if (sdk.type === 'assistant' || sdk.type === 'user') {
      const inner = sdk.message as { content?: unknown } | undefined
      if (!Array.isArray(inner?.content)) return
      for (const block of inner.content) {
        if (!block || typeof block !== 'object') continue
        const typed = block as Record<string, unknown>
        if (typed.type === 'tool_use') {
          turnToolUseCount += 1
          if (typeof typed.id === 'string') {
            turnToolUses.set(typed.id, {
              toolName: typeof typed.name === 'string' ? typed.name : 'unknown',
              input: typed.input,
            })
          }
        } else if (
          typed.type === 'tool_result' &&
          typeof typed.tool_use_id === 'string'
        ) {
          turnToolResults.set(typed.tool_use_id, typed.content)
        }
      }
      return
    }

    if (sdk.type === 'result') {
      if (sdk.is_error === true) turnFailed = true
      const current = readCumulativeUsage(sdk.usage)
      if (current) {
        turnUsage = diffCumulativeTurnUsage(cumulativeUsage, current)
        cumulativeUsage = current
      }
    }
  }

  const unsubscribe = controller.subscribe((event: AppSessionEvent) => {
    if (event.type === 'message') {
      observeMessage(event.message)
      return
    }
    if (event.type !== 'turn.status') return

    if (event.activeTurn) {
      activeTurn = true
      beginTurn()
      return
    }

    activeTurn = false
    endTurn()
  })

  return {
    scheduler,
    detach() {
      unsubscribe()
    },
  }
}
