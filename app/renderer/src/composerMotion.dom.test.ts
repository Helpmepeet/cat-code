import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import type { SDKMessage } from '@cat-code/engine/session-events'
import type { RunControlsSnapshot } from '../../shared/protocol.js'
import type { ServerFrame } from '../../shared/protocol.js'
import { ComposerActionsBar } from './ComposerActionsBar.js'
import { MentionPicker } from './MentionPicker.js'
import { PermissionModeChip } from './PermissionModeChip.js'
import { PermissionQueue } from './PermissionQueue.js'
import { PlanPanel } from './PlanPanel.js'
import { SessionPane } from './SessionPane.js'
import { SlashCommandPicker } from './SlashCommandPicker.js'
import { ContextGauge } from './ContextGauge.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import type { PermissionQueueItem, PermissionRequest } from './permissionState.js'
import { idleSessionPaneProps } from './sessionPaneTestProps.js'
import { createTranscriptState, projectServerFrame } from './transcriptProjector.js'

let harness: DomTestHarness
let scrollIntoView: typeof HTMLElement.prototype.scrollIntoView
let elementAnimate: typeof HTMLElement.prototype.animate

beforeAll(async () => {
  harness = await createDomTestHarness()
  scrollIntoView = HTMLElement.prototype.scrollIntoView
  HTMLElement.prototype.scrollIntoView = () => {}
  // happy-dom has no Web Animations API; the Welcome flight (behavior 3)
  // drives one directly (it bypasses CSS), so it needs a stand-in here. The
  // promise resolves on a real timer, not immediately, so a test can observe
  // the flight mid-air rather than always racing straight to its landing.
  elementAnimate = HTMLElement.prototype.animate
  HTMLElement.prototype.animate = function (): Animation {
    return {
      finished: new Promise(resolve => setTimeout(resolve, 30)),
      cancel() {},
      finish() {},
    } as unknown as Animation
  }
})

afterEach(async () => {
  await harness.unmountAll()
})

afterAll(async () => {
  HTMLElement.prototype.scrollIntoView = scrollIntoView
  HTMLElement.prototype.animate = elementAnimate
  await harness.teardown()
})

const REQUEST: PermissionRequest = {
  requestId: 'first',
  request: {
    subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'date' }, tool_use_id: 'tool-1',
  },
}

function queueItem(request: PermissionRequest, submitted = false): PermissionQueueItem {
  return { request, submitted, dismissed: false }
}

function queue(items: PermissionQueueItem[]) {
  return createElement(PermissionQueue, {
    items, onAllow: () => {}, onDeny: () => {}, onRestore: () => {},
  })
}

test('permission cards arrive only after the queue was mounted and submitted opacity clears on failure', async () => {
  const first = queueItem(REQUEST)
  const second = queueItem({ ...REQUEST, requestId: 'second' })
  const tree = await harness.mount(queue([first]))
  const card = (id: string) => [...tree.container.querySelectorAll<HTMLElement>('[role="alertdialog"]')]
    .find(node => node.getAttribute('aria-labelledby') === `permission-title-${id}`)

  expect(card('first')?.classList.contains('animate-toast-in')).toBe(false)
  await tree.render(queue([first, second]))
  expect(card('second')?.classList.contains('animate-toast-in')).toBe(true)
  expect(card('first')?.classList.contains('animate-toast-in')).toBe(false)
  await tree.render(queue([first, second]))
  expect(card('second')?.classList.contains('animate-toast-in')).toBe(true)
  await tree.render(queue([first, queueItem(second.request, true)]))
  expect(card('second')?.classList.contains('opacity-55')).toBe(true)
  await tree.render(queue([first, second]))
  expect(card('second')?.classList.contains('opacity-55')).toBe(false)
  await tree.unmount()

  const remounted = await harness.mount(queue([first, second]))
  expect(remounted.container.querySelector('[aria-labelledby="permission-title-second"]')
    ?.classList.contains('animate-toast-in')).toBe(false)

  await remounted.unmount()
  const empty = await harness.mount(queue([]))
  await empty.render(queue([first]))
  expect(empty.container.querySelector('[role="alertdialog"]')?.classList.contains('animate-toast-in')).toBe(true)
})

const COMPACT = {
  enabled: true, threshold: 187_000, warningThreshold: 167_000,
} as RunControlsSnapshot['autoCompact']

