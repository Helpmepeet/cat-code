import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { roughTokenCountEstimationForMessages } from '../services/tokenEstimation.js'
import type { AssistantMessage, Message } from '../types/message.js'
import { findLastCompactBoundaryIndex, isCompactBoundaryMessage, SYNTHETIC_MODEL } from './messages.js'
import { getProviderForModel } from './model/providers.js'
import { jsonStringify } from './slowOperations.js'

type ContextUsage = Pick<
  Usage,
  'input_tokens' | 'output_tokens' | 'cache_creation_input_tokens' | 'cache_read_input_tokens'
>

/**
 * Usage of a real API response, or undefined for synthetic/placeholder records.
 *
 * The SYNTHETIC_MODEL stamp is the only test applied, and it is both sufficient
 * and precise: every locally-constructed synthetic assistant record is built by
 * baseCreateAssistantMessage (messages.ts:379-436), which hardcodes
 * model: SYNTHETIC_MODEL, and the only two exported constructors
 * (createAssistantMessage, createAssistantAPIErrorMessage) both route through
 * it. A second test — first content block's text present in SYNTHETIC_MESSAGES —
 * used to sit alongside it, but it false-positives on a genuine model response
 * whose first text block happens to be exactly one of those strings (e.g. a
 * model that replies "No response requested."), silently discarding that turn's
 * real usage and dropping the context measurement back to an older anchor.
 */
export function getTokenUsage(message: Message): Usage | undefined {
  if (
    message?.type === 'assistant' &&
    'usage' in message.message &&
    message.message.model !== SYNTHETIC_MODEL
  ) {
    return message.message.usage
  }
  return undefined
}

/**
 * Get the API response id for an assistant message with real (non-synthetic) usage.
 * Used to identify split assistant records that came from the same API response —
 * when parallel tool calls are streamed, each content block becomes a separate
 * AssistantMessage record, but they all share the same message.id.
 */
function getAssistantMessageId(message: Message): string | undefined {
  if (
    message?.type === 'assistant' &&
    'id' in message.message &&
    message.message.model !== SYNTHETIC_MODEL
  ) {
    return message.message.id
  }
  return undefined
}

/**
 * Calculate total context window tokens from an API response's usage data.
 * Includes input_tokens + cache tokens + output_tokens.
 *
 * This represents the full context size at the time of that API call.
 * Use tokenCountWithEstimation() when you need context size from messages.
 */
export function getTokenCountFromUsage(usage: Usage): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    usage.output_tokens
  )
}

/**
 * FLOOR for the non-message content of every request that a pure rough estimate
 * cannot see: the system prompt, the tool schemas, and userContext. Server usage
 * already includes all of it, so this is added ONLY on the rough-estimate
 * fallback paths, never on top of a usage anchor.
 *
 * compact.ts:667-670 measures the gap at "~20-40K". The low end is chosen
 * deliberately: minimal-prompt contexts really do sit near the bottom of that
 * range (swarm teammates run with empty system prompts,
 * src/utils/swarm/inProcessRunner.ts:1370), and overstating their context would
 * push them into premature compaction. Undershooting a fat prompt only delays
 * autocompact slightly; overshooting a thin one compacts work away for nothing.
 *
 * A flat 20K is a floor, not the truth: tool schemas are unbounded, so a session
 * with heavy MCP tooling exceeds it by construction. The two DECISION call sites
 * (shouldAutoCompact and the query.ts blocking preempt) can see the real system
 * prompt, userContext and tool schemas, so they measure them and pass the result
 * as `nonMessageOverheadTokens`; the larger of the two wins. Display and
 * telemetry callers have no request context and keep this floor.
 */
export const NON_MESSAGE_REQUEST_OVERHEAD_TOKENS = 20_000

