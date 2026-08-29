/**
 * The rail's width invariant AT MOUNT, which the SSR suite cannot see.
 *
 * `sidebarWidth.ts` promises that a persisted width is held inside the
 * window-relative ceiling, and the only place that promise can be observed is
 * the custom property the width effect writes onto the <aside>. That effect
 * never runs under `renderToStaticMarkup`, so a real DOM is the only witness.
 *
 * No JSX and no component export, so this file stays `.ts` and out of the Fast
 * Refresh component-boundary rule (`paneStructure.dom.test.ts` idiom).
 *
 * What this cannot prove: happy-dom has no layout engine, so nothing here says
 * the rail actually PAINTS at the asserted width. It says the width the rail
 * publishes obeys the ceiling.
 */

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { createElement } from 'react'
import { createDomTestHarness } from './domTestHarness.js'
import type { DomTestHarness } from './domTestHarness.js'
import { Sidebar } from './Sidebar.js'
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
} from './sidebarWidth.js'

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

/** A read-only stand-in holding one persisted width and nothing else. */
function storageWithWidth(width: number): Pick<Storage, 'getItem' | 'setItem'> {
  return {
    getItem: (key: string) =>
      key === SIDEBAR_WIDTH_STORAGE_KEY
        ? JSON.stringify({ version: 1, width })
        : null,
    setItem: () => {},
  }
}

function sidebarWithStorage(storage: Pick<Storage, 'getItem' | 'setItem'>) {
  return createElement(Sidebar, {
    rows: [],
    activeSessionId: null,
    activeView: 'chat',
    onSelectView: () => {},
    onSelectLive: () => {},
    onRestore: () => {},
    onOpenHistory: () => {},
    storage,
  })
}

/** The <aside>'s published expanded width, in px, or null when unset. */
function publishedWidth(container: HTMLElement): number | null {
  const aside = container.querySelector('aside')
  if (!aside) return null
  const raw = aside.style.getPropertyValue('--sidebar-expanded-width')
  return raw ? Number.parseInt(raw, 10) : null
}

function setWindowWidth(width: number): void {
  ;(globalThis.window as unknown as {
    happyDOM: { setViewport: (size: { width: number }) => void }
  }).happyDOM.setViewport({ width })
}

test('a persisted width over the window-relative ceiling is clamped at mount', async () => {
  // 1100 is the window `createWindow` opens at (`app/main/main.ts`), where a
  // third of the frame is 367 — below the fixed 420 the storage read allows.
  setWindowWidth(1100)
  const tree = await harness.mount(sidebarWithStorage(storageWithWidth(SIDEBAR_MAX_WIDTH)))
  expect(publishedWidth(tree.container)).toBe(367)
})

test('a persisted width the window can afford is restored untouched', async () => {
  setWindowWidth(1440)
  const tree = await harness.mount(sidebarWithStorage(storageWithWidth(SIDEBAR_MAX_WIDTH)))
  expect(publishedWidth(tree.container)).toBe(SIDEBAR_MAX_WIDTH)
})