function rail(usedTokens: number, cacheExpired: boolean | null = null) {
  return createElement(ComposerActionsBar, {
    attachDisabled: false, onAttach: () => {}, model: null, reasoningEffort: null,
    fastMode: null, permissionContext: null, onSetMode: () => {}, account: null,
    contextUsage: { usedTokens, contextWindow: 200_000, percentUsed: Math.round(usedTokens / 2_000) },
    runControls: { autoCompact: COMPACT, cacheExpired } as RunControlsSnapshot,
  })
}

test('cache status changes do not add a toolbar action or open a popover', async () => {
  const tree = await harness.mount(rail(167_000))
  const indicator = () => tree.container.querySelector<HTMLElement>('[aria-label="Cache expired"]')
  const faces = () => [...tree.container.querySelectorAll('[data-composer-face]')]
    .map(node => node.getAttribute('data-composer-face'))
  const before = faces()
  expect(indicator()).toBeNull()
  await tree.render(rail(167_000, true))
  expect(indicator()?.tagName).toBe('SPAN')
  expect(indicator()?.getAttribute('role')).toBe('status')
  expect(indicator()?.querySelector('.composer-cache-label')?.textContent).toBe('Cache expired')
  await act(async () => {
    indicator()?.click()
  })
  expect(tree.container.querySelector('[role="dialog"]')).toBeNull()
  expect(faces()).toEqual(before)
  expect(faces()).not.toContain('token-warning')
  await tree.render(rail(167_000, false))
  expect(indicator()).toBeNull()
  await tree.render(rail(167_000, true))
  expect(indicator()).not.toBeNull()
  await tree.render(rail(167_000, null))
  expect(indicator()).toBeNull()
})

test('keyboard cursor rows switch without a colour transition', async () => {
  const commands = [{ name: 'help', description: 'Help', argumentHint: '' }, { name: 'status', description: 'Status', argumentHint: '' }]
  const slash = (activeIndex: number) => createElement(SlashCommandPicker, {
    open: true, query: '', commands, activeIndex, onPick: () => {},
  })
  const tree = await harness.mount(slash(0))
  const slashRows = () => [...tree.container.querySelectorAll<HTMLButtonElement>('[data-slash-active]')]
  expect(slashRows()[0]?.classList.contains('transition-colors')).toBe(false)
  await tree.render(slash(1))
  expect(slashRows()[1]?.classList.contains('transition-colors')).toBe(false)
  expect(slashRows()[0]?.classList.contains('transition-colors')).toBe(false)
  await tree.unmount()

  const mention = (activeIndex: number) => createElement(MentionPicker, {
    open: true, query: '', items: [{ label: 'A' }, { label: 'B' }], activeIndex,
    onPick: () => {},
  })
  const mentions = await harness.mount(mention(0))
  const mentionRows = () => [...mentions.container.querySelectorAll<HTMLButtonElement>('[data-mention-active]')]
  expect(mentionRows()[0]?.classList.contains('transition-colors')).toBe(false)
  await mentions.render(mention(1))
  expect(mentionRows()[1]?.classList.contains('transition-colors')).toBe(false)
  expect(mentionRows()[0]?.classList.contains('transition-colors')).toBe(false)
})

test('permission mode popover enters on opening and disappears immediately on close', async () => {
  const context = {
    mode: 'default', alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {},
    ruleMetadata: [], managedRulesOnly: false, permissionClassifierEnabled: false,
    additionalWorkingDirectories: [], isBypassPermissionsModeAvailable: false,
  }
  const tree = await harness.mount(createElement(PermissionModeChip, { context, onSetMode: () => {} }))
  const trigger = tree.container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')
  expect(tree.container.querySelector('[role="menu"]')).toBeNull()
  await act(async () => { trigger?.click() })
  expect(tree.container.querySelector('[role="menu"]')?.classList.contains('animate-pop-up')).toBe(true)
  await act(async () => { trigger?.click() })
  expect(tree.container.querySelector('[role="menu"]')).toBeNull()
})

test('context arc and tone carry value transitions as usage changes', async () => {
  const gauge = (percentUsed: number) => createElement(ContextGauge, {
    usage: { usedTokens: percentUsed * 2_000, contextWindow: 200_000, percentUsed },
  })
  const tree = await harness.mount(gauge(40))
  const ring = () => tree.container.querySelectorAll('circle')[1]
  expect(ring()?.classList.contains('transition-[stroke-dasharray,stroke]')).toBe(true)
  const oldArc = ring()?.getAttribute('stroke-dasharray')
  await tree.render(gauge(80))
  expect(ring()?.getAttribute('stroke-dasharray')).not.toBe(oldArc)
  expect(tree.container.querySelector('[aria-label="Context 80% used"]')
    ?.classList.contains('transition-colors')).toBe(true)
})

