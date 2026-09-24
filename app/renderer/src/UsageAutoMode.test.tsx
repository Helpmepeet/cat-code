import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { collectRetainedUsage } from '../../../src/utils/statsUsage.js'
import { UsagePage } from './UsagePage.js'
import { UsageAutoMode } from './UsageAutoMode.js'

const snapshot = await collectRetainedUsage([], '2026-09-13T12:00:00.000Z')

test('uses the selected range summary and preserves chart order before the heatmap', () => {
  const selectedSnapshot = structuredClone(snapshot)
  for (const [range, attempts] of [['7d', 7], ['30d', 30], ['all', 100]] as const) {
    const autoMode = selectedSnapshot.ranges[range].autoMode
    autoMode.allTools.coverage.state = 'complete'
    autoMode.allTools.outcomes.allowed = attempts
    autoMode.routes = [{ route: 'base', outcome: 'allowed', count: attempts }]
    const html = renderToStaticMarkup(<UsagePage state={{ snapshot: selectedSnapshot, status: 'ready' }} selection={{ range, date: '' }}/>)
    expect(html).toContain(`Normal decision flow for ${attempts} recorded automatic permission attempts`)
    expect(html.indexOf('Decision flow')).toBeLessThan(html.indexOf('Token volume by hour'))
    expect(html.indexOf('Decision flow')).toBeLessThan(html.indexOf('Command block rate'))
    expect(html.indexOf('Command block rate')).toBeLessThan(html.indexOf('Decisions over time'))
    expect(html).toContain('Execution timing')
    expect(html).not.toContain('Auto-mode latency')
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
  expect(renderToStaticMarkup(<UsageAutoMode summary={partial}/>)).toContain('Partial history')
  expect(renderToStaticMarkup(<UsageAutoMode summary={zero}/>)).toContain('No decisions')
})
