export const DEFAULT_TEXT_READ_MAX_OUTPUT_TOKENS = 25_000
export const MAX_TEXT_READ_OUTPUT_TOKENS = 100_000

const CONTEXT_SHARE_DIVISOR = 8
const ESTIMATED_BYTES_PER_TOKEN = 1.4

export type TextReadBudget = {
  hardTokenLimit: number
  prefixTargetTokens: number
}

/** Keep an absent configured limit distinct from the legacy 25k default. */
export function resolveReadMaxTokensOverride(
  envOverride: string | undefined,
  featureOverride: unknown,
): number | undefined {
  const parsed = envOverride ? parseInt(envOverride, 10) : NaN
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  return typeof featureOverride === 'number' &&
    Number.isFinite(featureOverride) &&
    featureOverride > 0
    ? featureOverride
    : undefined
}

/**
 * Use the effective context window, including account/operator clamps and
 * output reservation, rather than the model's advertised capacity. This is a
 * per-read ceiling, not a replacement for the query loop's context management.
 */
export function getTextReadBudget(
  effectiveContextTokens?: number,
  maxTokensOverride?: number,
): TextReadBudget {
  const contextLimit =
    effectiveContextTokens !== undefined &&
    Number.isFinite(effectiveContextTokens)
      ? Math.max(0, Math.floor(effectiveContextTokens / CONTEXT_SHARE_DIVISOR))
      : DEFAULT_TEXT_READ_MAX_OUTPUT_TOKENS
  const overrideLimit =
    maxTokensOverride !== undefined &&
    Number.isFinite(maxTokensOverride) &&
    maxTokensOverride > 0
      ? Math.floor(maxTokensOverride)
      : MAX_TEXT_READ_OUTPUT_TOKENS
  const hardTokenLimit = Math.min(
    contextLimit,
    overrideLimit,
    MAX_TEXT_READ_OUTPUT_TOKENS,
  )

  // suggestedRetryLimit already leaves headroom for prefix rendering. There
  // is no second, much smaller output budget after crossing the ceiling.
  return { hardTokenLimit, prefixTargetTokens: hardTokenLimit }
}

/**
 * Preserve the conservative byte upper bound when exact counting is
 * unavailable. The estimate only guides prefix sizing; it never admits a
 * result that could exceed the hard token ceiling.
 */
export async function measureTextReadTokens(
  content: string,
  targetTokens: number,
  hardTokens: number,
  countTokens: (content: string) => Promise<number | null>,
): Promise<{ targetCount: number; hardCount: number }> {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes === 0) return { targetCount: 0, hardCount: 0 }

  const estimatedCount = Math.ceil(bytes / ESTIMATED_BYTES_PER_TOKEN)
  if (estimatedCount <= targetTokens && bytes <= hardTokens) {
    return { targetCount: estimatedCount, hardCount: bytes }
  }
  const exactCount = await countTokens(content)
  if (exactCount !== null) {
    return { targetCount: exactCount, hardCount: exactCount }
  }
  return { targetCount: estimatedCount, hardCount: bytes }
}
