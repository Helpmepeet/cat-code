import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import type { RunControlsSnapshot } from '../../shared/protocol.js'
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

let harness: DomTestHarness
let scrollIntoView: typeof HTMLElement.prototype.scrollIntoView

beforeAll(async () => {
  harness = await createDomTestHarness()
  scrollIntoView = HTMLElement.prototype.scrollIntoView
  HTMLElement.prototype.scrollIntoView = () => {}
})

afterEach(async () => {
  await harness.unmountAll()
})

afterAll(async () => {
  HTMLElement.prototype.scrollIntoView = scrollIntoView
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

function rail(usedTokens: number) {
  return createElement(ComposerActionsBar, {
    attachDisabled: false, onAttach: () => {}, model: null, reasoningEffort: null,
    fastMode: null, permissionContext: null, onSetMode: () => {}, account: null,
    contextUsage: { usedTokens, contextWindow: 200_000, percentUsed: Math.round(usedTokens / 2_000) },
    runControls: { autoCompact: COMPACT } as RunControlsSnapshot,
  })
}

test('context warning pops only when it crosses the threshold within one mount', async () => {
  const tree = await harness.mount(rail(167_000))
  const warning = () => tree.container.querySelector('[aria-label="11% until auto-compact"]')
  expect(warning()?.classList.contains('animate-token-warn-in')).toBe(false)
  await tree.render(rail(40_000))
  await tree.render(rail(167_000))
  expect(warning()?.classList.contains('animate-token-warn-in')).toBe(true)
  await tree.render(rail(167_000))
  expect(warning()?.classList.contains('animate-token-warn-in')).toBe(true)
  await tree.unmount()
  const remounted = await harness.mount(rail(167_000))
  expect(remounted.container.querySelector('[aria-label="11% until auto-compact"]')
    ?.classList.contains('animate-token-warn-in')).toBe(false)
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