/**
 * Bounds for a backward usage walk over a display-shaped message array.
 *
 * `boundaryIdx` is the index of the LAST compact boundary, or 0 when there is
 * none — the same slice point getMessagesAfterCompactBoundary uses (it keeps
 * the boundary itself, which normalizeMessagesForAPI then drops). It is a hard
 * floor: query.ts:394 slices the array there before building a request, so
 * nothing before it is part of the next request. Display and
 * telemetry callers (StatusLine, REPL, Notifications, sessionMemory) pass the
 * UNSLICED array, and fullscreen mode (default-on) keeps pre-compact scrollback
 * in it, so a walk that ignores the boundary anchors on stale pre-compact usage
 * and reports a freshly-compacted session as still-full.
 *
 * `preserved` is a second, narrower skip. After a partial/session-memory
 * compaction the kept tail (messagesToKeep) is spliced in AFTER the boundary,
 * but those assistant messages keep their ORIGINAL usage — whose input_tokens
 * describes the pre-compaction window. The boundary records the kept range as
 * head/tail UUIDs (compact.ts annotateBoundaryWithPreservedSegment); this
 * resolves it to an index range [start, end] so usage walks can skip it. It is
 * null when there is no boundary or no preserved segment (nothing to skip).
 *
 * Both come from one scan for the boundary, so callers never search twice.
 */
function getUsageWalkBounds(messages: readonly Message[]): {
  boundaryIdx: number
  preserved: { start: number; end: number } | null
} {
  const found = findLastCompactBoundaryIndex(messages as Message[])
  const boundaryIdx = found === -1 ? 0 : found
  if (found === -1) return { boundaryIdx, preserved: null }
  const boundary = messages[found]
  const seg =
    boundary && isCompactBoundaryMessage(boundary)
      ? boundary.compactMetadata?.preservedSegment
      : undefined
  if (!seg) return { boundaryIdx, preserved: null }
  // head/tail sit after the boundary; scan forward from it to resolve indices.
  let start = -1
  let end = -1
  for (let i = found + 1; i < messages.length; i++) {
    const uuid = messages[i]?.uuid
    if (uuid === seg.headUuid) start = i
    if (uuid === seg.tailUuid) {
      end = i
      break
    }
  }
  if (start === -1 || end === -1) return { boundaryIdx, preserved: null }
  return { boundaryIdx, preserved: { start, end } }
}

/**
 * Rough estimate for a request whose context could not be anchored on server
 * usage. Adds the non-message overhead the estimator cannot see, except for a
 * genuinely empty array — an empty session must still report 0.
 *
 * `measured` is a caller-supplied measurement of that overhead (see
 * NON_MESSAGE_REQUEST_OVERHEAD_TOKENS). It only ever raises the number: a
 * measurement below the floor means the measurement missed something the floor
 * was chosen to cover, not that the request is cheaper than the floor.
 */
function roughEstimateWithOverhead(
  slice: readonly Message[],
  measured: number | undefined,
): number {
  if (slice.length === 0) return 0
  return (
    roughTokenCountEstimationForMessages(slice) +
    Math.max(NON_MESSAGE_REQUEST_OVERHEAD_TOKENS, measured ?? 0)
  )
}

/**
 * Fresh input tokens from an Anthropic-format usage object.
 *
 * Excludes cache reads so UI surfaces can distinguish newly-processed input
 * from replayed cached prefix.
 */
export function getFreshInputTokens(
  usage: Pick<Usage, 'input_tokens' | 'cache_creation_input_tokens'>,
): number {
  return usage.input_tokens + (usage.cache_creation_input_tokens ?? 0)
}

/**
 * Display-oriented token count for a single response.
 *
 * Excludes cache-read tokens from the headline number and leaves them to a
 * separate cache breakdown so the UI does not overstate fresh growth.
 */
export function getDisplayedTokenCountFromUsage(
  usage:
    | Pick<Usage, 'input_tokens' | 'output_tokens' | 'cache_creation_input_tokens'>
    | undefined,
): number {
  if (!usage) {
    return 0
  }
  return getFreshInputTokens(usage) + usage.output_tokens
}

/**
 * Total input tokens from an Anthropic-format usage object
 * (sum of the three exclusive buckets). Use this as the denominator
 * for cache hit rate. Works for both the native Anthropic path and
 * the Codex adapter path (which converts to Anthropic-exclusive
 * semantics before emitting). Do NOT apply to raw OpenAI usage.
 */
