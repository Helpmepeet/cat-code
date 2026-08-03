import type { SDKMessage } from '@cat-code/engine/sdk'

/**
 * Context-window fullness for the composer donut (the desktop analog of the
 * terminal's `ctx: NN%` indicator). The prototype's `ContextChip` is ALWAYS on —
 * it renders `Math.round(tokens / (contextMax || 200000) * 100)` with `tokens`
 * defaulting to 0 (`Surfaces.jsx:471-473`), so a fresh session shows a 0% donut,
 * never a hidden gauge. This selector matches that: it ALWAYS returns a usage,
 * defaulting to 0% over a 200k window before any turn.
 *
 * ## `usedTokens` — the size of ONE message's context, never a running total
 *
 * NEVER read this off the `result` frame. `result.usage` is
 * `QueryEngine.totalUsage` (`src/QueryEngine.ts:1256`), an instance field seeded
 * once in the constructor (`:228`) and accumulated on every `message_stop`
 * (`:916`) for the LIFETIME of the session — one engine per session
 * (`src/app-runtime/createQueryEngineAppSession.ts:36`), so it never resets. It
 * looks per-turn because it is correct on turn one. Reading it made the gauge
 * report 177k on a 30k session, climbing ~30k per turn no matter how cheap the
 * turn was, because every turn re-reads the whole prefix from cache. Full
 * forensics: `docs/migration/reviews/2026-08-02-context-gauge-accumulator.md`.
 *
 * The numerator is the engine's `getTokenCountFromUsage`
 * (`src/utils/tokens.ts:52-59`): all three input buckets PLUS `output_tokens`.
 * `src/utils/tokens.ts` holds three near-identical helpers and this is the only
 * one that means context size — `getTotalInputTokens` (`:136`) is a cache-hit-rate
 * denominator and `getDisplayedTokenCountFromUsage` (`:117`) deliberately drops
 * cache reads. Do not swap them.
 *
 * The SOURCE is a fold of `message_start` + `message_delta`, mirroring the
 * engine's own `currentMessageUsage` (`src/QueryEngine.ts:893-905`), because the
 * two providers put the numbers in different events:
 *
 *  - Anthropic seeds the input + cache buckets on `message_start`; the delta
 *    carries output.
 *  - The Codex adapter seeds `{0,0,0,0}` on `message_start` and fills real
 *    numbers only on the final delta (`src/utils/tokens.ts:350-355`).
 *
 * So neither event alone is sufficient, and reading only the newest delta would
 * silently drop input + cache on Anthropic. The fold uses the engine's
 * `updateUsage` rule (`src/services/api/claude.ts:3237-3259`) — newest POSITIVE
 * value wins per input bucket, newest PRESENT value wins for output. It is not a
 * sum.
 *
 * Assistant frames are the FALLBACK, not the source: S1 §4 — a live assistant
 * frame serialises message_start-era usage and the engine's later write-back
 * "mutates only its own copy" (`sdkMessageFixtures.ts:128-130`), so it is stale
 * on the wire. It is accurate on REPLAYED traffic (a preview cache is written
 * after that write-back), which is exactly when no stream events are present.
 *
 * Known, bounded gap: the engine adds a rough estimate for messages after the
 * usage anchor (`tokenCountWithEstimation`, `src/utils/tokens.ts:321-395`). The
 * renderer has no tokenizer, so it omits that term and reads a few tokens low
 * (3 on the reference session). Sub-0.01% of the window; do not fabricate it.
 *
 * ## `contextWindow`
 *
 * `modelUsage[model].contextWindow`, already computed by the engine's real
 * `getContextWindowForModel` (`src/cost-tracker.ts:107`, incl. the `[1m]` beta +
 * model-capability + env-override logic — valid for gpt/Codex too). The renderer
 * REUSES that value instead of re-deriving it (§10). The live run-controls
 * snapshot supplies the current main-loop model, so historical model entries
 * cannot leave the gauge on a stale larger window after a switch.
 *
 * Before a turn completes there IS no result frame, and after a model switch the
 * newest one only knows the model that already ran, so in both states the window
 * comes from `modelContextWindow` instead: the live run-controls snapshot's
 * `model.contextWindow`, which the sidecar resolves with the engine's own
 * `getContextWindowForModel` — the same function that produced the number on the
 * result frame. That is what makes a fresh session read 1M on Claude 5 and 372k on
 * GPT-5.6 rather than 200k for everything.
 *
 * `DEFAULT_CONTEXT_WINDOW` remains the last resort, for a pane with no live
 * snapshot at all (a preview, or the moment before attach), exactly like the
 * prototype's `status.contextMax || 200000`.
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

function isPositive(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** One message's usage, in the four fields `getTokenCountFromUsage` sums. */
type MessageUsage = {
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
}

