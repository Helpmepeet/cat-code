import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { hundredAttemptAutoModeFixture } from '../../../src/utils/autoModeUsage.fixture.js'
import { reduceAutoModeUsage } from '../../../src/utils/autoModeUsage.js'
import { UsageAutoModeFlow } from './UsageAutoModeFlow.js'

const summary = reduceAutoModeUsage(hundredAttemptAutoModeFixture())

test('renders a labelled Sankey and exact route values from aggregated routes', () => {
  const html = renderToStaticMarkup(<UsageAutoModeFlow summary={summary} />)
  expect(html).toContain('Decision flow')
  expect(html).toContain('Initial automatic permission routes for all recorded tool attempts.')
  expect(html).toContain('Decision flow for 100 recorded automatic permission attempts')
  expect(html).toContain('Base checks')
  expect(html).toContain('Policy-blocked')
  expect(html).toContain('Exact route values')
  expect(html).toContain('100 recorded attempts')
  expect(html).toContain('of all 100 recorded attempts')
})

test('does not render a zero-valued flow for unavailable or empty coverage', () => {
  const unavailable = structuredClone(summary)
  unavailable.allTools.coverage.state = 'unavailable'
  expect(renderToStaticMarkup(<UsageAutoModeFlow summary={unavailable} />)).toContain('Decision routes are unavailable for this period.')

  const empty = structuredClone(summary)
  for (const outcome of Object.keys(empty.allTools.outcomes) as Array<keyof typeof empty.allTools.outcomes>) empty.allTools.outcomes[outcome] = 0
  empty.routes = []
  expect(renderToStaticMarkup(<UsageAutoModeFlow summary={empty} />)).toContain('No recorded automatic permission attempts in this period.')
})

test('marks partial history without replacing the recorded route flow', () => {
  const partial = structuredClone(summary)
  partial.allTools.coverage.state = 'partial'
  const html = renderToStaticMarkup(<UsageAutoModeFlow summary={partial} />)
  expect(html).toContain('Partial retained history. This flow shows recorded routes only.')
  expect(html).toContain('Recorded automatic permission routes')
})