test('plan dialog and approve menu enter without delaying close', async () => {
  const review = {
    request: REQUEST, submitted: false,
    data: { plan: '1. Check', planFilePath: null, allowedPrompts: [] },
  }
  const panel = (open: boolean) => createElement(PlanPanel, {
    open, review, onApprove: () => {}, onClose: () => {}, onRevise: () => {},
  })
  const tree = await harness.mount(panel(false))
  await tree.render(panel(true))
  expect(tree.container.querySelector('[role="dialog"]')?.classList.contains('animate-sa-pop')).toBe(true)
  expect(tree.container.firstElementChild?.classList.contains('animate-scrim-in')).toBe(true)
  // The menu is only mounted for the open edge; it leaves with the dialog.
  const approve = [...tree.container.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.textContent?.includes('Approve plan'))
  await act(async () => { approve?.click() })
  expect(tree.container.querySelector('[role="menu"]')?.classList.contains('animate-sa-pop')).toBe(true)
  await tree.render(panel(false))
  expect(tree.container.querySelector('[role="dialog"]')).toBeNull()
})

function pane(overrides: Record<string, unknown> = {}) {
  return createElement(SessionPane, { ...idleSessionPaneProps(), ...overrides } as never)
}

test('question arrival and failed submission follow the pane mount', async () => {
  const question = {
    request: { ...REQUEST, requestId: 'question-1' }, submitted: false,
    questions: [{ question: 'Which?', header: 'Choice', multiSelect: false, options: [
      { label: 'A', description: 'First', preview: null },
      { label: 'B', description: 'Second', preview: null },
    ] }],
  }
  const tree = await harness.mount(pane({ askQuestion: question }))
  const card = () => [...tree.container.querySelectorAll<HTMLElement>('div')]
    .find(node => node.classList.contains('transition-opacity') && node.textContent?.includes('Which?'))
  expect(card()?.classList.contains('animate-toast-in')).toBe(false)
  await tree.render(pane({ askQuestion: null }))
  await tree.render(pane({ askQuestion: question }))
  expect(card()?.classList.contains('animate-toast-in')).toBe(true)
  await tree.render(pane({ askQuestion: question }))
  expect(card()?.classList.contains('animate-toast-in')).toBe(true)
  await tree.render(pane({ askQuestion: { ...question, submitted: true } }))
  expect(card()?.classList.contains('opacity-55')).toBe(true)
  await tree.render(pane({ askQuestion: question }))
  expect(card()?.classList.contains('opacity-55')).toBe(false)
  await tree.unmount()
  const remounted = await harness.mount(pane({ askQuestion: question }))
  expect(remounted.container.querySelector('.animate-toast-in')).toBeNull()
})

