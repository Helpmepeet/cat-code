import { expect, test } from 'bun:test'
import { hundredAttemptAutoModeFixture } from '../../../src/utils/autoModeUsage.fixture.js'
import { reduceAutoModeUsage } from '../../../src/utils/autoModeUsage.js'
import {
  autoModeAttempts,
  autoModeDisplayCounts,
  autoModeCommandRateHeadline,
  autoModeCommandRatePoints,
  autoModeOverviewEdges,
  autoModeOutcomeSeries,
  autoModeRouteEdges,
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

test('uses stable outcome/category order and conserves route edges', () => {
  expect(autoModeOutcomeSeries(summary).map(series => series.outcome)).toEqual([
    'allowed', 'policy_blocked', 'review_required', 'operational_error', 'cancelled', 'unknown_outcome', 'incomplete',
  ])
  expect(sortedAutoModeCategories(summary)).toEqual([...summary.categories].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)))
  const edges = autoModeRouteEdges(summary)
  expect(edges.filter(edge => edge.from === 'Attempts').reduce((total, edge) => total + edge.count, 0)).toBe(100)
  expect(edges.filter(edge => edge.to === 'allowed' || edge.to === 'policy_blocked' || edge.to === 'review_required' || edge.to === 'operational_error').reduce((total, edge) => total + edge.count, 0)).toBe(100)
  expect(new Set(edges.map(edge => `${edge.from}:${edge.to}`)).size).toBe(edges.length)
  for (const node of ['Base checks', 'Stage 1', 'Stage 2']) {
    expect(edges.filter(edge => edge.to === node).reduce((total, edge) => total + edge.count, 0)).toBe(
      edges.filter(edge => edge.from === node).reduce((total, edge) => total + edge.count, 0),
    )
  }
})

test('builds a conserved flow for all attempts and groups the four display outcomes', () => {
  const edges = autoModeOverviewEdges(summary)
  expect(edges.filter(edge => edge.from === 'Attempts')).toEqual([
    { from: 'Attempts', to: 'Base paths', count: 60 },
    { from: 'Attempts', to: 'Stage 1', count: 33 },
    { from: 'Attempts', to: 'Stage 2', count: 7 },
  ])
  expect(edges.filter(edge => edge.from === 'Base paths' || edge.from === 'Stage 1' || edge.from === 'Stage 2').reduce((total, edge) => total + edge.count, 0)).toBe(100)
  expect(autoModeDisplayCounts(summary)).toEqual([
    { group: 'allowed', label: 'Allowed', count: 85 },
    { group: 'blocked', label: 'Blocked', count: 7 },
    { group: 'error', label: 'Error', count: 8 },
    { group: 'cancelled', label: 'Cancelled', count: 0 },
  ])
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
