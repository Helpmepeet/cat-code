/**
 * P4-30 — the `SAModal` + `saBtn` contract (PARITY-LEDGER §17 rows 1266-1272).
 *
 * The dismissal rows (scrim-click, card `stopPropagation`) are behavioural, and
 * this package has no DOM click harness, so they are exercised by invoking the
 * hook-free `SAModalFrame` and calling the handler off its element — the
 * `WelcomeScreen.test.tsx` / `OrchestratorReflect` convention, i.e. the exact
 * code path a click runs. Escape is covered as a unit in
 * `sessionActionDialogState.test.ts` (`sessionActionModalKeyAction`) plus the
 * one-line wiring in `SAModal`.
 */
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SAButton, SAModal, SAModalFrame } from './SAModal.js'

type El = { props: Record<string, unknown> }

function frame(overrides: Record<string, unknown> = {}): El {
  return SAModalFrame({
    icon: null,
    tint: 'info',
    title: 'Branch session',
    onClose: () => {},
    children: null,
    ...overrides,
  } as never) as never as El
}

test('the scrim dismisses the dialog', () => {
  let closed = 0
  const el = frame({ onClose: () => (closed += 1) })
  expect(el.props.role).toBe('presentation')
  ;(el.props.onMouseDown as () => void)()
  expect(closed).toBe(1)
})

test('the card stops propagation, so a click INSIDE the dialog never dismisses it', () => {
  let closed = 0
  const el = frame({ onClose: () => (closed += 1) })
  const card = el.props.children as El
  expect(card.props.role).toBe('dialog')
  expect(card.props['aria-modal']).toBe('true')

  let stopped = 0
  ;(card.props.onMouseDown as (e: { stopPropagation: () => void }) => void)({
    stopPropagation: () => (stopped += 1),
  })
  expect(stopped).toBe(1)
  expect(closed).toBe(0)
})

test('the header renders a tinted icon chip, title, subtitle and a labelled close button', () => {
  const html = renderToStaticMarkup(
    <SAModal
      icon={<svg />}
      tint="accent"
      title="Export session"
      subtitle="Refactor auth"
      onClose={() => {}}
    >
      <p>body</p>
    </SAModal>,
  )
  expect(html).toContain('aria-label="Export session"')
  expect(html).toContain('Refactor auth')
  expect(html).toContain('aria-label="Close dialog"')
  // Static tint class, never an interpolated arbitrary value (the v4 trap).
  expect(html).toContain('bg-accent/[0.11] text-accent')
  expect(html).toContain('animate-sa-pop')
})

test('the tint map is static per dialog hue', () => {
  const info = renderToStaticMarkup(
    <SAModal icon={null} tint="info" title="T" onClose={() => {}}>
      <p />
    </SAModal>,
  )
  const warn = renderToStaticMarkup(
    <SAModal icon={null} tint="warn" title="T" onClose={() => {}}>
      <p />
    </SAModal>,
  )
  expect(info).toContain('bg-tone-info/[0.11] text-tone-info')
  expect(warn).toContain('bg-tone-warn/[0.11] text-tone-warn')
})

test('the body scrolls without a visible scrollbar and the card is height-capped', () => {
  const html = renderToStaticMarkup(
    <SAModal icon={null} tint="info" title="T" onClose={() => {}}>
      <p>body</p>
    </SAModal>,
  )
  expect(html).toContain('max-h-[86vh]')
  expect(html).toContain('overflow-y-auto')
  expect(html).toContain('[scrollbar-width:none]')
})

test('the footer slot renders only when given, right-aligned', () => {
  const without = renderToStaticMarkup(
    <SAModal icon={null} tint="info" title="T" onClose={() => {}}>
      <p>body</p>
    </SAModal>,
  )
  expect(without).not.toContain('justify-end')

  const withFooter = renderToStaticMarkup(
    <SAModal
      icon={null}
      tint="info"
      title="T"
      onClose={() => {}}
      footer={<SAButton label="Cancel" />}
    >
      <p>body</p>
    </SAModal>,
  )
  expect(withFooter).toContain('justify-end')
  expect(withFooter).toContain('Cancel')
})

test('the two prototype widths are static classes', () => {
  const narrow = renderToStaticMarkup(
    <SAModal icon={null} tint="info" title="T" onClose={() => {}}>
      <p />
    </SAModal>,
  )
  const wide = renderToStaticMarkup(
    <SAModal icon={null} tint="accent" title="T" width="wide" onClose={() => {}}>
      <p />
    </SAModal>,
  )
  expect(narrow).toContain('w-[540px]')
  expect(wide).toContain('w-[580px]')
})

test('saBtn: primary / danger / secondary are distinct variants', () => {
  const primary = renderToStaticMarkup(<SAButton label="Create branch" variant="primary" />)
  const danger = renderToStaticMarkup(<SAButton label="Rewind" variant="danger-primary" />)
  const secondary = renderToStaticMarkup(<SAButton label="Cancel" />)
  expect(primary).toContain('bg-accent')
  expect(danger).toContain('bg-tone-danger')
  expect(secondary).toContain('bg-transparent')
})

test('saBtn: disabled renders the inert variant and explains itself on hover', () => {
  const html = renderToStaticMarkup(
    <SAButton label="Download" variant="primary" disabled reason="Not available yet." />,
  )
  expect(html).toContain('disabled=""')
  expect(html).toContain('title="Not available yet."')
  expect(html).toContain('text-text-ghost')
  // A disabled button must not also paint itself as the live primary.
  expect(html).not.toContain('bg-accent')
})

test('saBtn: an enabled button carries no leftover disabled tooltip', () => {
  const html = renderToStaticMarkup(<SAButton label="Copy" reason="ignored when enabled" />)
  expect(html).not.toContain('title=')
})
