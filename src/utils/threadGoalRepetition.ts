import { hashContent } from './hash.js'

/**
 * Detecting a goal that is repeating itself.
 *
 * The turn-level progress signal is coarse: it asks whether a turn called any
 * tool at all. A loop that re-reads the same file, re-runs the same failing
 * command, and re-greps the same pattern passes that check forever while
 * advancing nothing.
 *
 * This adds the finer signal: the identity of what a turn actually did. A turn
 * whose every tool call reproduces a call already seen, WITH THE SAME RESULT,
 * has not moved. The result is part of the identity on purpose: re-running a
 * test that now passes is progress, and treating it as repetition is the
 * false positive that would make this worse than useless.
 *
 * The history lives on the durable goal rather than being derived from the
 * message array, because compaction prunes exactly the messages a repetition
 * check needs to look back across.
 */

export type ThreadGoalToolCall = {
  toolName: string
  /** Tool input, as the caller received it. */
  input: unknown
  /** Tool result, as the caller received it. */
  result: unknown
}

/**
 * How many call fingerprints a goal remembers.
 *
 * Wide enough to span several turns of a stuck loop, bounded because it rides
 * on a record replayed at every session load.
 */
export const MAX_THREAD_GOAL_CALL_HISTORY = 64

/**
 * How many times one identical call may repeat before it counts as a loop.
 *
 * Two is the first repeat, which is often legitimate (a retry after an edit).
 * Three of the same call with the same result is the point where nothing is
 * being learned.
 */
export const THREAD_GOAL_REPETITION_THRESHOLD = 3

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']'
  }
  // Key order must not change a fingerprint: the same call serialised twice by
  // different code paths has to hash the same.
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return (
    '{' +
    entries
      .map(([key, entryValue]) => JSON.stringify(key) + ':' + stableStringify(entryValue))
      .join(',') +
    '}'
  )
}

/**
 * Identity of one tool call: name, arguments, AND result.
 *
 * Including the result is what prevents the false positive. Two runs of the
 * same command that produced different output are two different events, and
 * only the pair that also matched on result indicates a loop.
 */
export function fingerprintThreadGoalToolCall(call: ThreadGoalToolCall): string {
  return hashContent(
    call.toolName +
      ' ' +
      stableStringify(call.input) +
      ' ' +
      stableStringify(call.result),
  )
}

export type ThreadGoalRepetitionVerdict = {
  /** True when every call this turn reproduced an earlier call and result. */
  repeatedEverything: boolean
  /** Fingerprints that hit the threshold, for a durable reason. */
  loopingFingerprints: string[]
  /** History to persist, already bounded. */
  nextHistory: string[]
}

/**
 * Judge one turn's tool calls against the goal's history.
 *
 * A turn with no tool calls returns `repeatedEverything: false` and is left to
 * the coarse signal: doing nothing is a different failure from doing the same
 * thing again, and conflating them would report the wrong reason.
 */
export function detectThreadGoalRepetition({
  history,
  calls,
  threshold = THREAD_GOAL_REPETITION_THRESHOLD,
}: {
  history: readonly string[]
  calls: readonly ThreadGoalToolCall[]
  threshold?: number
}): ThreadGoalRepetitionVerdict {
  if (calls.length === 0) {
    return {
      repeatedEverything: false,
      loopingFingerprints: [],
      nextHistory: [...history],
    }
  }

  const fingerprints = calls.map(fingerprintThreadGoalToolCall)
  const counts = new Map<string, number>()
  for (const entry of history) {
    counts.set(entry, (counts.get(entry) ?? 0) + 1)
  }

  const loopingFingerprints: string[] = []
  let everyCallSeenBefore = true

  for (const fingerprint of fingerprints) {
    const priorCount = counts.get(fingerprint) ?? 0
    if (priorCount === 0) everyCallSeenBefore = false
    const nextCount = priorCount + 1
    counts.set(fingerprint, nextCount)
    if (nextCount >= threshold && !loopingFingerprints.includes(fingerprint)) {
      loopingFingerprints.push(fingerprint)
    }
  }

  const merged = [...history, ...fingerprints]
  const nextHistory =
    merged.length > MAX_THREAD_GOAL_CALL_HISTORY
      ? merged.slice(merged.length - MAX_THREAD_GOAL_CALL_HISTORY)
      : merged

  return {
    // A turn only counts as repetition when EVERY call was one it had already
    // made with the same result. One genuinely new call is progress, and
    // blocking a turn that did something new is the false positive this is
    // built to avoid.
    repeatedEverything: everyCallSeenBefore && loopingFingerprints.length > 0,
    loopingFingerprints,
    nextHistory,
  }
}

export function parseThreadGoalCallHistory(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  return input
    .filter((entry): entry is string => typeof entry === 'string')
    .slice(-MAX_THREAD_GOAL_CALL_HISTORY)
}