test('Latest settles when a run ends above the reader and jumps instantly', async () => {
  const running = { status: 'ready', inputEnabled: false }
  const idle = { status: 'ready', inputEnabled: true }
  const tree = await harness.mount(pane({ activeConnection: idle }))
  const scroller = tree.container.querySelector<HTMLElement>('.overflow-auto')
  if (!scroller) throw new Error('missing transcript scroller')
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1_000 })
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })
  await act(async () => {
    scroller.scrollTop = 600
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    scroller.scrollTop = 300
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
  const latest = () => [...tree.container.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.textContent?.includes('Latest'))
  expect(latest()).toBeDefined()
  expect(latest()?.querySelector('span')?.classList.contains('animate-settle')).toBe(false)
  await tree.render(pane({ activeConnection: running }))
  await tree.render(pane({ activeConnection: idle }))
  expect(latest()?.querySelector('span')?.classList.contains('animate-settle')).toBe(true)
  await tree.render(pane({ activeConnection: idle }))
  expect(latest()?.querySelector('span')?.classList.contains('animate-settle')).toBe(true)
  expect(latest()?.classList.contains('-translate-x-1/2')).toBe(true)
  let options: ScrollToOptions | undefined
  scroller.scrollTo = ((value?: ScrollToOptions | number) => {
    if (typeof value === 'object') options = value
  }) as typeof scroller.scrollTo
  await act(async () => { latest()?.click() })
  expect(options?.behavior).toBe('instant')
  await tree.unmount()
  const remounted = await harness.mount(pane({ activeConnection: idle }))
  const remountScroller = remounted.container.querySelector<HTMLElement>('.overflow-auto')
  if (!remountScroller) throw new Error('missing remounted transcript scroller')
  Object.defineProperty(remountScroller, 'scrollHeight', { configurable: true, value: 1_000 })
  Object.defineProperty(remountScroller, 'clientHeight', { configurable: true, value: 400 })
  await act(async () => {
    remountScroller.scrollTop = 600
    remountScroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    remountScroller.scrollTop = 300
    remountScroller.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
  const remountLatest = [...remounted.container.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.textContent?.includes('Latest'))
  expect(remountLatest?.querySelector('span')?.classList.contains('animate-settle')).toBe(false)
})

// ── Send-message motion (docs/design-html/2026-09-28-send-message-motion.html) ──

const SEND_SESSION_ID = 'session-1'
const READY = { status: 'ready' as const, inputEnabled: true }
const CONNECTING = { status: 'connecting' as const, inputEnabled: false }
const readyFrame: ServerFrame = {
  kind: 'ready', protocolVersion: 2, sessionId: SEND_SESSION_ID, engineSessionId: 'engine-send',
  payload: {
    type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false,
    abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [],
  },
}
const messageFrame = (message: SDKMessage): ServerFrame => ({
  kind: 'event', protocolVersion: 2, sessionId: SEND_SESSION_ID, event: { type: 'message', message },
})
const userText = (uuid: string, text: string): SDKMessage => ({
  type: 'user', uuid: uuid as never, parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'text', text }] },
} as SDKMessage)
const assistantText = (uuid: string, text: string): SDKMessage => ({
  type: 'assistant', uuid: uuid as never, parent_tool_use_id: null, session_id: 'engine-send',
  message: { id: uuid, role: 'assistant', content: [{ type: 'text', text }] },
} as SDKMessage)
/** One finished turn already in the transcript, so a fresh send exercises the
 * ORDINARY composer lift and in-chat slide, not the empty-chat Welcome path. */
function seededTranscript() {
  let state = projectServerFrame(createTranscriptState(), readyFrame)
  state = projectServerFrame(state, messageFrame(userText('seed-u', 'hi')))
  state = projectServerFrame(state, messageFrame(assistantText('seed-a', 'hello')))
  return state
}
function withUserRow(state: ReturnType<typeof seededTranscript>, uuid: string, text: string) {
  return projectServerFrame(state, messageFrame(userText(uuid, text)))
}
function sendPane(overrides: Record<string, unknown> = {}) {
  return pane({
    activeSessionId: SEND_SESSION_ID,
    prompt: 'a fresh message',
    transcript: seededTranscript(),
    ...overrides,
  })
}
const sendGhost = (tree: { container: HTMLElement }) => tree.container.querySelector('.composer-ghost')
const sendArrow = (tree: { container: HTMLElement }) =>
  tree.container.querySelector<SVGElement>('button[aria-label="Send prompt"] svg')
const stopGlyph = (tree: { container: HTMLElement }) =>
  tree.container.querySelector<SVGElement>('button[aria-label="Stop the turn"] svg')
const composerForm = (tree: { container: HTMLElement }) =>
  tree.container.querySelector<HTMLFormElement>('form[aria-label="Composer"]')
