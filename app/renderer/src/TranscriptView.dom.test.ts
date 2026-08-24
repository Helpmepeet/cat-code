/**
 * DOM proof for the transcript's COMPOSITE containers — the invariants a
 * `renderToStaticMarkup` suite cannot reach: effects run, the pane scroller is
 * real, a scroll actually moves a mounted range, and a child that leaves the
 * range is really unmounted and really remounted.
 *
 * What this pins (CC-59): expanding a nested agent transcript, a grouped tool
 * run, or a delegate group mounts a BOUNDED number of children whatever the
 * container holds, while every count the chrome prints still comes from the
 * complete retained list; and the interaction state a user put into a child
 * survives that child being unmounted and mounted again.
 *
 * WHAT THIS CANNOT PROVE. happy-dom has no layout engine: every
 * `getBoundingClientRect()` is zeros, `clientHeight` is 0, and its
 * `ResizeObserver` never fires. So the scroll positions below are INJECTED by
 * shadowing `getBoundingClientRect` on the two elements the container reads,
 * and real measured heights, real spacer geometry, and real anchor preservation
 * remain browser-only. What is proven here is the range logic, the mount/unmount
 * lifecycle, and the mounted structure.
 *
 * No JSX here on purpose: keeping the file `.ts` keeps it outside the
 * `lint:fast-refresh` component-boundary rule that governs `renderer/src/**.tsx`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act, createElement, useState } from 'react'
import type { ReactNode } from 'react'
import { createDomTestHarness } from './domTestHarness.js'
import type { DomTestHarness } from './domTestHarness.js'
import { TranscriptRowsView } from './TranscriptView.js'
import type { RestorePhase } from './TranscriptView.js'
import { axesForName, faceRects } from './agentFace.js'
import {
  createToolCardExpansionStore,
  ToolCardExpansionContext,
  type ToolCardExpansionStore,
} from './toolCardExpansion.js'
import { MAX_MOUNTED_COMPOSITE_CHILDREN } from './compositeChildWindow.js'
import type {
  NestedToolUseRow,
  NestedTranscriptRow,
  ToolCardStatus,
} from './transcriptProjector.js'

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

const blockSource = {
  sessionId: 's' as const,
  messageId: 'm',
  frameId: 'f',
  blockIndex: 0,
  parentToolUseId: null,
  children: [] as NestedTranscriptRow[],
}

function readRow(index: number): NestedToolUseRow {
  return {
    ...blockSource,
    id: `s:m:${index}:Read`,
    kind: 'tool-use',
    toolUseId: `toolu_read_${index}`,
    toolName: 'Read',
    toolFamily: 'read',
    agentCompletion: null,
    input: { file_path: `/repo/pkg/file${index}.ts` },
    status: 'success',
    result: { content: '1\tconst a = 1', isError: false, diff: null },
    children: [],
  }
}

function reads(count: number): NestedToolUseRow[] {
  return Array.from({ length: count }, (_unused, index) => readRow(index))
}

/** A tool row that does NOT fold into a run, so a list of them stays N children. */
function bashRow(index: number, content = `out of call ${index}`): NestedToolUseRow {
  return {
    ...blockSource,
    id: `s:m:${index}:Bash`,
    kind: 'tool-use',
    toolUseId: `toolu_bash_${index}`,
    toolName: 'Bash',
    toolFamily: 'bash',
    agentCompletion: null,
    input: { command: `echo ${index}` },
    status: 'success',
    result: { content, isError: false, diff: null },
    children: [],
  }
}

function calls(count: number): NestedTranscriptRow[] {
  return Array.from({ length: count }, (_unused, index) => bashRow(index))
}

function agentRow(
  suffix: string,
  children: NestedTranscriptRow[],
  over: { messageId?: string; status?: ToolCardStatus } = {},
): NestedToolUseRow {
  return {
    ...blockSource,
    id: `s:${over.messageId ?? 'm'}:0:agent-${suffix}`,
    messageId: over.messageId ?? 'm',
    kind: 'tool-use',
    toolUseId: `toolu_agent_${suffix}`,
    toolName: 'Agent',
    toolFamily: 'agent',
    agentCompletion: null,
    input: { subagent_type: 'Explore', description: `job ${suffix}` },
    status: over.status ?? 'success',
    result: { content: 'done', isError: false, diff: null },
    children,
  }
}

