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
import { act, createElement } from 'react'
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

function sidebar(over: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  return createElement(Sidebar, {
    rows: [],
    activeSessionId: null,
    activeView: 'chat',
    onSelectView: () => {},
    onSelectLive: () => {},
    onRestore: () => {},
    onOpenHistory: () => {},
    storage: null,
    ...over,
  })
}

function sidebarWithStorage(storage: Pick<Storage, 'getItem' | 'setItem'>) {
  return sidebar({ storage })
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

test('a hover-expanded destination remains direct and dismisses the overlay after selection', async () => {
  const selections: string[] = []
  const tree = await harness.mount(
    sidebar({ onSelectView: view => { selections.push(view) } }),
  )
  const aside = tree.container.querySelector('aside')
  expect(aside).not.toBeNull()

  await act(async () => {
    aside!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 140))
  })
  expect(aside!.className).toContain('sidebar-expanded')

  const destination = tree.container.querySelector<HTMLButtonElement>(
    '[data-sidebar-nav-id="sessions"]',
  )
  expect(destination?.textContent).toContain('Sessions')
  expect(tree.container.textContent).not.toContain('Show destinations')

  await act(async () => {
    destination!.click()
  })
  expect(selections).toEqual(['sessions'])
  expect(aside!.className).toContain('w-12')
})

test('selecting a destination preserves an explicitly pinned sidebar', async () => {
  const selections: string[] = []
  const tree = await harness.mount(
    sidebar({ onSelectView: view => { selections.push(view) } }),
  )
  const aside = tree.container.querySelector('aside')
  const collapsedPin = tree.container.querySelector<HTMLButtonElement>(
    '[aria-label="Pin sidebar open"]',
  )

  await act(async () => {
    collapsedPin!.focus()
  })
  const expandedPin = tree.container.querySelector<HTMLButtonElement>(
    '[aria-label="Pin sidebar open"]',
  )
  await act(async () => {
    expandedPin!.click()
  })
  expect(tree.container.querySelector('[aria-label="Unpin sidebar"]')).not.toBeNull()

  const destination = tree.container.querySelector<HTMLButtonElement>(
    '[data-sidebar-nav-id="goals"]',
  )
  await act(async () => {
    destination!.click()
  })
  expect(selections).toEqual(['goals'])
  expect(aside!.className).toContain('sidebar-expanded')
  expect(tree.container.querySelector('[aria-label="Unpin sidebar"]')).not.toBeNull()
})
