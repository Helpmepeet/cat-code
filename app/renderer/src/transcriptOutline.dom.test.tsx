import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, createRef, useRef, useState } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { TranscriptOutline } from './TranscriptOutline.js'
import { TranscriptRowsView } from './TranscriptView.js'
import { TranscriptModeContext } from './transcriptMode.js'
import { registerTranscriptRowOffsets } from './transcriptRowNavigation.js'
import type { TranscriptOutlineEntry } from './transcriptOutlineModel.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'
import { createTranscriptState, projectServerFrame } from './transcriptProjector.js'
import { PROTOCOL_VERSION } from '../../shared/protocol.js'
import { SessionPane } from './SessionPane.js'
import { idleSessionPaneProps } from './sessionPaneTestProps.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => {
  await harness.unmountAll()
  document.querySelectorAll('.outline-fixture-scroller').forEach(element => element.remove())
})
afterAll(async () => { await harness.teardown() })
const source = (id: string) => ({ id, sessionId: 'outline', messageId: id, frameId: id, blockIndex: 0, parentToolUseId: null, children: [] })
const prompt = (id: string, content = id): NestedTranscriptRow => ({ ...source(id), kind: 'user-text', role: 'user', isReplay: false, content })
const answer = (id: string, content = id): NestedTranscriptRow => ({ ...source(id), kind: 'assistant-text', role: 'assistant', phase: 'final_answer', content })
const rows = [prompt('p1', 'First prompt'), answer('a1', 'First answer'), prompt('p2', 'Second prompt'), answer('a2', 'Second answer'), prompt('p3', 'Unanswered prompt')]
const ticks = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>('.transcript-outline-tick')]
const card = (root: HTMLElement) => root.querySelector<HTMLElement>('.transcript-outline-preview')
const button = (root: HTMLElement, selector: string) => root.querySelector<HTMLButtonElement>(selector)!
async function key(target: Element, key: string) {
  await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
}
async function pointer(target: Element, type: string) {
  const eventType = type === 'pointerenter' ? 'pointerover' : type === 'pointerleave' ? 'pointerout' : type
  await act(async () => { target.dispatchEvent(new PointerEvent(eventType, { bubbles: true })) })
}
async function pause(ms: number) { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }
async function click(target: HTMLElement) { await act(async () => { target.click() }) }
async function mountOutline(initial = rows) {
  const scroller = document.createElement('div')
  scroller.className = 'outline-fixture-scroller'
  harness.document.body.append(scroller)
  const scrollerRef = createRef<HTMLDivElement>()
  scrollerRef.current = scroller
  const jumps: TranscriptOutlineEntry[] = []
  const render = (data: NestedTranscriptRow[]) => <TranscriptOutline rows={data} scrollerRef={scrollerRef} onJump={entry => jumps.push(entry)} />
  const tree = await harness.mount(render(initial))
  return { ...tree, scroller, jumps, update: (data: NestedTranscriptRow[]) => tree.render(render(data)) }
}

test('hover magnifies nearby ticks, previews the right answer, and crosses into the card', async () => {
  const tree = await mountOutline()
  const rail = ticks(tree.container)
  expect(card(tree.container) === null).toBe(true)
  expect(rail.filter(tick => tick.tabIndex === 0)).toHaveLength(1)
  await pointer(rail[1]!, 'pointerenter')
  expect(card(tree.container) === null).toBe(true)
  await pause(110)
  expect(card(tree.container)?.textContent).toContain('Second answer')
  expect(rail[1]!.getAttribute('data-distance')).toBe('0')
  expect(rail[0]!.getAttribute('data-distance')).toBe('1')
  await pointer(rail[1]!, 'pointerleave')
  await pointer(card(tree.container)!, 'pointerenter')
  await pause(180)
  expect(card(tree.container) !== null).toBe(true)
  await pointer(card(tree.container)!, 'pointerleave')
  await pause(180)
  expect(card(tree.container) === null).toBe(true)
  tree.scroller.remove()
})

