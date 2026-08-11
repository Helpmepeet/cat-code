/**
 * Plan-mode domain — P4-11 (`PlanBar`/`PlanPanel`), reusing P2-4's
 * permission-mode read path (decisions/PERMISSION-BOUNDARY.md C1-C3). There
 * is NO new read-seam here: a plan review IS a permission request
 * (`ExitPlanMode`, `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts`), so
 * everything below is derived from the SAME `permission.requested` /
 * `permission.resolved` events `permissionState.ts` already models — never a
 * parallel store (PARITY-LEDGER.md §24 / INVENTORY §W4).
 *
 * Real vs GUI-invented (PARITY-LEDGER.md §24, phase4.md:636 "flag, don't
 * fabricate progress"): the plan FILE path, its text, and the
 * `allowedPrompts` it requests are real tool-call input
 * (`ExitPlanModeV2Tool.ts` `_sdkInputSchema`/`inputSchema`, :97-108/:77-89).
 * The prototype's persistent reopenable drawer + live per-step execution
 * checklist (pending/running/done/blocked) have NO engine counterpart — the
 * engine tracks no per-step state, and the ExitPlanMode request itself is
 * REMOVED from the queue the instant it resolves (approve or deny,
 * `permissionState.ts` `removeRequest`). So `selectPlanReview` below only
 * ever returns non-null while the review is genuinely pending; there is
 * nothing to reopen afterward, and no fabricated "executing" sub-state.
 */

import type {
  PermissionQueueItem,
  PermissionRequest,
  PermissionState,
} from './permissionState.js'
import {
  isPlanPermissionRequest,
  selectPermissionQueue,
} from './permissionState.js'
import type { SessionId } from '../../shared/protocol.js'

// Re-exported for parity: the plan-request predicate + tool-name literal are
// owned by `permissionState.ts` (single source of truth for the ACTION and
// RENDER paths), and consumers of the plan domain still read them from here.
export { EXIT_PLAN_MODE_TOOL_NAME } from './permissionState.js'

export type PlanReviewData = {
  /** SOURCE-BACKED: `ExitPlanModeV2Tool.ts` `_sdkInputSchema` `plan` (:99-102). */
  plan: string | null
  /** SOURCE-BACKED: `_sdkInputSchema` `planFilePath` (:103-106). */
  planFilePath: string | null
  /** SOURCE-BACKED: `inputSchema` `allowedPrompts` (:81-86). */
  allowedPrompts: Array<{ tool: string; prompt: string }>
}

export type PlanReview = {
  request: PermissionRequest
  /** An answer (approve/revise) is in flight for this review. */
  submitted: boolean
  data: PlanReviewData
}

function narrowAllowedPrompt(
  value: unknown,
): { tool: string; prompt: string } | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.tool !== 'string' || typeof record.prompt !== 'string') {
    return null
  }
  return { tool: record.tool, prompt: record.prompt }
}

function narrowPlanReviewData(input: Record<string, unknown>): PlanReviewData {
  const plan = typeof input.plan === 'string' ? input.plan : null
  const planFilePath =
    typeof input.planFilePath === 'string' ? input.planFilePath : null
  const allowedPrompts: Array<{ tool: string; prompt: string }> = []
  if (Array.isArray(input.allowedPrompts)) {
    for (const entry of input.allowedPrompts) {
      const narrowed = narrowAllowedPrompt(entry)
      if (narrowed) allowedPrompts.push(narrowed)
    }
  }
  return { plan, planFilePath, allowedPrompts }
}

/** The pending `ExitPlanMode` review for this session, or `null` if none. */
export function selectPlanReview(
  state: PermissionState,
  sessionId: SessionId | null,
): PlanReview | null {
  const item = selectPermissionQueue(state, sessionId).find(candidate =>
    isPlanPermissionRequest(candidate.request),
  )
  if (!item) return null
  return {
    request: item.request,
    submitted: item.submitted,
    data: narrowPlanReviewData(item.request.request.input),
  }
}

/**
 * The generic permission queue minus the plan review — `PlanBar`/`PlanPanel`
 * own `ExitPlanMode` exclusively (TUI parity: `ExitPlanModePermissionRequest`
 * is its own dedicated renderer, never the generic per-tool card).
 */
export function selectNonPlanPermissionQueue(
  state: PermissionState,
  sessionId: SessionId | null,
): PermissionQueueItem[] {
  return selectPermissionQueue(state, sessionId).filter(
    item => !isPlanPermissionRequest(item.request),
  )
}

/**
 * A real, derived step count from the plan's markdown text — top-level
 * numbered (`1.`/`1)`) or bulleted (`-`/`*`) list items. This is a display
 * derivation of REAL text (the plan is free-form markdown, no structured
 * step field exists engine-side); it is NOT the per-step execution state the
 * prototype invents (StepDot rows, PARITY-LEDGER.md §24) — that stays cut.
 */
export function parsePlanSteps(plan: string | null): string[] {
  if (!plan) return []
  const steps: string[] = []
  for (const line of plan.split('\n')) {
    const match = /^\s*(?:[-*]|\d+[.)])\s+(.+?)\s*$/.exec(line)
    if (match?.[1]) steps.push(match[1])
  }
  return steps
}

/**
 * The two plan-approval modes intentionally offered by this menu. The general
 * permission-mode picker also supports `bypassPermissions`, but this approval
 * menu keeps its smaller two-choice flow.
 */
export type PlanApprovalMode = 'default' | 'acceptEdits'

export type PlanApprovalOption = {
  mode: PlanApprovalMode
  label: string
  description: string
}

export const PLAN_APPROVE_OPTIONS: PlanApprovalOption[] = [
  {
    mode: 'acceptEdits',
    label: 'Approve & auto-accept edits',
    description: 'Run the plan, applying edits automatically.',
  },
  {
    mode: 'default',
    label: 'Approve & ask per edit',
    description: 'Run, but confirm each edit/command.',
  },
]
