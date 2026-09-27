import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { hundredAttemptAutoModeFixture } from '../../../src/utils/autoModeUsage.fixture.js'
import { reduceAutoModeUsage } from '../../../src/utils/autoModeUsage.js'
import { UsageAutoModeFlow } from './UsageAutoModeFlow.js'

const summary = reduceAutoModeUsage(hundredAttemptAutoModeFixture())

test('renders the simplified route groups and outcome labels without a duplicate legend', () => {
  const html = renderToStaticMarkup(<UsageAutoModeFlow summary={summary} />)
  expect(html).toContain('Decision flow')
  expect(html).toContain('Decision flow for 92 recorded allowed or blocked automatic permission decisions')
  expect(html).toContain('>Base paths</text>')
  expect(html).toContain('>Stage 1</text>')
  expect(html).toContain('>Stage 2</text>')
  expect(html).not.toContain('base route')
  expect(html).not.toContain('usage-auto-flow-legend')
  expect(html).toContain('Allowed')
  expect(html).toContain('Blocked')
  expect(html).not.toContain('>Error</text>')
  expect(html).not.toContain('>Cancelled</text>')
  expect(html).toContain('of 92 allowed or blocked decisions')
  expect(html).toContain('Stage 2 to Blocked: 2 recorded decisions, 2.2% of 92 allowed or blocked decisions')
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

test('does not narrate partial history', () => {
  const partial = structuredClone(summary)
  partial.allTools.coverage.state = 'partial'
  const html = renderToStaticMarkup(<UsageAutoModeFlow summary={partial} />)
  expect(html).not.toContain('Partial history')
  expect(html).toContain('Decision flow for 92 recorded allowed or blocked automatic permission decisions')
})

test('exceptional-only histories have no allowed or blocked flow', () => {
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
  expect(html).toContain('No allowed or blocked decisions')
  expect(html).not.toContain('>Error</text>')
})
