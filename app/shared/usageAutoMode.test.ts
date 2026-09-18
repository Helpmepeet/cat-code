import { expect, test } from 'bun:test'
import type { AutoModeUsageSummary } from './usageAutoMode.js'

test('aggregate contract contains only renderer-safe counts and category labels', () => {
  const outcomes = {
    allowed: 1,
    policy_blocked: 0,
    review_required: 0,
    operational_error: 0,
    cancelled: 0,
    unknown_outcome: 0,
    incomplete: 0,
  }
  const summary: AutoModeUsageSummary = {
    allTools: {
      outcomes,
      coverage: { state: 'complete', invalidRecords: 0, orphanRecords: 0 },
    },
    commands: {
      outcomes,
      coverage: { state: 'complete', invalidRecords: 0, orphanRecords: 0 },
    },
    buckets: [],
    routes: [{ route: 'base', outcome: 'allowed', count: 1 }],
    categories: [],
  }

  expect(summary.routes[0]).toEqual({
    route: 'base',
    outcome: 'allowed',
    count: 1,
  })
})
