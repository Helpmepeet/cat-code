import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'

export function getImmediateCommandQueryState(
  localQueryActive: boolean,
  externalQueryActive: boolean,
): boolean {
  return localQueryActive || externalQueryActive
}

/**
 * Whether inference-config commands (/model, /fast, /effort) should execute
 * immediately (during a running query) rather than waiting for the current
 * turn to finish.
 *
 * Always enabled for ants; gated by experiment for external users.
 */
export function shouldInferenceConfigCommandBeImmediate(): boolean {
  return (
    process.env.USER_TYPE === 'ant' ||
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_immediate_model_command', false)
  )
}

/**
 * Ownership tokens for the shared local-JSX slot used by immediate commands.
 *
 * Immediate dispatch is fire-and-forget and a command may do async work
 * before installing JSX or firing onDone (/context runs its whole analysis
 * first and never installs a panel). Two overlapping immediate commands can
 * therefore interleave: without ownership, a stale command's onDone
 * `clearLocalJSX` evicts a newer command's panel — or nulls unrelated live
 * toolJSX when no panel is installed (PR #9 review, finding 1).
 *
 * Rules enforced via resolveToolJsxUpdate:
 * - an owned clear only clears a panel installed by the same owner;
 * - an owned clear with no active panel is a no-op (never touches tool UI);
 * - ownerless calls (the serialized queued-command path) keep the historical
 *   clear-anything behavior.
 */

let lastClaimedOwner = 0

export function claimImmediateOwner(): number {
  return ++lastClaimedOwner
}

export function isCurrentImmediateOwner(owner: number): boolean {
  return owner === lastClaimedOwner
}

/**
 * Set while the serialized (queued) path is dispatching a local-JSX command
 * that has not yet installed its panel or fired onDone. The serialized path
 * issues OWNERLESS installs/clears (processSlashCommand.tsx local-jsx case,
 * executeUserInput's clearLocalJSX), so an immediate command overlapping this
 * window would be evicted by the serialized command's late ownerless clear —
 * the round-2 review race. While pending, immediate dispatch must decline and
 * let input take the serialized queue path instead. Safe as a single flag:
 * the queue processor and the query guard serialize these dispatches.
 */
let serializedLocalJsxPending = false

export function markSerializedLocalJsxPending(): void {
  serializedLocalJsxPending = true
}

export function clearSerializedLocalJsxPending(): void {
  serializedLocalJsxPending = false
}

export function isSerializedLocalJsxPending(): boolean {
  return serializedLocalJsxPending
}

export function _forTestResetImmediateOwner(): void {
  lastClaimedOwner = 0
  serializedLocalJsxPending = false
}

export type ToolJsxSlotAction = 'install' | 'clear' | 'ignore' | 'apply'

export function resolveToolJsxUpdate(
  activeLocalJsxOwner: number | undefined,
  hasActiveLocalJsx: boolean,
  update: {
    isLocalJSXCommand?: boolean
    clearLocalJSX?: boolean
    localJsxOwner?: number
  } | null,
): ToolJsxSlotAction {
  if (update?.isLocalJSXCommand) return 'install'
  if (hasActiveLocalJsx) {
    if (
      update?.clearLocalJSX &&
      (update.localJsxOwner === undefined ||
        update.localJsxOwner === activeLocalJsxOwner)
    ) {
      return 'clear'
    }
    return 'ignore'
  }
  if (update?.clearLocalJSX) {
    return update.localJsxOwner === undefined ? 'clear' : 'ignore'
  }
  return 'apply'
}