function thinkingRow(index: number, content: string): NestedTranscriptRow {
  return { ...blockSource, id: `s:m:${index}:thinking`, kind: 'thinking', content }
}

/** A scroll parent `findPaneScroller` accepts, holding one transcript. */
function Pane({
  rows,
  store,
  restorePhase = null,
}: {
  rows: NestedTranscriptRow[]
  store: ToolCardExpansionStore
  restorePhase?: RestorePhase | null
}): ReactNode {
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  const attach = (element: HTMLElement | null): void => {
    if (element !== null) element.style.overflowY = 'auto'
    setScroller(element)
  }
  return createElement(
    'div',
    { ref: attach, 'data-testid': 'pane' },
    scroller === null
      ? null
      : createElement(
          ToolCardExpansionContext.Provider,
          { value: store },
          createElement(TranscriptRowsView, { rows, restorePhase }),
        ),
  )
}

async function mountPane(
  rows: NestedTranscriptRow[],
  store: ToolCardExpansionStore = createToolCardExpansionStore(),
  restorePhase: RestorePhase | null = null,
) {
  const tree = await harness.mount(createElement(Pane, { rows, store, restorePhase }))
  await harness.nextFrame()
  const pane = tree.container.querySelector<HTMLElement>('[data-testid="pane"]')
  expect(pane).not.toBeNull()
  return { tree, pane: pane as HTMLElement, store }
}

function mountedChildren(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[data-transcript-child]')]
}

function mountedKeys(root: ParentNode): string[] {
  return mountedChildren(root).map(
    element => element.getAttribute('data-transcript-child') ?? '',
  )
}

/** The `BoundedChildList` root that owns these mounted children. */
function containerRootOf(root: ParentNode): HTMLElement {
  const first = root.querySelector<HTMLElement>('[data-transcript-child]')
  expect(first).not.toBeNull()
  const parent = first?.parentElement ?? null
  expect(parent).not.toBeNull()
  return parent as HTMLElement
}

/**
 * happy-dom reports zeros for every box, so the scroll position a container
 * reads is injected here. The container computes `scrollerTop - rootTop`, so a
 * container root placed at a negative top has scrolled up out of view.
 */
function placeAt(element: HTMLElement, top: number): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top, bottom: top, left: 0, right: 0, width: 0, height: 0 }),
  })
}

/**
 * One pane scroll, flushed. Two frames because the shared coordinator batches
 * the event into one frame and the container batches its own measurement pass
 * into the next; `act` is what turns the resulting state update into a commit.
 */
async function scrollPane(pane: HTMLElement): Promise<void> {
  await act(async () => {
    pane.dispatchEvent(new globalThis.Event('scroll'))
    await harness.nextFrame()
    await harness.nextFrame()
  })
}

/** A user click, committed. */
async function click(element: HTMLElement | null | undefined): Promise<void> {
  expect(element).toBeTruthy()
  await act(async () => {
    element?.click()
  })
}

test('a successful message copy briefly replaces the copy icon with a checkmark', async () => {
  const clipboardWrites: string[] = []
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(
    globalThis.navigator,
    'clipboard',
  )
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (content: string) => {
        clipboardWrites.push(content)
      },
    },
  })

  try {
    const tree = await harness.mount(
      createElement(TranscriptRowsView, {
        rows: [
          {
            ...blockSource,
            id: 's:m:0:user-text',
            kind: 'user-text',
            role: 'user',
            content: 'copy this message',
            isReplay: false,
          },
        ],
        onMessageAction: () => {},
      }),
    )
    const copyButton = tree.container.querySelector<HTMLElement>(
      '[aria-label="Copy message"]',
    )

    await act(async () => {
      copyButton?.click()
      await Promise.resolve()
    })

    expect(clipboardWrites).toEqual(['copy this message'])
    const copiedButton = tree.container.querySelector<HTMLElement>(
      '[aria-label="Message copied"]',
    )
    expect(copiedButton).not.toBeNull()
    expect(
      copiedButton?.querySelector('polyline[points="20 6 9 17 4 12"]'),
    ).not.toBeNull()
  } finally {
    if (clipboardDescriptor) {
      Object.defineProperty(
        globalThis.navigator,
        'clipboard',
        clipboardDescriptor,
      )
    } else {
      Reflect.deleteProperty(globalThis.navigator, 'clipboard')
    }
  }
})

