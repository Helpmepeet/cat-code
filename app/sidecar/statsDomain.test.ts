import { describe, expect, test } from 'bun:test'
import type { ClaudeCodeStats } from '../../src/utils/stats.js'
import {
  buildUsageStatsSnapshot,
  getEmptyUsageStatsSnapshot,
  tryGetUsageStatsSnapshot,
} from './statsDomain.js'

describe('statsDomain', () => {
  test('buildUsageStatsSnapshot calculates exact aggregates and cache hit rates', () => {
    const rawStats: ClaudeCodeStats = {
      totalSessions: 14,
      totalMessages: 120,
      totalDays: 7,
      activeDays: 5,
      streaks: {
        currentStreak: 3,
        longestStreak: 5,
        currentStreakStart: '2026-08-10',
        longestStreakStart: '2026-08-01',
        longestStreakEnd: '2026-08-05',
      },
      dailyActivity: [
        { date: '2026-08-13', messageCount: 50, sessionCount: 6, toolCallCount: 12 },
        { date: '2026-08-14', messageCount: 70, sessionCount: 8, toolCallCount: 18 },
      ],
      dailyModelTokens: [
        { date: '2026-08-13', tokensByModel: { 'claude-3-5-sonnet': 40000 } },
        { date: '2026-08-14', tokensByModel: { 'claude-3-5-sonnet': 60000 } },
      ],
      longestSession: null,
      modelUsage: {
        'claude-3-5-sonnet': {
          inputTokens: 50000,
          outputTokens: 20000,
          cacheCreationInputTokens: 10000,
          cacheReadInputTokens: 140000,
        },
      },
      firstSessionDate: '2026-08-01',
      lastSessionDate: '2026-08-14',
      peakActivityDay: '2026-08-14',
      peakActivityHour: 14,
      totalSpeculationTimeSavedMs: 0,
    }

    const snapshot = buildUsageStatsSnapshot(rawStats, '7d')
    expect(snapshot.range).toBe('7d')
    expect(snapshot.totalTokens).toBe(70000) // 50000 input + 20000 output
    expect(snapshot.freshInputTokens).toBe(50000)
    expect(snapshot.cacheWriteTokens).toBe(10000)
    expect(snapshot.cacheReadTokens).toBe(140000)
    // 140000 / (140000 + 10000 + 50000) = 140000 / 200000 = 70%
    expect(snapshot.cacheHitRate).toBe(70)
    expect(snapshot.totalSessions).toBe(14)
    expect(snapshot.totalMessages).toBe(120)
    expect(snapshot.activeDays).toBe(5)
    expect(snapshot.dailyModelTokens).toHaveLength(2)
    expect(snapshot.dailyActivity).toHaveLength(2)
  })

  test('getEmptyUsageStatsSnapshot produces a clean zeroed snapshot with zero tokens', () => {
    const empty = getEmptyUsageStatsSnapshot('30d')
    expect(empty.range).toBe('30d')
    expect(empty.totalTokens).toBe(0)
    expect(empty.cacheHitRate).toBe(0)
    expect(empty.dailyModelTokens).toEqual([])
    expect(empty.modelUsage).toEqual({})
    expect(empty.dailyActivity).toEqual([])
  })

  test('tryGetUsageStatsSnapshot runs throw-free and returns a valid UsageStatsSnapshot', async () => {
    const snap = await tryGetUsageStatsSnapshot('7d')
    // Null is reserved for a FAILED read. This machine has a readable projects
    // directory, so a null here is a real failure, not an empty history.
    expect(snap).not.toBeNull()
    if (!snap) return
    expect(snap.range).toBe('7d')
    expect(typeof snap.totalTokens).toBe('number')
    expect(typeof snap.cacheHitRate).toBe('number')
    expect(Array.isArray(snap.dailyModelTokens)).toBe(true)
    expect(Array.isArray(snap.dailyActivity)).toBe(true)
    expect(typeof snap.modelUsage).toBe('object')
  })

  test('a failed aggregation reads as null, never as an empty snapshot', async () => {
    // The distinction the whole fix rests on: an empty snapshot is a measured
    // fact ("no activity in this range") and the UI is entitled to say so; a
    // failed read is not, and publishing it as zeros is what printed
    // "No session activity recorded" at a user with 33k messages.
    const { _forTest } = await import('./statsDomain.js')
    const restore = _forTest.setAggregatorForTest(() => {
      throw new Error('transcript directory unreadable')
    })
    try {
      expect(await tryGetUsageStatsSnapshot('30d', true)).toBeNull()
    } finally {
      restore()
    }
  })

  test('the cache TTL is stamped when the snapshot is stored, not when the call began', async () => {
    // A transcript scan that outlasts the TTL used to expire the very entry it
    // was still producing, so the cache went empty exactly on the large corpora
    // it exists for.
    const { _forTest } = await import('./statsDomain.js')
    const emptyStats: ClaudeCodeStats = {
      totalSessions: 0,
      totalMessages: 0,
      totalDays: 0,
      activeDays: 0,
      streaks: {
        currentStreak: 0,
        longestStreak: 0,
        currentStreakStart: null,
        longestStreakStart: null,
        longestStreakEnd: null,
      },
      dailyActivity: [],
      dailyModelTokens: [],
      longestSession: null,
      modelUsage: {},
      firstSessionDate: null,
      lastSessionDate: null,
      peakActivityDay: null,
      peakActivityHour: null,
      totalSpeculationTimeSavedMs: 0,
    }
    const realNow = Date.now
    let clock = 10_000_000_000_000
    Date.now = () => clock
    let aggregations = 0
    const restore = _forTest.setAggregatorForTest(async () => {
      aggregations += 1
      clock += 6000 // the scan alone outlasts the 5s TTL
      return emptyStats
    })
    try {
      await tryGetUsageStatsSnapshot('30d', true)
      expect(aggregations).toBe(1)
      // Same instant the first call returned: still well inside the TTL.
      await tryGetUsageStatsSnapshot('30d')
      expect(aggregations).toBe(1)
    } finally {
      restore()
      Date.now = realNow
      _forTest.clearCacheForTest()
    }
  })
})
