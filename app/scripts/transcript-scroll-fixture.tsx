import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { TranscriptRowsView } from '../renderer/src/TranscriptView.js'
import { observePaneBottomLock } from '../renderer/src/markdownScrollCoordinator.js'
import { ToolsExpandedContext } from '../renderer/src/toolsExpanded.js'
import { captureTranscriptScrollAnchor, restoreTranscriptScroll } from '../renderer/src/transcriptScrollMemory.js'
import type { NestedTranscriptRow } from '../renderer/src/transcriptProjector.js'
import type { SyntheticWheelRequest } from './transcriptScrollWheelInput.js'
import './transcript-scroll-fixture.css'

const root = createRoot(document.getElementById('fixture')!)
const writes: Array<{ owner: string; value: unknown; stack: string | undefined }> = []
const samples: Array<{ scrollTop: number; scrollHeight: number; mounted: number; anchorTop: number | null; anchorError: number | null; observers: number; observedTargets: number }> = []
let useNativeAnchoring = false
let inputMode: 'script' | 'wheel' = 'script'
let inputSequence = 0
let pendingWheel: { request: SyntheticWheelRequest; taken: boolean; resolve: () => void } | null = null
const wheelEvents: Array<{ deltaY: number; isTrusted: boolean; time: number }> = []
let scenario = 'initialization'
const geometryDiagnostics: unknown[] = []
document.addEventListener('wheel', event => {
  wheelEvents.push({ deltaY: event.deltaY, isTrusted: event.isTrusted, time: performance.now() })
}, { passive: true })
const observed = new Map<ResizeObserver, Set<Element>>()
const NativeResizeObserver = window.ResizeObserver
window.ResizeObserver = class extends NativeResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    super(callback)
    observed.set(this, new Set())
  }
  override observe(target: Element, options?: ResizeObserverOptions) {
    super.observe(target, options)
    observed.get(this)!.add(target)
  }
  override unobserve(target: Element) {
    super.unobserve(target)
    observed.get(this)?.delete(target)
  }
  override disconnect() {
    super.disconnect()
    observed.delete(this)
  }
}
// Capture every JS write owner, not only the coordinator. Frame samples and
// visible-character checks also detect motion that has no JS setter call.
const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!
Object.defineProperty(Element.prototype, 'scrollTop', {
  ...descriptor,
  set(value: number) { writes.push({ owner: 'scrollTop', value, stack: new Error().stack }); descriptor.set!.call(this, value) },
})
for (const method of ['scrollTo', 'scrollBy', 'scrollIntoView'] as const) {
  const original = Element.prototype[method] as (...args: unknown[]) => void
  Object.defineProperty(Element.prototype, method, {
    configurable: true,
    value: function (this: Element, ...args: unknown[]) {
      writes.push({ owner: method, value: args, stack: new Error().stack })
      original.apply(this, args)
    },
  })
}

