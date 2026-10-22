import { beforeAll, afterAll, afterEach, test, expect } from 'bun:test'
import { act } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { LidClosedProvider, LidClosedNotice } from './LidClosedMode.js'
import { StartupShell } from './StartupSurfaces.js'
import { LidClosedCup } from './LidClosedCup.js'
import type { CatCodeBridge } from '../../shared/protocol.js'
import type { LidModeView, LidModeCommand } from '../../shared/lidClosed.js'
let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })
const initial = (phase: LidModeView['phase'] = 'active', overrides: Partial<LidModeView> = {}): LidModeView => ({
  phase, activeSessions: 2, activeSubagents: 1, waitingForApproval: false, installed: true, sleepRequested: false, ...overrides,
})

test('every session cup shows shared work state, and only a restore failure adds a banner', async () => {
  let view = initial(); let receive!: (view: LidModeView) => void
  const commands: LidModeCommand[] = []
  window.catcode = { lidClosed: { read: async () => view, command: async (value: LidModeCommand) => { commands.push(value); return view }, subscribe: (callback: (view: LidModeView) => void) => { receive = callback; return () => {} } } } as unknown as CatCodeBridge
  const shell = (composer = true) => <LidClosedProvider>
    <LidClosedNotice />
    {composer ? <><LidClosedCup faceProps={{ 'data-composer-face': 'lid-a', tabIndex: 0, onFocus() {} }} /><LidClosedCup faceProps={{ 'data-composer-face': 'lid-b', tabIndex: 0, onFocus() {} }} /></> : <main>Page</main>}
  </LidClosedProvider>
  const tree = await harness.mount(shell())
  const button = (label: string) => [...tree.container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!
  const compareCups = () => {
    const cups = [...tree.container.querySelectorAll('.lid-cup-slot')]
    expect(cups).toHaveLength(2)
    // Ids from useId and the test's face labels differ; everything else must match.
    const [a, b] = cups.map(cup => cup.outerHTML.replaceAll(/id="[^"]*"|url\(#[^)]*\)|data-composer-face="[^"]*"/g, ''))
    expect(a).toBe(b!)
  }
  compareCups()
  for (const phase of ['off', 'starting', 'restoring', 'ended', 'unavailable'] as const) {
    await act(async () => { view = initial(phase, { reason: phase === 'ended' ? 'work-finished' : undefined, error: phase === 'unavailable' ? 'Open the lid before starting.' : undefined }); receive(view) })
    expect(tree.container.querySelectorAll('.lid-notice')).toHaveLength(0)
    compareCups()
  }
  expect(commands).toHaveLength(0)
  await act(async () => { receive({ ...view, phase: 'unresolved', error: 'restore-failed' }) })
  await tree.render(shell(false))
  expect(tree.container.querySelectorAll('[role=status]')).toHaveLength(1)
  expect(tree.container.textContent).toContain("Couldn't restore normal sleep")
  expect(button('Dismiss')).toBeUndefined()
  await act(async () => { button('Retry').click() })
  expect(commands.at(-1)).toEqual({ action: 'retry' })
})

test('off starts on activation, active stops, and focus, wheel, or arrows do not change state', async () => {
  let receive!: (view: LidModeView) => void
  const commands: LidModeCommand[] = []
  let view = initial('off')
  window.catcode = { lidClosed: { read: async () => view, command: async (value: LidModeCommand) => { commands.push(value); return view }, subscribe: (callback: (view: LidModeView) => void) => { receive = callback; return () => {} } } } as unknown as CatCodeBridge
  const tree = await harness.mount(<LidClosedProvider><LidClosedCup faceProps={{ 'data-composer-face': 'lid', tabIndex: 0, onFocus() {} }} /><LidClosedNotice /></LidClosedProvider>)
  const cup = tree.container.querySelector<HTMLButtonElement>('.lid-cup')!
  await act(async () => { cup.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })) })
  await act(async () => { cup.focus() })
  expect(commands).toEqual([])
  expect(tree.container.querySelector('.lid-digits')).toBeNull()
  expect(cup.getAttribute('aria-label')).toContain('Keep awake until all work finishes')
  await act(async () => {
    cup.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }))
    cup.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
    cup.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
  })
  expect(commands).toEqual([])
  await act(async () => { cup.click() })
  expect(commands).toEqual([{ action: 'start' }])
  view = initial()
  await act(async () => { receive(view) })
  await act(async () => {
    cup.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }))
    cup.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
    cup.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
  })
  expect(commands).toEqual([{ action: 'start' }])
  await act(async () => { cup.click() })
  expect(commands).toEqual([{ action: 'start' }, { action: 'stop' }])
})

