/**
 * The runtime half of the appearance preference, which an SSR suite structurally
 * cannot see: `renderToStaticMarkup` runs no effects, so a provider that never
 * stamps the document and never tells main is indistinguishable from a working
 * one (the same blind spot `GlassModeProvider.dom.test.ts` was written for).
 *
 * This file mounts the real provider against a real document, drives the real
 * media-query subscription, and asserts three things a source read cannot: the
 * stamp lands on the document element, the OS is followed LIVE rather than read
 * once, and main hears the user's CHOICE rather than the resolved appearance.
 *
 * ONE THING IT STRUCTURALLY CANNOT SEE, and the first version of this feature
 * shipped broken because of it: `media` is injected, so the real `matchMedia` is
 * never exercised, and the real one is the one `nativeTheme.themeSource` pins.
 * A provider that forces the OS query and then subscribes to it looks perfect
 * here. That gap is why the notify assertions below test the value crossing the
 * boundary rather than the repaint it causes.
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
  onScheme?: (scheme: ColorSchemeKey) => void
  children?: ReturnType<typeof createElement>
}) {
  const store = storage(options.scheme ? stored(options.scheme) : {})
  const media = fakeMedia(options.systemDark)
  await harness.mount(
    createElement(ColorSchemeProvider, {
      storage: store,
      media: media.query,
      onScheme: options.onScheme ?? (() => {}),
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
 * THE REGRESSION GUARD FOR THIS FILE'S OWN BLIND SPOT.
 *
 * Main is told the user's CHOICE, never the resolved appearance. The first
 * version sent the resolved value, and `themeSource` is an override: it pins the
 * real `prefers-color-scheme`, so forcing `dark` the moment someone picks "Match
 * system" freezes the query this provider subscribes to and the OS can never
 * move the window again.
 *
 * Nothing above catches that, and this test cannot catch it either — `fakeMedia`
 * is a stub, so it keeps emitting whatever the test says regardless of what main
 * did. That is exactly why the assertion is on the VALUE CROSSING THE BOUNDARY
 * rather than on a repaint: `'system'` reaching main is the whole mechanism, and
 * it is the one thing observable from here.
 */
test('main hears the choice, not the appearance, and only when the choice changes', async () => {
  const seen: ColorSchemeKey[] = []
  const { media } = await mount({
    scheme: 'system',
    systemDark: true,
    onScheme: scheme => void seen.push(scheme),
  })
  // 'system', NOT 'dark' — sending 'dark' here is the bug.
  expect(seen).toEqual(['system'])

  // An OS flip repaints the document but must not re-cross the boundary: the
  // choice did not change, and re-sending would be a no-op at best.
  await media.emit(false)
  expect(stamp()).toBe('light')
  expect(seen).toEqual(['system'])
})

test('a forced choice crosses the boundary as itself', async () => {
  const seen: ColorSchemeKey[] = []
  let setScheme: ((next: ColorSchemeKey) => void) | null = null
  await mount({
    scheme: 'system',
    systemDark: true,
    onScheme: scheme => void seen.push(scheme),
    children: createElement(Probe, {
      onReady: (next: (value: ColorSchemeKey) => void) => {
        setScheme = next
      },
    }),
  })
  await act(async () => {
    setScheme?.('light')
  })
  await act(async () => {
    setScheme?.('system')
  })
  expect(seen).toEqual(['system', 'light', 'system'])
})

/**
 * THE DEFAULT NOTIFY PATH, which every other test in this file injects past.
 *
 * `onScheme` is injectable so the notify assertions above can observe it, and
 * that convenience hid the one line that actually crosses into the preload:
 * deleting `getBridge().setAppearance(...)` from `notifyMain` left the entire
 * suite green. Here the prop is OMITTED, so the provider takes its real default
 * and calls the real bridge accessor against a stub `window.catcode` — the same
 * shape `contextBridge` exposes.
 */
test('with no injected notifier it calls the real bridge', async () => {
  const calls: unknown[] = []
  const globals = globalThis as { catcode?: unknown }
  const previous = globals.catcode
  globals.catcode = { setAppearance: (value: unknown) => void calls.push(value) }
  try {
    await harness.mount(
      createElement(ColorSchemeProvider, {
        storage: storage(stored('light')),
        media: fakeMedia(true).query,
        children: createElement('div'),
      }),
    )
    expect(calls).toEqual(['light'])
  } finally {
    if (previous === undefined) delete globals.catcode
    else globals.catcode = previous
  }
})

/**
 * And the same path when the bridge is not there at all. The preload injects
 * `window.catcode` before any page script runs, so this is the defensive edge
 * rather than the expected one; it matters because the guard around `notify`
 * lives at the call site and a throw here would take the whole tree down.
 */
test('a missing bridge never breaks the paint', async () => {
  const globals = globalThis as { catcode?: unknown }
  const previous = globals.catcode
  delete globals.catcode
  try {
    await harness.mount(
      createElement(ColorSchemeProvider, {
        storage: storage(stored('dark')),
        media: fakeMedia(false).query,
        children: createElement('div'),
      }),
    )
    expect(stamp()).toBe('dark')
  } finally {
    if (previous !== undefined) globals.catcode = previous
  }
})

test('choosing from Settings stamps the document, persists, and notifies main', async () => {
  const seen: ColorSchemeKey[] = []
  let setScheme: ((next: ColorSchemeKey) => void) | null = null
  const { store } = await mount({
    scheme: 'system',
    systemDark: true,
    onScheme: scheme => void seen.push(scheme),
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
  expect(seen).toEqual(['system', 'light'])
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
    onScheme: () => {
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
 * NESTING ORDER IS DELIBERATELY NOT ASSERTED. An earlier version pinned this
 * provider above `GlassModeProvider` and claimed the order kept the dark glass
 * ground off a light window. It never did: the appearance stamp was a passive
 * effect then, and passive effects run after paint, so glass won regardless of
 * nesting. Both stamps are layout effects now, and every layout effect runs
 * before paint, so the guarantee is the PHASE. Pinning the order here would
 * re-assert a mechanism that does not exist.
 */
test('the composition root mounts the provider', () => {
  const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8').replace(
    /^\s*\/\/.*$/gm,
    '',
  )
  expect(main).toContain("from './ColorSchemeProvider.js'")
  expect(main).toContain('<ColorSchemeProvider>')
})

/**
 * The phase itself, asserted where it is actually decided. `applyAppearance` in
 * a passive effect means one fully dark frame on every launch and every renderer
 * reload before the flip; `GlassModeProvider` records the same lesson and the
 * same swap. happy-dom does not paint, so no runtime assertion here can observe
 * the flash: the source check is what is available.
 */
test('the appearance is stamped before paint, like glass', () => {
  const source = readFileSync(
    new URL('./ColorSchemeProvider.tsx', import.meta.url),
    'utf8',
  )
  expect(source).toContain(
    "typeof document === 'undefined' ? useEffect : useLayoutEffect",
  )
  const stampIndex = source.indexOf('applyAppearance(target, appearance)')
  expect(stampIndex).toBeGreaterThan(source.indexOf('useStampEffect(() => {'))
})
