import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/services/analytics/index.js'
import { logEvent } from 'src/services/analytics/index.js'
import { EMPTY_USAGE } from '../services/api/emptyUsage.js'
import { setHasUnknownModelCost } from '../bootstrap/state.js'
import { logForDebugging } from './debug.js'
import { isFastModeEnabled } from './fastMode.js'
import { CLAUDE_OPUS_4_6_CONFIG } from './model/configs.js'
import {
  firstPartyNameToCanonical,
  getCanonicalName,
  getDefaultMainLoopModelSetting,
  type ModelShortName,
} from './model/model.js'
import {
  COST_TIER_30_150,
  COST_TIER_5_25,
  MODEL_COSTS,
  type ModelCosts,
} from './modelCostRates.js'
export {
  COST_FABLE_10_50,
  COST_HAIKU_35,
  COST_HAIKU_45,
  COST_TIER_15_75,
  COST_TIER_30_150,
  COST_TIER_3_15,
  COST_TIER_5_25,
  MODEL_COSTS,
  getConfiguredStandardModelCosts,
  type ModelCosts,
} from './modelCostRates.js'

const DEFAULT_UNKNOWN_MODEL_COST = COST_TIER_5_25

/**
 * Get the cost tier for Opus 4.6 based on fast mode.
 */
export function getOpus46CostTier(fastMode: boolean): ModelCosts {
  if (isFastModeEnabled() && fastMode) {
    return COST_TIER_30_150
  }
  return COST_TIER_5_25
}


/**
 * Calculates the USD cost based on token usage and model cost configuration
 */
function tokensToUSDCost(modelCosts: ModelCosts, usage: Usage): number {
  return (
    (usage.input_tokens / 1_000_000) * modelCosts.inputTokens +
    (usage.output_tokens / 1_000_000) * modelCosts.outputTokens +
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheReadTokens +
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheWriteTokens +
    (usage.server_tool_use?.web_search_requests ?? 0) *
      modelCosts.webSearchRequests
  )
}

function normalizeUsageForCostCalculation(
  resolvedModel: string,
  usage: Usage | undefined,
): Usage {
  if (
    usage &&
    typeof usage.input_tokens === 'number' &&
    typeof usage.output_tokens === 'number'
  ) {
    return usage
  }

  logForDebugging(
    `[cost] missing_usage_for_calculation model=${resolvedModel} ` +
      `has_usage=${Boolean(usage)} ` +
      `input_type=${typeof usage?.input_tokens} ` +
      `output_type=${typeof usage?.output_tokens}`,
    { level: 'warn' },
  )
  return EMPTY_USAGE as Usage
}

export function getModelCosts(model: string, usage: Usage): ModelCosts {
  const shortName = getCanonicalName(model)

  // Check if this is an Opus 4.6 model with fast mode active.
  if (
    shortName === firstPartyNameToCanonical(CLAUDE_OPUS_4_6_CONFIG.firstParty)
  ) {
    const isFastMode = usage.speed === 'fast'
    return getOpus46CostTier(isFastMode)
  }

  const costs = MODEL_COSTS[shortName]
  if (!costs) {
    trackUnknownModelCost(model, shortName)
    return (
      MODEL_COSTS[getCanonicalName(getDefaultMainLoopModelSetting())] ??
      DEFAULT_UNKNOWN_MODEL_COST
    )
  }
  return costs
}

function trackUnknownModelCost(model: string, shortName: ModelShortName): void {
  logEvent('tengu_unknown_model_cost', {
    model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    shortName:
      shortName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  setHasUnknownModelCost()
}

// Calculate the cost of a query in US dollars.
// If the model's costs are not found, use the default model's costs.
export function calculateUSDCost(
  resolvedModel: string,
  usage: Usage | undefined,
): number {
  const normalizedUsage = normalizeUsageForCostCalculation(
    resolvedModel,
    usage,
  )
  const modelCosts = getModelCosts(resolvedModel, normalizedUsage)
  return tokensToUSDCost(modelCosts, normalizedUsage)
}

/**
 * Calculate cost from raw token counts without requiring a full BetaUsage object.
 * Useful for side queries (e.g. classifier) that track token counts independently.
 */
export function calculateCostFromTokens(
  model: string,
  tokens: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
  },
): number {
  const usage: Usage = {
    input_tokens: tokens.inputTokens,
    output_tokens: tokens.outputTokens,
    cache_read_input_tokens: tokens.cacheReadInputTokens,
    cache_creation_input_tokens: tokens.cacheCreationInputTokens,
  } as Usage
  return calculateUSDCost(model, usage)
}

function formatPrice(price: number): string {
  // Format price: integers without decimals, others with 2 decimal places
  // e.g., 3 -> "$3", 0.8 -> "$0.80", 22.5 -> "$22.50"
  if (Number.isInteger(price)) {
    return `$${price}`
  }
  return `$${price.toFixed(2)}`
}

/**
 * Format model costs as a pricing string for display
 * e.g., "$3/$15 per Mtok"
 */
export function formatModelPricing(costs: ModelCosts): string {
  return `${formatPrice(costs.inputTokens)}/${formatPrice(costs.outputTokens)} per Mtok`
}

/**
 * Get formatted pricing string for a model
 * Accepts either a short name or full model name
 * Returns undefined if model is not found
 */
export function getModelPricingString(model: string): string | undefined {
  const shortName = getCanonicalName(model)
  const costs = MODEL_COSTS[shortName]
  if (!costs) return undefined
  return formatModelPricing(costs)
}