export function getTotalInputTokens(usage: Usage): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  )
}

export function getCacheHitRate(usage: Usage): number {
  const total = getTotalInputTokens(usage)
  return total > 0 ? (usage.cache_read_input_tokens ?? 0) / total : 0
}

/**
 * A usage object that carries no context at all ({0,0,0,0}) is a seed, not a
 * measurement: the Codex adapter writes it on message_start and only fills real
 * numbers on the final message_delta/stop, and tool-use sub-records split from
 * one API response keep the seed. Anchoring on one reports the context as 0.
 * Every backward usage walk in this module treats it as "no usage yet" and
 * keeps walking to the last record with real numbers.
 */
function hasRealUsage(usage: Usage | undefined): usage is Usage {
  return usage !== undefined && getTokenCountFromUsage(usage) > 0
}

export function tokenCountFromLastAPIResponse(messages: Message[]): number {
  let i = messages.length - 1
  while (i >= 0) {
    const message = messages[i]
    const usage = message ? getTokenUsage(message) : undefined
    if (hasRealUsage(usage)) {
      return getTokenCountFromUsage(usage)
    }
    i--
  }
  return 0
}

/**
 * Final context window size from the last API response's usage.iterations[-1].
 * Used for task_budget.remaining computation across compaction boundaries —
 * the server's budget countdown is context-based, so remaining decrements by
 * the pre-compact final window, not billing spend. See monorepo
 * api/api/sampling/prompt/renderer.py:292 for the server-side computation.
 *
 * Falls back to top-level input_tokens + output_tokens when iterations is
 * absent (no server-side tool loops, so top-level usage IS the final window).
 * Both paths exclude cache tokens to match #304930's formula.
 */
export function finalContextTokensFromLastResponse(
  messages: Message[],
): number {
  let i = messages.length - 1
  while (i >= 0) {
    const message = messages[i]
    const usage = message ? getTokenUsage(message) : undefined
    if (hasRealUsage(usage)) {
      // Stainless types don't include iterations yet — cast like advisor.ts:43
      const iterations = (
        usage as {
          iterations?: Array<{
            input_tokens: number
            output_tokens: number
          }> | null
        }
      ).iterations
      if (iterations && iterations.length > 0) {
        const last = iterations.at(-1)!
        return last.input_tokens + last.output_tokens
      }
      // No iterations → no server tool loop → top-level usage IS the final
      // window. Match the iterations path's formula (input + output, no cache)
      // rather than getTokenCountFromUsage — #304930 defines final window as
      // non-cache input + output. Whether the server's budget countdown
      // (renderer.py:292 calculate_context_tokens) counts cache the same way
      // is an open question; aligning with the iterations path keeps the two
      // branches consistent until that's resolved.
      return usage.input_tokens + usage.output_tokens
    }
    i--
  }
  return 0
}

/**
 * Get only the output_tokens from the last API response.
 * This excludes input context (system prompt, tools, prior messages).
 *
 * WARNING: Do NOT use this for threshold comparisons (autocompact, session memory).
 * Use tokenCountWithEstimation() instead, which measures full context size.
 * This function is only useful for measuring how many tokens Claude generated
 * in a single response, not how full the context window is.
 */
export function messageTokenCountFromLastAPIResponse(
  messages: Message[],
): number {
  let i = messages.length - 1
  while (i >= 0) {
    const message = messages[i]
    const usage = message ? getTokenUsage(message) : undefined
    if (hasRealUsage(usage)) {
      return usage.output_tokens
    }
    i--
  }
  return 0
}

export function getCurrentUsage(messages: Message[]): ContextUsage | null {
  const { boundaryIdx, preserved } = getUsageWalkBounds(messages)
  // Stop at the last compact boundary: messages before it are scrollback, not
  // part of the next request, and their usage describes the pre-compact window.
  for (let i = messages.length - 1; i >= boundaryIdx; i--) {
    // Skip kept-tail messages whose usage describes the pre-compaction window.
    if (preserved && i >= preserved.start && i <= preserved.end) {
      i = preserved.start
      continue
    }
    const message = messages[i]
    const usage = message ? getTokenUsage(message) : undefined
    if (hasRealUsage(usage)) {
      return {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      }
    }
  }
  return null
}

