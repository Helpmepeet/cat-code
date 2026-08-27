/**
 * The runtime half of the appearance preference, which an SSR suite structurally
 * cannot see: `renderToStaticMarkup` runs no effects, so a provider that never
 * stamps the document and never tells main is indistinguishable from a working
 * one (the same blind spot `GlassModeProvider.dom.test.ts` was written for).
 *
 * This file mounts the real provider against a real document, drives the real
 * media-query subscription, and asserts three things a source read cannot: the
 * stamp lands on the document element, the OS is followed LIVE rather than read
 * once, and main hears the resolved appearance rather than the raw choice.
 *
 * No JSX and no component export: `renderer/src` `.tsx` files are governed by the
 * Fast Refresh component-boundary rule, which a test module has no business
 * tripping. `createElement` keeps this file `.ts`.
 */

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { act, createElement, useContext } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { ColorSchemeProvider } from './ColorSchemeProvider.js'
import {
  APPEARANCE_ATTRIBUTE,
  COLOR_SCHEME_STORAGE_KEY,
  ColorSchemeContext,
  type ColorSchemeKey,
  type ResolvedAppearance,
} from './colorScheme.js'

let harness: DomTestHarness

beforeAll(async () => {
  harness = await createDomTestHarness()
})

afterEach(async () => {
  await harness.unmountAll()
  harness.document.documentElement.removeAttribute(APPEARANCE_ATTRIBUTE)
})

afterAll(async () => {
  await harness.teardown()
})

function storage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  }
}

/** A real subscription, not a stub: `emit` is what an OS light/dark flip looks
 * like to the provider. */
function fakeMedia(matches: boolean) {
  const listeners = new Set<() => void>()
  return {
    query: {
      get matches() {
        return matches
      },
      addEventListener: (_type: 'change', listener: () => void) => {
        listeners.add(listener)
      },
      removeEventListener: (_type: 'change', listener: () => void) => {
        listeners.delete(listener)
      },
    },
    listenerCount: () => listeners.size,
    async emit(next: boolean) {
      matches = next
      await act(async () => {
        for (const listener of listeners) listener()
      })
    },
  }
}

function stored(scheme: ColorSchemeKey) {
  return { [COLOR_SCHEME_STORAGE_KEY]: JSON.stringify({ version: 1, scheme }) }
}

function Probe({ onReady }: { onReady: (set: (next: ColorSchemeKey) => void) => void }) {
  const { setScheme } = useContext(ColorSchemeContext)
  onReady(setScheme)
  return null
}

function stamp(): string | null {
  return harness.document.documentElement.getAttribute(APPEARANCE_ATTRIBUTE)
}

async function mount(options: {
  scheme?: ColorSchemeKey
  systemDark: boolean
  onAppearance?: (appearance: ResolvedAppearance) => void
  children?: ReturnType<typeof createElement>
}) {
  const store = storage(options.scheme ? stored(options.scheme) : {})
  const media = fakeMedia(options.systemDark)
  await harness.mount(
    createElement(ColorSchemeProvider, {
      storage: store,
      media: media.query,
      onAppearance: options.onAppearance ?? (() => {}),
      children: options.children ?? createElement('div'),
    }),
  )
  return { store, media }
}

test('with no stored choice the real document follows the system', async () => {
  await mount({ systemDark: false })
  expect(stamp()).toBe('light')
})

test('a stored choice overrides the system on the real document', async () => {
  await mount({ scheme: 'light', systemDark: true })
  expect(stamp()).toBe('light')
})

/**
 * The subscription is the difference between "follows the system" and "read the
 * system once at launch". Deleting the `matchMedia` effect leaves the first
 * assertion above green.
 */
test('the system choice repaints when the operating system flips', async () => {
  const { media } = await mount({ scheme: 'system', systemDark: true })
  expect(stamp()).toBe('dark')
  await media.emit(false)
  expect(stamp()).toBe('light')
  await media.emit(true)
  expect(stamp()).toBe('dark')
})

test('a forced choice ignores the operating system flipping under it', async () => {
  const { media } = await mount({ scheme: 'light', systemDark: true })
  expect(stamp()).toBe('light')
  await media.emit(false)
  expect(stamp()).toBe('light')
})

test('the subscription is released on unmount', async () => {
  const { media } = await mount({ systemDark: true })
  expect(media.listenerCount()).toBe(1)
  await harness.unmountAll()
  expect(media.listenerCount()).toBe(0)
})

/**
 * Main is told the RESOLVED appearance, never the raw choice: `themeSource`
 * takes `'system'` too, and sending it would hand the vibrancy material back to
 * the OS while the page kept painting the forced one.
 */
test('main hears the resolved appearance, and only when it changes', async () => {
  const seen: ResolvedAppearance[] = []
  const { media } = await mount({
    scheme: 'system',
    systemDark: true,
    onAppearance: appearance => void seen.push(appearance),
  })
  expect(seen).toEqual(['dark'])
  await media.emit(false)
  expect(seen).toEqual(['dark', 'light'])
  // A flip that resolves to the same appearance must not re-cross the boundary.
  await media.emit(false)
  expect(seen).toEqual(['dark', 'light'])
})

test('choosing from Settings stamps the document, persists, and notifies main', async () => {
  const seen: ResolvedAppearance[] = []
  let setScheme: ((next: ColorSchemeKey) => void) | null = null
  const { store } = await mount({
    scheme: 'system',
    systemDark: true,
    onAppearance: appearance => void seen.push(appearance),
    children: createElement(Probe, {
      onReady: (next: (value: ColorSchemeKey) => void) => {
        setScheme = next
      },
    }),
  })
  expect(setScheme).not.toBeNull()

  await act(async () => {
    setScheme?.('light')
  })
  expect(stamp()).toBe('light')
  expect(store.store.get(COLOR_SCHEME_STORAGE_KEY)).toBe(
    JSON.stringify({ version: 1, scheme: 'light' }),
  )
  expect(seen).toEqual(['dark', 'light'])
})

/**
 * A bridge that throws must not raise into React. Telling main is best-effort by
 * design: it only selects a native material, and the preload's own rate guard
 * can legitimately reject a send.
 */
test('a failing notify never breaks the paint', async () => {
  await mount({
    scheme: 'light',
    systemDark: true,
    onAppearance: () => {
      throw new Error('rate limited')
    },
  }).catch(() => {
    throw new Error('the provider let a notify failure escape')
  })
  expect(stamp()).toBe('light')
})

/**
 * The composition root is the one part of the wiring no runtime assertion here
 * can reach, because this file mounts the provider itself. Weak evidence, and
 * the only evidence available: without it, removing the provider from `main.tsx`
 * leaves every test in the repo green.
 *
 * The ORDER is asserted too, not just the presence. Glass reads its alphas out
 * of `light-dark()`, so an appearance applied after glass would paint the dark
 * glass ground onto a light window for the first frame after every reload.
 */
test('the composition root mounts the provider, above glass', () => {
  const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8').replace(
    /^\s*\/\/.*$/gm,
    '',
  )
  expect(main).toContain("from './ColorSchemeProvider.js'")
  expect(main.indexOf('<ColorSchemeProvider>')).toBeGreaterThanOrEqual(0)
  expect(main.indexOf('<ColorSchemeProvider>')).toBeLessThan(
    main.indexOf('<GlassModeProvider>'),
  )
})
