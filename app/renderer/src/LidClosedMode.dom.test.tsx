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
const initial = (allowance = 15): LidModeView => ({ phase: 'active', allowance, remainingSeconds: allowance * 60 - 30, installed: true, sleepRequested: false })

test('every session cup shows the one shared state, and only a restore failure adds a banner', async () => {
  let view = initial(); let receive!: (view: LidModeView) => void
  const commands: LidModeCommand[] = []
  window.catcode = { lidClosed: { read: async () => view, command: async (value: LidModeCommand) => { commands.push(value); return view }, subscribe: (callback: (view: LidModeView) => void) => { receive = callback; return () => {} } } } as unknown as CatCodeBridge
  const shell = (composer = true) => <LidClosedProvider>
    <LidClosedNotice />
    {composer ? <><LidClosedCup faceProps={{ 'data-composer-face': 'lid-a', tabIndex: 0, onFocus() {} }} /><LidClosedCup faceProps={{ 'data-composer-face': 'lid-b', tabIndex: 0, onFocus() {} }} /></> : <main>Page</main>}
  </LidClosedProvider>
  const tree = await harness.mount(shell())
  const button = (label: string) => [...tree.container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!
  for (const allowance of [5,15,30,60,120]) {
    await act(async () => { view = initial(allowance); receive(view) })
    expect(tree.container.querySelectorAll('.lid-notice')).toHaveLength(0)
    const cups = [...tree.container.querySelectorAll('.lid-cup-slot')]
    expect(cups).toHaveLength(2)
    // Ids from useId and the test's face labels differ; everything else must match.
    const [a, b] = cups.map(cup => cup.outerHTML.replaceAll(/id="[^"]*"|url\(#[^)]*\)|data-composer-face="[^"]*"/g, ''))
    expect(a).toBe(b!)
    expect(cups[0]!.querySelectorAll('.lid-tick.selected')).toHaveLength(1)
    const ticks = [...cups[0]!.querySelectorAll('.lid-tick')]
    expect(ticks).toHaveLength(5)
    const selected = ticks.find(tick => tick.classList.contains('selected'))!
    const tickY = Number(selected.getAttribute('d')!.split(' ')[1]!.replace('h3', ''))
    await act(async () => { receive({ ...view, remainingSeconds: allowance * 60 }) })
    expect(Number(cups[0]!.querySelector('.lid-liquid')!.getAttribute('y'))).toBeCloseTo(tickY)
  }
  for (const phase of ['starting', 'restoring', 'ended', 'unavailable'] as const) {
    await act(async () => { receive({ ...view, phase, reason: 'expired', error: phase === 'unavailable' ? 'Open the lid before starting.' : undefined }) })
    expect(tree.container.querySelectorAll('.lid-notice')).toHaveLength(0)
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

test('focus does not activate; active keyboard adjustment sends only fixed presets', async () => {
  let receive!: (view: LidModeView) => void
  const commands: LidModeCommand[] = []
  const view = { ...initial(), phase: 'off' as const, remainingSeconds: 0 }
  window.catcode = { lidClosed: { read: async () => view, command: async (value: LidModeCommand) => { commands.push(value); return view }, subscribe: (callback: (view: LidModeView) => void) => { receive = callback; return () => {} } } } as unknown as CatCodeBridge
  const tree = await harness.mount(<LidClosedProvider><LidClosedCup faceProps={{ 'data-composer-face': 'lid', tabIndex: 0, onFocus() {} }} /><LidClosedNotice /></LidClosedProvider>)
  const cup = tree.container.querySelector<HTMLButtonElement>('.lid-cup')!
  await act(async () => { cup.focus() })
  expect(commands).toEqual([])
  expect(tree.container.querySelector('.lid-digits')).toBeNull()
  expect(cup.getAttribute('aria-label')).toContain('Start for 5 minutes')
  await act(async () => { cup.click() })
  expect(commands.at(-1)).toEqual({ action: 'start', minutes: 5 })
  await act(async () => { receive(initial(5)) })
  await act(async () => { cup.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })) })
  expect(commands.at(-1)).toEqual({ action: 'adjust', minutes: 15 })
  await act(async () => { receive(initial()) })
  await act(async () => { cup.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })) })
  expect(commands.at(-1)).toEqual({ action: 'adjust', minutes: 30 })
  await act(async () => { cup.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  expect(commands.at(-1)).toEqual({ action: 'adjust', minutes: 5 })
  await act(async () => { receive(initial(5)) })
  await act(async () => { cup.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  expect(commands.at(-1)).toEqual({ action: 'stop' })
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

test('the cup tooltip explains safety endings and refused starts', async () => {
  let receive!: (view: LidModeView) => void
  const view = initial()
  window.catcode = { lidClosed: { read: async () => view, command: async () => view,
    subscribe: (callback: (view: LidModeView) => void) => { receive = callback; return () => {} } } } as unknown as CatCodeBridge
  const tree = await harness.mount(<LidClosedProvider><LidClosedCup faceProps={{ 'data-composer-face': 'lid', tabIndex: 0, onFocus() {} }} /></LidClosedProvider>)
  const title = () => tree.container.querySelector('.lid-cup')!.getAttribute('title')
  await act(async () => { receive({ ...view, phase: 'ended', reason: 'stopped' }) })
  expect(title()).toBe('Keep working with lid closed')
  expect(tree.container.querySelector('.lid-mark')).toBeNull()
  await act(async () => { receive({ ...view, phase: 'ended', reason: 'expired' }) })
  expect(title()).toBe('Keep working with lid closed')
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
  const view: LidModeView = { ...initial(), phase: 'off', remainingSeconds: 0 }
  window.catcode = { lidClosed: { read: async () => view, command: async (value: LidModeCommand) => { commands.push(value); return view },
    subscribe: (callback: (view: LidModeView) => void) => { receive = callback; return () => {} } } } as unknown as CatCodeBridge
  const tree = await harness.mount(<LidClosedProvider><LidClosedCup faceProps={{ 'data-composer-face': 'lid', tabIndex: 0, onFocus() {} }} /></LidClosedProvider>)
  const cup = tree.container.querySelector<HTMLButtonElement>('.lid-cup')!
  await act(async () => { receive({ ...view, phase: 'unavailable', error: 'Charge above 20% before starting.' }) })
  expect(cup.getAttribute('aria-disabled')).toBe('false')
  await act(async () => { cup.click() })
  expect(commands).toEqual([{ action: 'start', minutes: 5 }])
})

test('restored power settings do not imply an unconfirmed Sleep request succeeded', async () => {
  let receive!: (view: LidModeView) => void
  const commands: LidModeCommand[] = []
  const view: LidModeView = { ...initial(), phase: 'ended', reason: 'sleep-unconfirmed', sleepRequested: false }
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
  expect(cup.title).toBe('Keep working with lid closed')
  expect(tree.container.querySelector('.lid-mark')).toBeNull()
})

test('the numeral shows remaining minutes, the allowance while adjusting or starting, and warns at five minutes', async () => {
  let receive!: (view: LidModeView) => void
  const view = initial(60)
  window.catcode = { lidClosed: { read: async () => view, command: async () => view,
    subscribe: (callback: (view: LidModeView) => void) => { receive = callback; return () => {} } } } as unknown as CatCodeBridge
  const tree = await harness.mount(<LidClosedProvider><LidClosedCup faceProps={{ 'data-composer-face': 'lid', tabIndex: 0, onFocus() {} }} /></LidClosedProvider>)
  const digits = () => tree.container.querySelector('.lid-digits')
  const shown = () => tree.container.querySelector('.lid-digit-in, .lid-digit:not(.lid-digit-out)')?.textContent
  expect(shown()).toBe('60')
  expect(digits()!.classList.contains('warn')).toBe(false)
  await act(async () => { receive({ ...view, remainingSeconds: 5 * 60 - 10 }) })
  expect(shown()).toBe('5')
  expect(digits()!.classList.contains('warn')).toBe(true)
  await act(async () => { receive({ ...view, remainingSeconds: 6 * 60 - 10 }) })
  expect(digits()!.classList.contains('warn')).toBe(false)
  await act(async () => { receive({ ...view, phase: 'starting', allowance: 30, remainingSeconds: 0 }) })
  expect(shown()).toBe('30')
  expect(digits()!.classList.contains('starting')).toBe(true)
  const cup = tree.container.querySelector<HTMLButtonElement>('.lid-cup')!
  await act(async () => { receive(view) })
  await act(async () => { cup.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })) })
  await act(async () => { receive({ ...view, allowance: 120, remainingSeconds: 55 * 60 }) })
  expect(shown()).toBe('120')
  for (const phase of ['off', 'ended', 'restoring', 'unresolved', 'unavailable'] as const)
    await act(async () => { receive({ ...view, phase, reason: 'expired' }) }), expect(digits()).toBeNull()
})

test('normal endings look exactly like off; safety endings and errors keep the amber mark', async () => {
  let receive!: (view: LidModeView) => void
  const view = initial()
  window.catcode = { lidClosed: { read: async () => view, command: async () => view,
    subscribe: (callback: (view: LidModeView) => void) => { receive = callback; return () => {} } } } as unknown as CatCodeBridge
  const tree = await harness.mount(<LidClosedProvider><LidClosedCup faceProps={{ 'data-composer-face': 'lid', tabIndex: 0, onFocus() {} }} /></LidClosedProvider>)
  const face = () => tree.container.querySelector('.lid-cup-slot')!.outerHTML.replaceAll(/id="[^"]*"|url\(#[^)]*\)/g, '')
  await act(async () => { receive({ ...view, phase: 'off', remainingSeconds: 0 }) })
  const off = face()
  for (const reason of ['stopped', 'expired', 'sleep-requested']) {
    await act(async () => { receive({ ...view, phase: 'ended', reason, remainingSeconds: 0 }) })
    expect(face()).toBe(off)
    expect(tree.container.querySelector('.lid-mark')).toBeNull()
  }
  for (const reason of ['thermal', 'battery-reserve', 'supervision-lost', 'monitoring-unavailable', 'override-conflict', 'sleep-unconfirmed', 'unknown', undefined]) {
    await act(async () => { receive({ ...view, phase: 'ended', reason, remainingSeconds: 0 }) })
    expect(tree.container.querySelector('.lid-cup-slot')!.classList.contains('lid-ended')).toBe(true)
    expect(tree.container.querySelector('.lid-mark')).not.toBeNull()
  }
  for (const reason of ['stopped', 'expired', 'sleep-requested']) {
    await act(async () => { receive({ ...view, phase: 'ended', reason, error: 'sleep-request-failed', remainingSeconds: 0 }) })
    expect(tree.container.querySelector('.lid-cup-slot')!.classList.contains('lid-ended')).toBe(true)
    expect(tree.container.querySelector('.lid-mark')).not.toBeNull()
  }
})
