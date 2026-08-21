/**
 * Live TUI session status: which dialog owns input, whether delegated work is
 * still running, and whether the session is busy, waiting, or idle.
 *
 * This module is the single owner of focused-dialog priority. `REPL.tsx`
 * gathers raw facts and calls in here; it must not re-rank dialogs locally,
 * because a second ranking is how the status list and the visible dialog
 * drifted apart in the first place.
 *
 * Ported from upstream Claude Code 2.1.237's aggregate activity derivation.
 * See docs/research/2026-08-20-current-upstream-session-activity-comparison.md
 * and docs/plans/2026-08-20-tui-session-activity-upstream-parity-implementation.md.
 */

import { type TaskStatus, type TaskType, isTerminalTaskStatus } from '../Task.js'
import type { TabStatusKind } from '../ink/hooks/use-tab-status.js'
import type { TaskState } from '../tasks/types.js'

/**
 * Every dialog that can own terminal input. `init-onboarding` is deliberately
 * absent: the old inline union named it, but REPL has neither a producer nor a
 * render branch for it.
 */
export type FocusedInputDialog =
  | 'message-selector'
  | 'sandbox-permission'
  | 'tool-permission'
  | 'prompt'
  | 'worker-sandbox-permission'
  | 'elicitation'
  | 'cost'
  | 'idle-return'
  | 'resume-paused-goal'
  | 'ide-onboarding'
  | 'model-switch'
  | 'undercover-callout'
  | 'effort-callout'
  | 'remote-callout'
  | 'lsp-recommendation'
  | 'plugin-hint'
  | 'desktop-upsell'
  | 'ultraplan-choice'
  | 'ultraplan-launch'

/**
 * Raw dialog facts. Gates that belong to the caller stay in the caller:
 * `hasExitFlow` is `exitFlow != null`, `hasCostDialog` is the already-derived
 * `showingCostDialog`, the ultraplan flags carry their feature and `!isLoading`
 * gates, and the ant-only callouts carry their build-user gate.
 */
export type FocusedInputDialogFacts = {
  isExiting: boolean
  hasExitFlow: boolean
  isMessageSelectorVisible: boolean
  suppressInterruptDialogs: boolean
  allowDialogsWithAnimation: boolean
  hasSandboxPermission: boolean
  hasToolPermission: boolean
  hasPrompt: boolean
  hasWorkerSandboxPermission: boolean
  hasElicitation: boolean
  hasCostDialog: boolean
  hasIdleReturn: boolean
  hasResumePausedGoal: boolean
  hasUltraplanChoice: boolean
  hasUltraplanLaunch: boolean
  hasIdeOnboarding: boolean
  hasModelSwitchCallout: boolean
  hasUndercoverCallout: boolean
  hasEffortCallout: boolean
  hasRemoteCallout: boolean
  hasLspRecommendation: boolean
  hasPluginHint: boolean
  hasDesktopUpsell: boolean
}

/**
 * Decide which dialog owns input. Order is load-bearing and mirrors the render
 * branches in `REPL.tsx`:
 *
 *   exit > message selector > typing suppression > local sandbox >
 *   tool permission > prompt > worker sandbox > elicitation > cost >
 *   idle return > resume paused goal > ultraplan choice > ultraplan launch >
 *   IDE onboarding > callouts > recommendations > upsell
 *
 * Local sandbox prompts sit above `allowDialogsWithAnimation` on purpose: a
 * network prompt has to reach the user even while a tool owns the frame.
 */
export function deriveFocusedInputDialog(
  facts: FocusedInputDialogFacts,
): FocusedInputDialog | undefined {
  // Exit states always take precedence.
  if (facts.isExiting || facts.hasExitFlow) return undefined

  // High priority dialogs (always show regardless of typing).
  if (facts.isMessageSelectorVisible) return 'message-selector'

  // Suppress interrupt dialogs while the user is actively typing, so a
  // keystroke cannot answer a prompt the user has not read yet.
  if (facts.suppressInterruptDialogs) return undefined

  if (facts.hasSandboxPermission) return 'sandbox-permission'

  // Permission/interactive dialogs (shown unless blocked by toolJSX).
  const allow = facts.allowDialogsWithAnimation
  if (allow && facts.hasToolPermission) return 'tool-permission'
  if (allow && facts.hasPrompt) return 'prompt'
  if (allow && facts.hasWorkerSandboxPermission) return 'worker-sandbox-permission'
  if (allow && facts.hasElicitation) return 'elicitation'
  if (allow && facts.hasCostDialog) return 'cost'
  if (allow && facts.hasIdleReturn) return 'idle-return'
  if (allow && facts.hasResumePausedGoal) return 'resume-paused-goal'
  if (allow && facts.hasUltraplanChoice) return 'ultraplan-choice'
  if (allow && facts.hasUltraplanLaunch) return 'ultraplan-launch'

  // Onboarding dialogs (special conditions).
  if (allow && facts.hasIdeOnboarding) return 'ide-onboarding'

  if (allow && facts.hasModelSwitchCallout) return 'model-switch'
  if (allow && facts.hasUndercoverCallout) return 'undercover-callout'
  if (allow && facts.hasEffortCallout) return 'effort-callout'
  if (allow && facts.hasRemoteCallout) return 'remote-callout'

  // Non-blocking suggestions, then the upsell, last.
  if (allow && facts.hasLspRecommendation) return 'lsp-recommendation'
  if (allow && facts.hasPluginHint) return 'plugin-hint'
  if (allow && facts.hasDesktopUpsell) return 'desktop-upsell'
  return undefined
}

