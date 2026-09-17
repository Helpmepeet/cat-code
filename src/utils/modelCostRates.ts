import {
  CLAUDE_3_5_HAIKU_CONFIG,
  CLAUDE_3_5_V2_SONNET_CONFIG,
  CLAUDE_3_7_SONNET_CONFIG,
  CLAUDE_FABLE_5_CONFIG,
  CLAUDE_HAIKU_4_5_CONFIG,
  CLAUDE_OPUS_4_1_CONFIG,
  CLAUDE_OPUS_4_5_CONFIG,
  CLAUDE_OPUS_4_6_CONFIG,
  CLAUDE_OPUS_4_CONFIG,
  CLAUDE_OPUS_5_CONFIG,
  CLAUDE_SONNET_4_5_CONFIG,
  CLAUDE_SONNET_4_6_CONFIG,
  CLAUDE_SONNET_4_CONFIG,
  CLAUDE_SONNET_5_CONFIG,
  type ModelConfig,
} from './model/configs.js'

// @see https://platform.claude.com/docs/en/about-claude/pricing
export type ModelCosts = {
  inputTokens: number
  outputTokens: number
  promptCacheWriteTokens: number
  promptCacheReadTokens: number
  webSearchRequests: number
}

export const COST_TIER_3_15 = { inputTokens: 3, outputTokens: 15, promptCacheWriteTokens: 3.75, promptCacheReadTokens: 0.3, webSearchRequests: 0.01 } as const satisfies ModelCosts
export const COST_TIER_15_75 = { inputTokens: 15, outputTokens: 75, promptCacheWriteTokens: 18.75, promptCacheReadTokens: 1.5, webSearchRequests: 0.01 } as const satisfies ModelCosts
export const COST_TIER_5_25 = { inputTokens: 5, outputTokens: 25, promptCacheWriteTokens: 6.25, promptCacheReadTokens: 0.5, webSearchRequests: 0.01 } as const satisfies ModelCosts
export const COST_TIER_30_150 = { inputTokens: 30, outputTokens: 150, promptCacheWriteTokens: 37.5, promptCacheReadTokens: 3, webSearchRequests: 0.01 } as const satisfies ModelCosts
export const COST_HAIKU_35 = { inputTokens: 0.8, outputTokens: 4, promptCacheWriteTokens: 1, promptCacheReadTokens: 0.08, webSearchRequests: 0.01 } as const satisfies ModelCosts
export const COST_HAIKU_45 = { inputTokens: 1, outputTokens: 5, promptCacheWriteTokens: 1.25, promptCacheReadTokens: 0.1, webSearchRequests: 0.01 } as const satisfies ModelCosts
export const COST_FABLE_10_50 = { inputTokens: 10, outputTokens: 50, promptCacheWriteTokens: 12.5, promptCacheReadTokens: 1, webSearchRequests: 0.01 } as const satisfies ModelCosts

// @[MODEL LAUNCH]: Update this table for new priced models. Any rate or matching
// change used by retained history also requires a USAGE_PRICING_VERSION bump.
const STANDARD_CONFIG_COSTS = [
  [CLAUDE_3_5_HAIKU_CONFIG, COST_HAIKU_35],
  [CLAUDE_HAIKU_4_5_CONFIG, COST_HAIKU_45],
  [CLAUDE_3_5_V2_SONNET_CONFIG, COST_TIER_3_15],
  [CLAUDE_3_7_SONNET_CONFIG, COST_TIER_3_15],
  [CLAUDE_SONNET_4_CONFIG, COST_TIER_3_15],
  [CLAUDE_SONNET_4_5_CONFIG, COST_TIER_3_15],
  [CLAUDE_SONNET_4_6_CONFIG, COST_TIER_3_15],
  [CLAUDE_OPUS_4_CONFIG, COST_TIER_15_75],
  [CLAUDE_OPUS_4_1_CONFIG, COST_TIER_15_75],
  [CLAUDE_OPUS_4_5_CONFIG, COST_TIER_5_25],
  [CLAUDE_OPUS_4_6_CONFIG, COST_TIER_5_25],
  [CLAUDE_SONNET_5_CONFIG, COST_TIER_3_15],
  [CLAUDE_OPUS_5_CONFIG, COST_TIER_5_25],
  [CLAUDE_FABLE_5_CONFIG, COST_FABLE_10_50],
] as const satisfies readonly (readonly [ModelConfig, ModelCosts])[]

/** Canonical pricing table retained for existing live-query cost callers. */
export const MODEL_COSTS: Record<string, ModelCosts> = Object.fromEntries(
  STANDARD_CONFIG_COSTS.map(([config, costs]) => [standardCanonicalId(config.firstParty), costs]),
)

const CONFIGURED_STANDARD_MODEL_COSTS = new Map<string, ModelCosts>(
  STANDARD_CONFIG_COSTS.flatMap(([config, costs]) =>
    [...new Set(Object.values(config))].map(id => [id.toLowerCase(), costs] as const),
  ),
)

function standardCanonicalId(model: string): string {
  const normalized = model.toLowerCase()
  for (const [config] of STANDARD_CONFIG_COSTS) {
    const canonical = config.foundry.toLowerCase()
    if (Object.values(config).some(id => id.toLowerCase() === normalized)) return canonical
  }
  return normalized
}

/**
 * Exact configured-ID lookup for retained history. Unknown aliases and future
 * model versions remain unpriced instead of inheriting a substring match.
 */
export function getConfiguredStandardModelCosts(model: string): ModelCosts | undefined {
  const configuredId = model.trim().toLowerCase().replace(/\[1m\]$/i, '')
  return CONFIGURED_STANDARD_MODEL_COSTS.get(configuredId)
}
