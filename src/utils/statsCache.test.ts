import { describe, expect, test } from 'bun:test'
import type { ModelUsage } from '../entrypoints/agentSdkTypes.js'
import {
  mergeCacheWithNewStats,
  type PersistedStatsCache,
  STATS_CACHE_VERSION,
  withStatsCacheLock,
} from './statsCache.js'

const emptyUsage: ModelUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  webSearchRequests: 0,
  costUSD: 0,
  contextWindow: 0,
  maxOutputTokens: 0,
}

function emptyCache(): PersistedStatsCache {
  return {
    version: STATS_CACHE_VERSION,
    lastComputedDate: null,
    dailyActivity: [],
    dailyModelTokens: [],
    modelUsage: {},
    totalSessions: 0,
    totalMessages: 0,
    longestSession: null,
    firstSessionDate: null,
    hourCounts: {},
    totalSpeculationTimeSavedMs: 0,
    shotDistribution: {},
    sessionIndex: {},
  }
}

function fragment(timestamp: string, messageCount = 1) {
  return {
    dailyActivity: [],
    dailyModelTokens: [],
    modelUsage: { model: { ...emptyUsage, inputTokens: 100 } },
    sessionStats: [
      {
        sessionId: 'resumed-session',
        duration: 0,
        messageCount,
        timestamp,
      },
    ],
    hourCounts: {},
    totalSpeculationTimeSavedMs: 0,
  }
}

describe('stats cache session reconciliation', () => {
  test('serializes cache readers so the second observes the first update', async () => {
    let persisted = 0
    const first = withStatsCacheLock(async () => {
      const fresh = persisted
      await Promise.resolve()
      persisted = fresh + 1
    })
    const second = withStatsCacheLock(async () => {
      const fresh = persisted
      persisted = fresh + 1
    })

    await Promise.all([first, second])
    expect(persisted).toBe(2)
  })

  test('keeps daily fragments as one all-time session with a full span', () => {
    const first = mergeCacheWithNewStats(
      emptyCache(),
      fragment('2026-09-10T23:00:00.000Z'),
      '2026-09-10',
    )
    const second = mergeCacheWithNewStats(
      first,
      fragment('2026-09-11T01:00:00.000Z'),
      '2026-09-11',
    )
    const third = mergeCacheWithNewStats(
      second,
      fragment('2026-09-12T01:00:00.000Z'),
      '2026-09-12',
    )

    expect([first.totalSessions, second.totalSessions, third.totalSessions]).toEqual([
      1, 1, 1,
    ])
    expect(third.totalMessages).toBe(3)
    expect(third.longestSession).toMatchObject({
      sessionId: 'resumed-session',
      duration: 93_600_000,
      messageCount: 3,
      timestamp: '2026-09-10T23:00:00.000Z',
    })

    // Identity survives independently of transcript availability, so restoring
    // the same file later updates its summary instead of adding a new session.
    const restored = mergeCacheWithNewStats(
      third,
      fragment('2026-09-13T01:00:00.000Z'),
      '2026-09-13',
    )
    expect(restored.totalSessions).toBe(1)
    expect(restored.longestSession?.duration).toBe(180_000_000)
  })
})
