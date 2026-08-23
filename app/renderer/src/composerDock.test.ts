import { readFileSync } from 'node:fs'
import { expect, test } from 'bun:test'

/**
 * The composer dock's height contract, guarded at the source.
 *
 * What it is guarding: `<main>` is `overflow-hidden` and the transcript is its
 * only `flex-1` child, so the transcript collapses to zero before anything else
 * gives. A dock that cannot shrink past that point does not overflow into a
 * scrollbar, it is CLIPPED, and the composer is its last child, so the composer
 * is what disappears. Measured at the 495px window floor with a question card
 * and two permission cards docked: 839px of dock in 455px of pane, the composer
 * 400px below the viewport, nothing scrollable anywhere on the page.
 *
 * Why this is a source test and not a layout test: this package's DOM harness
 * is happy-dom, which has no layout engine. `getBoundingClientRect` returns
 * zeroes there, so no test in this suite can observe a clipped element. The
 * geometry was proved instead against the real built stylesheet in a browser at
 * a 495px viewport; what a test CAN hold is the structure that geometry depends
 * on, which is what this file does.
 */
const SOURCE = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

/** The dock wrapper: the centred column that hosts the composer and its satellites. */
const DOCK = /<div className="(mx-auto [^"]*max-w-\[var\(--transcript-width\)\][^"]*)">/

/** The scrolling panel region inside the dock. */
const PANELS = '<div className="min-h-0 overflow-y-auto">'

test('the dock yields instead of clipping, and the composer never gives', () => {
  const dock = SOURCE.match(DOCK)
  expect(dock).not.toBeNull()
  const dockClasses = dock![1]!

  // `shrink-0` here is the bug: it makes the dock the one thing in an
  // overflow-hidden column that cannot yield.
  expect(dockClasses).not.toContain('shrink-0')
  // And `min-h-0` is what lets it yield past its own min-content height. A
  // scrolling child does NOT reduce that automatic minimum on its own: without
  // this the dock freezes at min-content and clips again.
  expect(dockClasses).toContain('min-h-0')

  // The squeeze has to land somewhere. The composer is the one child excluded
  // from absorbing it.
  const composerForm = SOURCE.slice(SOURCE.indexOf('aria-label="Composer"'))
  const composerClasses = composerForm.match(/className="([^"]*)"/)?.[1] ?? ''
  expect(composerClasses).toContain('shrink-0')
})

test('every docked surface that can grow without limit sits inside the scroller', () => {
  const dockAt = SOURCE.search(DOCK)
  const panelsAt = SOURCE.indexOf(PANELS, dockAt)
  const activityAt = SOURCE.indexOf('<ActivityIndicator', dockAt)
  const composerAt = SOURCE.indexOf('aria-label="Composer"', dockAt)

  expect(panelsAt).toBeGreaterThan(dockAt)
  expect(activityAt).toBeGreaterThan(panelsAt)

  // The surfaces with no ceiling of their own, or a ceiling that a stack of
  // them defeats. A new one belongs in this list AND in the region.
  for (const surface of [
    '<AskQuestionFlow',
    '<PermissionQueue',
    'queuedPrompts.map',
  ]) {
    const at = SOURCE.indexOf(surface, dockAt)
    expect(at).toBeGreaterThan(panelsAt)
    expect(at).toBeLessThan(activityAt)
  }

  // The region closes before the activity row: those last two are deliberately
  // outside it, being one fixed row each and the row that hugs the input.
  // Dock children sit at a six-space indent, so this is the region's own close.
  const tail = SOURCE.slice(SOURCE.lastIndexOf('queuedPrompts.map'), activityAt)
  expect(tail).toContain('\n      </div>\n')
  expect(activityAt).toBeLessThan(composerAt)
})