/** Counts real `scroll` registrations on one element by shadowing its own. */
function countScrollListeners(element: HTMLElement): () => number {
  let added = 0
  const add = element.addEventListener.bind(element)
  Object.defineProperty(element, 'addEventListener', {
    configurable: true,
    value: (type: string, ...rest: unknown[]) => {
      if (type === 'scroll') added += 1
      return (add as (...args: unknown[]) => unknown)(type, ...rest)
    },
  })
  return () => added
}

describe('bounded composite containers', () => {
  test('an expanded nested agent transcript mounts a bounded number of rows', async () => {
    const store = createToolCardExpansionStore()
    store.set('toolu_agent_solo', true)
    const { pane } = await mountPane([agentRow('solo', calls(3_000))], store)

    const mounted = mountedChildren(pane)
    expect(mounted.length).toBeGreaterThan(0)
    expect(mounted.length).toBeLessThanOrEqual(MAX_MOUNTED_COMPOSITE_CHILDREN)
    // The retained model is untouched: the card's own progress badge counts
    // every child row it holds, not the mounted slice.
    expect(pane.textContent).toContain('3000 tool calls')
    // The rows that DID mount are the leading ones, in order.
    expect(mountedKeys(pane)[0]).toBe('s:m:0:Bash')
  })

  test('a grouped tool run mounts a bounded number of members and still counts them all', async () => {
    const store = createToolCardExpansionStore()
    store.set('run:toolu_read_0', true)
    const { pane } = await mountPane(reads(3_000), store)

    // One card, whose head states the true total.
    expect(pane.textContent).toContain('3000 files')
    const mounted = mountedChildren(pane)
    expect(mounted.length).toBeGreaterThan(0)
    expect(mounted.length).toBeLessThanOrEqual(MAX_MOUNTED_COMPOSITE_CHILDREN)
  })

  test('a delegate group mounts a bounded number of members and still counts them all', async () => {
    const members = Array.from({ length: 3_000 }, (_unused, index) =>
      agentRow(`d${index}`, []),
    )
    const { pane } = await mountPane(members)

    expect(pane.textContent).toContain('3000 explore workers')
    const mounted = mountedChildren(pane)
    expect(mounted.length).toBeGreaterThan(0)
    expect(mounted.length).toBeLessThanOrEqual(MAX_MOUNTED_COMPOSITE_CHILDREN)
  })

  test('a nested transcript containing a grouped run is bounded at BOTH levels', async () => {
    const store = createToolCardExpansionStore()
    store.set('toolu_agent_solo', true)
    // The run head inside the nested transcript, opened so its members mount.
    store.set('run:toolu_read_0', true)
    const { pane } = await mountPane([agentRow('solo', reads(4_000))], store)

    // Level one: the nested list folded 4,000 reads into one run item.
    expect(pane.textContent).toContain('4000 files')
    // Level two: that run's own member list is bounded too. Two nested
    // containers, so the ceiling applies twice, never once per member.
    const mounted = mountedChildren(pane)
    expect(mounted.length).toBeGreaterThan(0)
    expect(mounted.length).toBeLessThanOrEqual(MAX_MOUNTED_COMPOSITE_CHILDREN * 2)
    expect(pane.textContent).toContain('4000 tool calls')
  })

  test('the mounted count stays fixed as each source grows ten times', async () => {
    const counts: number[] = []
    for (const size of [500, 5_000, 50_000]) {
      const store = createToolCardExpansionStore()
      store.set('run:toolu_read_0', true)
      const { tree, pane } = await mountPane(reads(size), store)
      counts.push(mountedChildren(pane).length)
      expect(pane.textContent).toContain(`${size} files`)
      await tree.unmount()
    }

    expect(counts[0]).toBeGreaterThan(0)
    expect(counts[1]).toBe(counts[0])
    expect(counts[2]).toBe(counts[0])
  })

  test('every container shares ONE pane scroll listener however many there are', async () => {
    // Three nested transcripts, each holding its own grouped run: seven bounded
    // containers in one pane. The coordinator has to pool them all onto the one
    // listener, or pane-level attachment grows with transcript history.
    const store = createToolCardExpansionStore()
    for (const suffix of ['a', 'b', 'c']) store.set(`toolu_agent_${suffix}`, true)
    const tree = await harness.mount(
      createElement(Pane, { rows: [], store }),
    )
    const pane = tree.container.querySelector<HTMLElement>('[data-testid="pane"]')
    const added = countScrollListeners(pane as HTMLElement)

    await tree.render(
      createElement(Pane, {
        rows: ['a', 'b', 'c'].map(suffix =>
          agentRow(suffix, reads(200), { messageId: `m-${suffix}` }),
        ),
        store,
      }),
    )
    await harness.nextFrame()

    expect(mountedChildren(pane as HTMLElement).length).toBeGreaterThan(0)
    expect(added()).toBe(1)
  })
})

