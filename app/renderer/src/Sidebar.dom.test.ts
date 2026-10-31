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
import { Sidebar, SidebarRowItem } from './Sidebar.js'
import { sessionDescriptor } from './sessionDescriptorFixture.js'
import { selectMergedSessionRows, type MergedSessionRow } from './sessionsCatalogState.js'
import { reduceSessionUnarchived } from './sidebarArchivedSessions.js'
import { SIDEBAR_HIDDEN_WORKSPACES_STORAGE_KEY } from './sidebarHiddenWorkspaces.js'
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
  await withStubbedRects(async () => {
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

test('an outside pointerdown dismisses an unpinned Chat sidebar even when propagation stops', async () => {
  await withStubbedRects(async () => {
    const tree = await harness.mount(sidebar())
    const aside = tree.container.querySelector('aside')!
    await hoverOpenAt(aside, 200)
    const search = tree.container.querySelector<HTMLInputElement>('input')!
    await act(async () => { search.focus() })

    await act(async () => {
      search.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(aside.className).toContain('sidebar-expanded')

    const outside = document.createElement('button')
    outside.addEventListener('pointerdown', event => event.stopPropagation())
    tree.container.appendChild(outside)
    let clicks = 0
    outside.addEventListener('click', () => { clicks += 1 })
    await act(async () => {
      outside.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      outside.focus()
      outside.click()
    })
    expect(aside.className).toContain('w-12')
    expect(clicks).toBe(1)

    // A later hover must not resurrect the focus state from before dismissal.
    await hoverOpenAt(aside, 200)
    await act(async () => {
      aside.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: outside }))
      await new Promise(resolve => setTimeout(resolve, 400))
    })
    expect(aside.className).toContain('w-12')
  })
})

test('outside pointerdown preserves a sidebar held open by its row menu', async () => {
  const tree = await harness.mount(sidebar({ menuActive: true }))
  const aside = tree.container.querySelector('aside')!
  await act(async () => {
    tree.container.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  })
  expect(aside.className).toContain('sidebar-expanded')
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
 * happy-dom has no layout. Supply non-zero rects so these tests exercise the
 * column hit area rather than passing because every pointer is below zero.
 * The movable top also catches a hard-coded or mount-time-cached column height.
 */
const RAIL_BOTTOM = 900
const BAND_TOP = 712

async function withStubbedRects(
  run: () => Promise<void>,
  columnTop: () => number = () => BAND_TOP,
): Promise<void> {
  const original = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const rect = original.call(this)
    if (this.tagName === 'ASIDE') return { ...rect, top: 40, bottom: RAIL_BOTTOM }
    if (this.tagName === 'NAV' && this.className.includes('mt-auto')) {
      return { ...rect, top: columnTop(), bottom: RAIL_BOTTOM }
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

async function movePointer(aside: HTMLElement, clientY: number): Promise<void> {
  await act(async () => {
    aside.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY }))
  })
}

test('the open footer stays the same one-line strip across pointer movement, with or without a pin', async () => {
  await withStubbedRects(async () => {
    const archived = sessionRow('Archived')
    const tree = await harness.mount(sidebar({
      accountAlias: 'main',
      activeView: 'goals',
      accountsNeedingSignIn: 2,
      rows: [
        sessionRow('Low project', { cwd: '/tmp/low-project' }),
        sessionRow('Hidden project', { cwd: '/tmp/hidden', createdAtMs: 1 }),
        archived,
      ],
      archivedSessions: [{ sessionId: archived.sessionId, archivedAt: 1 }],
      storage: {
        getItem: key => key === SIDEBAR_HIDDEN_WORKSPACES_STORAGE_KEY
          ? JSON.stringify({ version: 1, workspaces: [{ cwd: '/tmp/hidden', hiddenAt: 2 }] })
          : null,
        setItem: () => {},
      },
    }))
    const aside = tree.container.querySelector('aside')!
    await hoverOpenAt(aside, BAND_TOP - 20)
    expect(aside.className).toContain('sidebar-expanded')
    const footer = aside.querySelector('nav')!
    const original = footer.innerHTML
    const destinations = [...footer.querySelectorAll<HTMLButtonElement>('[data-sidebar-nav-id]')]
    const lowRow = aside.querySelector('[aria-label^="session Low project,"]')!
    const archives = archiveToggle(tree.container)!
    const hiddenToggle = [...aside.querySelectorAll('button')].find(button =>
      button.textContent === 'Show 1 hidden project',
    )
    expect(destinations).toHaveLength(5)
    expect(footer.firstElementChild?.className).toContain('flex items-center')
    expect(footer.firstElementChild?.firstElementChild?.textContent).toContain('main')
    expect(destinations.map(button => button.textContent)).toEqual(['', '', '', '', ''])
    expect(destinations.map(button => button.title)).toEqual([
      'Scheduled', 'Goals', 'Accounts, 2 Codex accounts need sign-in', 'Analytics', 'Settings',
    ])
    expect(destinations[1]!.getAttribute('aria-current')).toBe('page')
    expect(destinations[2]!.querySelector('[data-sidebar-nav-badge="accounts"]')).not.toBeNull()
    expect(lowRow).not.toBeNull()
    expect(archives).toBeDefined()
    expect(hiddenToggle).toBeDefined()

    for (const pinned of [false, true]) {
      if (pinned) {
        await act(async () => {
          aside.querySelector<HTMLButtonElement>('[aria-label="Pin sidebar open"]')!.click()
        })
      }
      for (const y of [BAND_TOP, BAND_TOP + 60, RAIL_BOTTOM - 1, BAND_TOP - 1]) {
        await movePointer(aside, y)
        expect(footer.innerHTML).toBe(original)
        expect([...footer.querySelectorAll('[data-sidebar-nav-id]')]).toEqual(destinations)
        expect(aside.querySelector('[aria-label^="session Low project,"]')).toBe(lowRow)
        expect(archiveToggle(tree.container)).toBe(archives)
        expect(hiddenToggle!.isConnected).toBe(true)
      }
    }
  })
})

test('every collapsed destination stays put under mouse hover and dispatches only its own click', async () => {
  await withStubbedRects(async () => {
    for (const accountAlias of [null, 'main']) {
      for (const [index, id] of ['scheduled', 'goals', 'accounts', 'usage', 'settings'].entries()) {
        const calls: string[] = []
        const tree = await harness.mount(sidebar({
          accountAlias,
          rows: [sessionRow('Do not select')],
          onSelectView: view => calls.push(view),
          onSelectLive: () => calls.push('session'),
        }))
        const aside = tree.container.querySelector('aside')!
        const destination = aside.querySelector<HTMLButtonElement>(`[data-sidebar-nav-id="${id}"]`)!
        await act(async () => {
          destination.dispatchEvent(new MouseEvent('mouseover', {
            bubbles: true, clientY: BAND_TOP + 16 + index * 32,
          }))
          await new Promise(resolve => setTimeout(resolve, 140))
        })
        expect(aside.className).toContain('w-12')
        expect(aside.querySelector(`[data-sidebar-nav-id="${id}"]`)).toBe(destination)
        expect(destination.title).not.toBe('')
        await act(async () => {
          // happy-dom does not perform native press-to-focus. Model that default
          // only when mousedown was not cancelled, then release at the same node.
          const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
          destination.dispatchEvent(press)
          if (!press.defaultPrevented) destination.focus()
        })
        expect(aside.className).toContain('w-12')
        expect(destination.isConnected).toBe(true)
        await act(async () => {
          destination.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
          destination.click()
        })
        expect(calls).toEqual([id])
        expect(aside.className).toContain('w-12')
      }
    }
  })
})

test('moving up out of the collapsed column opens after the usual delay without leaving the rail', async () => {
  await withStubbedRects(async () => {
    const tree = await harness.mount(sidebar({ accountAlias: 'main' }))
    const aside = tree.container.querySelector('aside')!
    await hoverOpenAt(aside, BAND_TOP)
    expect(aside.className).toContain('w-12')
    await movePointer(aside, BAND_TOP - 1)
    expect(aside.className).toContain('w-12')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 70))
    })
    expect(aside.className).toContain('w-12')
    await movePointer(aside, BAND_TOP - 20)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 70))
    })
    expect(aside.className).toContain('sidebar-expanded')
  })
})

