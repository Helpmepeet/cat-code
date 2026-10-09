const MINUTE_MS = 60_000
export const CODEX_CACHE_IDLE_ESTIMATE_MS = 24 * 60 * MINUTE_MS
export const ANTHROPIC_CACHE_5M_MS = 5 * MINUTE_MS
export const ANTHROPIC_CACHE_1H_MS = 60 * MINUTE_MS
export const PROMPT_CACHE_ROUTE_FACTS_VERSION = 3

export function isCacheExpiryTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function tokens(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0
}

/**
 * An idle-time estimate, not a provider-issued expiry deadline. Codex uses the
 * conservative 24h retention-policy lead, not the public API's 30m minimum.
 * Historical Claude cache reads do not report their TTL, so use 1h unless a
 * write breakdown or the live engine's cache control supplies it.
 */
export function estimatePromptCacheExpiry(
  model: string,
  responseAtMs: number,
  usage: unknown,
  anthropicTtlMs?: number,
): number | null {
  if (!isCacheExpiryTimestamp(responseAtMs)) return null
  const counts = record(usage)
  if (!counts) return null
  const read = tokens(counts.cache_read_input_tokens)
  const written = tokens(counts.cache_creation_input_tokens)
  let idleMs: number
  if (model.toLowerCase().startsWith('gpt-')) {
    if (tokens(counts.input_tokens) + read + written < 1_024) return null
    idleMs = CODEX_CACHE_IDLE_ESTIMATE_MS
  } else if (model.toLowerCase().includes('claude-')) {
    if (read + written === 0) return null
    const creation = record(counts.cache_creation)
    idleMs = tokens(creation?.ephemeral_1h_input_tokens) > 0
      ? ANTHROPIC_CACHE_1H_MS
      : anthropicTtlMs === ANTHROPIC_CACHE_5M_MS ||
        anthropicTtlMs === ANTHROPIC_CACHE_1H_MS
        ? anthropicTtlMs
        : tokens(creation?.ephemeral_5m_input_tokens) > 0
          ? ANTHROPIC_CACHE_5M_MS
          : ANTHROPIC_CACHE_1H_MS
  } else {
    return null
  }
  const deadline = responseAtMs + idleMs
  return isCacheExpiryTimestamp(deadline) ? deadline : null
}
