import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { collectRetainedUsage } from '../../../src/utils/statsUsage.js'
import { UsageAutoMode } from './UsageAutoMode.js'

const snapshot = await collectRetainedUsage([], '2026-09-13T12:00:00.000Z')

test('uses recorded decisions from the selected range summary', () => {
  const selectedSnapshot = structuredClone(snapshot)
  for (const [range, attempts] of [['7d', 7], ['30d', 30], ['all', 100]] as const) {
    const autoMode = selectedSnapshot.ranges[range].autoMode
    autoMode.allTools.coverage.state = 'complete'
    autoMode.allTools.outcomes.allowed = attempts
    autoMode.routes = [{ route: 'base', outcome: 'allowed', count: attempts }]
    const html = renderToStaticMarkup(<UsageAutoMode summary={selectedSnapshot.ranges[range]}/> )
    expect(html).toContain(`Decision flow for ${attempts} recorded allowed or blocked automatic permission decisions`)
    expect(html).toContain(`100.0% of ${attempts} allowed or blocked decisions`)
  }
})

test('handles unavailable, partial, and zero auto-mode states locally', () => {
  const unavailable = structuredClone(snapshot.ranges['7d'])
  unavailable.autoMode.allTools.coverage.state = 'unavailable'
  const partial = structuredClone(snapshot.ranges['7d'])
  partial.autoMode.allTools.coverage.state = 'partial'
  const zero = structuredClone(snapshot.ranges['7d'])
  zero.autoMode.allTools.coverage.state = 'complete'
  expect(renderToStaticMarkup(<UsageAutoMode summary={unavailable}/>)).toContain('Decision flow unavailable')
  expect(renderToStaticMarkup(<UsageAutoMode summary={partial}/>)).not.toContain('Partial history')
  expect(renderToStaticMarkup(<UsageAutoMode summary={zero}/>)).toContain('No decisions')
})