export type TuiWaitingReason =
  | 'tool-approval'
  | 'input-needed'
  | 'worker-request'
  | 'sandbox-request'
  | 'dialog-open'

/**
 * Whether each dialog actually blocks the session on the user. Voluntary
 * navigation, callouts, recommendations, and upsells own keyboard focus
 * without the session waiting on anyone, so they map to `undefined`.
 *
 * The `Record` is total on purpose: a new dialog member fails to compile until
 * it makes this choice explicitly.
 */
const WAITING_REASON_BY_DIALOG: Record<
  FocusedInputDialog,
  TuiWaitingReason | undefined
> = {
  'sandbox-permission': 'sandbox-request',
  'worker-sandbox-permission': 'sandbox-request',
  'tool-permission': 'tool-approval',
  prompt: 'input-needed',
  elicitation: 'input-needed',
  cost: 'dialog-open',
  'idle-return': 'dialog-open',
  'ide-onboarding': 'dialog-open',
  'resume-paused-goal': 'input-needed',
  'ultraplan-choice': 'input-needed',
  'ultraplan-launch': 'input-needed',
  'message-selector': undefined,
  'model-switch': undefined,
  'undercover-callout': undefined,
  'effort-callout': undefined,
  'remote-callout': undefined,
  'lsp-recommendation': undefined,
  'plugin-hint': undefined,
  'desktop-upsell': undefined,
}

export function getDialogWaitingReason(
  dialog: FocusedInputDialog | undefined,
): TuiWaitingReason | undefined {
  return dialog === undefined ? undefined : WAITING_REASON_BY_DIALOG[dialog]
}

export type LocalWaitingFacts = {
  /**
   * The dialog the session is observed to be on: the visible one, or the one
   * typing is currently hiding. Always produced by `deriveFocusedInputDialog`,
   * never by a second ranking.
   */
  focusedInputDialog: FocusedInputDialog | undefined
  isExiting: boolean
  hasExitFlow: boolean
  hasPendingWorkerRequest: boolean
  hasPendingSandboxRequest: boolean
  isShowingLocalJsxCommand: boolean
}

/**
 * Why the session is blocked on this user, if it is.
 *
 * Outgoing worker and sandbox requests render outside the focused-dialog
 * switch, so they only apply when no dialog is observed. A visible local-JSX
 * command is the last fallback. Exit suppresses all of it: a session on its
 * way out is not waiting on anybody.
 */
export function deriveLocalWaitingReason(
  facts: LocalWaitingFacts,
): TuiWaitingReason | undefined {
  if (facts.isExiting || facts.hasExitFlow) return undefined
  if (facts.focusedInputDialog !== undefined) {
    return getDialogWaitingReason(facts.focusedInputDialog)
  }
  if (facts.hasPendingWorkerRequest) return 'worker-request'
  if (facts.hasPendingSandboxRequest) return 'sandbox-request'
  if (facts.isShowingLocalJsxCommand) return 'dialog-open'
  return undefined
}

/**
 * Human-readable waiting detail for the `BG_SESSIONS` PID record. Kept as a
 * plain string so the activity effect depends on a primitive, not an object.
 */
export function deriveTuiWaitingDetail(args: {
  reason: TuiWaitingReason | undefined
  toolName?: string
}): string | undefined {
  switch (args.reason) {
    case undefined:
      return undefined
    case 'tool-approval':
      return args.toolName === undefined
        ? 'input needed'
        : `approve ${args.toolName}`
    case 'worker-request':
      return 'worker request'
    case 'sandbox-request':
      return 'sandbox request'
    case 'dialog-open':
      return 'dialog open'
    case 'input-needed':
      return 'input needed'
    default: {
      const _exhaustive: never = args.reason
      void _exhaustive
      return undefined
    }
  }
}

export type DelegatedTaskStatus = {
  hasWorkingDelegatedTask: boolean
  waitingReason?: 'input-needed'
}

