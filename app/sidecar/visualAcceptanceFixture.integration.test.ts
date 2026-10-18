import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareAnalyticsFixture } from '../scripts/visualAcceptanceFixture.js'
import { collectIndexedUsage } from '../../src/utils/statsUsageIndex.js'
import { fitUsageDashboardSnapshot } from './usageSummary.js'
import { analyticsBuilds } from '../renderer/src/usageAnalyticsDetailsState.js'

test('synthetic matrix transcripts exercise live indexed analytics dimensions in every range', async () => {
  const root = mkdtempSync(join(tmpdir(), 'analytics-fixture-test-'))
  try {
    const now = new Date('2026-10-17T16:00:00.000Z')
    const files = prepareAnalyticsFixture(root, root, now)
    expect(files).toHaveLength(9)
    const result = await collectIndexedUsage(files, now.toISOString(), { path: join(root, 'index.sqlite'), timezone: 'UTC', deadline: Date.now() + 60000 })
    expect(result.coverage.state).toBe('complete')
    expect(result.coverage.invalidTimings).toBe(0)
    for (const range of Object.values(result.ranges)) {
      expect(range.requests).toBeGreaterThan(0)
      expect(range.cacheWriteReporting).toBe('partial')
      expect(range.rankedSessions.items).toHaveLength(3)
      expect(range.skills.length).toBeGreaterThan(0)
      expect(range.integrations.length).toBe(6)
      expect(range.timing.models.responseDuration.samples).toBeGreaterThan(0)
      expect(range.days.some(day => day.tools.some(tool => tool.builds?.items.length))).toBe(true)
      expect(range.autoMode.allTools.outcomes.allowed).toBeGreaterThan(0)
      for (const source of ['chat', 'subagents', 'compaction'] as const) {
        expect(range.rankedSessions.items[0]!.tokenSources[source].fresh).toBeGreaterThan(0)
      }
    }
    expect(result.ranges.all.days[0]!.date < result.ranges['30d'].startDate).toBe(true)
    expect(result.ranges['30d'].requests).toBeGreaterThan(result.ranges['7d'].requests)
    const fitted = fitUsageDashboardSnapshot(result)
    expect(Buffer.byteLength(JSON.stringify({ type: 'usage', version: 1, snapshot: fitted }))).toBeLessThan(262144)
    for (const range of Object.values(fitted.ranges)) {
      expect(range.rankedSessions.items.length).toBeGreaterThan(0)
      expect(range.cacheWriteReporting).toBe('partial')
      expect(analyticsBuilds(range).items.some(item => item.results >= 200)).toBe(true)
      expect(range.skills.length).toBeGreaterThan(0)
      expect(range.integrations.length).toBeGreaterThan(0)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 60000)
