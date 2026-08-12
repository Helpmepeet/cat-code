import { getMaxOutputTokensForModel } from '../services/api/claude.js'
import {
  applyLongContextEntitlementCap,
  type ContextWindowSource,
  is1mContextDisabled,
  isLongContextEntitlementRefused,
  isLongContextEntitlementScoped,
  readMaxContextTokensOverride,
  resolveNativeContextWindow,
} from './context.js'

/**
 * Four different numbers have been called "the context window", and Cat used to
 * collapse them into one, so it could neither explain nor react when they
 * diverged. They are:
 *
 *   native      what the model advertises
 *   entitled    what the account turned out to be allowed to use
 *   configured  what the operator asked for
 *   effective   what compaction actually budgets against
 *
 * Each step down carries a reason, and the reasons are what a user needs when
 * their window is smaller than the model's headline number. `clamps` records
 * every narrowing that actually moved a number, in the order it was applied.
 */

// Reserve this many tokens for output during compaction
// Based on p99.99 of compact summary output being 17,387 tokens.
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000

export type ContextWindowClampReason =
  /** `CLAUDE_CODE_DISABLE_1M_CONTEXT`, the C4E compliance kill switch. */
  | 'disable_1m_context'
  /** The provider refused long context for this account. */
  | 'long_context_entitlement'
  /** Ant-only `CLAUDE_CODE_MAX_CONTEXT_TOKENS`. Can raise as well as lower. */
  | 'max_context_tokens_override'
  /** `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. */
  | 'auto_compact_window'
  /** Output capacity held back so a summary response still fits. */
  | 'output_reservation'

export type ContextWindowClamp = {
  reason: ContextWindowClampReason
  from: number
  to: number
}

export type ContextWindowPolicy = {
  /** What the model advertises, before account or operator narrowing. */
  native: number
  /** Which resolution branch produced `native`. */
  nativeSource: ContextWindowSource
  /** `native`, capped by what the account is entitled to. */
  entitled: number
  /** `entitled`, with operator configuration applied. */
  configured: number
  /** `configured`, minus reserved output. What compaction budgets against. */
  effective: number
  outputReservation: number
  /** Ordered; only narrowings that actually moved a number appear. */
  clamps: ContextWindowClamp[]
}

function readAutoCompactWindow(): number | undefined {
  const raw = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  if (!raw) {
    return undefined
  }
  const parsed = parseInt(raw, 10)
  return !isNaN(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * Resolve all four windows and the reason for every step between them.
 *
 * Equivalence to the pre-split behavior is load-bearing and tested: with no
 * entitlement refusal latched, `effective` is exactly the old
 * `min(getContextWindowForModel(model, betas), CLAUDE_CODE_AUTO_COMPACT_WINDOW)
 * - min(getMaxOutputTokensForModel(model), 20_000)`, so every threshold derived
 * from it is unchanged for a healthy account.
 *
 * Note that the reservation subtracts the model's DEFAULT max-output tokens,
 * not its upper limit, and that default is itself capped to 8,000 when the
 * `tengu_otk_slot_v1` growthbook flag is on (`claude.ts`
 * `getMaxOutputTokensForModel`). Flipping that flag moves every derived
 * threshold, which is why the reservation is reported rather than assumed.
 */
export function resolveContextWindowPolicy(
  model: string,
  betas?: string[],
): ContextWindowPolicy {
  const clamps: ContextWindowClamp[] = []
  const advertised = resolveNativeContextWindow(model, betas, {
    ignore1mDisable: true,
    ignoreMaxContextTokensOverride: true,
  })
  const native = advertised.window

  let entitled = native
  if (
    isLongContextEntitlementRefused() &&
    isLongContextEntitlementScoped(advertised.source)
  ) {
    entitled = applyLongContextEntitlementCap(advertised)
    if (entitled < native) {
      clamps.push({
        reason: 'long_context_entitlement',
        from: native,
        to: entitled,
      })
    }
  }

  let configured = entitled
  // Re-resolve rather than min-ing against a constant: the kill switch does not
  // uniformly mean 200,000. It nullifies the 1M branches and lets resolution
  // fall through, and the capability-cache branch clamps instead of falling
  // through, so the post-switch number is whatever the remaining branches say.
  if (is1mContextDisabled()) {
    const afterDisable = resolveNativeContextWindow(model, betas, {
      ignoreMaxContextTokensOverride: true,
    }).window
    if (afterDisable < configured) {
      clamps.push({
        reason: 'disable_1m_context',
        from: configured,
        to: afterDisable,
      })
      configured = afterDisable
    }
  }

  // Exempt from the entitlement cap for the reason given on
  // applyLongContextEntitlementCap: this one is an operator typing a number.
  const override = readMaxContextTokensOverride()
  if (override !== undefined && override !== configured) {
    clamps.push({
      reason: 'max_context_tokens_override',
      from: configured,
      to: override,
    })
    configured = override
  }

  const autoCompactWindow = readAutoCompactWindow()
  if (autoCompactWindow !== undefined && autoCompactWindow < configured) {
    clamps.push({
      reason: 'auto_compact_window',
      from: configured,
      to: autoCompactWindow,
    })
    configured = autoCompactWindow
  }

  const outputReservation = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  const effective = configured - outputReservation
  clamps.push({
    reason: 'output_reservation',
    from: configured,
    to: effective,
  })

  return {
    native,
    nativeSource: advertised.source,
    entitled,
    configured,
    effective,
    outputReservation,
    clamps,
  }
}

/**
 * One-line provenance for the debug log. ASCII only and never user-visible:
 * this names environment variables and resolution branches, which belong in a
 * log, not on screen.
 */
export function formatContextWindowProvenance(
  policy: ContextWindowPolicy,
): string {
  const steps = policy.clamps
    .map(clamp => ` ${clamp.reason}=${clamp.from}->${clamp.to}`)
    .join('')
  return `native=${policy.native}(${policy.nativeSource})${steps}`
}