async function withReducedMotion(run: () => Promise<void>): Promise<void> {
  const original = window.matchMedia
  window.matchMedia = ((query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' })) as typeof window.matchMedia
  try {
    await run()
  } finally {
    window.matchMedia = original
  }
}

test('the composer lift plays for an immediate send, fades the send arrow, and neither happens held or under reduced motion', async () => {
  const tree = await harness.mount(sendPane({ activeConnection: READY }))
  await act(async () => { composerForm(tree)?.requestSubmit() })
  expect(sendGhost(tree)).not.toBeNull()
  expect(sendGhost(tree)?.classList.contains('animate-composer-lift')).toBe(true)
  expect(sendArrow(tree)?.classList.contains('animate-composer-glyph-out')).toBe(true)
  await tree.unmount()

  // No engine attached yet (CC-16 hold): behavior 1 is scoped to an
  // immediate send, so an ordinary (non-empty-chat) held submit gets none of
  // this — today's instant clear, unchanged.
  const held = await harness.mount(sendPane({ activeConnection: CONNECTING }))
  await act(async () => { composerForm(held)?.requestSubmit() })
  expect(sendGhost(held)).toBeNull()
  await held.unmount()

  await withReducedMotion(async () => {
    const reduced = await harness.mount(sendPane({ activeConnection: READY }))
    await act(async () => { composerForm(reduced)?.requestSubmit() })
    expect(sendGhost(reduced)).toBeNull()
    expect(sendArrow(reduced)?.classList.contains('animate-composer-glyph-out')).toBe(false)
    await reduced.unmount()
  })
})

test('the Stop glyph arrives only once the turn from an eligible send actually goes live', async () => {
  const tree = await harness.mount(sendPane({ activeConnection: READY }))
  await act(async () => { composerForm(tree)?.requestSubmit() })
  // Echo latency (CC-16): the turn has not gone live yet — no Stop button at
  // all, so nothing to have arrived.
  expect(stopGlyph(tree)).toBeNull()
  await tree.render(sendPane({ activeConnection: { status: 'ready', inputEnabled: false } }))
  expect(stopGlyph(tree)).not.toBeNull()
  expect(stopGlyph(tree)?.classList.contains('animate-arrive')).toBe(true)
  await tree.unmount()

  // Mounting directly into a live turn (a tab switch to a session already
  // generating) never went through an eligible send in THIS pane: no arrival.
  const alreadyLive = await harness.mount(
    sendPane({ activeConnection: { status: 'ready', inputEnabled: false } }),
  )
  expect(stopGlyph(alreadyLive)).not.toBeNull()
  expect(stopGlyph(alreadyLive)?.classList.contains('animate-arrive')).toBe(false)
})

test('the in-turn activity row arrives for a fresh live send pinned to bottom, not scrolled up or during load-earlier', async () => {
  const live = { status: 'ready' as const, inputEnabled: false }
  // `ActivityIndicator`'s own root div, so its wrapper (behavior 2's own
  // `animate-arrive`) is the one directly above it.
  const activityWrap = (tree: { container: HTMLElement }) =>
    [...tree.container.querySelectorAll('div')]
      .find(node => node.className === 'flex items-center gap-2.5 bg-transparent px-1 py-1.5 text-xs')
      ?.parentElement

  const base = seededTranscript()
  const tree = await harness.mount(sendPane({ activeConnection: READY, transcript: base }))
  await act(async () => { composerForm(tree)?.requestSubmit() })
  await tree.render(sendPane({ activeConnection: live, transcript: base }))
  expect(activityWrap(tree)?.classList.contains('animate-arrive')).toBe(true)
  await act(async () => {
    activityWrap(tree)?.dispatchEvent(new Event('animationend', { bubbles: true }))
  })
  expect(activityWrap(tree)?.classList.contains('animate-arrive')).toBe(false)
  await tree.render(sendPane({
    activeConnection: live, transcript: withUserRow(base, 'live-1', 'second message'),
  }))
  expect(activityWrap(tree)?.classList.contains('animate-arrive')).toBe(false)
  await tree.unmount()

  // Never on first mount: the row is already there when the pane appears.
  const mounted = await harness.mount(sendPane({
    activeConnection: live, transcript: withUserRow(base, 'live-1', 'second message'),
  }))
  expect(activityWrap(mounted)?.classList.contains('animate-arrive')).toBe(false)
  await mounted.unmount()

  // Scrolled up: the reader is not following the end, so nothing pushes.
  const scrolledUp = await harness.mount(sendPane({ activeConnection: READY, transcript: base }))
  const scroller = scrolledUp.container.querySelector<HTMLElement>('.overflow-auto')
  if (!scroller) throw new Error('missing transcript scroller')
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1_000 })
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })
  await act(async () => {
    scroller.scrollTop = 600
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    scroller.scrollTop = 300
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
  await act(async () => { composerForm(scrolledUp)?.requestSubmit() })
  await scrolledUp.render(sendPane({ activeConnection: live, transcript: base }))
  expect(activityWrap(scrolledUp)?.classList.contains('animate-arrive')).toBe(false)
  await scrolledUp.render(sendPane({
    activeConnection: live, transcript: withUserRow(base, 'live-2', 'third message'),
  }))
  expect(activityWrap(scrolledUp)?.classList.contains('animate-arrive')).toBe(false)
  await scrolledUp.unmount()

  // A read further back landing must never read as a live send.
  const loadingEarlier = await harness.mount(sendPane({
    activeConnection: READY, transcript: base, historyLoadEarlierPending: true,
  }))
  await act(async () => { composerForm(loadingEarlier)?.requestSubmit() })
  await loadingEarlier.render(sendPane({
    activeConnection: live, transcript: base, historyLoadEarlierPending: true,
  }))
  expect(activityWrap(loadingEarlier)?.classList.contains('animate-arrive')).toBe(false)
  await loadingEarlier.render(sendPane({
    activeConnection: live, transcript: withUserRow(base, 'live-3', 'fourth message'),
    historyLoadEarlierPending: true,
  }))
  expect(activityWrap(loadingEarlier)?.classList.contains('animate-arrive')).toBe(false)
})

