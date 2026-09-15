// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { resolveAntModel } from './model/antModels.js'
import { CONTEXT_1M_BETA_HEADER } from '../constants/betas.js'
import { getGlobalConfig } from './config.js'
import { isEnvTruthy } from './envUtils.js'
import { getCanonicalName } from './model/model.js'
import { getModelCapability } from './model/modelCapabilities.js'

// Model context window size (200k tokens for all models right now)
export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000

// Maximum output tokens for compact operations
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000

// Default max output tokens
const MAX_OUTPUT_TOKENS_DEFAULT = 32_000
const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 64_000

// Capped default for slot-reservation optimization. BQ p99 output = 4,911
// tokens, so 32k/64k defaults over-reserve 8-16× slot capacity. With the cap
// enabled, <1% of requests hit the limit; those get one clean retry at 64k
// (see query.ts max_output_tokens_escalate). Cap is applied in
// claude.ts:getMaxOutputTokensForModel to avoid the growthbook→betas→context
// import cycle.
export const CAPPED_DEFAULT_MAX_TOKENS = 8_000
export const ESCALATED_MAX_TOKENS = 64_000

/**
 * Check if 1M context is disabled via environment variable.
 * Used by C4E admins to disable 1M context for HIPAA compliance.
 */
export function is1mContextDisabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT)
}

export function has1mContext(model: string): boolean {
  return has1mSuffix(model, is1mContextDisabled())
}

function has1mSuffix(model: string, disabled: boolean): boolean {
  if (disabled) {
    return false
  }
  return /\[1m\]/i.test(model)
}

// @[MODEL LAUNCH]: Update this pattern if the new model supports 1M context
export function modelSupports1M(model: string): boolean {
  return supports1M(model, is1mContextDisabled())
}

function supports1M(model: string, disabled: boolean): boolean {
  if (disabled) {
    return false
  }
  const canonical = getCanonicalName(model)
  return canonical.includes('claude-sonnet-4') || canonical.includes('opus-4-6') || canonical.includes('claude-sonnet-5') || canonical.includes('claude-opus-5') || canonical.includes('claude-fable-5')
}

/**
 * Claude 5 frontier models use the 1M context window without requiring the
 * legacy `[1m]` model-selection suffix. Keep the suffix support above for
 * older models and explicit user configuration.
 */
export function modelUses1MContextByDefault(model: string): boolean {
  return uses1MByDefault(model, is1mContextDisabled())
}

function uses1MByDefault(model: string, disabled: boolean): boolean {
  if (disabled) {
    return false
  }
  const canonical = getCanonicalName(model)
  return (
    canonical.includes('claude-sonnet-5') ||
    canonical.includes('claude-opus-5') ||
    canonical.includes('claude-fable-5')
  )
}

/**
 * Which branch of the resolution below produced a model's advertised window.
 *
 * This tag is DECISIONAL, not cosmetic. The long-context entitlement cap is an
 * Anthropic extra-usage fact, so it must never narrow a window a Codex model
 * advertises: `isLongContextEntitlementScoped` reads this tag to decide.
 */
export type ContextWindowSource =
  | 'max_context_tokens_override'
  | 'model_1m_suffix'
  | 'frontier_1m_default'
  | 'model_capability_cache'
  | 'context_1m_beta'
  | 'sonnet_1m_experiment'
  | 'gpt_5_6_codex'
  | 'gpt_astra_codex'
  | 'gpt_default'
  | 'ant_model_catalog'
  | 'default'

export type NativeContextWindow = {
  window: number
  source: ContextWindowSource
}

export type NativeContextWindowOptions = {
  /**
   * Resolve as if `CLAUDE_CODE_DISABLE_1M_CONTEXT` were unset, i.e. what the
   * model advertises before the compliance kill switch narrows it. Only the
   * policy resolver uses this, to report the kill switch as its own clamp
   * instead of silently folding it into the model's advertised window.
   */
  ignore1mDisable?: boolean
  /**
   * Resolve as if the ant-only `CLAUDE_CODE_MAX_CONTEXT_TOKENS` were unset.
   * Same reason: an operator ceiling is configuration, not advertisement.
   */
  ignoreMaxContextTokensOverride?: boolean
}