describe('state survives a child leaving and re-entering the mounted range', () => {
  test('a member scrolled out and back returns expanded', async () => {
    const store = createToolCardExpansionStore()
    store.set('run:toolu_read_0', true)
    const { pane } = await mountPane(reads(3_000), store)
    const target = 's:m:3:Read'

    const toggle = mountedChildren(pane)
      .find(child => child.getAttribute('data-transcript-child') === target)
      ?.querySelector('button')
    expect(toggle).not.toBeNull()
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    await click(toggle)
    expect(mountedKeys(pane)).toContain(target)
    expect(openStateOf(pane, target)).toBe('true')

    // Scroll the run far past the viewport: the member must really unmount.
    const root = containerRootOf(pane)
    placeAt(pane, 0)
    placeAt(root, -80_000)
    await scrollPane(pane)
    expect(mountedKeys(pane)).not.toContain(target)

    // And back.
    placeAt(root, 0)
    await scrollPane(pane)
    expect(mountedKeys(pane)).toContain(target)
    expect(openStateOf(pane, target)).toBe('true')
  })

  test('progressive reveal extent survives the same round trip', async () => {
    const long = Array.from({ length: 900 }, (_unused, index) => `out ${index}`).join('\n')
    const children = calls(3_000)
    children[0] = bashRow(0, long)
    const store = createToolCardExpansionStore()
    store.set('toolu_agent_solo', true)
    store.set('toolu_bash_0', true)
    const { pane } = await mountPane([agentRow('solo', children)], store)

    const before = revealBandText(pane)
    expect(before).toContain('lines hidden')
    await click(revealButton(pane))
    const after = revealBandText(pane)
    expect(after).not.toBe(before)

    const root = containerRootOf(pane)
    placeAt(pane, 0)
    placeAt(root, -80_000)
    await scrollPane(pane)
    placeAt(root, 0)
    await scrollPane(pane)

    expect(revealBandText(pane)).toBe(after)
  })

  test('a folded reasoning run comes back folded', async () => {
    const rows: NestedTranscriptRow[] = [
      thinkingRow(0, 'Reading the seam'),
      thinkingRow(1, 'Checking the projector'),
      ...reads(3_000),
    ]
    const store = createToolCardExpansionStore()
    const { tree, pane } = await mountPane(rows, store)

    const reasoning = reasoningToggle(pane)
    expect(reasoning?.getAttribute('aria-expanded')).toBe('true')
    await click(reasoning)
    expect(reasoningToggle(pane)?.getAttribute('aria-expanded')).toBe('false')

    // A full unmount and remount is what a container does to a child that
    // leaves its mounted range, and the run must not spring back open.
    await tree.unmount()
    const next = await mountPane(rows, store)
    expect(reasoningToggle(next.pane)?.getAttribute('aria-expanded')).toBe('false')
  })

  test('nested transcript expansion survives a remount', async () => {
    const store = createToolCardExpansionStore()
    const rows = [agentRow('solo', calls(3_000))]
    const { tree, pane } = await mountPane(rows, store)

    expect(mountedChildren(pane)).toHaveLength(0) // collapsed by default (C4)
    await click(pane.querySelector('button'))
    expect(mountedChildren(pane).length).toBeGreaterThan(0)

    await tree.unmount()
    const next = await mountPane(rows, store)
    expect(mountedChildren(next.pane).length).toBeGreaterThan(0)
    expect(next.pane.textContent).toContain('3000 tool calls')
  })
})

