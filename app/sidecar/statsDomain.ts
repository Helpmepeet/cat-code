/**
 * Stats domain capability — read-seam projection for real engine token usage stats.
 *
 * Sourced directly from `src/utils/stats.ts` (`aggregateClaudeCodeStatsForRange`),
 * which reads the real transcript logs in the user's projects directory.
 *
 * ZERO fake numbers: if no session logs exist in the selected range, it produces
 * a clean empty snapshot with 0 tokens and empty model usage.
 *
 * Secret posture: produces numerical aggregates, dates, and model names only.
 * No credential, token key, or prompt text crosses this boundary.
 */

import {
  aggregateClaudeCodeStatsForRange,
  type ClaudeCodeStats,
  type StatsDateRange,
} from '../../src/utils/stats.js'
import type {
  UsageStatsDailyActivityItem,
  UsageStatsDailyModelTokens,
  UsageStatsModelUsageItem,
  UsageStatsRange,
  UsageStatsSnapshot,
} from '../shared/protocol.js'

/**
 * Transforms engine-level `ClaudeCodeStats` into a redacted `UsageStatsSnapshot`.
 */
export function buildUsageStatsSnapshot(
  stats: ClaudeCodeStats,
  range: UsageStatsRange,
): UsageStatsSnapshot {
  const modelUsage: Record<string, UsageStatsModelUsageItem> = {}
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let cacheCreationInputTokens = 0
  let cacheReadInputTokens = 0

  for (const [modelName, usage] of Object.entries(stats.modelUsage)) {
    const inputTokens = usage.inputTokens ?? 0
    const outputTokens = usage.outputTokens ?? 0
    const cacheCreation = usage.cacheCreationInputTokens ?? 0
    const cacheRead = usage.cacheReadInputTokens ?? 0

    modelUsage[modelName] = {
      inputTokens,
      outputTokens,
      cacheCreationInputTokens: cacheCreation,
      cacheReadInputTokens: cacheRead,
    }

    totalInputTokens += inputTokens
    totalOutputTokens += outputTokens
    cacheCreationInputTokens += cacheCreation
    cacheReadInputTokens += cacheRead
  }

  const totalTokens = totalInputTokens + totalOutputTokens
  const cacheTotalDenominator =
    cacheReadInputTokens + cacheCreationInputTokens + totalInputTokens
  const cacheHitRate =
    cacheTotalDenominator > 0
      ? Math.round((cacheReadInputTokens / cacheTotalDenominator) * 100)
      : 0

  const dailyModelTokens: UsageStatsDailyModelTokens[] = (
    stats.dailyModelTokens ?? []
  ).map(d => ({
    date: d.date,
    tokensByModel: { ...(d.tokensByModel ?? {}) },
  }))

  const dailyActivity: UsageStatsDailyActivityItem[] = (
    stats.dailyActivity ?? []
  ).map(a => ({
    date: a.date,
    messageCount: a.messageCount ?? 0,
    sessionCount: a.sessionCount ?? 0,
    toolCallCount: a.toolCallCount ?? 0,
  }))

  return {
    range,
    totalTokens,
    dailyModelTokens,
    modelUsage,
    dailyActivity,
    cacheHitRate,
    cacheReadTokens: cacheReadInputTokens,
    cacheWriteTokens: cacheCreationInputTokens,
    freshInputTokens: totalInputTokens,
    totalSessions: stats.totalSessions ?? 0,
    totalMessages: stats.totalMessages ?? 0,
    activeDays: stats.activeDays ?? 0,
  }
}

/**
 * Empty usage snapshot for fallbacks.
 */
export function getEmptyUsageStatsSnapshot(
  range: UsageStatsRange = '7d',
): UsageStatsSnapshot {
  return {
    range,
    totalTokens: 0,
    dailyModelTokens: [],
    modelUsage: {},
    dailyActivity: [],
    cacheHitRate: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    freshInputTokens: 0,
    totalSessions: 0,
    totalMessages: 0,
    activeDays: 0,
  }
}

const CACHE_TTL_MS = 5000
const statsMemoryCache: Partial<
  Record<UsageStatsRange, { snapshot: UsageStatsSnapshot; timestamp: number }>
> = {}

/**
 * Indirection so a test can drive the FAILURE path. The read-failed branch below
 * is the whole point of this module's return type, and without a seam the only
 * way to exercise it is to make the real transcript directory unreadable.
 */
type StatsAggregator = (range: StatsDateRange) => Promise<ClaudeCodeStats>
let aggregate: StatsAggregator = aggregateClaudeCodeStatsForRange

export const _forTest = {
  /** Swap the aggregator; returns the restore function. */
  setAggregatorForTest(next: StatsAggregator): () => void {
    const previous = aggregate
    aggregate = next
    return () => {
      aggregate = previous
    }
  },
  /** Drop cached snapshots so a test driving a fake clock cannot leak a
   *  timestamp into whatever runs after it. */
  clearCacheForTest(): void {
    for (const range of Object.keys(statsMemoryCache) as UsageStatsRange[]) {
      delete statsMemoryCache[range]
    }
  },
}

/**
 * Fetch real usage statistics from the engine for the given range ('7d' or '30d').
 * Cached in memory with a 5-second TTL to avoid redundant disk I/O on rapid attaches.
 *
 * Returns `null` when the READ FAILED, which is a different fact from an empty
 * snapshot. An empty snapshot means the aggregation ran and measured no activity
 * (`aggregateClaudeCodeStatsForRange` returns empty stats for zero session files
 * without throwing, `src/utils/stats.ts:764`); a null means we do not know. They
 * are indistinguishable downstream once collapsed, and collapsing them is what
 * printed "No session activity recorded" at a user with 33k messages. Callers
 * must not publish a null as zeros: omit the frame or event and leave the
 * renderer on its last good value.
 */
export async function tryGetUsageStatsSnapshot(
  range: UsageStatsRange = '7d',
  bypassCache = false,
): Promise<UsageStatsSnapshot | null> {
  const now = Date.now()
  const cached = statsMemoryCache[range]
  if (!bypassCache && cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.snapshot
  }

  try {
    const statsRange: StatsDateRange = range === '30d' ? '30d' : '7d'
    const stats = await aggregate(statsRange)
    const snapshot = buildUsageStatsSnapshot(stats, range)
    statsMemoryCache[range] = { snapshot, timestamp: Date.now() }
    return snapshot
  } catch {
    return null
  }
}