test('reaching the column before the hover delay cancels opening, and moving back up rearms it', async () => {
  await withStubbedRects(async () => {
    const tree = await harness.mount(sidebar())
    const aside = tree.container.querySelector('aside')!
    await act(async () => {
      aside.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientY: BAND_TOP - 20 }))
      await new Promise(resolve => setTimeout(resolve, 40))
    })
    await movePointer(aside, BAND_TOP)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 140)) })
    expect(aside.className).toContain('w-12')
    await movePointer(aside, BAND_TOP - 1)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 140)) })
    expect(aside.className).toContain('sidebar-expanded')
  })
})

test('the collapsed hit area follows the current column rect rather than a fixed or cached height', async () => {
  let top = BAND_TOP
  await withStubbedRects(async () => {
    const tree = await harness.mount(sidebar())
    const aside = tree.container.querySelector('aside')!
    top = 650
    await hoverOpenAt(aside, 700)
    expect(aside.className).toContain('w-12')
    top = 780
    await movePointer(aside, 700)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 140)) })
    expect(aside.className).toContain('sidebar-expanded')
  }, () => top)
})

test('explicit collapse stays dismissed during pointer movement until the next entry', async () => {
  await withStubbedRects(async () => {
    const tree = await harness.mount(sidebar())
    const aside = tree.container.querySelector('aside')!
    await hoverOpenAt(aside, 200)
    await act(async () => {
      aside.querySelector<HTMLButtonElement>('[aria-label="Collapse sidebar"]')!.click()
    })
    await movePointer(aside, 220)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 140)) })
    expect(aside.className).toContain('w-12')
    await act(async () => {
      aside.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: tree.container }))
    })
    await hoverOpenAt(aside, BAND_TOP + 1)
    expect(aside.className).toContain('w-12')
    await movePointer(aside, 200)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 140)) })
    expect(aside.className).toContain('sidebar-expanded')
  })
})

