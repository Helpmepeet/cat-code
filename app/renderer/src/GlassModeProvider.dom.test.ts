/**
 * The runtime half of glass mode, which the SSR suites structurally cannot see.
 *
 * `GlassModeProvider.test.tsx` renders through `renderToStaticMarkup`, so no
 * effect ever runs and the provider is free to never stamp anything: mutation
 * testing (2026-08-27) confirmed that deleting the `applyGlassMode` call, the
 * `writeGlassToStorage` call, or the provider's mount in `main.tsx` all left the
 * suites at full green. A build where the toggle does nothing was
 * indistinguishable from a working one.
 *
 * So this file mounts the real provider against a real document and asserts the
 * document element it defaults to, rather than an injected fake. `root` is
 * deliberately NOT injected here; that default IS the thing under test.
 *
 * No JSX and no component export: `renderer/src` `.tsx` files are governed by
 * the Fast Refresh component-boundary rule, which a test module has no business
 * tripping. `createElement` keeps this file `.ts`, the way
 * `paneStructure.dom.test.ts` does.
 */

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { createElement, useContext } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { GlassModeProvider } from './GlassModeProvider.js'
import {
  GLASS_ATTRIBUTE,
  GLASS_ATTRIBUTE_ON,
  GLASS_STORAGE_KEY,
  GlassModeContext,
} from './glassMode.js'

let harness: DomTestHarness

beforeAll(async () => {
  harness = await createDomTestHarness()
})

afterEach(async () => {
  await harness.unmountAll()
  harness.document.documentElement.removeAttribute(GLASS_ATTRIBUTE)
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

/** Captures the published setter so a test can flip the preference the way the
 * Settings row does. */
function Probe({ onReady }: { onReady: (setGlass: (next: boolean) => void) => void }) {
  const { setGlass } = useContext(GlassModeContext)
  onReady(setGlass)
  return null
}

test('a stored preference reaches the real document element on mount', async () => {
  const store = storage({
    [GLASS_STORAGE_KEY]: JSON.stringify({ version: 1, enabled: true }),
  })
  await harness.mount(
    createElement(GlassModeProvider, {
      storage: store,
      children: createElement('div'),
    }),
  )
  expect(harness.document.documentElement.getAttribute(GLASS_ATTRIBUTE)).toBe(
    GLASS_ATTRIBUTE_ON,
  )
})

test('no stored preference leaves the document unstamped', async () => {
  await harness.mount(
    createElement(GlassModeProvider, {
      storage: storage(),
      children: createElement('div'),
    }),
  )
  expect(harness.document.documentElement.hasAttribute(GLASS_ATTRIBUTE)).toBe(false)
})

test('flipping the preference stamps the document and persists it', async () => {
  const store = storage()
  let setGlass: ((next: boolean) => void) | null = null
  await harness.mount(
    createElement(GlassModeProvider, {
      storage: store,
      children: createElement(Probe, {
        onReady: (next: (value: boolean) => void) => {
          setGlass = next
        },
      }),
    }),
  )
  expect(setGlass).not.toBeNull()

  await harness.mount(createElement('div'))
  const { act } = await import('react')
  await act(async () => {
    setGlass?.(true)
  })
  expect(harness.document.documentElement.getAttribute(GLASS_ATTRIBUTE)).toBe(
    GLASS_ATTRIBUTE_ON,
  )
  expect(store.store.get(GLASS_STORAGE_KEY)).toBe(
    JSON.stringify({ version: 1, enabled: true }),
  )

  await act(async () => {
    setGlass?.(false)
  })
  expect(harness.document.documentElement.hasAttribute(GLASS_ATTRIBUTE)).toBe(false)
  expect(store.store.get(GLASS_STORAGE_KEY)).toBe(
    JSON.stringify({ version: 1, enabled: false }),
  )
})

/**
 * The composition root is the one part of the wiring no runtime assertion here
 * can reach, because this file mounts the provider itself. A source check is
 * weak evidence and is the only evidence available: without it, removing the
 * provider from `main.tsx` leaves every test in the repo green.
 */
test('the composition root actually mounts the provider', () => {
  const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8').replace(
    /^\s*\/\/.*$/gm,
    '',
  )
  expect(main).toContain('<GlassModeProvider>')
  expect(main).toContain("from './GlassModeProvider.js'")
})