test('Enter and Space activate the start or stop action', async () => {
  let receive!: (view: LidModeView) => void
  let view = initial('off')
  const commands: LidModeCommand[] = []
  window.catcode = { lidClosed: { read: async () => view, command: async (value: LidModeCommand) => { commands.push(value); return view },
    subscribe: (callback: (view: LidModeView) => void) => { receive = callback; return () => {} } } } as unknown as CatCodeBridge
  const tree = await harness.mount(<LidClosedProvider><LidClosedCup faceProps={{ 'data-composer-face': 'lid', tabIndex: 0, onFocus() {} }} /></LidClosedProvider>)
  const cup = tree.container.querySelector<HTMLButtonElement>('.lid-cup')!
  await act(async () => { cup.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
  expect(commands).toEqual([])
  await act(async () => { cup.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })) })
  expect(commands).toEqual([])
  // Native buttons synthesize click for Enter and Space; assert those activations
  // directly so this DOM harness does not depend on browser default actions.
  await act(async () => { cup.click() })
  expect(commands).toEqual([{ action: 'start' }])
  view = initial()
  await act(async () => { receive(view) })
  await act(async () => { cup.click() })
  expect(commands).toEqual([{ action: 'start' }, { action: 'stop' }])
})


test('sign-in and first-use setup show no lid banner', async () => {
  let receive!: (view: LidModeView) => void
  const view: LidModeView = { ...initial(), phase: 'unresolved', error: 'restore-failed' }
  window.catcode = { lidClosed: { read: async () => view,
    command: async () => view, subscribe: (callback: (view: LidModeView) => void) => { receive = callback; return () => {} } } } as unknown as CatCodeBridge
  const tree = await harness.mount(<LidClosedProvider><StartupShell step="auth">Sign in</StartupShell></LidClosedProvider>)
  expect(tree.container.querySelectorAll('.lid-notice')).toHaveLength(0)
  const notice = await harness.mount(<LidClosedProvider><LidClosedNotice /></LidClosedProvider>)
  await act(async () => { receive({ ...view, phase: 'setup', installed: false, error: undefined }) })
  expect(notice.container.querySelectorAll('.lid-notice')).toHaveLength(0)
})

test('the cup tooltip explains work counts, approvals, safety endings, and refused starts', async () => {
  let receive!: (view: LidModeView) => void
  const view = initial()
  window.catcode = { lidClosed: { read: async () => view, command: async () => view,
    subscribe: (callback: (view: LidModeView) => void) => { receive = callback; return () => {} } } } as unknown as CatCodeBridge
  const tree = await harness.mount(<LidClosedProvider><LidClosedCup faceProps={{ 'data-composer-face': 'lid', tabIndex: 0, onFocus() {} }} /></LidClosedProvider>)
  const title = () => tree.container.querySelector('.lid-cup')!.getAttribute('title')
  expect(title()).toBe('Keeping awake until all work finishes. 2 sessions and 1 subagent')
  await act(async () => { receive({ ...view, waitingForApproval: true }) })
  expect(title()).toBe('Keeping awake until all work finishes. 2 sessions and 1 subagent. Waiting for approval.')
  const cup = tree.container.querySelector<HTMLButtonElement>('.lid-cup')!
  expect(cup.getAttribute('aria-label')).toContain('2 sessions active; 1 subagent; waiting for approval')
  await act(async () => { cup.focus() })
  expect(tree.container.querySelector('.sr-only')?.textContent).toBe('2 sessions active; 1 subagent; waiting for approval')
  await act(async () => { cup.blur() })
  await act(async () => { receive({ ...view, phase: 'ended', reason: 'stopped' }) })
  expect(title()).toBe('Keep awake until all work finishes')
  expect(tree.container.querySelector('.lid-mark')).toBeNull()
  await act(async () => { receive({ ...view, phase: 'ended', reason: 'work-finished' }) })
  expect(title()).toBe('All work finished. Normal sleep restored.')
  expect(tree.container.querySelector('.lid-mark')).toBeNull()
  await act(async () => { receive({ ...view, phase: 'ended', reason: 'thermal' }) })
  expect(title()).toBe('Lid-closed mode ended because your Mac got too hot.')
  expect(tree.container.querySelector('.lid-mark')).not.toBeNull()
  await act(async () => { receive({ ...view, phase: 'unavailable', error: 'Charge above 20% before starting.' }) })
  expect(title()).toBe('Charge above 20% before starting.')
})

test('a refused start leaves the cup able to try again', async () => {
  let receive!: (view: LidModeView) => void
  const commands: LidModeCommand[] = []
  const view: LidModeView = { ...initial(), phase: 'off', reason: 'no-work' }
  window.catcode = { lidClosed: { read: async () => view, command: async (value: LidModeCommand) => { commands.push(value); return view },
    subscribe: (callback: (view: LidModeView) => void) => { receive = callback; return () => {} } } } as unknown as CatCodeBridge
  const tree = await harness.mount(<LidClosedProvider><LidClosedCup faceProps={{ 'data-composer-face': 'lid', tabIndex: 0, onFocus() {} }} /></LidClosedProvider>)
  const cup = tree.container.querySelector<HTMLButtonElement>('.lid-cup')!
  expect(cup.title).toBe('No work is running.')
  await act(async () => { receive({ ...view, phase: 'unavailable', error: 'Charge above 20% before starting.' }) })
  expect(cup.getAttribute('aria-disabled')).toBe('false')
  await act(async () => { cup.click() })
  expect(commands).toEqual([{ action: 'start' }])
})

