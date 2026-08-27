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

test('draws the reference tick on a window bigger than the reference', () => {
  const html = renderToStaticMarkup(
    <ContextGauge
      usage={{ usedTokens: 441_000, contextWindow: 980_000, percentUsed: 45 }}
    />,
  )
  // 372,000 / 980,000 = 0.37959…, so the tick sits at that fraction of a turn
  // from 12 o'clock. Endpoints are computed attributes, never a style object.
  expect(html).toContain('<line')
  // A presentation attribute, not a class, so the tick carries its own pair for
  // the light appearance; verified to resolve in Chromium 130 (2026-08-27).
  expect(html).toContain(
    'stroke="light-dark(rgba(9,9,11,0.7), rgba(255,255,255,0.75))"',
  )
  expect(html).not.toContain('style=')
})

test('names the mark in the hover text only where one is drawn', () => {
  const marked = renderToStaticMarkup(
    <ContextGauge
      usage={{ usedTokens: 441_000, contextWindow: 980_000, percentUsed: 45 }}
    />,
  )
  expect(marked).toContain('mark at 372,000')
  // The terse percentage label is unchanged: the tick is visual, and the svg it
  // lives in is aria-hidden.
  expect(marked).toContain('aria-label="Context 45% used"')

  const unmarked = renderToStaticMarkup(
    <ContextGauge usage={{ usedTokens: 100_000, contextWindow: 352_000, percentUsed: 28 }} />,
  )
  expect(unmarked).not.toContain('mark at')
  expect(unmarked).toContain('28% used')
})

test('places the tick at the same angle whether or not the arc has reached it', () => {
  const below = renderToStaticMarkup(
    <ContextGauge
      usage={{ usedTokens: 352_800, contextWindow: 980_000, percentUsed: 36 }}
    />,
  )
  const above = renderToStaticMarkup(
    <ContextGauge
      usage={{ usedTokens: 441_000, contextWindow: 980_000, percentUsed: 45 }}
    />,
  )
  const lineOf = (html: string) => /<line[^>]*>/.exec(html)?.[0]
  // The mark is a property of the WINDOW, not of usage: identical on both sides.
  expect(lineOf(below)).toBeDefined()
  expect(lineOf(below)).toBe(lineOf(above))
})

// A window at or below the reference puts the tick on or past the ring's end,
// where it marks nothing and reads as a defect in the donut. 352,000 is what a
// live Terra or Luna session actually reports; 372,000 is the same models
// through the result-frame fallback.
test('omits the tick when the window is not bigger than the reference', () => {
  for (const contextWindow of [372_000, 352_000, 200_000]) {
    const html = renderToStaticMarkup(
      <ContextGauge usage={{ usedTokens: 10_000, contextWindow, percentUsed: 3 }} />,
    )
    expect(html).not.toContain('<line')
  }
})

// Crossing the reference must change exactly one thing on screen: the tick's
// position relative to the arc. Not the tone, not a warning.
test('crossing the reference leaves the tone ladder alone', () => {
  const below = renderToStaticMarkup(
    <ContextGauge
      usage={{ usedTokens: 352_800, contextWindow: 980_000, percentUsed: 36 }}
    />,
  )
  const above = renderToStaticMarkup(
    <ContextGauge
      usage={{ usedTokens: 441_000, contextWindow: 980_000, percentUsed: 45 }}
    />,
  )
  expect(below).toContain('text-accent')
  expect(above).toContain('text-accent')
  expect(above).not.toContain('text-tone-warn')
  expect(above).not.toContain('text-tone-danger')
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

// Finding 8 (2026-08-19 transcript message-visibility review). The donut is
// never hidden, so the unknown state has to be a state OF the donut: ring at
// rest, no number, and the token count moved into the hover text.
test('withholds the percent when the window is the fallback constant', () => {
  const html = renderToStaticMarkup(
    <ContextGauge
      usage={{
        usedTokens: 10_000,
        contextWindow: 200_000,
        percentUsed: 5,
        windowIsFallback: true,
      }}
    />,
  )
  // Still rendered, still on the prototype's empty-state dot.
  expect(html).toContain('<svg')
  expect(html).toContain('stroke-dasharray="0 40.840704496667314"')
  // No percentage anywhere: not in the face, not in the label, not in the title.
  expect(html).not.toContain('5%')
  expect(html).not.toContain('% used')
  expect(html).toContain('aria-label="Context 10,000 tokens used"')
  expect(html).toContain('window size not reported yet')
})

test('fills the percent in as soon as a real window arrives', () => {
  const html = renderToStaticMarkup(
    <ContextGauge usage={{ usedTokens: 10_000, contextWindow: 200_000, percentUsed: 5 }} />,
  )
  expect(html).toContain('5%')
  expect(html).toContain('aria-label="Context 5% used"')
  expect(html).not.toContain('window size not reported yet')
})