test('bookmark changes only its prompt and survives streaming and earlier-history insertion', async () => {
  const tree = await mountOutline()
  await act(async () => { ticks(tree.container)[1]!.focus() })
  await click(button(tree.container, '.transcript-outline-bookmark'))
  expect(button(tree.container, '.transcript-outline-bookmark').getAttribute('aria-pressed')).toBe('true')
  expect(ticks(tree.container)[1]!.getAttribute('aria-label')).toContain('bookmarked')
  expect(tree.jumps).toEqual([])
  await tree.update([prompt('old'), answer('old-a'), ...rows, answer('a3', 'New streamed answer')])
  expect(card(tree.container)?.textContent).toContain('Second answer')
  expect(ticks(tree.container)[2]!.hasAttribute('data-bookmarked')).toBe(true)
  expect(ticks(tree.container)[1]!.hasAttribute('data-bookmarked')).toBe(false)
  await click(button(tree.container, '.transcript-outline-bookmark'))
  expect(ticks(tree.container)[2]!.hasAttribute('data-bookmarked')).toBe(false)
  await click(button(tree.container, '.transcript-outline-jump'))
  expect(tree.jumps.at(-1)?.rowKey).toBe('p2')
  tree.scroller.remove()
})

test('temporary bookmarks survive a tab remount without marking another session', async () => {
  const data = [prompt('remembered')]
  const first = await mountOutline(data)
  await act(async () => { ticks(first.container)[0]!.focus() })
  await click(button(first.container, '.transcript-outline-bookmark'))
  await first.unmount()
  first.scroller.remove()
  const second = await mountOutline(data)
  expect(ticks(second.container)[0]!.hasAttribute('data-bookmarked')).toBe(true)
  await second.update([{ ...data[0]!, sessionId: 'another-session' }])
  expect(ticks(second.container)[0]!.hasAttribute('data-bookmarked')).toBe(false)
  await second.update(data)
  await act(async () => { ticks(second.container)[0]!.focus() })
  await click(button(second.container, '.transcript-outline-bookmark'))
  second.scroller.remove()
})

test('keyboard focus enters the preview, returns to the rail, and dismisses without stale unanswered text', async () => {
  const tree = await mountOutline()
  await act(async () => { ticks(tree.container)[0]!.focus() })
  await key(ticks(tree.container)[0]!, 'ArrowDown')
  expect(document.activeElement === ticks(tree.container)[1]).toBe(true)
  expect(ticks(tree.container).filter(tick => tick.tabIndex === 0)).toHaveLength(1)
  await key(ticks(tree.container)[1]!, 'End')
  expect(document.activeElement === ticks(tree.container)[2]).toBe(true)
  expect(tree.container.querySelector('.transcript-outline-answer') === null).toBe(true)
  await key(ticks(tree.container)[2]!, 'ArrowRight')
  expect(document.activeElement === button(tree.container, '.transcript-outline-jump')).toBe(true)
  await key(document.activeElement!, 'ArrowLeft')
  expect(document.activeElement === ticks(tree.container)[2]).toBe(true)
  await key(ticks(tree.container)[2]!, 'Home')
  expect(document.activeElement === ticks(tree.container)[0]).toBe(true)
  await key(ticks(tree.container)[0]!, 'ArrowRight')
  await key(document.activeElement!, 'Escape')
  expect(document.activeElement === ticks(tree.container)[0]).toBe(true)
  expect(card(tree.container) === null).toBe(true)
  await key(ticks(tree.container)[0]!, 'ArrowRight')
  expect(document.activeElement === button(tree.container, '.transcript-outline-jump')).toBe(true)
  await key(document.activeElement!, 'Escape')
  await key(ticks(tree.container)[0]!, 'ArrowDown')
  await pointer(ticks(tree.container)[1]!, 'pointerleave')
  await pause(180)
  expect(card(tree.container) !== null).toBe(true)
  await pointer(tree.scroller, 'pointerdown')
  expect(card(tree.container) === null).toBe(true)
  tree.scroller.remove()
})

test('mouse-focused ticks dismiss on exit; removed prompts do not keep stale previews', async () => {
  const tree = await mountOutline()
  const tick = ticks(tree.container)[0]!
  await pointer(tick, 'pointerdown')
  await act(async () => { tick.focus() })
  await click(tick)
  expect(tree.jumps[0]?.rowKey).toBe('p1')
  await pointer(tick, 'pointerleave')
  await pause(180)
  expect(card(tree.container) === null).toBe(true)
  await act(async () => { ticks(tree.container)[1]!.focus() })
  await tree.update([prompt('p3')])
  expect(card(tree.container) === null).toBe(true)
  await tree.update([])
  expect(tree.container.querySelector('nav') === null).toBe(true)
  tree.scroller.remove()
})