test('turn start slides the pinned transcript when the activity dock shrinks its viewport before the echo', async () => {
  const tree = await harness.mount(sendPane({ activeConnection: READY }))
  const scroller = tree.container.querySelector<HTMLElement>('.overflow-auto')
  const column = tree.container.querySelector<HTMLElement>('.transcript-col-slide')
  if (!scroller || !column) throw new Error('missing transcript geometry')
  expect(column.classList.contains('is-sliding')).toBe(false)

  await act(async () => { composerForm(tree)?.requestSubmit() })
  await tree.render(sendPane({ activeConnection: { status: 'ready', inputEnabled: false } }))
  scroller.scrollTop = 40
  scroller.append(harness.document.createElement('span'))
  await harness.nextFrame()
  await harness.nextFrame()
  expect(column.classList.contains('is-sliding')).toBe(true)
  column.dispatchEvent(new Event('transitionend'))
  expect(column.classList.contains('is-sliding')).toBe(false)
})

test('the Welcome flight lands on the echoed bubble and hides it until then; a held first send falls back to the plain lift and still exits Welcome', async () => {
  const empty = createTranscriptState()
  const tree = await harness.mount(sendPane({ activeConnection: READY, transcript: empty }))
  expect(tree.container.textContent).toContain('Welcome back')
  await act(async () => { composerForm(tree)?.requestSubmit() })
  // The draft stays visible (the ghost, statically) rather than lifting away.
  expect(sendGhost(tree)).not.toBeNull()
  expect(sendGhost(tree)?.classList.contains('animate-composer-lift')).toBe(false)

  let withRow = projectServerFrame(empty, readyFrame)
  withRow = projectServerFrame(withRow, messageFrame(userText('first-u', 'a fresh message')))
  await tree.render(sendPane({ activeConnection: READY, transcript: withRow }))
  // Portaled to `document.body` (behavior 3's own spec: the transcript
  // scroller's overflow would otherwise clip its trip up from the composer).
  expect(harness.document.body.querySelector('.send-flight')).not.toBeNull()
  expect(tree.container.querySelector('[data-user-bubble]')?.classList.contains('invisible')).toBe(true)
  expect(tree.container.textContent).toContain('Welcome back')
  await tree.unmount()

  // Held (cold-spawn Queued path): never draws a flight — the plain lift
  // instead, and Welcome still exits once the parked prompt's row lands.
  const held = await harness.mount(sendPane({
    activeConnection: CONNECTING, transcript: empty, pendingSubmit: null,
  }))
  await act(async () => { composerForm(held)?.requestSubmit() })
  expect(harness.document.body.querySelector('.send-flight')).toBeNull()
  expect(sendGhost(held)?.classList.contains('animate-composer-lift')).toBe(true)
  let heldRow = projectServerFrame(empty, readyFrame)
  heldRow = projectServerFrame(heldRow, messageFrame(userText('held-u', 'a fresh message')))
  await held.render(sendPane({ activeConnection: READY, transcript: heldRow }))
  expect(harness.document.body.querySelector('.send-flight')).toBeNull()
  expect(held.container.querySelector('[data-user-bubble]')?.classList.contains('invisible'))
    .not.toBe(true)
})

test('a first send falls back to the lift after a brief echo wait', async () => {
  const empty = createTranscriptState()
  const tree = await harness.mount(sendPane({ activeConnection: READY, transcript: empty }))
  await act(async () => { composerForm(tree)?.requestSubmit() })
  expect(sendGhost(tree)?.classList.contains('animate-composer-lift')).toBe(false)
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 330))
  })
  expect(sendGhost(tree)?.classList.contains('animate-composer-lift')).toBe(true)

  let withRow = projectServerFrame(empty, readyFrame)
  withRow = projectServerFrame(withRow, messageFrame(userText('late-u', 'a fresh message')))
  await tree.render(sendPane({ activeConnection: READY, transcript: withRow }))
  expect(harness.document.body.querySelector('.send-flight')).toBeNull()
  expect(tree.container.querySelector('[data-user-bubble]')?.classList.contains('invisible'))
    .not.toBe(true)
})