const EMPTY_MESSAGE_USAGE: MessageUsage = {
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
}

/** The engine's context-size numerator, `getTokenCountFromUsage`
 * (`src/utils/tokens.ts:52-59`): every input bucket plus output. */
function contextTokens(usage: MessageUsage): number {
  return (
    usage.input_tokens +
    usage.cache_creation_input_tokens +
    usage.cache_read_input_tokens +
    usage.output_tokens
  )
}

/**
 * Fold one partial usage into an accumulator, mirroring the engine's
 * `updateUsage` (`src/services/api/claude.ts:3237-3259`): each input bucket takes
 * the newest POSITIVE reading, output takes the newest PRESENT one. Summing
 * instead would double-count, and taking the newest reading unconditionally
 * would let the Codex adapter's `{0,0,0,0}` message_start erase real numbers.
 */
function foldUsage(into: MessageUsage, part: unknown): MessageUsage {
  if (!isRecord(part)) return into
  const positiveOr = (value: unknown, prior: number): number => {
    const next = readNum(value)
    return next > 0 ? next : prior
  }
  return {
    input_tokens: positiveOr(part.input_tokens, into.input_tokens),
    cache_creation_input_tokens: positiveOr(
      part.cache_creation_input_tokens,
      into.cache_creation_input_tokens,
    ),
    cache_read_input_tokens: positiveOr(
      part.cache_read_input_tokens,
      into.cache_read_input_tokens,
    ),
    output_tokens:
      typeof part.output_tokens === 'number' && Number.isFinite(part.output_tokens)
        ? part.output_tokens
        : into.output_tokens,
  }
}

/** Subagent traffic carries its OWN context, not the main thread's. The
 * reference session's 19,194-token subagent turn must never move this gauge. */
function isMainThread(message: SDKMessage): boolean {
  return message.parent_tool_use_id == null
}

function streamEventOf(message: SDKMessage): Record<string, unknown> | null {
  if (message.type !== 'stream_event' || !isMainThread(message)) return null
  return isRecord(message.event) ? message.event : null
}

function newestCompactBoundary(messages: readonly SDKMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message) continue
    if (message.type === 'system' && message.subtype === 'compact_boundary') {
      return i
    }
  }
  return -1
}

/**
 * The preserved tail's index range, or null when there is nothing to skip.
 *
 * Compaction is stale on BOTH sides of its boundary, for two different reasons,
 * and each needs its own guard:
 *
 *  - BELOW it, the pre-compaction stream groups measure a context that no longer
 *    exists. `newestCompactBoundary` + 1 is the floor that stops the walk-back
 *    there.
 *  - ABOVE it, the kept messages are the ORIGINALS, spliced in after the
 *    boundary with their ORIGINAL usage, whose `input_tokens` still describes
 *    the pre-compaction window (`src/utils/tokens.ts:61-66`). A floor cannot
 *    help: these sit above it. The engine resolves the boundary's recorded
 *    head/tail uuids to an index range and skips it (`getPreservedSegmentRange`,
 *    `src/utils/tokens.ts:75-96`, applied at `:338`); this mirrors that.
 *
 * The second case is the restore and preview path specifically, where there are
 * no stream events at all, so the assistant fallback is the only source and
 * would otherwise freeze the gauge at the pre-compact percentage.
 */
function preservedTailRange(
  messages: readonly SDKMessage[],
  boundaryIndex: number,
): { start: number; end: number } | null {
  if (boundaryIndex === -1) return null
  const boundary = messages[boundaryIndex]
  if (!boundary || boundary.type !== 'system') return null
  const metadata = isRecord(boundary.compact_metadata)
    ? boundary.compact_metadata
    : null
  const segment =
    metadata && isRecord(metadata.preserved_segment)
      ? metadata.preserved_segment
      : null
  if (!segment) return null
  const head = segment.head_uuid
  const tail = segment.tail_uuid
  if (typeof head !== 'string' || typeof tail !== 'string') return null

  let start = -1
  let end = -1
  for (let i = boundaryIndex + 1; i < messages.length; i++) {
    const uuid = messages[i]?.uuid
    if (uuid === head) start = i
    if (uuid === tail) {
      end = i
      break
    }
  }
  return start === -1 || end === -1 ? null : { start, end }
}