test('unsafe-looking excerpts are literal text and a live answer updates the active preview', async () => {
  const tree = await mountOutline([prompt('p', '<img src=x onerror=alert(1)>'), answer('a', '<script>bad()</script>')])
  await act(async () => { ticks(tree.container)[0]!.focus() })
  expect(card(tree.container)?.textContent).toContain('<script>bad()</script>')
  expect(card(tree.container)?.querySelector('script, img') === null).toBe(true)
  await tree.update([prompt('p', '<img src=x onerror=alert(1)>'), answer('a', 'Updated answer')])
  expect(card(tree.container)?.textContent).toContain('Updated answer')
  tree.scroller.remove()
})

test('hidden transcript panes defer viewport measurements until they have height', async () => {
  const tree = await mountOutline()
  let reads = 0
  const release = registerTranscriptRowOffsets(tree.scroller, key => {
    reads++
    return ({ p1: 0, p2: 100, p3: 200 } as Record<string, number>)[key] ?? null
  })
  await act(async () => { await harness.nextFrame(); await harness.nextFrame() })
  expect(reads).toBe(0)
  expect(ticks(tree.container).some(tick => tick.hasAttribute('aria-current'))).toBe(false)
  Object.defineProperties(tree.scroller, {
    scrollTop: { configurable: true, writable: true, value: 220 },
    clientHeight: { configurable: true, value: 300 },
  })
  await act(async () => { tree.scroller.dispatchEvent(new Event('scroll')); await harness.nextFrame(); await harness.nextFrame() })
  expect(reads).toBeGreaterThan(0)
  expect(ticks(tree.container)[2]!.getAttribute('aria-current')).toBe('location')
  release()
  tree.scroller.remove()
})

test('reading and viewport indicators use virtual row offsets without mounting every prompt', async () => {
  const data = Array.from({ length: 1000 }, (_, index) => prompt(`p${index}`))
  const tree = await mountOutline(data)
  Object.defineProperties(tree.scroller, {
    scrollTop: { configurable: true, writable: true, value: 50_020 },
    clientHeight: { configurable: true, value: 250 },
  })
  let reads = 0
  const release = registerTranscriptRowOffsets(tree.scroller, key => { reads++; return Number(key.slice(1)) * 100 })
  await act(async () => { tree.scroller.dispatchEvent(new Event('scroll')); await harness.nextFrame(); await harness.nextFrame() })
  expect(ticks(tree.container)[500]!.getAttribute('aria-current')).toBe('location')
  expect(ticks(tree.container).filter(tick => tick.hasAttribute('data-in-view'))).toHaveLength(3)
  expect(reads).toBeLessThan(50)
  release()
  tree.scroller.remove()
})

function NavigableTranscript({ data, mode }: { data: NestedTranscriptRow[]; mode: 'full' | 'focused' }) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [request, setRequest] = useState<{ key: string; sequence: number } | null>(null)
  return <TranscriptModeContext.Provider value={{ mode, setMode() {} }}>
    <div ref={node => {
      scrollerRef.current = node
      if (node) node.style.overflowY = 'auto'
    }} className="outline-test-scroller">
      <TranscriptRowsView rows={data} revealRow={request} />
    </div>
    <TranscriptOutline rows={data} scrollerRef={scrollerRef} onJump={entry => setRequest(previous => ({ key: entry.rowKey, sequence: (previous?.sequence ?? 0) + 1 }))} />
  </TranscriptModeContext.Provider>
}

