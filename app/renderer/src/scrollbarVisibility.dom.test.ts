/**
 * Drives the real document listeners. Happy DOM performs no layout, so each
 * scroller's box metrics are injected; this proves the reveal/hide decisions,
 * not Chromium's painting of the thumb.
 */

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { installScrollbarVisibility, SCROLLBAR_VISIBLE_ATTRIBUTE } from './scrollbarVisibility.js'

const HIDE_DELAY_MS = 20

let harness: DomTestHarness
let uninstall: (() => void) | null = null
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(() => {
  uninstall?.()
  uninstall = null
  harness.document.body.replaceChildren()
})
afterAll(async () => { await harness.teardown() })

/** A 200x100 scroller with a 12px vertical bar and taller content. */
function scroller(): HTMLElement {
  const el = document.createElement('div')
  const metrics: Record<string, number> = {
    clientWidth: 188, clientHeight: 100, clientLeft: 0, clientTop: 0, scrollWidth: 188, scrollHeight: 400,
  }
  for (const [key, value] of Object.entries(metrics)) {
    Object.defineProperty(el, key, { configurable: true, get: () => value })
  }
  el.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100, x: 0, y: 0, toJSON: () => ({}),
  })
  const child = document.createElement('p')
  el.append(child)
  document.body.append(el)
  return el
}

const visible = (el: Element) => el.hasAttribute(SCROLLBAR_VISIBLE_ATTRIBUTE)
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const move = (target: Element, clientX: number, clientY = 50) =>
  target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX, clientY }))

test('scrolling reveals the bar and it hides once scrolling has been idle', async () => {
  uninstall = installScrollbarVisibility(document, HIDE_DELAY_MS)
  const el = scroller()
  expect(visible(el)).toBe(false)

  el.dispatchEvent(new Event('scroll'))
  expect(visible(el)).toBe(true)
  await wait(HIDE_DELAY_MS / 2)
  el.dispatchEvent(new Event('scroll'))
  await wait(HIDE_DELAY_MS / 2 + 5)
  expect(visible(el)).toBe(true)

  await wait(HIDE_DELAY_MS)
  expect(visible(el)).toBe(false)
})

test('the pointer over the bar keeps it shown; over the content it does not', async () => {
  uninstall = installScrollbarVisibility(document, HIDE_DELAY_MS)
  const el = scroller()

  move(el.firstElementChild!, 50)
  expect(visible(el)).toBe(false)
  move(el, 50)
  expect(visible(el)).toBe(false)

  move(el, 194)
  expect(visible(el)).toBe(true)
  el.dispatchEvent(new Event('scroll'))
  await wait(HIDE_DELAY_MS * 2)
  expect(visible(el)).toBe(true)

  move(el, 50)
  expect(visible(el)).toBe(true)
  await wait(HIDE_DELAY_MS * 2)
  expect(visible(el)).toBe(false)
})

test('a scroller without overflow never reveals a bar', () => {
  uninstall = installScrollbarVisibility(document, HIDE_DELAY_MS)
  const el = scroller()
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 100 })
  move(el, 194)
  expect(visible(el)).toBe(false)
})

test('leaving the window releases a hovered bar', async () => {
  uninstall = installScrollbarVisibility(document, HIDE_DELAY_MS)
  const el = scroller()
  move(el, 194)
  el.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: null }))
  await wait(HIDE_DELAY_MS * 2)
  expect(visible(el)).toBe(false)
})

test('uninstalling stops listening and clears every mark', () => {
  uninstall = installScrollbarVisibility(document, HIDE_DELAY_MS)
  const el = scroller()
  el.dispatchEvent(new Event('scroll'))
  uninstall()
  uninstall = null
  expect(visible(el)).toBe(false)
  el.dispatchEvent(new Event('scroll'))
  expect(visible(el)).toBe(false)
})