describe('display degrades gracefully', () => {
  test('an unknown row variant inside a bounded container renders its fallback', async () => {
    const store = createToolCardExpansionStore()
    store.set('toolu_agent_solo', true)
    const children = calls(40)
    // A schema-drifted kind past the pinned union, as a runtime value only.
    const drifted: NestedTranscriptRow = {
      ...blockSource,
      id: 's:m:5:drift',
      ...JSON.parse('{"kind":"comet-trail"}'),
    }
    children.splice(2, 0, drifted)
    const { pane } = await mountPane([agentRow('solo', children)], store)

    expect(pane.textContent).toContain('Unrecognized transcript row: comet-trail')
    expect(mountedChildren(pane).length).toBeGreaterThan(0)
  })
})

function openStateOf(root: ParentNode, key: string): string | null {
  const child = mountedChildren(root).find(
    element => element.getAttribute('data-transcript-child') === key,
  )
  return child?.querySelector('button')?.getAttribute('aria-expanded') ?? null
}

function revealButton(root: ParentNode): HTMLElement | null {
  return (
    [...root.querySelectorAll<HTMLElement>('button')].find(button =>
      (button.textContent ?? '').startsWith('Show '),
    ) ?? null
  )
}

function revealBandText(root: ParentNode): string {
  return (
    [...root.querySelectorAll<HTMLElement>('span')]
      .map(span => span.textContent ?? '')
      .find(text => text.endsWith('lines hidden')) ?? ''
  )
}

function reasoningToggle(root: ParentNode): HTMLElement | null {
  return (
    [...root.querySelectorAll<HTMLElement>('button')].find(button =>
      (button.textContent ?? '').includes('Reasoning'),
    ) ?? null
  )
}

/**
 * A composite container grows inline in the transcript, so a measured child
 * height replacing an estimate moves everything below it and the pane must
 * correct for it. `VirtualLineList` deliberately does NOT report: it lives
 * inside its own bounded scroll box, so its measurements never change the
 * pane's height.
 */
test('CC-63: a composite container reports its height change to the pane', async () => {
  const store = createToolCardExpansionStore()
  store.set('run:toolu_read_0', true)
  const { tree, pane } = await mountPane(reads(400), store)
  const container = containerRootOf(tree.container)

  // The container sits above the reader, and the pane is parked mid document.
  pane.scrollTop = 5_000
  Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 800 })
  Object.defineProperty(pane, 'scrollHeight', { configurable: true, value: 40_000 })
  placeAt(pane, 0)
  placeAt(container, -3_000)
  await scrollPane(pane)

  // The container's own box grows: a measured child turned out taller than its
  // estimate. The next commit is what reports it.
  const grown = pane.scrollTop
  Object.defineProperty(container, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top: -3_600, bottom: 0, left: 0, right: 0, width: 0, height: 900 }),
  })
  await scrollPane(pane)

  // Something above the reader got taller, so the pane compensated rather than
  // letting the content they were reading slide down the screen.
  expect(pane.scrollTop).toBeGreaterThan(grown)
})