/**
 * The fields delegated classification reads. Declared structurally rather than
 * taken from `TaskState`, which currently widens to `any` because
 * `src/tasks/types.ts` imports two modules that do not exist on disk
 * (`LocalWorkflowTask`, `MonitorMcpTask`). Naming the fields here keeps this
 * classification checked regardless of that.
 */
type DelegatedTaskFacts = {
  type: TaskType
  status: TaskStatus
  /** local_agent: 'blocked' means the agent handed a question back to the user. */
  handoffStatus?: 'done' | 'blocked'
  /** in_process_teammate: teammate is holding for plan approval. */
  awaitingPlanApproval?: boolean
  /** in_process_teammate: teammate has nothing to do. */
  isIdle?: boolean
  /** remote_agent: ultraplan attention phases; undefined means still running. */
  ultraplanPhase?: 'needs_input' | 'plan_ready'
  /** remote_agent: deliberately never completes, so it is not pending work. */
  isLongRunning?: boolean
}

type DelegatedContribution = 'working' | 'waiting' | 'none'

/**
 * Classify one task's contribution to session status.
 *
 * `waiting` means the task is stalled on this user, so reporting busy would be
 * wrong even though the task row still says running. `none` means the task
 * exists but owns no pending work: counting every retained row would leave the
 * session permanently busy.
 */
function classifyDelegatedTask(task: DelegatedTaskFacts): DelegatedContribution {
  if (isTerminalTaskStatus(task.status)) return 'none'

  switch (task.type) {
    // Local shell, MCP monitors, and dream consolidation are not delegated
    // agent work and never block the user.
    case 'local_bash':
    case 'monitor_mcp':
    case 'dream':
      return 'none'

    // Includes a backgrounded main session, which runs as a local_agent.
    case 'local_agent':
      return task.handoffStatus === 'blocked' ? 'waiting' : 'working'

    case 'in_process_teammate':
      if (task.awaitingPlanApproval === true) return 'waiting'
      return task.isIdle === true ? 'none' : 'working'

    case 'remote_agent':
      if (
        task.ultraplanPhase === 'needs_input' ||
        task.ultraplanPhase === 'plan_ready'
      ) {
        return 'waiting'
      }
      return task.isLongRunning === true ? 'none' : 'working'

    case 'local_workflow':
      return 'working'

    default: {
      const _exhaustive: never = task.type
      void _exhaustive
      return 'none'
    }
  }
}

/**
 * Aggregate delegated facts. Working and waiting are independent: a blocked
 * agent and a running agent can coexist, and losing either fact produces a
 * wrong answer (false idle, or a machine that sleeps mid-run).
 *
 * Allocates, so REPL destructures the result into primitives before any effect
 * depends on it.
 */
export function deriveDelegatedTaskStatus(
  tasks: Readonly<Record<string, TaskState>>,
): DelegatedTaskStatus {
  let hasWorkingDelegatedTask = false
  let isWaiting = false

  for (const task of Object.values(tasks)) {
    const facts: DelegatedTaskFacts = task
    switch (classifyDelegatedTask(facts)) {
      case 'working':
        hasWorkingDelegatedTask = true
        break
      case 'waiting':
        isWaiting = true
        break
      case 'none':
        break
    }
  }

  return isWaiting
    ? { hasWorkingDelegatedTask, waitingReason: 'input-needed' }
    : { hasWorkingDelegatedTask }
}

/**
 * `waiting > busy > idle`. The only implementation of that precedence.
 *
 * Waiting wins because it answers who must act next. Busy covers work the
 * session owns, whether that is the local turn or a delegated worker still
 * running after the leader turn ended.
 */
export function deriveTuiSessionStatus(args: {
  isLoading: boolean
  hasWorkingDelegatedTask: boolean
  localWaitingReason: TuiWaitingReason | undefined
  delegatedWaitingReason: 'input-needed' | undefined
}): TabStatusKind {
  if (
    args.localWaitingReason !== undefined ||
    args.delegatedWaitingReason !== undefined
  ) {
    return 'waiting'
  }
  if (args.isLoading || args.hasWorkingDelegatedTask) return 'busy'
  return 'idle'
}

/**
 * Whether the machine should be kept awake.
 *
 * Deliberately not `sessionStatus !== 'idle'`. A foreground turn parked on a
 * permission dialog must stop holding `caffeinate`, which is existing
 * behavior, but delegated work that is still running must keep holding it even
 * while something else waits on the user.
 */
export function deriveHasOperationalWork(args: {
  isLoading: boolean
  hasWorkingDelegatedTask: boolean
  localWaitingReason: TuiWaitingReason | undefined
}): boolean {
  return (
    (args.isLoading && args.localWaitingReason === undefined) ||
    args.hasWorkingDelegatedTask
  )
}
