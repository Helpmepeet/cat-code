import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { hundredAttemptAutoModeFixture } from '../../../src/utils/autoModeUsage.fixture.js'
import { reduceAutoModeUsage } from '../../../src/utils/autoModeUsage.js'
import { UsageAutoModeFlow } from './UsageAutoModeFlow.js'

const summary = reduceAutoModeUsage(hundredAttemptAutoModeFixture())

test('renders the normal decision path and exact route values from aggregated routes', () => {
  const html = renderToStaticMarkup(<UsageAutoModeFlow summary={summary} />)
  expect(html).toContain('Decision flow')
  expect(html).toContain('Normal decision flow for 87 recorded automatic permission attempts')
  expect(html).toContain('Normal completed path')
  expect(html).toContain('13 exceptional records listed below')
  expect(html).toContain('Stage 1')
  expect(html).toContain('Stage 2')
  expect(html).toContain('Approved')
  expect(html).toContain('Blocked')
  expect(html).toContain('Base checks')
  expect(html).toContain('Policy-blocked')
  expect(html).toContain('Exact route values')
  expect(html).toContain('of 87 normal completed decisions')
})

test('does not render a zero-valued flow for unavailable or empty coverage', () => {
  const unavailable = structuredClone(summary)
  unavailable.allTools.coverage.state = 'unavailable'
  expect(renderToStaticMarkup(<UsageAutoModeFlow summary={unavailable} />)).toContain('Decision flow unavailable')

  const empty = structuredClone(summary)
  for (const outcome of Object.keys(empty.allTools.outcomes) as Array<keyof typeof empty.allTools.outcomes>) empty.allTools.outcomes[outcome] = 0
  empty.routes = []
  expect(renderToStaticMarkup(<UsageAutoModeFlow summary={empty} />)).toContain('No decisions')
})

test('marks partial history without replacing the recorded route flow', () => {
  const partial = structuredClone(summary)
  partial.allTools.coverage.state = 'partial'
  const html = renderToStaticMarkup(<UsageAutoModeFlow summary={partial} />)
  expect(html).toContain('Partial history')
  expect(html).toContain('Recorded automatic permission routes')
})

test('keeps exact values available when every record is exceptional', () => {
  const exceptional = structuredClone(summary)
  exceptional.allTools.outcomes = {
    allowed: 0,
    policy_blocked: 0,
    review_required: 0,
    operational_error: 1,
    cancelled: 0,
    unknown_outcome: 0,
    incomplete: 0,
  }
  exceptional.routes = [{ route: 'base', outcome: 'operational_error', count: 1 }]
  const html = renderToStaticMarkup(<UsageAutoModeFlow summary={exceptional} />)
  expect(html).toContain('No normal completed decisions')
  expect(html).toContain('Exact route values')
  expect(html).toContain('Operational error')
})
