import { beforeAll, afterAll, afterEach, test, expect } from 'bun:test'
import { act } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { LidClosedProvider, LidClosedNotice } from './LidClosedMode.js'
import { LidClosedCup } from './LidClosedCup.js'
import type { CatCodeBridge } from '../../shared/protocol.js'
import type { LidModeView, LidModeCommand } from '../../shared/lidClosed.js'
let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })
const initial = (allowance = 15): LidModeView => ({ phase: 'active', allowance, remainingSeconds: allowance * 60 - 30, included: [{ sessionId: 'one', title: 'Build', id: 'run-one', startedAt: 1, activeTurn: true, status: 'running', children: [] }], currentRuns: { one: 'run-one', two: 'run-two' }, installed: true, sleepRequested: false, canContinue: false })

test('all presets have direct Stop, original-scope inspection and one shared recovery notice after navigation', async () => {
  let view = initial(); let receive!: (view: LidModeView) => void
  const commands: LidModeCommand[] = []
  window.catcode = { lidClosed: { read: async () => view, command: async (value: LidModeCommand) => { commands.push(value); return view }, subscribe: (callback: (view: LidModeView) => void) => { receive = callback; return () => {} } } } as unknown as CatCodeBridge
  const shell = (session: string, composer = true) => <LidClosedProvider>
    <LidClosedNotice currentSessionId={session} onSelect={() => {}} />
    {composer ? <><LidClosedCup faceProps={{ 'data-composer-face': 'lid-a', tabIndex: 0, onFocus() {} }} /><LidClosedCup faceProps={{ 'data-composer-face': 'lid-b', tabIndex: 0, onFocus() {} }} /></> : <main>Page</main>}
  </LidClosedProvider>
  const tree = await harness.mount(shell('two'))
  const button = (label: string) => [...tree.container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!
  expect(tree.container.textContent).toContain('This run is not included.')
  await act(async () => { button('Inspect work').click() })
  expect(tree.container.textContent).toContain('Build')
  for (const allowance of [15,30,60,120]) {
    await act(async () => { view = initial(allowance); receive(view) })
    await act(async () => { button('Stop').click() })
    expect(commands.at(-1)).toEqual({ action: 'stop' })
  }
  expect(commands).toHaveLength(4)
  await act(async () => { receive({ ...view, phase: 'unresolved', error: 'restore-failed' }) })
  await tree.render(shell('one', false))
  expect(tree.container.querySelectorAll('[role=status]')).toHaveLength(1)
  expect(tree.container.textContent).toContain("Couldn't restore normal sleep")
  expect(button('Dismiss')).toBeUndefined()
  await act(async () => { button('Retry').click() })
  expect(commands.at(-1)).toEqual({ action: 'retry' })
})

test('focus does not activate; lid-open arrows cannot extend and click only continues', async () => {
  let receive!: (view: LidModeView) => void
  const commands: LidModeCommand[] = []
  const view = { ...initial(), phase: 'off' as const, remainingSeconds: 0 }
  window.catcode = { lidClosed: { read: async () => view, command: async (value: LidModeCommand) => { commands.push(value); return view }, subscribe: (callback: (view: LidModeView) => void) => { receive = callback; return () => {} } } } as unknown as CatCodeBridge
  const tree = await harness.mount(<LidClosedProvider><LidClosedCup faceProps={{ 'data-composer-face': 'lid', tabIndex: 0, onFocus() {} }} /><LidClosedNotice currentSessionId="one" onSelect={() => {}} /></LidClosedProvider>)
  const cup = tree.container.querySelector<HTMLButtonElement>('.lid-cup')!
  await act(async () => { cup.focus() })
  expect(commands).toEqual([])
  expect(tree.container.querySelector('.lid-number')?.textContent).toBe('0min')
  await act(async () => { receive({ ...initial(), phase: 'lid-open', canContinue: true, remainingSeconds: 700 }) })
  await act(async () => { cup.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })) })
  expect(commands).toEqual([])
  await act(async () => { cup.click() })
  expect(commands).toEqual([{ action: 'continue' }])
})
