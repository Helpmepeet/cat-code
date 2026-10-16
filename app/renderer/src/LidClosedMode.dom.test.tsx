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

test('all presets have direct Stop for the whole Mac and one shared recovery notice after navigation', async () => {
  let view = initial(); let receive!: (view: LidModeView) => void
  const commands: LidModeCommand[] = []
  window.catcode = { lidClosed: { read: async () => view, command: async (value: LidModeCommand) => { commands.push(value); return view }, subscribe: (callback: (view: LidModeView) => void) => { receive = callback; return () => {} } } } as unknown as CatCodeBridge
  const shell = (composer = true) => <LidClosedProvider>
    <LidClosedNotice />
    {composer ? <><LidClosedCup faceProps={{ 'data-composer-face': 'lid-a', tabIndex: 0, onFocus() {} }} /><LidClosedCup faceProps={{ 'data-composer-face': 'lid-b', tabIndex: 0, onFocus() {} }} /></> : <main>Page</main>}
  </LidClosedProvider>
  const tree = await harness.mount(shell())
  const button = (label: string) => [...tree.container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!
  expect(tree.container.textContent).toContain('Keeping your Mac awake. 15 minutes left.')
  expect(button('End mode and sleep')).toBeUndefined()
  for (const allowance of [15,30,60,120]) {
    await act(async () => { view = initial(allowance); receive(view) })
    await act(async () => { button('Stop').click() })
    expect(commands.at(-1)).toEqual({ action: 'stop' })
  }
  expect(commands).toHaveLength(4)
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
  expect(tree.container.querySelector('.lid-number')?.textContent).toBe('0min')
  await act(async () => { receive(initial()) })
  await act(async () => { cup.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })) })
  expect(commands).toEqual([{ action: 'adjust', minutes: 30 }])
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

test('only endings the user did not choose leave a banner', async () => {
  let receive!: (view: LidModeView) => void
  const view = initial()
  window.catcode = { lidClosed: { read: async () => view, command: async () => view,
    subscribe: (callback: (view: LidModeView) => void) => { receive = callback; return () => {} } } } as unknown as CatCodeBridge
  const tree = await harness.mount(<LidClosedProvider><LidClosedNotice /></LidClosedProvider>)
  await act(async () => { receive({ ...view, phase: 'ended', reason: 'stopped' }) })
  expect(tree.container.querySelectorAll('.lid-notice')).toHaveLength(0)
  await act(async () => { receive({ ...view, phase: 'ended', reason: 'expired' }) })
  expect(tree.container.textContent).toContain('Lid-closed mode reached its time limit.')
})