function userRow(index: number): Extract<NestedTranscriptRow, { kind: 'user-text' }> {
  return { id: `history:${index}`, sessionId: 'synthetic', messageId: `m:${index}`, frameId: `f:${index}`,
    blockIndex: 0, parentToolUseId: null, children: [], kind: 'user-text', content: `Synthetic message ${index}`,
    role: 'user', isReplay: false }
}
function proseRow(content: string): NestedTranscriptRow {
  const { kind: _kind, role: _role, isReplay: _replay, ...source } = userRow(0)
  return { ...source, id: 'prose', kind: 'assistant-text', content, role: 'assistant' }
}
function render(rows: NestedTranscriptRow[], variant = ''): HTMLElement {
  flushSync(() => root.render(createElement('div', { className: `scroll-fixture-pane ${variant} ${useNativeAnchoring ? 'scroll-fixture-native' : ''}` },
    createElement(ToolsExpandedContext.Provider, { value: { expanded: true, setExpanded: () => {} } },
      createElement(TranscriptRowsView, { rows, initialScrollRowKey: rows.length > 1 ? 'history:110' : rows[0]?.id })))))
  return document.querySelector<HTMLElement>('.scroll-fixture-pane')!
}
function recordGeometry(pane: HTMLElement, reason: string, tracked?: TrackedCharacter): void {
  const bounds = (element: Element) => {
    const box = element.getBoundingClientRect()
    return { top: box.top, bottom: box.bottom, height: box.height, width: box.width }
  }
  let actualTop: number | null = null
  if (tracked) {
    try { actualTop = readTracked(pane, tracked) } catch { /* Retain the missing-content diagnostic. */ }
  }
  geometryDiagnostics.push({
    scenario, reason, scrollTop: pane.scrollTop, clientHeight: pane.clientHeight,
    scrollHeight: pane.scrollHeight, bounds: bounds(pane),
    overflowAnchor: getComputedStyle(pane).getPropertyValue('overflow-anchor'),
    paneScrollOwner: pane.hasAttribute('data-pane-scroll-owner'),
    tracked: tracked ? { textStart: tracked.text.slice(0, 80), offset: tracked.offset, expectedTop: tracked.top, actualTop } : null,
    buttons: [...pane.querySelectorAll('button[aria-expanded]')].slice(0, 12).map(button => ({
      expanded: button.getAttribute('aria-expanded'), text: button.textContent?.slice(0, 80), bounds: bounds(button),
    })),
    owners: [...pane.querySelectorAll('[data-pane-height-owner]')].slice(0, 8).map(owner => ({
      bounds: bounds(owner), gap: getComputedStyle(owner).rowGap, children: owner.childElementCount,
      entries: [...owner.children].slice(0, 8).map(child => ({
        key: child.getAttribute('data-transcript-entry') ?? child.getAttribute('data-transcript-child'),
        spacerHeight: (child as HTMLElement).style.height, text: child.textContent?.slice(0, 60), bounds: bounds(child),
      })),
    })),
    text: pane.textContent?.slice(0, 300),
  })
  if (geometryDiagnostics.length > 40) geometryDiagnostics.shift()
}
async function settle(pane: HTMLElement, count = 12, tracked?: TrackedCharacter, expectedTop = tracked?.top,
  motion?: { start: number; delta: 2 | -2 }) {
  let previousScrollTop = motion?.start
  for (let frame = 0; frame < count; frame++) {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    // Read after all frame callbacks, not between the fixture's callback and
    // the coordinator's callback in the same pre-paint batch.
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    const expectedOwnership = useNativeAnchoring ? 'auto' : 'none'
    if (!pane.hasAttribute('data-pane-scroll-owner') ||
      getComputedStyle(pane).getPropertyValue('overflow-anchor') !== expectedOwnership) {
      recordGeometry(pane, 'scroll correction ownership changed')
      throw new Error(`Unexpected scroll correction ownership: ${scenario}`)
    }
    if (motion && tracked) {
      const progress = (pane.scrollTop - motion.start) * Math.sign(motion.delta)
      const reversal = (pane.scrollTop - previousScrollTop!) * Math.sign(motion.delta)
      if (progress < -1 || progress > Math.abs(motion.delta) + 1 || reversal < -1) {
        throw new Error(`Wheel step moved outside its intended range: start ${motion.start}, delta ${motion.delta}, actual ${pane.scrollTop}`)
      }
      previousScrollTop = pane.scrollTop
      expectedTop = tracked.top - (pane.scrollTop - motion.start)
    }
    let anchorTop: number | null = null
    if (tracked) {
      try { anchorTop = readTracked(pane, tracked) } catch { /* Sample remount gaps, too. */ }
    }
    samples.push({ scrollTop: pane.scrollTop, scrollHeight: pane.scrollHeight,
      mounted: pane.querySelectorAll('[data-transcript-entry]').length, anchorTop,
      anchorError: anchorTop === null || expectedTop === undefined ? null : anchorTop - expectedTop,
      observers: observed.size, observedTargets: [...observed.values()].reduce((sum, targets) => sum + targets.size, 0) })
  }
}
async function movePane(pane: HTMLElement, delta: 2 | -2): Promise<void> {
  if (inputMode === 'script') {
    pane.scrollTop += delta
    return
  }
  if (pendingWheel) throw new Error('A wheel request is already pending')
  const rect = pane.getBoundingClientRect()
  await new Promise<void>(resolve => {
    pendingWheel = {
      request: {
        id: ++inputSequence, deltaY: delta,
        x: Math.min(rect.left + 100, window.innerWidth - 16),
        y: Math.min(rect.top + pane.clientHeight / 2, window.innerHeight - 16),
      },
      taken: false, resolve,
    }
  })
}
function takeWheelRequest(): SyntheticWheelRequest | null {
  if (!pendingWheel || pendingWheel.taken) return null
  pendingWheel.taken = true
  return pendingWheel.request
}
function acknowledgeWheelRequest(id: number): void {
  if (!pendingWheel || pendingWheel.request.id !== id) throw new Error(`Unexpected wheel acknowledgement: ${id}`)
  const { resolve } = pendingWheel
  pendingWheel = null
  resolve()
}
async function scrollStep(pane: HTMLElement, delta: 2 | -2, count: number) {
  const tracked = track(pane)
  const start = pane.scrollTop
  const writeCount = writes.length
  const wheelCount = wheelEvents.length
  await movePane(pane, delta)
  await settle(pane, count, tracked, tracked.top - delta, inputMode === 'wheel' ? { start, delta } : undefined)
  assertClose(pane.scrollTop - start, delta, 'intentional scroll distance')
  assertClose(readTracked(pane, tracked), tracked.top - delta, 'visible character during intentional scrolling')
  if (inputMode === 'wheel') {
    if (!wheelEvents.slice(wheelCount).some(event => event.isTrusted && event.deltaY === delta)) {
      throw new Error('Chromium did not deliver the requested trusted wheel input')
    }
    if (writes.length !== writeCount) throw new Error('An automatic JS scroll write interrupted the wheel step')
  }
  return { tracked, anchorError: readTracked(pane, tracked) - (tracked.top - delta), writes: writes.length - writeCount }
}
type TrackedCharacter = { text: string; offset: number; top: number }
function track(pane: HTMLElement): TrackedCharacter {
  const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  const paneTop = pane.getBoundingClientRect().top
  let node: Node | null
  while ((node = walker.nextNode())) {
    const text = node as Text
    if (!/Synthetic message|Paragraph/.test(text.data)) continue
    range.selectNodeContents(text)
    const box = range.getBoundingClientRect()
    if (box.bottom <= paneTop || box.top >= paneTop + pane.clientHeight) continue
    let offset = 0
    // Intentionally independent of the production anchor's binary search.
    while (offset < text.length - 1) {
      range.setStart(text, offset); range.setEnd(text, offset + 1)
      if (range.getBoundingClientRect().bottom > paneTop) break
      offset++
    }
    range.setStart(text, offset); range.setEnd(text, offset + 1)
    return { text: text.data, offset, top: range.getBoundingClientRect().top - paneTop }
  }
  recordGeometry(pane, 'no visible synthetic character')
  throw new Error(`No synthetic visible character is mounted: ${scenario}`)
}
function readTracked(pane: HTMLElement, tracked: TrackedCharacter): number {
  const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) {
    if ((node as Text).data !== tracked.text) continue
    const range = document.createRange()
    range.setStart(node, tracked.offset); range.setEnd(node, tracked.offset + 1)
    return range.getBoundingClientRect().top - pane.getBoundingClientRect().top
  }
  throw new Error('The tracked content disappeared from the mounted window')
}
function assertClose(actual: number, expected: number, label: string) {
  if (Math.abs(actual - expected) > 1) throw new Error(`${label}: expected ${expected}, got ${actual}`)
}