/**
 * The window the MODEL advertises, plus which branch said so.
 *
 * Eleven branches, in precedence order: the ant operator override, the `[1m]`
 * suffix, the Claude 5 frontier default, the first-party capability cache, the
 * 1M beta header, the Sonnet 1M experiment, GPT-5.6 Sol, other GPT-5.6 Codex,
 * other `gpt-*`, the ant model catalog, and the 200,000 fallback. Every
 * Claude-side 1M branch is nullified by
 * `CLAUDE_CODE_DISABLE_1M_CONTEXT`, and the capability-cache branch clamps back
 * to 200,000 under it rather than falling through.
 */
export function resolveNativeContextWindow(
  model: string,
  betas?: string[],
  options: NativeContextWindowOptions = {},
): NativeContextWindow {
  const disabled = options.ignore1mDisable ? false : is1mContextDisabled()

  // Allow override via environment variable (ant-only)
  // This takes precedence over all other context window resolution, including 1M detection,
  // so users can cap the effective context window for local decisions (auto-compact, etc.)
  // while still using a 1M-capable endpoint.
  if (!options.ignoreMaxContextTokensOverride) {
    const override = readMaxContextTokensOverride()
    if (override !== undefined) {
      return { window: override, source: 'max_context_tokens_override' }
    }
  }

  // [1m] suffix — explicit client-side opt-in, respected over all detection
  if (has1mSuffix(model, disabled)) {
    return { window: 1_000_000, source: 'model_1m_suffix' }
  }

  // Claude 5 frontier models have a 1M context window by default. This must
  // precede capability-cache lookup so a cold or stale cache cannot make the
  // statusline and compaction logic fall back to the legacy 200k default.
  if (uses1MByDefault(model, disabled)) {
    return { window: 1_000_000, source: 'frontier_1m_default' }
  }

  const cap = getModelCapability(model)
  if (cap?.max_input_tokens && cap.max_input_tokens >= 100_000) {
    if (cap.max_input_tokens > MODEL_CONTEXT_WINDOW_DEFAULT && disabled) {
      return {
        window: MODEL_CONTEXT_WINDOW_DEFAULT,
        source: 'model_capability_cache',
      }
    }
    return { window: cap.max_input_tokens, source: 'model_capability_cache' }
  }

  if (betas?.includes(CONTEXT_1M_BETA_HEADER) && supports1M(model, disabled)) {
    return { window: 1_000_000, source: 'context_1m_beta' }
  }
  if (sonnet1mExpTreatmentEnabled(model, disabled)) {
    return { window: 1_000_000, source: 'sonnet_1m_experiment' }
  }
  const canonicalModel = getCanonicalName(model)
  // GPT-5.6 Sol runs a 1M Codex context window. It shares the `gpt_5_6_codex`
  // source with its 372k siblings on purpose: the source is what exempts a
  // Codex window from the Anthropic long-context entitlement cap (see
  // isLongContextEntitlementScoped), and that exemption is not about the size.
  // For the same reason it is not routed through the 1M branches above —
  // CLAUDE_CODE_DISABLE_1M_CONTEXT is a first-party compliance switch and has
  // never narrowed a Codex window.
  if (canonicalModel === 'gpt-5.6-sol') {
    return { window: 1_000_000, source: 'gpt_5_6_codex' }
  }
  // GPT-5.6 Terra and Luna have a 372k Codex context window.
  if (canonicalModel === 'gpt-5.6-terra' || canonicalModel === 'gpt-5.6-luna') {
    return { window: 372_000, source: 'gpt_5_6_codex' }
  }
  if (canonicalModel === 'gpt-6-astra') {
    return { window: 1_050_000, source: 'gpt_astra_codex' }
  }
  // GPT/Codex models: 272k max input tokens (400k total budget minus 128k output reserve)
  if (canonicalModel.startsWith('gpt-')) {
    return { window: 272_000, source: 'gpt_default' }
  }

  if (process.env.USER_TYPE === 'ant') {
    const antModel = resolveAntModel(model)
    if (antModel?.contextWindow) {
      return { window: antModel.contextWindow, source: 'ant_model_catalog' }
    }
  }
  return { window: MODEL_CONTEXT_WINDOW_DEFAULT, source: 'default' }
}

/**
 * The ant-only operator ceiling, or undefined when unset or unparseable.
 * Exported so the policy resolver applies the exact same gate rather than a
 * lookalike that could drift.
 */
