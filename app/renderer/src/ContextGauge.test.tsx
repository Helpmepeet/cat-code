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

test('accent (pink) tone under 70% — the prototype donut at headroom', () => {
  const html = renderToStaticMarkup(
    <ContextGauge usage={{ usedTokens: 1, contextWindow: 2, percentUsed: 69 }} />,
  )
  expect(html).toContain('text-accent')
  expect(html).not.toContain('text-tone-warn')
  expect(html).not.toContain('text-tone-danger')
})

// The prototype's break is 70, not the 65 the ACCOUNT-quota ladder uses
// (`usageTone`, accountsPageModel.ts:94). Reading the wrong ladder here is what
// painted the popover's percent green while the donut beside it was pink.
test('warn tone in the 70–89% band', () => {
  expect(
    renderToStaticMarkup(
      <ContextGauge usage={{ usedTokens: 1, contextWindow: 2, percentUsed: 70 }} />,
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
  // Half the circumference drawn, the rest left as gap; no inline style attribute.
  expect(html).toContain('stroke-dasharray="20.420352248333657 40.840704496667314"')
  expect(html).not.toContain('style=')
})

// The empty state is the one value where the two dash forms disagree: the
// prototype's `0 CIRCUMFERENCE` under a round linecap draws a DOT at 12 o'clock,
// where `strokeDashoffset={CIRCUMFERENCE}` would draw nothing at all.
test('0% keeps the prototype dot rather than an empty ring', () => {
  const html = renderToStaticMarkup(
    <ContextGauge usage={{ usedTokens: 0, contextWindow: 200_000, percentUsed: 0 }} />,
  )
  expect(html).toContain('stroke-dasharray="0 40.840704496667314"')
  expect(html).toContain('stroke-linecap="round"')
  expect(html).not.toContain('stroke-dashoffset')
})