export function doesMostRecentAssistantMessageExceed200k(
  messages: Message[],
): boolean {
  const THRESHOLD = 200_000

  const lastAsst = messages.findLast(m => m.type === 'assistant')
  if (!lastAsst) return false
  const usage = getTokenUsage(lastAsst)
  return usage ? getTokenCountFromUsage(usage) > THRESHOLD : false
}

/**
 * Calculate the character content length of an assistant message.
 * Used for spinner token estimation (characters / 4 ≈ tokens).
 * This is used when subagent streaming events are filtered out and we
 * need to count content from completed messages instead.
 *
 * Counts the same content that handleMessageFromStream would count via deltas:
 * - text (text_delta)
 * - thinking (thinking_delta)
 * - redacted_thinking data
 * - tool_use input (input_json_delta)
 * Note: signature_delta is excluded from streaming counts (not model output).
 */
export function getAssistantMessageContentLength(
  message: AssistantMessage,
): number {
  let contentLength = 0
  for (const block of message.message.content) {
    if (block.type === 'text') {
      contentLength += block.text.length
    } else if (block.type === 'thinking') {
      contentLength += block.thinking.length
    } else if (block.type === 'redacted_thinking') {
      contentLength += block.data.length
    } else if (block.type === 'tool_use') {
      contentLength += jsonStringify(block.input).length
    }
  }
  return contentLength
}

/**
 * Get the current context window size in tokens.
 *
 * This is the CANONICAL function for measuring context size when checking
 * thresholds (autocompact, session memory init, etc.). Uses the last API
 * response's token count (input + output + cache) plus estimates for any
 * messages added since.
 *
 * Always use this instead of:
 * - Cumulative token counting (which double-counts as context grows)
 * - messageTokenCountFromLastAPIResponse (which only counts output_tokens)
 * - tokenCountFromLastAPIResponse (which doesn't estimate new messages)
 *
 * Implementation note on parallel tool calls: when the model makes multiple
 * tool calls in one response, the streaming code emits a SEPARATE assistant
 * record per content block (all sharing the same message.id and usage), and
 * the query loop interleaves each tool_result immediately after its tool_use.
 * So the messages array looks like:
 *   [..., assistant(id=A), user(result), assistant(id=A), user(result), ...]
 * If we stop at the LAST assistant record, we only estimate the one tool_result
 * after it and miss all the earlier interleaved tool_results — which will ALL
 * be in the next API request. To avoid undercounting, after finding a usage-
 * bearing record we walk back to the FIRST sibling with the same message.id
 * so every interleaved tool_result is included in the rough estimate. The
 * sibling records' own content is then excluded from that estimate when the
 * anchor is the terminal sibling, because the anchor's output_tokens already
 * covers it — see the stop_reason note at the return.
 */
