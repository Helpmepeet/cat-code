/**
 * Send-message motion helpers (`composerSendMotion.ts`), at the layer that can
 * actually be proven here: happy-dom has no layout engine, so geometry is
 * injected on the elements it reads (same technique `composerMotion.dom.test.ts`'s
 * "Latest settles" case uses for `scrollHeight`/`clientHeight`) rather than
 * relied on to be real. `composerMotion.dom.test.ts` covers the layer above —
 * whether `SessionPane` decides to call these at all.
 */

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import {
  afterNextScrollCorrection,
  captureComposerGhost,
  computeFlightTransform,
  finishTranscriptColumnSlide,
  playTranscriptColumnSlide,
  prefersReducedMotion,
} from './composerSendMotion.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })

function stubRect(el: HTMLElement, rect: { top: number; left: number; width: number }): void {
  el.getBoundingClientRect = () => ({
    top: rect.top, left: rect.left, width: rect.width, height: 24,
    bottom: rect.top + 24, right: rect.left + rect.width, x: rect.left, y: rect.top,
    toJSON: () => ({}),
  })
}

test('captureComposerGhost is null for an empty field and positions relative to the wrap otherwise', () => {
  const wrap = harness.document.createElement('div')
  const field = harness.document.createElement('div')
  wrap.append(field)
  harness.document.body.append(wrap)
  stubRect(wrap, { top: 100, left: 10, width: 300 })
  stubRect(field, { top: 130, left: 10, width: 280 })

  expect(captureComposerGhost(field, wrap)).toBeNull()
  field.textContent = '   '
  expect(captureComposerGhost(field, wrap)).toBeNull()

  field.innerHTML = 'hello <b>world</b>'
  const ghost = captureComposerGhost(field, wrap)
  expect(ghost).not.toBeNull()
  expect(ghost?.html).toBe('hello <b>world</b>')
  // The field's rect is captured relative to the wrap, BEFORE any clear — the
  // trap the spec calls out: an emptied field is shorter and bottom-aligned,
  // so reading this after the clear would give the wrong height.
  expect(ghost?.topPx).toBe(30)
  expect(ghost?.widthPx).toBe(280)

  wrap.remove()
})

test('captureComposerGhost is null with no field or wrap resolved', () => {
  const wrap = harness.document.createElement('div')
  const field = harness.document.createElement('div')
  field.textContent = 'hi'
  expect(captureComposerGhost(null, wrap)).toBeNull()
  expect(captureComposerGhost(field, null)).toBeNull()
})

test('computeFlightTransform keeps the draft words aligned into the bubble at 15/14 scale', () => {
  const transform = computeFlightTransform(
    { top: 500, left: 20 },
    { top: 100, left: 40 },
  )
  const k = 15 / 14
  expect(transform.scale).toBeCloseTo(k, 10)
  expect(transform.originXPx).toBeCloseTo(20 - k * 17 - 40, 10)
  expect(transform.originYPx).toBeCloseTo(500 + 6 - k * 11 - 100, 10)
})

test('prefersReducedMotion reads the live matchMedia query and tolerates its absence', () => {
  const originalMatchMedia = globalThis.matchMedia
  globalThis.matchMedia = (((query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)',
  })) as unknown) as typeof globalThis.matchMedia
  expect(prefersReducedMotion()).toBe(true)
  globalThis.matchMedia = ((() => ({ matches: false })) as unknown) as typeof globalThis.matchMedia
  expect(prefersReducedMotion()).toBe(false)
  // @ts-expect-error -- exercising the no-matchMedia branch deliberately.
  globalThis.matchMedia = undefined
  expect(prefersReducedMotion()).toBe(false)
  globalThis.matchMedia = originalMatchMedia
})

test('the transcript column slide jumps to the delta then transitions back to 0, cleaning up on transitionend', async () => {
  const column = harness.document.createElement('div')
  harness.document.body.append(column)
  playTranscriptColumnSlide(column, 40)
  expect(column.style.getPropertyValue('--transcript-col-offset')).toBe('0px')
  expect(column.classList.contains('is-sliding')).toBe(true)
  column.dispatchEvent(new Event('transitionend'))
  expect(column.classList.contains('is-sliding')).toBe(false)
  expect(column.style.getPropertyValue('--transcript-col-offset')).toBe('')
  column.remove()
})

test('the column slide also settles from its own fallback timeout, without a transitionend', async () => {
  const column = harness.document.createElement('div')
  harness.document.body.append(column)
  playTranscriptColumnSlide(column, 40)
  expect(column.classList.contains('is-sliding')).toBe(true)
  await new Promise(resolve => setTimeout(resolve, 280))
  expect(column.classList.contains('is-sliding')).toBe(false)
  column.remove()
})

test('an earlier slide timeout cannot end a newer slide', async () => {
  const column = harness.document.createElement('div')
  harness.document.body.append(column)
  playTranscriptColumnSlide(column, 40)
  await new Promise(resolve => setTimeout(resolve, 120))
  playTranscriptColumnSlide(column, 30)
  await new Promise(resolve => setTimeout(resolve, 160))
  expect(column.classList.contains('is-sliding')).toBe(true)
  column.dispatchEvent(new Event('transitionend'))
  expect(column.classList.contains('is-sliding')).toBe(false)
  column.remove()
})

test('finishTranscriptColumnSlide is idempotent and safe on a column never slid', () => {
  const column = harness.document.createElement('div')
  finishTranscriptColumnSlide(column)
  expect(column.classList.contains('is-sliding')).toBe(false)
})

test('afterNextScrollCorrection fires once, after the pane frame flushes, and can be cancelled', async () => {
  const scroller = harness.document.createElement('div')
  harness.document.body.append(scroller)
  let calls = 0
  afterNextScrollCorrection(scroller, () => { calls++ })
  // The shared pane coordinator schedules its frame from a resize/mutation
  // observer; a plain DOM mutation on the registered scroller is enough to
  // trigger one without mounting React at all.
  scroller.append(harness.document.createElement('span'))
  await harness.nextFrame()
  await harness.nextFrame()
  expect(calls).toBe(1)
  scroller.append(harness.document.createElement('span'))
  await harness.nextFrame()
  await harness.nextFrame()
  expect(calls).toBe(1)
  scroller.remove()
})
