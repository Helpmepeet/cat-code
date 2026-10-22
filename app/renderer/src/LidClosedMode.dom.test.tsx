import { beforeAll, afterAll, afterEach, test, expect } from 'bun:test'
import { act, StrictMode } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { LidClosedProvider, LidClosedNotice } from './LidClosedMode.js'
import { StartupShell } from './StartupSurfaces.js'
import { LidClosedCup } from './LidClosedCup.js'
import type { CatCodeBridge } from '../../shared/protocol.js'
import type { LidModeView, LidModeCommand } from '../../shared/lidClosed.js'
import { lidFill, lidPreview, nextLidTarget } from './lidClosedState.js'
let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })
const initial = (phase: LidModeView['phase'] = 'active', overrides: Partial<LidModeView> = {}): LidModeView => ({
  phase, mode: 'work', allowance: 0, remainingSeconds: 0, workAvailable: true, activeSessions: 2, activeSubagents: 1, waitingForApproval: false, installed: true, sleepRequested: false, ...overrides,
})

function cycleBridge(start: LidModeView) {
  let view = start
  let receive: (value: LidModeView) => void = () => {}
  const commands: LidModeCommand[] = []
  const publish = (value: LidModeView) => { view = value; receive(value) }
  window.catcode = { lidClosed: {
    read: async () => view,
    subscribe: (callback: (value: LidModeView) => void) => { receive = callback; return () => {} },
    command: async (value: LidModeCommand) => {
      commands.push(value)
      if (value.action === 'set') {
        const preview = lidPreview(view, value.target)
        publish({ ...preview, phase: value.target === 'off' ? 'off' : 'active' })
      }
      return view
    },
  } } as unknown as CatCodeBridge
  return { commands, publish }
}

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

test('clicks preview the cycle immediately and send only the last target after a quiet second', async () => {
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
  expect(cup.getAttribute('aria-label')).toContain('Next: until all work finishes')
  await act(async () => {
    cup.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }))
  })
  expect(commands).toEqual([])
  await act(async () => { cup.click() })
  expect(tree.container.querySelector('.lid-starting')).not.toBeNull()
  expect(tree.container.querySelector('.lid-digits')).toBeNull()
  await act(async () => { cup.click() })
  expect(tree.container.querySelector('.lid-digit:not(.lid-digit-out)')?.textContent).toBe('15')
  await act(async () => { cup.click() })
  expect(tree.container.querySelector('.lid-digit:not(.lid-digit-out)')?.textContent).toBe('30')
  expect(commands).toEqual([])
  await act(async () => { await Bun.sleep(1100) })
  expect(commands).toEqual([{ action: 'set', target: 30 }])
  view = initial()
  await act(async () => { receive(view) })
  await act(async () => {
    cup.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }))
  })
  expect(commands).toEqual([{ action: 'set', target: 30 }])
  await act(async () => { cup.click() })
  expect(tree.container.querySelector('.lid-digit:not(.lid-digit-out)')?.textContent).toBe('15')
  await act(async () => { cup.blur() })
  expect(commands).toEqual([{ action: 'set', target: 30 }, { action: 'set', target: 15 }])
})