test('restored power settings do not imply an unconfirmed Sleep request succeeded', async () => {
  let receive!: (view: LidModeView) => void
  const commands: LidModeCommand[] = []
  const view: LidModeView = initial('ended', { reason: 'sleep-unconfirmed', sleepRequested: false })
  window.catcode = { lidClosed: { read: async () => view, command: async (value: LidModeCommand) => { commands.push(value); return view },
    subscribe: (callback: (view: LidModeView) => void) => { receive = callback; return () => {} } } } as unknown as CatCodeBridge
  const tree = await harness.mount(<LidClosedProvider><LidClosedCup faceProps={{ 'data-composer-face': 'lid', tabIndex: 0, onFocus() {} }} /><LidClosedNotice /></LidClosedProvider>)
  const cup = tree.container.querySelector<HTMLButtonElement>('.lid-cup')!
  for (const error of [undefined, 'sleep-request-failed']) {
    await act(async () => { receive({ ...view, error }) })
    expect(cup.title).toBe('Normal sleep restored. Sleep could not be confirmed. Check your Mac.')
    expect(cup.title).not.toContain('Sleep was requested.')
    expect(tree.container.querySelector('.lid-mark')).not.toBeNull()
    expect(tree.container.querySelector('.lid-notice')).toBeNull()
  }
  await act(async () => { cup.focus() })
  expect(commands).toEqual([])
  await act(async () => { receive({ ...view, reason: 'sleep-requested', sleepRequested: true }) })
  expect(cup.title).toBe('Keep awake until all work finishes')
  expect(tree.container.querySelector('.lid-mark')).toBeNull()
})

test('active cup fill is fixed and has no minute or tick labels', async () => {
  let receive!: (view: LidModeView) => void
  const view = initial()
  window.catcode = { lidClosed: { read: async () => view, command: async () => view,
    subscribe: (callback: (view: LidModeView) => void) => { receive = callback; return () => {} } } } as unknown as CatCodeBridge
  const tree = await harness.mount(<LidClosedProvider><LidClosedCup faceProps={{ 'data-composer-face': 'lid', tabIndex: 0, onFocus() {} }} /></LidClosedProvider>)
  const fill = () => tree.container.querySelector('.lid-liquid')?.getAttribute('y') ?? null
  const activeFill = fill()
  expect(activeFill).not.toBeNull()
  expect(tree.container.querySelector('.lid-digits')).toBeNull()
  expect(tree.container.querySelectorAll('.lid-tick')).toHaveLength(0)
  await act(async () => { receive(initial('active', { activeSessions: 8, activeSubagents: 4, waitingForApproval: true })) })
  expect(fill()).toBe(activeFill)
  expect(tree.container.querySelector('.lid-digits')).toBeNull()
  expect(tree.container.querySelectorAll('.lid-tick')).toHaveLength(0)
  for (const phase of ['off', 'ended', 'restoring', 'unresolved', 'unavailable'] as const)
    await act(async () => { receive({ ...view, phase, reason: 'expired' }) }), expect(fill()).toBeNull()
})

test('work-finished looks exactly like off; safety endings and errors keep the amber mark', async () => {
  let receive!: (view: LidModeView) => void
  const view = initial()
  window.catcode = { lidClosed: { read: async () => view, command: async () => view,
    subscribe: (callback: (view: LidModeView) => void) => { receive = callback; return () => {} } } } as unknown as CatCodeBridge
  const tree = await harness.mount(<LidClosedProvider><LidClosedCup faceProps={{ 'data-composer-face': 'lid', tabIndex: 0, onFocus() {} }} /></LidClosedProvider>)
  const face = () => {
    const slot = tree.container.querySelector('.lid-cup-slot')!
    return `${slot.className}|${slot.querySelector('svg')?.innerHTML}`
  }
  await act(async () => { receive({ ...view, phase: 'off' }) })
  const off = face()
  for (const reason of ['stopped', 'work-finished', 'sleep-requested']) {
    await act(async () => { receive({ ...view, phase: 'ended', reason }) })
    expect(face()).toBe(off)
    expect(tree.container.querySelector('.lid-mark')).toBeNull()
    if (reason === 'work-finished') expect(tree.container.querySelector('.lid-cup')?.getAttribute('title')).toBe('All work finished. Normal sleep restored.')
  }
  for (const reason of ['thermal', 'battery-reserve', 'supervision-lost', 'monitoring-unavailable', 'override-conflict', 'sleep-unconfirmed', 'unknown', undefined]) {
    await act(async () => { receive({ ...view, phase: 'ended', reason }) })
    expect(tree.container.querySelector('.lid-cup-slot')!.classList.contains('lid-ended')).toBe(true)
    expect(tree.container.querySelector('.lid-mark')).not.toBeNull()
  }
  for (const reason of ['stopped', 'expired', 'sleep-requested']) {
    await act(async () => { receive({ ...view, phase: 'ended', reason, error: 'sleep-request-failed' }) })
    expect(tree.container.querySelector('.lid-cup-slot')!.classList.contains('lid-ended')).toBe(true)
    expect(tree.container.querySelector('.lid-mark')).not.toBeNull()
  }
})
