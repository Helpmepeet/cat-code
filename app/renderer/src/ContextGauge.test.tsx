import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ContextGauge } from './ContextGauge.js'

test('renders the percent + an accessible label', () => {
  const html = renderToStaticMarkup(
    <ContextGauge usage={{ usedTokens: 50_000, contextWindow: 200_000, percentUsed: 25 }} />,
  )
  expect(html).toContain('25%')
  expect(html).toContain('aria-label="Context 25% used"')
})

test('healthy tone (neutral) under 65%', () => {
  const html = renderToStaticMarkup(
    <ContextGauge usage={{ usedTokens: 1, contextWindow: 2, percentUsed: 64 }} />,
  )
  expect(html).toContain('text-text-muted')
  expect(html).not.toContain('text-tone-warn')
  expect(html).not.toContain('text-tone-danger')
})

test('warn tone in the 65–89% band', () => {
  expect(
    renderToStaticMarkup(
      <ContextGauge usage={{ usedTokens: 1, contextWindow: 2, percentUsed: 65 }} />,
    ),
  ).toContain('text-tone-warn')
  expect(
    renderToStaticMarkup(
      <ContextGauge usage={{ usedTokens: 1, contextWindow: 2, percentUsed: 89 }} />,
    ),
  ).toContain('text-tone-warn')
})

test('danger tone at 90% and above', () => {
  expect(
    renderToStaticMarkup(
      <ContextGauge usage={{ usedTokens: 1, contextWindow: 2, percentUsed: 90 }} />,
    ),
  ).toContain('text-tone-danger')
})

test('the arc geometry is a computed SVG attribute, not a style object', () => {
  const html = renderToStaticMarkup(
    <ContextGauge usage={{ usedTokens: 100_000, contextWindow: 200_000, percentUsed: 50 }} />,
  )
  // Two ring circles + a dash offset; no inline style attribute on the gauge.
  expect(html).toContain('stroke-dashoffset')
  expect(html).not.toContain('style=')
})
