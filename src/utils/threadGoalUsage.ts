import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { SYNTHETIC_MODEL } from './messages.js'
import type { Message } from '../types/message.js'

/**
 * Real API usage charged to a goal.
 *
 * The pre-existing accounting charged positive conversation-context GROWTH,
 * which is not spend: a compaction shrinks context while costing a full
 * request, and a long tool-heavy turn that ends near its starting context
 * charged close to nothing. A goal budget built on that number cannot bound
 * anything, so the goal now charges what the provider actually reported.
 */
export type ThreadGoalUsageDelta = {
  /** Uncached input plus cache-creation input. */
  inputTokens: number
  outputTokens: number
  /** Cache reads, kept separate: real spend, but at a different rate. */
  cachedInputTokens: number
  /**
   * The number a token budget is measured against: uncached input + output.
   * Cache reads are excluded so a long goal is not charged the full window
   * again on every single turn.
   */
  billableTokens: number
  /** How many distinct API responses this delta covers. */
  responseCount: number
}

export const EMPTY_THREAD_GOAL_USAGE_DELTA: ThreadGoalUsageDelta = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  billableTokens: 0,
  responseCount: 0,
}

function billableFromUsage(usage: Usage): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    usage.output_tokens
  )
}

/**
 * Identity of the API response an assistant record came from.
 *
 * Parallel tool calls stream as several AssistantMessage records that all
 * carry the SAME `message.id` and the SAME usage object (see
 * tokens.ts getAssistantMessageId). Summing per record would multiply one
 * response's cost by its content-block count, so responses are deduped by id
 * before charging. Records with no usable id fall back to their own uuid,
 * which charges them once rather than dropping them.
 */
function getResponseKey(message: Message): string | null {
  if (message?.type !== 'assistant') return null
  const inner = message.message
  if (!('usage' in inner)) return null
  if (inner.model === SYNTHETIC_MODEL) return null
  const id = 'id' in inner && typeof inner.id === 'string' ? inner.id : null
  return id ?? message.uuid ?? null
}

/**
 * Sum real provider usage across `messages`, ignoring any response id in
 * `alreadyCharged`.
 *
 * `alreadyCharged` is what makes repeated accounting safe: an aborted turn, a
 * mid-turn budget check, and the end-of-turn charge all walk overlapping
 * message ranges, and each response must be charged exactly once across all of
 * them. The caller persists the returned ids and passes them back.
 */
export function sumRealThreadGoalUsage(
  messages: readonly Message[],
  alreadyCharged: ReadonlySet<string> = new Set(),
): ThreadGoalUsageDelta & { chargedResponseIds: string[] } {
  const seen = new Set<string>()
  const chargedResponseIds: string[] = []
  let inputTokens = 0
  let outputTokens = 0
  let cachedInputTokens = 0
  let billableTokens = 0

  for (const message of messages) {
    const key = getResponseKey(message)
    if (!key || seen.has(key) || alreadyCharged.has(key)) continue
    seen.add(key)

    const usage = (message as { message: { usage: Usage } }).message.usage
    if (!usage) continue

    inputTokens +=
      usage.input_tokens + (usage.cache_creation_input_tokens ?? 0)
    outputTokens += usage.output_tokens
    cachedInputTokens += usage.cache_read_input_tokens ?? 0
    billableTokens += billableFromUsage(usage)
    chargedResponseIds.push(key)
  }

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    billableTokens,
    responseCount: chargedResponseIds.length,
    chargedResponseIds,
  }
}

/**
 * Cap on how many charged response ids a goal keeps.
 *
 * The ledger only exists to stop double-charging across overlapping walks of
 * the live message array, so it needs to cover the current session's messages,
 * not the goal's entire history. Newest ids are kept.
 */
export const MAX_CHARGED_RESPONSE_IDS = 512

export function mergeChargedResponseIds(
  existing: readonly string[],
  added: readonly string[],
): string[] {
  if (added.length === 0) {
    return existing.length > MAX_CHARGED_RESPONSE_IDS
      ? existing.slice(existing.length - MAX_CHARGED_RESPONSE_IDS)
      : [...existing]
  }
  const merged = [...existing, ...added]
  return merged.length > MAX_CHARGED_RESPONSE_IDS
    ? merged.slice(merged.length - MAX_CHARGED_RESPONSE_IDS)
    : merged
}
