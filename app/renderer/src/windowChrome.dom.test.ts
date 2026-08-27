/**
 * The runtime half of the traffic-light well, which the SSR suite structurally
 * cannot see: `renderToStaticMarkup` runs no effects, so a well that reads the
 * fullscreen query ONCE at mount and never subscribes is indistinguishable there
 * from one that follows the window. Entering fullscreen with the app already
 * open is the case that matters, and it is exactly the case a subscription-less
 * version gets wrong.
 *
 * ONE THING IT STRUCTURALLY CANNOT SEE: `media` is injected, so the real
 * `matchMedia('(display-mode: fullscreen)')` is never exercised — and whether
 * Electron reports a fullscreened BrowserWindow through `display-mode` at all is
 * the question the live window answers, not this file. A hook that subscribes
 * perfectly to a query Chromium never matches looks green here.
 *
 * No JSX and no component export: `renderer/src` `.tsx` files are governed by the
 * Fast Refresh component-boundary rule, which a test module has no business
 * tripping. `createElement` keeps this file `.ts`.
 */

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { useTrafficLightWell, type FullscreenMediaQuery } from './windowChrome.js'

let harness: DomTestHarness

beforeAll(async () => {
  harness = await createDomTestHarness()
})

afterEach(async () => {
  await harness.unmountAll()
})

afterAll(async () => {
  await harness.teardown()
})

/** A real subscription, not a stub: `emit` is what entering or leaving
 * fullscreen looks like to the hook. */
function fakeMedia(initial: boolean) {
  const listeners = new Set<() => void>()
  let matches = initial
  const query: FullscreenMediaQuery = {
    get matches() {
      return matches
    },
    addEventListener: (_type: 'change', listener: () => void) => {
      listeners.add(listener)
    },
    removeEventListener: (_type: 'change', listener: () => void) => {
      listeners.delete(listener)
    },
  }
  return {
    query,
    listenerCount: () => listeners.size,
    emit: (next: boolean) => {
      matches = next
      for (const listener of listeners) listener()
    },
  }
}

function probe(media: FullscreenMediaQuery | null) {
  return createElement(function Probe() {
    return createElement(
      'span',
      { 'data-well': useTrafficLightWell(media) ? 'reserved' : 'collapsed' },
    )
  })
}

function wellState(container: HTMLElement): string | null {
  return container.querySelector('span')?.getAttribute('data-well') ?? null
}

test('the well collapses when the window enters fullscreen, and comes back', async () => {
  const media = fakeMedia(false)
  const tree = await harness.mount(probe(media.query))

  expect(wellState(tree.container)).toBe('reserved')

  await act(async () => {
    media.emit(true)
  })
  expect(wellState(tree.container)).toBe('collapsed')

  await act(async () => {
    media.emit(false)
  })
  expect(wellState(tree.container)).toBe('reserved')
})

test('a window already fullscreen at mount never paints the well', async () => {
  // The reload / OOM-restart case: there is no `change` event coming, so a hook
  // that only subscribes would hold 84px open for the rest of the session.
  const tree = await harness.mount(probe(fakeMedia(true).query))
  expect(wellState(tree.container)).toBe('collapsed')
})

test('with no usable query the well stays reserved, and the subscription is dropped on unmount', async () => {
  // Fails closed: the gap we already have, never a well collapsed under the
  // lights.
  const noQuery = await harness.mount(probe(null))
  expect(wellState(noQuery.container)).toBe('reserved')

  const media = fakeMedia(false)
  const tree = await harness.mount(probe(media.query))
  expect(media.listenerCount()).toBe(1)
  await tree.unmount()
  expect(media.listenerCount()).toBe(0)
})