test('pointer movement never replaces a focused open-footer destination', async () => {
  await withStubbedRects(async () => {
    const tree = await harness.mount(sidebar())
    const aside = tree.container.querySelector('aside')!
    await hoverOpenAt(aside, 200)
    const destination = tree.container.querySelector<HTMLButtonElement>(
      '[data-sidebar-nav-id="goals"]',
    )!
    await act(async () => { destination.focus() })
    await act(async () => {
      aside.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: BAND_TOP + 1 }))
    })
    expect(destination.isConnected).toBe(true)
    expect(document.activeElement).toBe(destination)

    await act(async () => {
      aside.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: tree.container }))
      await new Promise(resolve => setTimeout(resolve, 400))
    })
    expect(aside.className).toContain('sidebar-expanded')
    await act(async () => {
      destination.blur()
    })
    expect(aside.className).toContain('w-12')
  })
})

test('keyboard entry preserves focus when the collapsed navigation is replaced', async () => {
  await withStubbedRects(async () => {
    const tree = await harness.mount(sidebar())
    const aside = tree.container.querySelector('aside')!
    await hoverOpenAt(aside, BAND_TOP + 1)
    expect(aside.className).toContain('w-12')
    const destination = tree.container.querySelector<HTMLButtonElement>(
      '[data-sidebar-nav-id="goals"]',
    )!
    await act(async () => { destination.focus() })
    expect(destination.isConnected).toBe(false)
    expect(aside.className).toContain('sidebar-expanded')
    expect(document.activeElement).toBe(
      tree.container.querySelector('[data-sidebar-nav-id="goals"]'),
    )
  })
})

