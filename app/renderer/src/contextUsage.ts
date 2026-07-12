import type { SDKMessage } from '@cat-code/engine/sdk'

/**
 * Context-window fullness for the composer gauge (the desktop analog of the
 * terminal's `ctx: NN%` indicator). Derived purely from the LATEST `result`
 * frame — real data already on the wire under the locked raw-`AppSessionEvent`
 * fidelity, so this adds NO new seam, protocol field, or sidecar computation.
 *
 * Two facts come off that one frame:
 *
 *  - `usedTokens` = the per-turn `usage` (`input_tokens` + both cache buckets),
 *    matching the engine's own `getTotalInputTokens` (`src/utils/tokens.ts:136`).
 *    This is the current context size. It is NOT `modelUsage.*Tokens`, which the
 *    cost tracker ACCUMULATES across the whole session (`src/cost-tracker.ts`);
 *    using those would report far over 100% — the S1 §4 "usage read from the
 *    result layer, never the assistant frames" trap the projector documents.
 *  - `contextWindow` = `modelUsage[model].contextWindow`, already computed by the
 *    engine's real `getContextWindowForModel` (`src/cost-tracker.ts:107`,
 *    incl. the `[1m]` beta + model-capability + env-override logic). The renderer
 *    REUSES that value instead of re-deriving 200k/1M itself (§10 — don't
 *    duplicate engine machinery). The main conversation model owns the largest
 *    window, so the max across `modelUsage` entries is the conversation window (a
 *    small-fast side model carries a smaller one).
 *
 * Returns null until a `result` frame with both facts exists (no turn completed
 * yet, or a fixture without `contextWindow`) — the gauge is then simply absent,
 * never a fabricated 0%.
 */
export type ContextUsage = {
  usedTokens: number
  contextWindow: number
  /** 0–100, clamped. Context-window fullness = usedTokens ÷ contextWindow. */
  percentUsed: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readNum(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function selectContextUsage(
  messages: readonly SDKMessage[],
): ContextUsage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || message.type !== 'result') continue

    // `usage` is typed `unknown` at the SDK seam — runtime-narrow it (projector
    // discipline: narrow unknown shapes, zero `as` casts).
    const usage = isRecord(message.usage) ? message.usage : null
    if (!usage) continue
    const usedTokens =
      readNum(usage.input_tokens) +
      readNum(usage.cache_read_input_tokens) +
      readNum(usage.cache_creation_input_tokens)

    let contextWindow = 0
    const modelUsage = isRecord(message.modelUsage) ? message.modelUsage : null
    if (modelUsage) {
      for (const entry of Object.values(modelUsage)) {
        if (isRecord(entry)) {
          contextWindow = Math.max(contextWindow, readNum(entry.contextWindow))
        }
      }
    }

    if (usedTokens <= 0 || contextWindow <= 0) return null
    const percentUsed = Math.min(
      100,
      Math.max(0, Math.round((usedTokens / contextWindow) * 100)),
    )
    return { usedTokens, contextWindow, percentUsed }
  }
  return null
}