for (const mode of ['full', 'focused'] as const) {
  test(`the real ${mode} session pane releases following when its outline is used`, async () => {
    const sheet = document.createElement('style')
    sheet.textContent = '.overflow-auto { overflow-y: auto; }'
    document.head.append(sheet)
    let state = projectServerFrame(createTranscriptState(), {
      kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId: 'session-1', engineSessionId: 'engine-1', payload: {
        type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false,
        abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [],
      },
    } as never)
    const event = (message: unknown) => ({ kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'session-1', event: { type: 'message', message } }) as never
    state = projectServerFrame(state, event({
      type: 'user', uuid: 'outline-user', session_id: 'engine-1', parent_tool_use_id: null,
      message: { role: 'user', content: 'Inspect the module' },
    }))
    const appendAnswer = (id: string) => {
      state = projectServerFrame(state, event({
        type: 'assistant', uuid: id, session_id: 'engine-1', parent_tool_use_id: null,
        message: { id, role: 'assistant', content: [{ type: 'text', text: 'A new progress update.' }] },
      }))
    }
    appendAnswer('first-update')
    const view = () => <TranscriptModeContext.Provider value={{ mode, setMode() {} }}>
      <SessionPane {...idleSessionPaneProps()} transcript={state} activeConnection={{ status: 'ready', inputEnabled: false }} turnStartedAt={Date.now()} />
    </TranscriptModeContext.Provider>
    try {
      const tree = await harness.mount(view())
      const scroller = tree.container.querySelector<HTMLElement>('.session-transcript-scroll')!
      Object.defineProperties(scroller, {
        clientHeight: { configurable: true, value: 500 },
        scrollHeight: { configurable: true, value: 1800 },
      })
      scroller.scrollTop = 800
      expect(scroller.contains(tree.container.querySelector('.transcript-outline'))).toBe(false)
      await click(ticks(tree.container)[0]!)
      const landed = scroller.scrollTop
      expect(tree.container.querySelector('.session-transcript-region > button') !== null).toBe(true)
      appendAnswer('later-update')
      await tree.render(view())
      await act(async () => { await harness.nextFrame(); await harness.nextFrame() })
      expect(scroller.scrollTop).toBe(landed)
      await tree.unmount()
    } finally { sheet.remove() }
  })

  test(`outline reveals an unmounted prompt in the real ${mode} transcript virtualizer`, async () => {
    const data = Array.from({ length: 240 }, (_, index) => prompt(`history:${index}`))
    const oldRect = HTMLElement.prototype.getBoundingClientRect
    const oldScrollIntoView = HTMLElement.prototype.scrollIntoView
    const landed: { key: string | null } = { key: null }
    HTMLElement.prototype.scrollIntoView = function () { landed.key = this.getAttribute('data-row-key') }
    const height = (element: Element): number => {
      if (element.classList.contains('outline-test-scroller')) return 800
      if (element.hasAttribute('data-transcript-entry')) return 82
      if (element.hasAttribute('aria-hidden')) return Number.parseFloat((element as HTMLElement).style.height) || 0
      if (element.classList.contains('transcript-virtual-column')) return [...element.children].reduce((sum, child) => sum + height(child), 0)
      return 82
    }
    HTMLElement.prototype.getBoundingClientRect = function () {
      let top = this.classList.contains('outline-test-scroller') ? 0 : -(this.closest('.outline-test-scroller')?.scrollTop ?? 0)
      const row = this.closest('[data-transcript-entry]')
      if (row) for (const sibling of row.parentElement!.children) {
        if (sibling === row) break
        top += height(sibling)
      }
      return { top, bottom: top + height(this), height: height(this), left: 0, right: 800, width: 800, x: 0, y: top, toJSON() {} }
    }
    try {
      const tree = await harness.mount(<NavigableTranscript data={data} mode={mode} />)
      expect(tree.container.querySelector('[data-row-key="history:210"]') === null).toBe(true)
      await click(ticks(tree.container)[210]!)
      await act(async () => { await harness.nextFrame(); await harness.nextFrame() })
      expect(tree.container.querySelector('[data-row-key="history:210"]') !== null).toBe(true)
      expect(landed.key).toBe('history:210')
      expect(tree.container.querySelectorAll('[data-transcript-entry]').length).toBeLessThan(90)
      expect(tree.container.querySelector('.outline-test-scroller')?.contains(tree.container.querySelector('.transcript-outline'))).toBe(false)
      await tree.unmount()
    } finally {
      HTMLElement.prototype.getBoundingClientRect = oldRect
      HTMLElement.prototype.scrollIntoView = oldScrollIntoView
    }
  })
}
