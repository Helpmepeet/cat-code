import { expect, test } from 'bun:test'
import { hundredAttemptAutoModeFixture } from '../../../src/utils/autoModeUsage.fixture.js'
import {
  reduceAutoModeUsage,
  type RetainedAutoModeRecord,
} from '../../../src/utils/autoModeUsage.js'
import {
  autoModeAttempts,
  autoModeCommandRateHeadline,
  autoModeCommandRatePoints,
  autoModeOverviewEdges,
  confirmedRateSegments,
  sortedAutoModeCategories,
} from './usageAutoModeState.js'

const summary = reduceAutoModeUsage(hundredAttemptAutoModeFixture())

test('derives canonical attempt totals and exact command-rate math', () => {
  expect(autoModeAttempts(summary)).toBe(100)
  expect(autoModeCommandRateHeadline(summary)).toEqual({
    numerator: 4,
    denominator: 40,
    rate: 0.1,
    state: 'confirmed',
  })
})

test('reports mixed-source command coverage as unavailable in the headline', () => {
  const fixture = hundredAttemptAutoModeFixture()
  const mixedSourceSummary = reduceAutoModeUsage({
    ...fixture,
    sources: [
      ...fixture.sources,
      { sourceScope: 'unsupported-source', allTools: 'unavailable', commands: 'unavailable' },
    ],
  })

  expect(mixedSourceSummary.commands.coverage.state).toBe('partial')
  expect(autoModeCommandRateHeadline(mixedSourceSummary)).toEqual({
    numerator: 4,
    denominator: 40,
    rate: null,
    state: 'unavailable',
  })
})

test('derives the headline from unequal daily command denominators', () => {
  const sourceScope = 'rate-source'
  const records: RetainedAutoModeRecord[] = []
  for (let index = 0; index < 100; index++) {
    const id = `rate-${index}`
    const date = index < 10 ? '2026-09-10' : '2026-09-11'
    const observedAt = `${date}T12:00:00.000Z`
    const disposition = index === 0 || index === 10 ? 'policy_blocked' : 'allowed'
    records.push({
      sourceScope,
      recordId: `start-${id}`,
      observedAt,
      diagnosticKind: 'auto_mode_observation',
      payload: {
        schema_version: 1,
        subtype: 'auto_permission_start',
        attempt_id: id,
        tool_use_id: `tool-${id}`,
        tool_kind: 'bash',
        auto_mode: 'auto',
        initial: true,
      },
    })
    records.push({
      sourceScope,
      recordId: `end-${id}`,
      observedAt: `${date}T12:01:00.000Z`,
      diagnosticKind: 'auto_mode_observation',
      payload: {
        schema_version: 1,
        subtype: 'auto_permission_end',
        attempt_id: id,
        raw_result: disposition === 'allowed' ? 'allow' : 'deny',
        disposition,
        route: 'base',
      },
    })
  }
  const summary = reduceAutoModeUsage({
    records,
    sources: [{ sourceScope, allTools: 'complete', commands: 'complete' }],
    rangeStart: '2026-09-10T00:00:00.000Z',
    rangeEnd: '2026-09-11T23:59:59.999Z',
    cutoff: '2026-09-12T00:00:00.000Z',
    timezone: 'UTC',
  })

  expect(summary.buckets.map(bucket =>
    Object.values(bucket.commands.outcomes).reduce((total, count) => total + count, 0),
  )).toEqual([10, 90])
  expect(autoModeCommandRateHeadline(summary)).toEqual({
    numerator: 2,
    denominator: 100,
    rate: 0.02,
    state: 'confirmed',
  })
})

test('keeps unavailable and provisional points out of confirmed segments', () => {
  const points = autoModeCommandRatePoints({
    ...summary,
    buckets: [
      { ...summary.buckets[0]!, date: '2026-09-10' },
      { ...summary.buckets[0]!, date: '2026-09-12', commands: { ...summary.buckets[0]!.commands, coverage: { ...summary.buckets[0]!.commands.coverage, state: 'partial' } } },
      { ...summary.buckets[0]!, date: '2026-09-13', commands: { ...summary.buckets[0]!.commands, outcomes: { ...summary.buckets[0]!.commands.outcomes, incomplete: 1 }, coverage: { ...summary.buckets[0]!.commands.coverage, state: 'complete' } } },
    ],
  })
  expect(points.map(point => point.state)).toEqual(['confirmed', 'unavailable', 'provisional'])
  expect(confirmedRateSegments(points)).toEqual([[points[0]]])
  expect(confirmedRateSegments([points[0]!, { ...points[0]!, date: '2026-09-12' }])).toHaveLength(2)
})

test('sorts auto-mode categories by count then key', () => {
  expect(sortedAutoModeCategories(summary)).toEqual([...summary.categories].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)))
})

test('builds a conserved flow for allowed and blocked outcomes', () => {
  const edges = autoModeOverviewEdges(summary)
  expect(edges.filter(edge => edge.from === 'Attempts')).toEqual([
    { from: 'Attempts', to: 'Base paths', count: 55 },
    { from: 'Attempts', to: 'Stage 1', count: 32 },
    { from: 'Attempts', to: 'Stage 2', count: 5 },
  ])
  expect(edges.filter(edge => edge.from === 'Base paths' || edge.from === 'Stage 1' || edge.from === 'Stage 2').reduce((total, edge) => total + edge.count, 0)).toBe(92)
  expect(edges.every(edge => edge.to !== 'error' && edge.to !== 'cancelled')).toBe(true)
  const variedRoutes = structuredClone(summary)
  variedRoutes.routes = [
    { route: 'base', outcome: 'allowed', count: 1 },
    { route: 'forced', outcome: 'allowed', count: 2 },
    { route: 'guard', outcome: 'allowed', count: 3 },
    { route: 'accept_edits', outcome: 'allowed', count: 4 },
    { route: 'allowlist', outcome: 'allowed', count: 5 },
    { route: 'unknown', outcome: 'allowed', count: 6 },
    { route: 'stage1', outcome: 'allowed', count: 7 },
    { route: 'stage2', outcome: 'allowed', count: 8 },
  ]
  expect(autoModeOverviewEdges(variedRoutes).filter(edge => edge.from === 'Attempts')).toEqual([
    { from: 'Attempts', to: 'Base paths', count: 21 },
    { from: 'Attempts', to: 'Stage 1', count: 7 },
    { from: 'Attempts', to: 'Stage 2', count: 8 },
  ])
})
