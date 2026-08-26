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

/**
 * The dock wrapper: the centred column that hosts the composer and its
 * satellites.
 *
 * Found by walking BACK from the composer, not by taking the first match in the
 * file. The transcript's own column carries the same measure — that is the
 * point of `--transcript-width` — so the waiting-message block at the end of
 * the scroller (D1a) matches this shape too and appears first. Keying on
 * `min-h-0` would separate them, but that is one of the things this file
 * asserts, and a locator built from the assertion cannot fail.
 */
const DOCK = /<div className="(mx-auto [^"]*max-w-\[var\(--transcript-width\)\][^"]*)">/g

/** The scrolling panel region inside the dock. */
const PANELS = '<div className="min-h-0 overflow-y-auto">'

function findDock(): { at: number; classes: string } {
  const composerAt = SOURCE.indexOf('aria-label="Composer"')
  expect(composerAt).toBeGreaterThan(-1)
  let found: { at: number; classes: string } | null = null
  for (const match of SOURCE.matchAll(DOCK)) {
    if (match.index === undefined || match.index > composerAt) break
    found = { at: match.index, classes: match[1]! }
  }
  expect(found).not.toBeNull()
  // The walk is POSITIONAL, so a nested wrapper inside the dock that reused the
  // transcript-width column would silently rebind it to the wrong element and
  // every assertion below would pass vacuously. The dock is the element that
  // opens the scrolling panel region, so say so: a rebind fails loudly here
  // instead of quietly everywhere.
  const panelsAt = SOURCE.indexOf(PANELS, found!.at)
  const nextDock = SOURCE.slice(found!.at + 1).search(DOCK)
  expect(panelsAt).toBeGreaterThan(-1)
  if (nextDock !== -1) {
    expect(panelsAt).toBeLessThan(found!.at + 1 + nextDock)
  }
  return found!
}

test('the dock yields instead of clipping, and the composer never gives', () => {
  const dockClasses = findDock().classes

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
  const dockAt = findDock().at
  const panelsAt = SOURCE.indexOf(PANELS, dockAt)
  const activityAt = SOURCE.indexOf('<ActivityIndicator', dockAt)
  const composerAt = SOURCE.indexOf('aria-label="Composer"', dockAt)

  expect(panelsAt).toBeGreaterThan(dockAt)
  expect(activityAt).toBeGreaterThan(panelsAt)

  // The surfaces with no ceiling of their own, or a ceiling that a stack of
  // them defeats. A new one belongs in this list AND in the region.
  //
  // Waiting messages are NOT on this list any more: they are not docked at all.
  // The dock spends the transcript's height, so a block that exists only while
  // a turn runs was buying a permanent full-width band with the reader's pane;
  // it renders at the end of the scrolling transcript instead (App.tsx D1a,
  // pinned by `App.test.tsx`).
  let last = panelsAt
  for (const surface of ['<AskQuestionFlow', '<PermissionQueue']) {
    const at = SOURCE.indexOf(surface, dockAt)
    expect(at).toBeGreaterThan(panelsAt)
    expect(at).toBeLessThan(activityAt)
    last = Math.max(last, at)
  }

  // The region closes before the activity row: those last two are deliberately
  // outside it, being one fixed row each and the row that hugs the input.
  // Dock children sit at a six-space indent, so this is the region's own close.
  const closeAt = SOURCE.indexOf('\n      </div>\n', last)
  expect(closeAt).toBeGreaterThan(last)
  expect(closeAt).toBeLessThan(activityAt)
  expect(activityAt).toBeLessThan(composerAt)
})