export function readMaxContextTokensOverride(): number | undefined {
  if (
    process.env.USER_TYPE !== 'ant' ||
    !process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  ) {
    return undefined
  }
  const override = parseInt(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, 10)
  return !isNaN(override) && override > 0 ? override : undefined
}

/**
 * The window this model is currently usable at: what it advertises, capped by
 * what the account turned out to be entitled to. This is the NOMINAL window
 * (statusline denominator, `/context`, cost tracker, tool-search sizing);
 * compaction budgets against `resolveContextWindowPolicy(...).effective`, which
 * additionally reserves output capacity.
 */
export function getContextWindowForModel(
  model: string,
  betas?: string[],
): number {
  const resolved = resolveNativeContextWindow(model, betas)
  return applyLongContextEntitlementCap(resolved)
}

export function getSonnet1mExpTreatmentEnabled(model: string): boolean {
  return sonnet1mExpTreatmentEnabled(model, is1mContextDisabled())
}

function sonnet1mExpTreatmentEnabled(model: string, disabled: boolean): boolean {
  if (disabled) {
    return false
  }
  // Only applies to sonnet 4.6 without an explicit [1m] suffix
  if (has1mSuffix(model, disabled)) {
    return false
  }
  if (!getCanonicalName(model).includes('sonnet-4-6')) {
    return false
  }
  return getGlobalConfig().clientDataCache?.['coral_reef_sonnet'] === 'true'
}

/**
 * The window a session falls back to once the provider has refused long
 * context. Same number as the legacy default, but a distinct constant: this one
 * is an entitlement ceiling, not a "we don't know this model" guess.
 */
export const LONG_CONTEXT_ENTITLEMENT_WINDOW = MODEL_CONTEXT_WINDOW_DEFAULT

let longContextEntitlementRefused = false
let longContextEntitlementAccountUuid: string | undefined

function getActiveClaudeAccountUuid(): string | undefined {
  return getGlobalConfig().activeClaudeAccountUuid
}

/**
 * Record that the provider refused this request because the account is not
 * entitled to long context.
 *
 * This is durable information about the session, not a transient error: the
 * same account retried against the same endpoint refuses the same way, so
 * retrying is a guaranteed second failure. Latching it narrows the session's
 * windows (see `getContextWindowForModel` and `resolveContextWindowPolicy`) so
 * the next turn's autocompact budget is one the account can actually spend.
 *
 * Deliberately process-scoped and in memory. Entitlement is enabled in a minute
 * at claude.ai/settings/usage, so persisting the cap would keep a 1M model
 * pinned at 200,000 long after the user fixed it, with nothing on screen to say
 * why. A restart is the cheapest possible reset, and `/extra-usage` already
 * exists for the fix itself.
 *
 * The active Claude account pointer is also the existing account-switch signal.
 * Binding the refusal to that pointer avoids an import cycle through auth while
 * ensuring a different account starts with its own entitlement budget.
 */
export function noteLongContextEntitlementRefused(): void {
  longContextEntitlementRefused = true
  longContextEntitlementAccountUuid = getActiveClaudeAccountUuid()
}

export function isLongContextEntitlementRefused(): boolean {
  if (
    longContextEntitlementRefused &&
    longContextEntitlementAccountUuid !== getActiveClaudeAccountUuid()
  ) {
    longContextEntitlementRefused = false
    longContextEntitlementAccountUuid = undefined
  }
  return longContextEntitlementRefused
}

export function _resetLongContextEntitlementForTest(): void {
  longContextEntitlementRefused = false
  longContextEntitlementAccountUuid = undefined
}

/**
 * Does the long-context entitlement cap govern a window from this branch?
 *
 * Extra usage is an Anthropic first-party entitlement, so a Codex model's 272K,
 * 372K, or 1M window is not the provider's to refuse. Without this, one
 * Anthropic refusal would silently cut a later `gpt-5.6-luna` turn's budget by
 * 172,000 tokens for the rest of the session, and a `gpt-5.6-sol` turn's by
 * 800,000.
 */
export function isLongContextEntitlementScoped(
  source: ContextWindowSource,
): boolean {
  return (
    source !== 'gpt_5_6_codex' &&
    source !== 'gpt_astra_codex' &&
    source !== 'gpt_default'
  )
}

/**
 * The ant operator override is exempt on purpose: it is someone explicitly
 * typing a ceiling for local decisions, and entitlement narrows what the MODEL
 * advertises, not what the operator asked for.
 */