function sessionRow(id: string, over: Partial<MergedSessionRow> = {}): MergedSessionRow {
  return {
    ...selectMergedSessionRows([sessionDescriptor(id, { title: id })], null)[0]!,
    lastMessageSentAt: null,
    transcriptActivityAtMs: null,
    ...over,
  }
}

function archiveToggle(container: HTMLElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(button =>
    /^\d+ archived$/.test(button.textContent ?? ''),
  )
}

test('archives are hidden from both normal lists, toggle below projects, and keep the full count under search', async () => {
  const project = sessionRow('Project archive', { cwd: '/tmp/proj' })
  const chat = sessionRow('Chat archive', {
    binding: { kind: 'managed', storageRootId: 'managed-root', storageId: 'chat' },
    cwd: '',
  })
  const visible = sessionRow('Visible')
  const rows = [project, chat, visible]
  const archivedSessions = [project, chat].map(row => ({
    sessionId: row.sessionId, archivedAt: Date.now(),
  }))
  const tree = await harness.mount(sidebar({
    menuActive: true, rows, archivedSessions, onOpenRowActions: () => {},
  }))
  const title = (text: string) => tree.container.querySelector(`[aria-label^="session ${text},"]`)
  expect(title('Project archive')).toBeNull()
  expect(title('Chat archive')).toBeNull()
  expect(title('Visible')).not.toBeNull()
  expect(archiveToggle(tree.container)?.textContent).toBe('2 archived')
  expect(archiveToggle(tree.container)?.getAttribute('aria-expanded')).toBe('false')
  const projectsSection = [...tree.container.querySelectorAll('section')].find(section =>
    section.textContent?.includes('Projects'),
  )!
  expect(projectsSection.compareDocumentPosition(archiveToggle(tree.container)!) &
    Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)

  await act(async () => { archiveToggle(tree.container)!.click() })
  expect(title('Project archive')?.querySelector('span.text-text-faint')).not.toBeNull()
  expect(title('Chat archive')).not.toBeNull()
  expect(archiveToggle(tree.container)?.getAttribute('aria-expanded')).toBe('true')

  const input = tree.container.querySelector<HTMLInputElement>('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Project archive')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(input.value).toBe('Project archive')
  expect(title('Chat archive')).toBeNull()
  expect(title('Project archive')).not.toBeNull()
  expect(archiveToggle(tree.container)?.textContent).toBe('2 archived')
  await act(async () => { archiveToggle(tree.container)!.click() })
  expect(title('Project archive')).toBeNull()
})

for (const kind of ['live', 'restorable', 'history'] as const) {
  test(`opening an archived ${kind} row unarchives first, then follows its normal open path`, async () => {
    const row = sessionRow('Archived', kind === 'history'
      ? { appSessionId: null, inRegistry: false, live: false, status: 'history', modifiedAtMs: 0 }
      : kind === 'restorable'
        ? { live: false, restorable: true, status: 'exited' }
        : {})
    let archivedSessions = [{ sessionId: row.sessionId, archivedAt: Date.now() }]
    const calls: string[] = []
    const props = {
      menuActive: true, rows: [row], archivedSessions,
      onSelectLive: (id: string) => { calls.push(`select:${id}`) },
      onRestore: (id: string) => { calls.push(`restore:${id}`) },
      onOpenHistory: (id: string) => { calls.push(`history:${id}`) },
      onUnarchiveSession: (target: MergedSessionRow) => {
        calls.push(`unarchive:${target.sessionId}`)
        archivedSessions = [...reduceSessionUnarchived(archivedSessions, target)]
      },
    }
    const tree = await harness.mount(sidebar(props))
    await act(async () => { archiveToggle(tree.container)!.click() })
    const target = tree.container.querySelector<HTMLElement>('[aria-label^="session Archived,"]')!
    await act(async () => { target.click() })
    expect(calls).toEqual([
      `unarchive:${row.sessionId}`,
      kind === 'history' ? `history:${row.sessionId}` :
        `${kind === 'live' ? 'select' : 'restore'}:${row.appSessionId}`,
    ])
    await tree.render(sidebar({ ...props, archivedSessions }))
    expect(archiveToggle(tree.container)).toBeUndefined()
    expect(tree.container.querySelector('[aria-label^="session Archived,"]')).not.toBeNull()
  })
}