async function run(options: { nativeAnchoring?: boolean; inputMode?: 'script' | 'wheel' } = {}) {
  const { nativeAnchoring = false } = options
  if (pendingWheel) throw new Error('The previous wheel run is still active')
  useNativeAnchoring = nativeAnchoring
  inputMode = options.inputMode ?? 'script'
  inputSequence = 0
  wheelEvents.length = 0
  writes.length = 0
  samples.length = 0
  geometryDiagnostics.length = 0
  await document.fonts.ready
  const results: Array<{ scenario: string; anchorError: number; writes: number }> = []
  const rowCases = ['', 'scroll-fixture-short', 'scroll-fixture-tall']
  for (const variant of rowCases) {
    scenario = `outer rows: ${variant || 'equal'}`
    flushSync(() => root.render(null))
    const rows = Array.from({ length: 800 }, (_, index) => userRow(index))
    const pane = render(rows, `scroll-fixture-fixed ${variant}`)
    pane.scrollTop = 9_050
    await settle(pane)
    const { tracked, anchorError: error, writes: stepWrites } = await scrollStep(pane, 2, 12)
    assertClose(error, 0, `lower edge ${variant || 'equal'}`)
    results.push({ scenario: `lower edge ${variant || 'equal'}`, anchorError: error, writes: stepWrites })
    for (let step = 0; step < 8; step++) {
      const movement = step % 2 === 0 ? -2 : 2
      await scrollStep(pane, movement, 12)
    }
    // Exercise measurement-cache turnover and a genuine node remount.
    for (let offset = 12_000; offset <= 64_000; offset += 4_000) {
      pane.scrollTop = offset
      await settle(pane)
    }
    pane.scrollTop = 9_052; await settle(pane)
    assertClose(readTracked(pane, tracked), tracked.top - 2, 'remount/cache turnover')
    if (pane.querySelectorAll('[data-transcript-entry]').length > 80) throw new Error('Mounted-row ceiling exceeded')
    const saved = captureTranscriptScrollAnchor(pane, { atBottom: false })
    flushSync(() => root.render(null))
    const rebound = render(rows, `scroll-fixture-fixed ${variant}`)
    restoreTranscriptScroll(rebound, { anchor: saved })
    await settle(rebound, 12, tracked, tracked.top - 2)
    assertClose(readTracked(rebound, tracked), tracked.top - 2, 'saved-position restoration')
  }
  flushSync(() => root.render(null))
  const agent: NestedTranscriptRow = {
    id: 'synthetic-agent', sessionId: 'synthetic', messageId: 'agent-message', frameId: 'agent-frame',
    blockIndex: 0, parentToolUseId: null, kind: 'tool-use', toolUseId: 'agent-tool',
    toolName: 'Agent', toolFamily: 'agent', agentCompletion: null,
    input: { subagent_type: 'Explore', description: 'Synthetic nested history' },
    status: 'success', result: { content: 'Complete', isError: false, diff: null },
    children: Array.from({ length: 200 }, (_, index) => userRow(index)),
  }
  const nestedPane = render([agent])
  scenario = 'nested agent'
  recordGeometry(nestedPane, 'rendered nested agent')
  const disclosure = nestedPane.querySelector<HTMLButtonElement>(
    '[data-transcript-entry="synthetic-agent"] button[aria-expanded]',
  )
  if (!disclosure || disclosure.getAttribute('aria-expanded') !== 'false') {
    throw new Error('Synthetic foreground agent did not start with its production collapsed default')
  }
  // AgentToolCard deliberately ignores ToolsExpandedContext (C4). Open its real
  // disclosure for setup rather than changing that product default.
  flushSync(() => disclosure.click())
  await settle(nestedPane)
  if (disclosure.getAttribute('aria-expanded') !== 'true' || !nestedPane.querySelector('[data-transcript-child]')) {
    recordGeometry(nestedPane, 'agent disclosure failed to open')
    throw new Error('Opening the production agent disclosure did not mount its nested history')
  }
  recordGeometry(nestedPane, 'opened production agent disclosure')
  nestedPane.scrollTop = 1_000
  await settle(nestedPane)
  recordGeometry(nestedPane, 'nested agent after scroll and settling')
  const nestedTracked = track(nestedPane)
  const nestedWriteCount = writes.length
  for (let step = 0; step < 20; step++) {
    await scrollStep(nestedPane, 2, 12)
  }
  const nestedBody = nestedPane.querySelector('[data-transcript-child]')?.parentElement
  if (!nestedBody || nestedBody.querySelectorAll(':scope > [data-transcript-child]').length > 80) {
    throw new Error('Nested mounted-row ceiling exceeded or nested body missing')
  }
  const childBoxes = [...nestedBody.children].map(child => child.getBoundingClientRect())
  const gap = Number.parseFloat(getComputedStyle(nestedBody).rowGap)
  assertClose(gap, 8, 'nested flex gap')
  assertClose(nestedBody.getBoundingClientRect().height,
    childBoxes.reduce((total, box) => total + box.height, 0) + (childBoxes.length - 1) * gap,
    'nested measured spacer and gap total')
  const nestedError = readTracked(nestedPane, nestedTracked) - (nestedTracked.top - 40)
  assertClose(nestedError, 0, 'nested cumulative intentional motion')
  results.push({ scenario: 'nested gaps and measurements', anchorError: nestedError, writes: writes.length - nestedWriteCount })
  flushSync(() => root.render(null))
  const paragraph = (index: number) => `Paragraph ${index.toString().padStart(3, '0')}: ` + 'Synthetic reading content with wrapped lines. '.repeat(12)
  let paragraphs = Array.from({ length: 100 }, (_, index) => paragraph(index))
  let rows = [proseRow(paragraphs.join('\n\n'))]
  const pane = render(rows, 'scroll-fixture-prose')
  scenario = 'Markdown initialization'
  pane.scrollTop = 1_000; await settle(pane)
  for (const step of ['append below', 'equal-height prepend and tail removal', 'resize', 'prepend rows'] as const) {
    scenario = `Markdown: ${step}`
    const tracked = track(pane)
    const start = writes.length
    recordGeometry(pane, 'before change', tracked)
    if (step === 'append below') paragraphs.push(paragraph(100))
    if (step === 'equal-height prepend and tail removal') { paragraphs = [paragraph(999), ...paragraphs.slice(0, -1)] }
    rows = [proseRow(paragraphs.join('\n\n'))]
    if (step === 'resize') pane.classList.add('scroll-fixture-narrow')
    if (step === 'prepend rows') rows = [userRow(999), ...rows]
    render(rows, `scroll-fixture-prose ${step === 'resize' ? 'scroll-fixture-narrow' : ''}`)
    await settle(pane, 12, tracked)
    recordGeometry(pane, 'after change', tracked)
    const error = readTracked(pane, tracked) - tracked.top
    assertClose(error, 0, step)
    results.push({ scenario: step, anchorError: error, writes: writes.length - start })
  }
  scenario = 'bottom following'
  let following = true
  const release = observePaneBottomLock(pane, () => following)
  pane.scrollTop = pane.scrollHeight; await settle(pane)
  paragraphs.push(paragraph(101)); render([proseRow(paragraphs.join('\n\n'))], 'scroll-fixture-prose')
  await settle(pane)
  assertClose(pane.scrollHeight - pane.clientHeight - pane.scrollTop, 0, 'bottom follow')
  following = false
  scenario = 'released follow'
  pane.scrollTop = 1_000; await settle(pane)
  const tracked = track(pane)
  paragraphs.push(paragraph(102)); render([proseRow(paragraphs.join('\n\n'))], 'scroll-fixture-prose')
  await settle(pane, 12, tracked)
  assertClose(readTracked(pane, tracked), tracked.top, 'released follow')
  release()
  flushSync(() => root.render(null))
  if (observed.size !== 0) throw new Error(`Observers retained after unmount: ${observed.size}`)
  const peakAnchorError = samples.reduce((peak, sample) => Math.max(peak, Math.abs(sample.anchorError ?? 0)), 0)
  if (peakAnchorError > 1) throw new Error(`Transient visible-character error: ${peakAnchorError}px`)
  return { results, writes, samples, wheelEvents, geometryDiagnostics, inputMode, peakAnchorError, userAgent: navigator.userAgent,
    evidence: 'Input delivery and DOM layout geometry, not captured paint.' }
}

Object.assign(window, { transcriptScrollRegression: {
  run, takeWheelRequest, acknowledgeWheelRequest, diagnostics: { writes, samples, wheelEvents, geometryDiagnostics },
} })