export function applyLongContextEntitlementCap(
  resolved: NativeContextWindow,
): number {
  if (
    !isLongContextEntitlementRefused() ||
    resolved.source === 'max_context_tokens_override' ||
    !isLongContextEntitlementScoped(resolved.source) ||
    resolved.window <= LONG_CONTEXT_ENTITLEMENT_WINDOW
  ) {
    return resolved.window
  }
  return LONG_CONTEXT_ENTITLEMENT_WINDOW
}

/**
 * Calculate context window usage percentage from a pre-computed token count.
 * Returns used and remaining percentages, or null values if tokenCount is null.
 */
export function calculateContextPercentages(
  tokenCount: number | null,
  effectiveWindow: number,
): { used: number | null; remaining: number | null } {
  if (tokenCount === null) {
    return { used: null, remaining: null }
  }

  const usedPercentage = Math.round((tokenCount / effectiveWindow) * 100)
  const clampedUsed = Math.min(100, Math.max(0, usedPercentage))

  return {
    used: clampedUsed,
    remaining: 100 - clampedUsed,
  }
}

/**
 * Returns the model's default and upper limit for max output tokens.
 */
export function getModelMaxOutputTokens(model: string): {
  default: number
  upperLimit: number
} {
  let defaultTokens: number
  let upperLimit: number

  if (process.env.USER_TYPE === 'ant') {
    const antModel = resolveAntModel(model.toLowerCase())
    if (antModel) {
      defaultTokens = antModel.defaultMaxTokens ?? MAX_OUTPUT_TOKENS_DEFAULT
      upperLimit = antModel.upperMaxTokensLimit ?? MAX_OUTPUT_TOKENS_UPPER_LIMIT
      return { default: defaultTokens, upperLimit }
    }
  }

  const m = getCanonicalName(model)

  // GPT/Codex models: 128k max output (gpt-5.1-codex-mini is 100k, use 100k as safe floor)
  if (m.startsWith('gpt-')) {
    const upperLimit = m.includes('codex-mini') ? 100_000 : 128_000
    return { default: 32_000, upperLimit }
  }

  if (m.includes('fable-5') || m.includes('opus-5') || m.includes('sonnet-5')) {
    defaultTokens = 64_000
    upperLimit = 128_000
  } else if (m.includes('opus-4-6')) {
    defaultTokens = 64_000
    upperLimit = 128_000
  } else if (m.includes('sonnet-4-6')) {
    defaultTokens = 32_000
    upperLimit = 128_000
  } else if (
    m.includes('opus-4-5') ||
    m.includes('sonnet-4') ||
    m.includes('haiku-4')
  ) {
    defaultTokens = 32_000
    upperLimit = 64_000
  } else if (m.includes('opus-4-1') || m.includes('opus-4')) {
    defaultTokens = 32_000
    upperLimit = 32_000
  } else if (m.includes('claude-3-opus')) {
    defaultTokens = 4_096
    upperLimit = 4_096
  } else if (m.includes('claude-3-sonnet')) {
    defaultTokens = 8_192
    upperLimit = 8_192
  } else if (m.includes('claude-3-haiku')) {
    defaultTokens = 4_096
    upperLimit = 4_096
  } else if (m.includes('3-5-sonnet') || m.includes('3-5-haiku')) {
    defaultTokens = 8_192
    upperLimit = 8_192
  } else if (m.includes('3-7-sonnet')) {
    defaultTokens = 32_000
    upperLimit = 64_000
  } else {
    defaultTokens = MAX_OUTPUT_TOKENS_DEFAULT
    upperLimit = MAX_OUTPUT_TOKENS_UPPER_LIMIT
  }

  const cap = getModelCapability(model)
  if (cap?.max_tokens && cap.max_tokens >= 4_096) {
    upperLimit = cap.max_tokens
    defaultTokens = Math.min(defaultTokens, upperLimit)
  }

  return { default: defaultTokens, upperLimit }
}

/**
 * Returns the max thinking budget tokens for a given model. The max
 * thinking tokens should be strictly less than the max output tokens.
 *
 * Deprecated since newer models use adaptive thinking rather than a
 * strict thinking token budget.
 */
export function getMaxThinkingTokensForModel(model: string): number {
  return getModelMaxOutputTokens(model).upperLimit - 1
}