test('row menus preserve identity and pinning stays separate from row activation', async () => {
  const live = sessionRow('Live')
  const history = sessionRow('History', {
    appSessionId: null, inRegistry: false, live: false, status: 'history', modifiedAtMs: 0,
  })
  const orphan = { ...history, sessionId: 'orphan', cwd: '', displayLabel: 'Orphan' }
  const calls: { id: string; archived?: boolean; anchor: { top: number; bottom: number; left: number } }[] = []
  const opens: string[] = []
  const props = {
    menuActive: true, rows: [live, history, orphan],
    onOpenRowActions: (id: string, anchor: { top: number; bottom: number; left: number }, archived?: boolean) => {
      calls.push({ id, anchor, archived })
    },
    onOpenHistory: (id: string) => { opens.push(id) },
    onSelectLive: (id: string) => { opens.push(id) },
  }
  const tree = await harness.mount(sidebar(props))
  for (const row of [live, history, orphan]) {
    const kebab = tree.container.querySelector<HTMLButtonElement>(
      `[aria-label="Session actions for ${row.displayLabel}"]`,
    )
    expect(kebab).not.toBeNull()
    await act(async () => { kebab!.click() })
  }
  expect(calls.map(call => call.id)).toEqual([live.sessionId, history.sessionId, orphan.sessionId])
  expect(calls.every(call => call.archived === undefined)).toBe(true)
  expect(opens).toEqual([])
  expect(tree.container.querySelector('[aria-label="Pin Live"]')).not.toBeNull()
  expect(tree.container.querySelector('[aria-label^="Unpin Live"]')).toBeNull()
  expect(tree.container.textContent).not.toContain('Pinned')
  await act(async () => {
    tree.container.querySelector<HTMLButtonElement>('[aria-label="Pin Live"]')!.click()
  })
  expect(opens).toEqual([])
  expect(tree.container.textContent).toContain('Pinned')
  expect(tree.container.querySelector('[aria-label="Unpin Live"]')).not.toBeNull()
  expect(tree.container.querySelectorAll('[aria-label^="session Live,"]')).toHaveLength(1)

  await tree.render(sidebar({
    ...props, archivedSessions: [{ sessionId: history.sessionId, archivedAt: Date.now() }],
  }))
  await act(async () => { archiveToggle(tree.container)!.click() })
  await act(async () => {
    tree.container.querySelector<HTMLButtonElement>('[aria-label="Session actions for History"]')!.click()
  })
  expect(calls.at(-1)?.archived).toBe(true)
  const archivedRow = tree.container.querySelector('[aria-label^="session History,"]')!
  await act(async () => {
    archivedRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 35, clientY: 42 }))
  })
  expect(calls.at(-1)).toEqual({
    id: history.sessionId, archived: true, anchor: { top: 42, bottom: 42, left: 35 },
  })
  expect(opens).toEqual([])
})

test('archived rows open from the keyboard, but kebab key events do not open or unarchive', async () => {
  const row = sessionRow('History', {
    appSessionId: null, inRegistry: false, live: false, status: 'history',
  })
  const calls: string[] = []
  const tree = await harness.mount(createElement(SidebarRowItem, {
    row, isActive: false, archived: true,
    onSelectLive: () => { calls.push('select') },
    onRestore: () => { calls.push('restore') },
    onOpenHistory: id => { calls.push(`history:${id}`) },
    onUnarchiveSession: target => { calls.push(`unarchive:${target.sessionId}`) },
    onOpenRowActions: () => { calls.push('menu') },
  }))
  const target = tree.container.querySelector<HTMLElement>('[role="button"]')!
  expect(target.tabIndex).toBe(0)
  await act(async () => {
    tree.container.querySelector('button')!.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }),
    )
  })
  expect(calls).toEqual([])
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
  })
  expect(calls).toEqual([`unarchive:${row.sessionId}`, `history:${row.sessionId}`])
})