test('native button keyboard clicks select the next target and blur flushes it', async () => {
  let receive!: (view: LidModeView) => void
  let view = initial('off')
  const commands: LidModeCommand[] = []
  window.catcode = { lidClosed: { read: async () => view, command: async (value: LidModeCommand) => { commands.push(value); return view },
    subscribe: (callback: (view: LidModeView) => void) => { receive = callback; return () => {} } } } as unknown as CatCodeBridge
  const tree = await harness.mount(<LidClosedProvider><LidClosedCup faceProps={{ 'data-composer-face': 'lid', tabIndex: 0, onFocus() {} }} /></LidClosedProvider>)
  const cup = tree.container.querySelector<HTMLButtonElement>('.lid-cup')!
  await act(async () => { cup.focus() })
  await act(async () => { cup.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
  expect(commands).toEqual([])
  await act(async () => { cup.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })) })
  expect(commands).toEqual([])
  // Native buttons synthesize click for Enter and Space; assert those activations
  // directly so this DOM harness does not depend on browser default actions.
  await act(async () => { cup.click() })
  expect(commands).toEqual([])
  await act(async () => { cup.blur() })
  expect(commands).toEqual([{ action: 'set', target: 'work' }])
  view = initial()
  await act(async () => { receive(view) })
  await act(async () => { cup.focus() })
  await act(async () => { cup.click() })
  await act(async () => { cup.blur() })
  expect(commands).toEqual([{ action: 'set', target: 'work' }, { action: 'set', target: 15 }])
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
  let view = initial()
  window.catcode = { lidClosed: { read: async () => view, command: async () => view,
    subscribe: (callback: (view: LidModeView) => void) => { receive = value => { view = value; callback(value) }; return () => {} } } } as unknown as CatCodeBridge
  const tree = await harness.mount(<LidClosedProvider><LidClosedCup faceProps={{ 'data-composer-face': 'lid', tabIndex: 0, onFocus() {} }} /></LidClosedProvider>)
  const title = () => tree.container.querySelector('.lid-cup')!.getAttribute('title')
  expect(title()).toBe('Keeping awake until all work finishes. 2 sessions and 1 subagent. Next: 15 minutes')
  await act(async () => { receive({ ...view, waitingForApproval: true }) })
  expect(title()).toBe('Keeping awake until all work finishes. 2 sessions and 1 subagent. Waiting for approval. Next: 15 minutes')
  const cup = tree.container.querySelector<HTMLButtonElement>('.lid-cup')!
  expect(cup.getAttribute('aria-label')).toContain('2 sessions active; 1 subagent; waiting for approval')
  await act(async () => { cup.focus() })
  expect(tree.container.querySelector('.sr-only')?.textContent).toBe('2 sessions active; 1 subagent; waiting for approval')
  await act(async () => { cup.blur() })
  await act(async () => { receive({ ...view, phase: 'ended', reason: 'stopped' }) })
  expect(title()).toBe('Keep awake until all work finishes')
  expect(tree.container.querySelector('.lid-mark')).toBeNull()
  await act(async () => { receive({ ...view, phase: 'ended', reason: 'work-finished' }) })
  expect(title()).toBe('All work finished. Normal sleep restored. Next: until all work finishes')
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
  const view: LidModeView = { ...initial(), phase: 'off', reason: 'no-work', workAvailable: false }
  window.catcode = { lidClosed: { read: async () => view, command: async (value: LidModeCommand) => { commands.push(value); return view },
    subscribe: (callback: (view: LidModeView) => void) => { receive = callback; return () => {} } } } as unknown as CatCodeBridge
  const tree = await harness.mount(<LidClosedProvider><LidClosedCup faceProps={{ 'data-composer-face': 'lid', tabIndex: 0, onFocus() {} }} /></LidClosedProvider>)
  const cup = tree.container.querySelector<HTMLButtonElement>('.lid-cup')!
  expect(cup.title).toBe('No work is running. Next: 15 minutes')
  const error = 'Work status is unavailable. Try again when sessions are connected.'
  await act(async () => { receive({ ...view, phase: 'unavailable', reason: 'work-status-unavailable', error }) })
  expect(cup.title).toBe(error)
  expect(cup.getAttribute('aria-disabled')).toBe('false')
  await act(async () => { cup.click() })
  await act(async () => { await Bun.sleep(1100) })
  expect(commands).toEqual([{ action: 'set', target: 15 }])
  await act(async () => { receive({ ...view, phase: 'unavailable', error: 'Charge above 20% before starting.' }) })
  expect(cup.getAttribute('aria-disabled')).toBe('false')
  await act(async () => { cup.click() })
  await act(async () => { await Bun.sleep(1100) })
  expect(commands).toEqual([{ action: 'set', target: 15 }, { action: 'set', target: 15 }])
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
  for (const reason of ['stopped', 'work-finished', 'sleep-requested', 'expired']) {
    await act(async () => { receive({ ...view, phase: 'ended', reason }) })
    expect(face()).toBe(off)
    expect(tree.container.querySelector('.lid-mark')).toBeNull()
    if (reason === 'work-finished') expect(tree.container.querySelector('.lid-cup')?.getAttribute('title')).toBe('All work finished. Normal sleep restored. Next: until all work finishes')
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

test('the full click cycle wraps only after 120 and keyboard steps stop at both ends', async () => {
  const bridge = cycleBridge(initial('off', { mode: null }))
  const tree = await harness.mount(<LidClosedProvider><LidClosedCup faceProps={{ 'data-composer-face': 'lid', tabIndex: 0, onFocus() {} }} /></LidClosedProvider>)
  const cup = tree.container.querySelector<HTMLButtonElement>('.lid-cup')!
  const digits = () => tree.container.querySelector('.lid-digit:not(.lid-digit-out)')?.textContent ?? null
  for (const value of [null, '15', '30', '60', '120', null]) {
    await act(async () => { cup.click() })
    expect(digits()).toBe(value)
  }
  expect(cup.getAttribute('aria-pressed')).toBe('false')
  expect(bridge.commands).toEqual([])
  const key = async (key: string) => act(async () => { cup.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
  await key('ArrowDown')
  expect(cup.getAttribute('aria-pressed')).toBe('false')
  for (let index = 0; index < 6; index++) await key('ArrowUp')
  expect(digits()).toBe('120')
  await key('ArrowDown')
  expect(digits()).toBe('60')
  await act(async () => { await tree.render(<LidClosedProvider><main>Page</main></LidClosedProvider>) })
  expect(bridge.commands).toEqual([{ action: 'set', target: 60 }])
})

test('no-work cycle starts at 15 and Arrow Down goes directly to off', async () => {
  const bridge = cycleBridge(initial('off', { mode: null, workAvailable: false, activeSessions: 0, activeSubagents: 0 }))
  const tree = await harness.mount(<LidClosedProvider><LidClosedCup faceProps={{ 'data-composer-face': 'lid', tabIndex: 0, onFocus() {} }} /></LidClosedProvider>)
  const cup = tree.container.querySelector<HTMLButtonElement>('.lid-cup')!
  await act(async () => { cup.click() })
  expect(tree.container.querySelector('.lid-digit:not(.lid-digit-out)')?.textContent).toBe('15')
  expect(cup.getAttribute('aria-disabled')).toBe('false')
  await act(async () => { cup.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
  expect(tree.container.querySelector('.lid-digits')).toBeNull()
  expect(cup.getAttribute('aria-pressed')).toBe('false')
  await act(async () => { await harness.unmountAll() })
  expect(bridge.commands).toEqual([{ action: 'set', target: 'off' }])
})

test('timed mode renders remaining minutes, four ticks, draining fill, and a five-minute warning', async () => {
  const bridge = cycleBridge(initial('active', { mode: 'timed', allowance: 30, remainingSeconds: 23 * 60 }))
  const tree = await harness.mount(<LidClosedProvider><LidClosedCup faceProps={{ 'data-composer-face': 'lid', tabIndex: 0, onFocus() {} }} /></LidClosedProvider>)
  const cup = tree.container.querySelector<HTMLButtonElement>('.lid-cup')!
  expect(tree.container.querySelector('.lid-digit:not(.lid-digit-out)')?.textContent).toBe('23')
  expect(tree.container.querySelectorAll('.lid-tick')).toHaveLength(4)
  expect(tree.container.querySelectorAll('.lid-tick.selected')).toHaveLength(1)
  expect(cup.title).toBe('Keeping awake for 23 more minutes. Next: 60 minutes')
  expect(cup.getAttribute('aria-label')).toContain('Next: 60 minutes')
  const height = Number(tree.container.querySelector('.lid-liquid')?.getAttribute('height'))
  expect(height).toBeCloseTo(17 * lidFill(23))
  await act(async () => { cup.click() })
  expect(tree.container.querySelector('.lid-digit:not(.lid-digit-out)')?.textContent).toBe('53')
  expect(tree.container.querySelector('.lid-active')).not.toBeNull()
  expect(bridge.commands).toEqual([])
  await act(async () => { bridge.publish(initial('active', { mode: 'timed', allowance: 30, remainingSeconds: 5 * 60 })) })
  expect(tree.container.querySelector('.lid-digit:not(.lid-digit-out)')?.textContent).toBe('35')
  await act(async () => { await Bun.sleep(1100) })
  await act(async () => { bridge.publish(initial('active', { mode: 'timed', allowance: 30, remainingSeconds: 5 * 60 })) })
  expect(tree.container.querySelector('.lid-digits.warn')).not.toBeNull()
  await act(async () => { bridge.publish(initial('ended', { mode: 'timed', allowance: 30, remainingSeconds: 0, reason: 'expired' })) })
  expect(tree.container.querySelector('.lid-off')).not.toBeNull()
  expect(tree.container.querySelector('.lid-mark')).toBeNull()
  expect(tree.container.querySelector('.lid-digits')).toBeNull()
  expect(cup.title).toBe('Timer finished. Normal sleep restored. Next: until all work finishes')
  await act(async () => { bridge.publish(initial('ended', { mode: 'timed', allowance: 30, remainingSeconds: 0, reason: 'expired', workAvailable: false })) })
  expect(cup.title).toBe('Timer finished. Normal sleep restored. Next: 15 minutes')
  expect(cup.getAttribute('aria-label')).toContain('Next: 15 minutes')
  await act(async () => { bridge.publish(initial('starting', { mode: 'timed', allowance: 15, remainingSeconds: 0 })) })
  await act(async () => { cup.focus() })
  expect(tree.container.querySelector('.sr-only')?.textContent).toBe('15 minutes.')
  expect(cup.getAttribute('aria-label')).toContain('Keep awake for 15 minutes.')
})

test('one shared preview updates every cup and provider unmount flushes exactly once', async () => {
  const bridge = cycleBridge(initial('off', { mode: null }))
  const tree = await harness.mount(<LidClosedProvider>{[0, 1].map(index => <LidClosedCup key={index} faceProps={{ 'data-composer-face': `lid-${index}`, tabIndex: 0, onFocus() {} }} />)}</LidClosedProvider>)
  const cups = [...tree.container.querySelectorAll<HTMLButtonElement>('.lid-cup')]
  await act(async () => { cups[0]!.click() })
  await act(async () => { cups[1]!.click() })
  expect([...tree.container.querySelectorAll('.lid-digit:not(.lid-digit-out)')].map(element => element.textContent)).toEqual(['15', '15'])
  await act(async () => { await harness.unmountAll() })
  expect(bridge.commands).toEqual([{ action: 'set', target: 15 }])
})

test('safety restoration failure cancels an unsent selection instead of starting after it', async () => {
  const bridge = cycleBridge(initial('off', { mode: null }))
  const tree = await harness.mount(<LidClosedProvider><LidClosedCup faceProps={{ 'data-composer-face': 'lid', tabIndex: 0, onFocus() {} }} /></LidClosedProvider>)
  await act(async () => { tree.container.querySelector<HTMLButtonElement>('.lid-cup')!.click() })
  await act(async () => { bridge.publish(initial('unresolved', { error: 'Normal sleep has not been restored.' })) })
  await act(async () => { await Bun.sleep(1100) })
  expect(bridge.commands).toEqual([])
  expect(tree.container.querySelector('.lid-unresolved')).not.toBeNull()
})

test('pure stepping and fill handle fixed endpoints and completed work', () => {
  expect(nextLidTarget(initial('active', { mode: 'timed', allowance: 15, workAvailable: false }), 'down')).toBe('off')
  expect(nextLidTarget(initial('active', { mode: 'timed', allowance: 120 }), 'up')).toBe(120)
  expect(nextLidTarget(initial('active', { mode: 'work', workAvailable: false }), 'down')).toBe('off')
  for (const [minutes, fill] of [[0, 0], [15, .25], [30, .5], [60, .75], [120, 1]])
    expect(lidFill(minutes!)).toBe(fill)
})

test('a late reply cannot overwrite a newer confirmed target', async () => {
  let finishFirst!: (value: LidModeView) => void
  const commands: LidModeCommand[] = []
  const off = initial('off', { mode: null })
  window.catcode = { lidClosed: {
    read: async () => off, subscribe: () => () => {},
    command: async (value: LidModeCommand) => {
      commands.push(value)
      if (commands.length === 1) return new Promise<LidModeView>(resolve => { finishFirst = resolve })
      return initial('active', { mode: 'timed', allowance: 30, remainingSeconds: 1800 })
    },
  } } as unknown as CatCodeBridge
  const tree = await harness.mount(<LidClosedProvider><LidClosedCup faceProps={{ 'data-composer-face': 'lid', tabIndex: 0, onFocus() {} }} /></LidClosedProvider>)
  const cup = tree.container.querySelector<HTMLButtonElement>('.lid-cup')!
  await act(async () => { cup.click() })
  await act(async () => { await Bun.sleep(1100) })
  await act(async () => { cup.click() })
  await act(async () => { cup.click() })
  await act(async () => { await Bun.sleep(1100) })
  expect(commands).toEqual([{ action: 'set', target: 'work' }, { action: 'set', target: 30 }])
  await act(async () => { finishFirst(initial('active')) })
  expect(tree.container.querySelector('.lid-digit:not(.lid-digit-out)')?.textContent).toBe('30')
  expect(cup.title).toBe('Keeping awake for 30 more minutes. Next: 60 minutes')
})

test('inspection refreshes work presence before choosing the optional work step', async () => {
  let view = initial('off', { mode: null, workAvailable: false })
  let reads = 0
  window.catcode = { lidClosed: {
    read: async () => { reads++; return view }, subscribe: () => () => {}, command: async () => view,
  } } as unknown as CatCodeBridge
  const tree = await harness.mount(<LidClosedProvider><LidClosedCup faceProps={{ 'data-composer-face': 'lid', tabIndex: 0, onFocus() {} }} /></LidClosedProvider>)
  const cup = tree.container.querySelector<HTMLButtonElement>('.lid-cup')!
  expect(cup.title).toBe('Keep awake for 15 minutes')
  view = initial('off', { mode: null, workAvailable: true })
  await act(async () => { cup.focus() })
  expect(reads).toBe(2)
  expect(cup.title).toBe('Keep awake until all work finishes')
  await act(async () => { cup.click() })
  expect(tree.container.querySelector('.lid-starting')).not.toBeNull()
  expect(tree.container.querySelector('.lid-digits')).toBeNull()
  expect(cup.getAttribute('aria-label')).toBe('Keep awake until all work finishes. Next: 15 minutes.')
})

test('StrictMode remount adopts the in-flight presence read without a duplicate query', async () => {
  let resolveRead!: (value: LidModeView) => void
  const pending = new Promise<LidModeView>(resolve => { resolveRead = resolve })
  let reads = 0
  window.catcode = { lidClosed: {
    read: () => { reads++; return pending }, subscribe: () => () => {}, command: async () => initial('off'),
  } } as unknown as CatCodeBridge
  const tree = await harness.mount(<StrictMode><LidClosedProvider><LidClosedCup faceProps={{ 'data-composer-face': 'lid', tabIndex: 0, onFocus() {} }} /></LidClosedProvider></StrictMode>)
  expect(reads).toBe(1)
  await act(async () => { resolveRead(initial('off', { mode: null, workAvailable: true })) })
  expect(tree.container.querySelector<HTMLButtonElement>('.lid-cup')!.title).toBe('Keep awake until all work finishes')
})
