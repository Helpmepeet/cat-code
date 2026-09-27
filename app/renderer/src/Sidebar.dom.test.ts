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
    '[data-sidebar-nav-id="goals"]',
  )
  expect(destination?.getAttribute('aria-label')).toBe('Goals')
  expect(
    tree.container.querySelector('[data-sidebar-nav-id="sessions"]'),
  ).toBeNull()
  expect(tree.container.textContent).not.toContain('Show destinations')

  await act(async () => {
    destination!.click()
  })
  expect(selections).toEqual(['goals'])
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

  await act(async () => {
    tree.container.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  })
  expect(aside!.className).toContain('sidebar-expanded')
})

test('an outside click collapses a pinned sidebar on a non-Chat page', async () => {
  const tree = await harness.mount(sidebar({ activeView: 'settings' }))
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
  expect(aside!.className).toContain('sidebar-expanded')

  await act(async () => {
    tree.container.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  })
  expect(aside!.className).toContain('w-12')
  expect(tree.container.querySelector('[aria-label="Pin sidebar open"]')).not.toBeNull()
})

test('New chat, Chats plus, and Add project dispatch separate actions with no sessions', async () => {
  const calls: string[] = []
  const tree = await harness.mount(
    sidebar({
      menuActive: true,
      onNewChat: () => calls.push('project-aware'),
      onNewManagedChat: () => calls.push('managed'),
      onAddProject: () => calls.push('project-picker'),
    }),
  )

  expect(tree.container.textContent).toContain('Chats')
  const newChat = [...tree.container.querySelectorAll('button')].find(button =>
    button.textContent?.includes('New chat'),
  )
  const managedChat = tree.container.querySelector<HTMLButtonElement>(
    '[aria-label="New chat without a project"]',
  )
  const addProject = tree.container.querySelector<HTMLButtonElement>(
    '[aria-label="Add project"]',
  )
  expect(newChat).not.toBeUndefined()
  expect(managedChat).not.toBeNull()
  expect(addProject).not.toBeNull()

  await act(async () => {
    newChat!.click()
    managedChat!.click()
    addProject!.click()
  })

  expect(calls).toEqual(['project-aware', 'managed', 'project-picker'])
})

/**
 * The footer's pointer band (operator, 2026-09-27). happy-dom has no layout, so
 * the rects the band is measured from are stubbed: the rail's bottom edge at
 * RAIL_BOTTOM and the collapsed icon column's top at BAND_TOP. The band is
 * measured from the COLLAPSED column, so its height must not depend on which
 * footer form the open rail shows.
 */
const RAIL_BOTTOM = 900
const BAND_TOP = 712

async function withStubbedRects(run: () => Promise<void>): Promise<void> {
  const original = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const rect = original.call(this)
    if (this.tagName === 'ASIDE') return { ...rect, top: 40, bottom: RAIL_BOTTOM }
    if (this.tagName === 'NAV' && this.className.includes('mt-auto')) {
      return { ...rect, top: BAND_TOP, bottom: RAIL_BOTTOM }
    }
    return rect
  }
  try {
    await run()
  } finally {
    HTMLElement.prototype.getBoundingClientRect = original
  }
}

async function hoverOpenAt(aside: HTMLElement, clientY: number): Promise<void> {
  await act(async () => {
    aside.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientY }))
    await new Promise(resolve => setTimeout(resolve, 140))
  })
}

function footerShowsList(container: HTMLElement): boolean {
  return (
    container.querySelector('[data-sidebar-nav-id="goals"]')?.textContent ===
    'Goals'
  )
}

test('opening from above the band rests the footer as the icon strip', async () => {
  await withStubbedRects(async () => {
    const tree = await harness.mount(sidebar({ accountAlias: 'main' }))
    const aside = tree.container.querySelector('aside')!
    await hoverOpenAt(aside, BAND_TOP - 20)
    expect(aside.className).toContain('sidebar-expanded')
    expect(footerShowsList(tree.container)).toBe(false)
    expect(
      tree.container.querySelector('[data-sidebar-nav-id="goals"]')?.getAttribute('aria-label'),
    ).toBe('Goals')
  })
})

test('opening inside the band shows the labelled list at once', async () => {
  await withStubbedRects(async () => {
    const tree = await harness.mount(sidebar({ activeView: 'goals' }))
    const aside = tree.container.querySelector('aside')!
    await hoverOpenAt(aside, BAND_TOP + 4)
    expect(footerShowsList(tree.container)).toBe(true)
    // The list keeps the session-row hover and active treatments.
    const html = tree.container.innerHTML
    expect(html).toContain(
      'border-transparent text-text-subtle hover:border-accent/[0.22] hover:bg-accent/[0.07]',
    )
    expect(html).toContain('border-accent/[0.18] bg-accent/[0.09] text-accent-soft')
  })
})

test('an open rail grows the footer when the pointer enters the band and rests it on leaving', async () => {
  await withStubbedRects(async () => {
    const tree = await harness.mount(sidebar())
    const aside = tree.container.querySelector('aside')!
    await hoverOpenAt(aside, 200)
    expect(footerShowsList(tree.container)).toBe(false)

    await act(async () => {
      aside.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: BAND_TOP + 1 }))
    })
    expect(footerShowsList(tree.container)).toBe(true)

    // Still inside the band measured from the collapsed column, even though the
    // list is now the footer on screen.
    await act(async () => {
      aside.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: BAND_TOP + 60 }))
    })
    expect(footerShowsList(tree.container)).toBe(true)

    await act(async () => {
      aside.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: BAND_TOP - 1 }))
    })
    expect(footerShowsList(tree.container)).toBe(false)
  })
})