/**
 * Context size as of the newest message that reported real numbers, from the
 * stream layer when it is present and replayed assistant frames when it is not.
 * Zero only when nothing since the newest compaction has reported yet, which the
 * caller renders as an honest 0% donut.
 *
 * The walk back through earlier `message_start` groups is load-bearing, not
 * defensive. The Codex adapter seeds `message_start` at `{0,0,0,0}` and ships
 * real numbers once, from `finishStream` at the END of the response
 * (`src/services/api/codex-fetch-adapter.ts:1708,2900`), and every per-block
 * assistant sub-record shares that one zero-seed object
 * (`src/services/api/claude.ts:2436-2453`). So on GPT the newest group reads
 * zero for the entire generation of each API call — seconds, several times per
 * turn in a tool loop.
 *
 * The assistant-frame fallback cannot rescue that: the engine's late write-back
 * is a property assignment on its OWN copy (`src/services/api/claude.ts:2490`),
 * and the app's copy is spread at `src/utils/messages.ts:820-844` then cloned
 * and serialised before `message_delta` is even parsed — so live Codex frames on
 * the wire are all-zero without exception. Reading only the newest group
 * therefore dropped the donut to 0% and snapped it back on every API call.
 *
 * The engine solves the identical seed by walking back the same way
 * (`src/utils/tokens.ts:356`); it can additionally fall through to a tokenizer
 * estimate (`:396`), which the renderer has no equivalent for. A reading that is
 * stale by one response is the correct answer here.
 */
function selectUsedTokens(messages: readonly SDKMessage[]): number {
  const boundaryIndex = newestCompactBoundary(messages)
  const floor = boundaryIndex + 1
  const preserved = preservedTailRange(messages, boundaryIndex)

  const startIndices: number[] = []
  for (let i = floor; i < messages.length; i++) {
    const message = messages[i]
    if (!message) continue
    if (streamEventOf(message)?.type === 'message_start') startIndices.push(i)
  }

  // Newest group first. Each group folds only its OWN events — folding to the
  // end of the array would let a newer group's delta leak into an older group's
  // total and report a context that never existed.
  for (let group = startIndices.length - 1; group >= 0; group--) {
    const start = startIndices[group]
    const next = startIndices[group + 1]
    const end = next === undefined ? messages.length : next
    if (start === undefined) continue
    let usage = EMPTY_MESSAGE_USAGE
    for (let i = start; i < end; i++) {
      const message = messages[i]
      if (!message) continue
      const event = streamEventOf(message)
      if (!event) continue
      if (event.type === 'message_start') {
        const started = isRecord(event.message) ? event.message : null
        usage = foldUsage(usage, started?.usage)
      } else if (event.type === 'message_delta') {
        usage = foldUsage(usage, event.usage)
      }
    }
    const total = contextTokens(usage)
    if (total > 0) return total
  }

  for (let i = messages.length - 1; i >= floor; i--) {
    if (preserved && i >= preserved.start && i <= preserved.end) {
      i = preserved.start
      continue
    }
    const message = messages[i]
    if (!message || message.type !== 'assistant' || !isMainThread(message)) {
      continue
    }
    const inner = isRecord(message.message) ? message.message : null
    const total = contextTokens(foldUsage(EMPTY_MESSAGE_USAGE, inner?.usage))
    if (total > 0) return total
  }

  return 0
}

export function selectContextUsage(
  messages: readonly SDKMessage[],
  currentModel?: string | null,
  /**
   * The window the CURRENT model runs with (`RunControlsSnapshot.model.contextWindow`).
   * Used whenever no result frame states one for that model, which is every
   * pre-turn render and every render between a model switch and the next result.
   */
  modelContextWindow?: number | null,
): ContextUsage {
  // Numerator and denominator come from DIFFERENT layers on purpose. The result
  // frame is the only carrier of the engine-resolved window, and its `usage` is
  // the session-lifetime accumulator that must never reach the numerator.
  const usedTokens = selectUsedTokens(messages)
  let contextWindow = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || message.type !== 'result') continue

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
    break // the latest result frame states the window the session last ran on
  }

  // Always show the donut (the prototype's ContextChip never hides). Where no
  // result frame stated a window for the current model, the engine-resolved one
  // for that model answers instead, and only a pane with neither falls back to
  // the constant.
  if (contextWindow <= 0 && isPositive(modelContextWindow)) {
    contextWindow = modelContextWindow
  }
  if (contextWindow <= 0) contextWindow = DEFAULT_CONTEXT_WINDOW
  const percentUsed = Math.min(
    100,
    Math.max(0, Math.round((usedTokens / contextWindow) * 100)),
  )
  return { usedTokens, contextWindow, percentUsed }
}