export function tokenCountWithEstimation(
  messages: readonly Message[],
  // The model of the request this count is gating. When provided AND the
  // usage-bearing anchor was produced under openai (a gpt-* model whose server
  // usage reflects wire-TRUNCATED tool outputs) while the current request is
  // NOT openai (a mid-session gpt→claude switch sends the FULL, untruncated
  // transcript), the anchor understates the real context — autocompact/413
  // warnings would fire late and the first Claude call can 413. In that case,
  // invalidate the anchor and fall through to a full rough re-estimation of the
  // whole array. claude→gpt is safe (anthropic anchor already reflects full
  // sizes; gpt only shrinks the wire, so the estimate stays conservative), so
  // that direction is left untouched.
  currentModel?: string,
  // Measured non-message request overhead (system prompt + userContext/
  // systemContext + serialized tool schemas) for the request this count is
  // gating. Only the two decision call sites can see it — autoCompactIfNeeded
  // and the query.ts blocking preempt — and it is consumed ONLY on the
  // pure-rough fallback paths, where NON_MESSAGE_REQUEST_OVERHEAD_TOKENS acts
  // as its floor. Never applied on an anchored path: server usage already
  // counts every one of those bytes.
  nonMessageOverheadTokens?: number,
): number {
  const invalidateOpenaiAnchor =
    currentModel !== undefined &&
    getProviderForModel(currentModel) !== 'openai'
  const { boundaryIdx, preserved } = getUsageWalkBounds(messages)
  let i = messages.length - 1
  // The walk floor is the last compact boundary — see getUsageWalkBounds.
  while (i >= boundaryIdx) {
    // Don't anchor on kept-tail usage (pre-compaction window). Skipping it lets
    // the walk fall through to the post-boundary rough estimate, which still
    // counts the kept tail as context — just not via its stale usage number.
    if (preserved && i >= preserved.start && i <= preserved.end) {
      i = preserved.start - 1
      continue
    }
    const message = messages[i]
    const usage = message ? getTokenUsage(message) : undefined
    // hasRealUsage skips the {0,0,0,0} Codex seed so the base anchors on the
    // last record with real numbers instead of reading the context as ~0 and
    // silently skipping autocompact until the API 413s. (GPT/Codex agents.)
    if (message && hasRealUsage(usage)) {
      // gpt→claude switch: this anchor's usage reflects the wire-truncated tool
      // outputs the openai server billed, but the current (non-openai) request
      // sends the full transcript. Trusting it understates context, so force a
      // rough re-estimation of everything the next request will carry — which
      // starts at the compact boundary, not at index 0.
      if (
        invalidateOpenaiAnchor &&
        message.type === 'assistant' &&
        getProviderForModel(message.message.model) === 'openai'
      ) {
        return roughEstimateWithOverhead(
          messages.slice(boundaryIdx),
          nonMessageOverheadTokens,
        )
      }
      // Walk back past any earlier sibling records split from the same API
      // response (same message.id) so interleaved tool_results between them
      // are included in the estimation slice.
      const responseId = getAssistantMessageId(message)
      if (responseId) {
        let j = i - 1
        while (j >= boundaryIdx) {
          const prior = messages[j]
          const priorId = prior ? getAssistantMessageId(prior) : undefined
          if (priorId === responseId) {
            // Earlier split of the same API response — anchor here instead.
            i = j
          } else if (priorId !== undefined) {
            // Hit a different API response — stop walking.
            break
          }
          // priorId === undefined: a user/tool_result/attachment message,
          // possibly interleaved between splits — keep walking.
          j--
        }
      }
      // Only the LAST split of a streamed response gets the final usage and
      // stop_reason written back (claude.ts:2496-2503). When stop_reason is
      // set, this anchor IS that terminal sibling, so its output_tokens already
      // covers every sibling's generated content (tool_use inputs included) —
      // rough-counting the sibling records again on top of it is pure phantom
      // context (measured +20k on three parallel 40KB Writes). Exclude them.
      //
      // When stop_reason is null/undefined the stream was interrupted before
      // the write-back, so this anchor is a message_start seed whose
      // output_tokens is ~1 and covers nothing. There the sibling content is
      // genuinely unaccounted for, and excluding it would turn a bounded
      // overcount into an undercount that hides a real 413.
      const excludeSiblings =
        responseId !== undefined &&
        message.type === 'assistant' &&
        message.message.stop_reason != null
      const tail = messages.slice(i + 1)
      return (
        getTokenCountFromUsage(usage) +
        roughTokenCountEstimationForMessages(
          excludeSiblings
            ? tail.filter(m => getAssistantMessageId(m) !== responseId)
            : tail,
        )
      )
    }
    i--
  }
  // No usable anchor at or after the boundary. Estimate only what the next
  // request will actually carry; rough-counting a fullscreen array's whole
  // scrollback here massively overcounts (measured 180,514 vs 14).
  return roughEstimateWithOverhead(
    messages.slice(boundaryIdx),
    nonMessageOverheadTokens,
  )
}
