import type { SDKMessage } from '@cat-code/engine/sdk'

/**
 * Context-window fullness for the composer donut (the desktop analog of the
 * terminal's `ctx: NN%` indicator). The prototype's `ContextChip` is ALWAYS on —
 * it renders `Math.round(tokens / (contextMax || 200000) * 100)` with `tokens`
 * defaulting to 0 (`Surfaces.jsx:471-473`), so a fresh session shows a 0% donut,
 * never a hidden gauge. This selector matches that: it ALWAYS returns a usage,
 * defaulting to 0% over a 200k window before any turn, then the real numbers once
 * a `result` frame carries them.
 *
 * Two facts come off the latest `result` frame that has usage:
 *
 *  - `usedTokens` = the per-turn `usage` (`input_tokens` + both cache buckets),
 *    matching the engine's own `getTotalInputTokens` (`src/utils/tokens.ts:136`).
 *    This is the current context size. It is NOT `modelUsage.*Tokens`, which the
 *    cost tracker ACCUMULATES across the whole session (`src/cost-tracker.ts`);
 *    using those would report far over 100% — the S1 §4 "usage read from the
 *    result layer, never the assistant frames" trap the projector documents.
 *  - `contextWindow` = `modelUsage[model].contextWindow`, already computed by the
 *    engine's real `getContextWindowForModel` (`src/cost-tracker.ts:107`, incl. the
 *    `[1m]` beta + model-capability + env-override logic — valid for gpt/Codex too).
 *    The renderer REUSES that value instead of re-deriving it (§10). The live
 *    run-controls snapshot supplies the current main-loop model, so historical
 *    model entries cannot leave the gauge on a stale larger window after a switch.
 *
 * Before a turn completes (or a frame that omits `contextWindow`), the window falls
 * back to `DEFAULT_CONTEXT_WINDOW`, exactly like the prototype's
 * `status.contextMax || 200000`: the displayed value is 0% (nothing used yet) and
 * self-corrects to the real window on the first result frame. (Follow-up option:
 * plumb the resolved model's exact window from the engine so the fresh-session
 * TOOLTIP total is exact for non-200k models too — the % is already correct.)
 */
export type ContextUsage = {
  usedTokens: number
  contextWindow: number
  /** 0–100, clamped. Context-window fullness = usedTokens ÷ contextWindow. */
  percentUsed: number
}

/** Prototype default when no turn has reported a real window yet (`Surfaces.jsx:472`). */
const DEFAULT_CONTEXT_WINDOW = 200_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readNum(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function selectContextUsage(
  messages: readonly SDKMessage[],
  currentModel?: string | null,
): ContextUsage {
  let usedTokens = 0
  let contextWindow = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || message.type !== 'result') continue

    // `usage` is typed `unknown` at the SDK seam — runtime-narrow it (projector
    // discipline: narrow unknown shapes, zero `as` casts).
    const usage = isRecord(message.usage) ? message.usage : null
    if (!usage) continue
    usedTokens =
      readNum(usage.input_tokens) +
      readNum(usage.cache_read_input_tokens) +
      readNum(usage.cache_creation_input_tokens)

    const modelUsage = isRecord(message.modelUsage) ? message.modelUsage : null
    if (modelUsage) {
      const currentEntry = currentModel ? modelUsage[currentModel] : undefined
      if (isRecord(currentEntry)) {
        contextWindow = readNum(currentEntry.contextWindow)
      } else if (!currentModel) {
        const entries = Object.values(modelUsage).filter(isRecord)
        if (entries.length === 1) {
          contextWindow = readNum(entries[0]?.contextWindow)
        }
      }
    }
    break // the latest result frame with usage wins
  }

  // Always show the donut (the prototype's ContextChip never hides): default the
  // window until a turn reports the real one — the displayed % is 0 on a fresh
  // session and self-corrects on the first result frame.
  if (contextWindow <= 0) contextWindow = DEFAULT_CONTEXT_WINDOW
  const percentUsed = Math.min(
    100,
    Math.max(0, Math.round((usedTokens / contextWindow) * 100)),
  )
  return { usedTokens, contextWindow, percentUsed }
}
