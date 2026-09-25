import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AutoModeUsageOutcomeCounts, AutoModeUsagePopulation, AutoModeUsageSummary } from '../../shared/usageAutoMode.js'
import { UsageAutoModeBlockRate } from './UsageAutoModeBlockRate.js'

const outcomes = (values: Partial<AutoModeUsageOutcomeCounts> = {}): AutoModeUsageOutcomeCounts => ({
  allowed: 0,
  policy_blocked: 0,
  review_required: 0,
  operational_error: 0,
  cancelled: 0,
  unknown_outcome: 0,
  incomplete: 0,
  ...values,
})

const population = (
  values: Partial<AutoModeUsageOutcomeCounts>,
  state: AutoModeUsagePopulation['coverage']['state'] = 'complete',
): AutoModeUsagePopulation => ({
  outcomes: outcomes(values),
  coverage: { state, invalidRecords: 0, orphanRecords: 0 },
})

function summary(): AutoModeUsageSummary {
  const first = population({ policy_blocked: 4, allowed: 33, review_required: 2, operational_error: 1 })
  const unavailable = population({}, 'unavailable')
  const provisional = population({ policy_blocked: 1, allowed: 8, review_required: 1, unknown_outcome: 1 })
  return {
    allTools: population({ policy_blocked: 5, allowed: 40, review_required: 3, operational_error: 1, unknown_outcome: 1, incomplete: 1 }),
    commands: population({ policy_blocked: 5, allowed: 40, review_required: 3, operational_error: 1, unknown_outcome: 1, incomplete: 1 }),
    buckets: [
      { date: '2026-09-10', allTools: first, commands: first },
      { date: '2026-09-11', allTools: unavailable, commands: unavailable },
      { date: '2026-09-13', allTools: provisional, commands: provisional },
    ],
    routes: [],
    categories: [],
  }
}

const render = (value = summary()) => renderToStaticMarkup(
  <UsageAutoModeBlockRate summary={value} startDate="2026-09-10" endDateExclusive="2026-09-14"/>,
)

test('renders confirmed 4/40, unavailable 0/0, and a gap before provisional values', () => {
  const html = render()
  expect(html).toContain('4 policy-denied commands / 40 recorded commands')
  expect(html).toContain('10.0%')
  expect(html).toContain('Sep 10')
  expect(html).toContain('Sep 13')
  expect(html).toContain('Provisional')
  expect((html.match(/usage-auto-mode-block-rate-line/g) ?? []).length).toBe(1)
  expect((html.match(/usage-auto-mode-block-rate-dot/g) ?? []).length).toBe(2)
  expect(html).toContain('usage-auto-mode-block-rate-dot usage-auto-mode-rate-provisional')
})

test('does not bridge confirmed points across missing UTC periods', () => {
  const gapped = summary()
  const second = population({ policy_blocked: 2, allowed: 18 })
  gapped.buckets = [
    gapped.buckets[0]!,
    { date: '2026-09-13', allTools: second, commands: second },
  ]
  const html = render(gapped)
  expect((html.match(/usage-auto-mode-block-rate-line/g) ?? []).length).toBe(2)
})

test('exposes keyboard-readable chart points without a per-panel table', () => {
  const html = render()
  expect(html).not.toContain('Exact command block-rate values')
  expect(html).toContain('Command block rate, 0 to ')
  expect(html).toContain('role="button"')
  expect(html).toContain('tabindex="0"')
  expect(html).toContain('1 operational error, 2 review-required decisions')
  expect(html).toContain('1 review-required decision, 1 unresolved')
})

test('uses a meaningful unavailable state instead of fabricated graph axes for 0/0 coverage', () => {
  const empty = summary()
  empty.commands = population({}, 'complete')
  empty.buckets = [{ date: '2026-09-10', allTools: population({}, 'complete'), commands: population({}, 'complete') }]
  const html = render(empty)
  expect(html).toContain('No command attempts')
  expect(html).not.toContain('usage-auto-mode-block-rate-chart')
  expect(html).not.toContain('Exact command block-rate values')
})