/**
 * The face stamp across a restore.
 *
 * `agentFace.ts` decides a worker's silhouette on FIRST DRAW, against the faces
 * the session already holds, and the registry that holds them is a ref in
 * `TranscriptRowsView` that survives the preview-to-live handover. So the
 * assignment depends on what has already been drawn, and a restore draws the
 * cached tail before the earlier history loads.
 *
 * That was examined on 2026-08-21 and the order dependence was ACCEPTED. The
 * alternative — leaving the preview unregistered and letting the settled
 * transcript assign — was measured against the real registry over 2,000
 * simulated 12-worker sessions previewing their last 5: it moves 24.7% of the
 * preview's cards at the handover (29.4% if the preview draws the bare hash),
 * against the 21.1% of workers whose face it would bring back into agreement
 * with an untruncated reading. It also charges that flicker to every previewed
 * session, including the ones whose cache already holds the whole transcript
 * and therefore have nothing wrong with them.
 *
 * This is the invariant that ruling chose, at the one level where the defect
 * class lives: not ids handed straight to `createAgentFaceRegistry`, but the
 * real component driven through a real preview-then-remainder render. It fails
 * for either version of the rejected fix.
 */
describe('the face stamp across a restore', () => {
  const WORKER_IDS = Array.from({ length: 12 }, (_unused, index) => `agent_740_${index}`)
  /** How many of the transcript's 12 workers the cached preview holds. */
  const PREVIEW_FROM = 7

  function workerRow(index: number): NestedToolUseRow {
    const agentId = WORKER_IDS[index]
    return {
      ...blockSource,
      id: `s:m${index}:0:${agentId}`,
      messageId: `m${index}`,
      kind: 'tool-use',
      toolUseId: `toolu_${agentId}`,
      toolName: 'Agent',
      toolFamily: 'agent',
      agentCompletion: null,
      input: { subagent_type: 'Explore', description: `job ${index}` },
      status: 'success',
      result: {
        content: 'done',
        isError: false,
        diff: null,
        agentId,
        agentName: `w${index}`,
      },
      children: [],
    }
  }

  /** Every drawn stamp in document order: its colour class and its geometry. */
  function drawnFaces(root: ParentNode): { tone: string; shape: string }[] {
    return [...root.querySelectorAll<Element>('svg[viewBox="0 0 9 9"]')].map(svg => ({
      tone: svg.getAttribute('class') ?? '',
      shape: [...svg.querySelectorAll<Element>('rect')]
        .map(
          rect =>
            `${rect.getAttribute('x')},${rect.getAttribute('y')},` +
            `${rect.getAttribute('width')},${rect.getAttribute('height')}`,
        )
        .join(' '),
    }))
  }

  /** The silhouette the hash asks for, before the session dedupes it. */
  function hashedShape(agentId: string): string {
    return faceRects(axesForName(agentId))
      .map(rect => `${rect.x},${rect.y},${rect.w},${rect.h}`)
      .join(' ')
  }

  test('a restored card keeps the face its preview drew', async () => {
    const all = WORKER_IDS.map((_unused, index) => workerRow(index))
    const cached = all.slice(PREVIEW_FROM)

    const { tree, pane, store } = await mountPane(cached, undefined, 'preview')
    const previewFaces = drawnFaces(pane)
    expect(previewFaces).toHaveLength(cached.length)
    // The fixture has teeth: the preview really deduped, so a version that drew
    // the bare hash here would already disagree with this row.
    expect(
      previewFaces.filter(
        (face, index) => face.shape !== hashedShape(WORKER_IDS[PREVIEW_FROM + index]),
      ).length,
    ).toBeGreaterThan(0)

    // The handover: the earlier history lands and the pane goes live, in the
    // same tree, so the session's registry is the one that was already used.
    await tree.render(
      createElement(Pane, { rows: all, store, restorePhase: null }),
    )
    const settledFaces = drawnFaces(pane)
    expect(settledFaces).toHaveLength(all.length)

    // Nothing the reader had already seen moved.
    expect(settledFaces.slice(PREVIEW_FROM)).toEqual(previewFaces)
    // And the distance rule still holds across the whole settled transcript.
    expect(new Set(settledFaces.map(face => `${face.tone}|${face.shape}`)).size).toBe(
      all.length,
    )
  })
})
