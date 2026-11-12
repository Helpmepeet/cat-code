import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { PaneElapsedReadout } from './PaneElapsedReadout.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })

test('elapsed leaf ticks alone, catches up on reveal, and resets on stop or session switch', async () => {
  let now = 40_000
  let hidden = false
  const ticks = new Map<number, () => void>()
  let id = 0
  const clock = spyOn(Date, 'now').mockImplementation(() => now)
  const interval = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
    ticks.set(++id, callback)
    return id
  }) as typeof setInterval)
  const clear = spyOn(globalThis, 'clearInterval').mockImplementation(((key: number) => { ticks.delete(key) }) as typeof clearInterval)
  const visibility = Object.getOwnPropertyDescriptor(harness.document, 'hidden')
  Object.defineProperty(harness.document, 'hidden', { configurable: true, get: () => hidden })
  let siblingRenders = 0
  function Sibling() { siblingRenders++; return <div>Transcript</div> }
  const pane = (start: number | null) => <><Sibling /><PaneElapsedReadout turnStartedAt={start} outputTokens={{ quality: 'estimated', tokens: 123 }} /></>
  try {
    const tree = await harness.mount(pane(10_000))
    expect(tree.container.textContent).toContain('30s')
    expect(tree.container.textContent).not.toContain('tokens')
    const before = siblingRenders
    await act(async () => { now += 1000; for (const tick of ticks.values()) tick() })
    expect(tree.container.textContent).toContain('123 tokens')
    expect(siblingRenders).toBe(before)
    await act(async () => { hidden = true; harness.document.dispatchEvent(new Event('visibilitychange')) })
    expect(ticks.size).toBe(0)
    await act(async () => { now = 80_000; hidden = false; harness.document.dispatchEvent(new Event('visibilitychange')) })
    expect(tree.container.textContent).toContain('1m 10s')
    await tree.render(pane(75_000))
    expect(tree.container.textContent).toContain('5s')
    expect(tree.container.textContent).not.toContain('tokens')
    await tree.render(pane(null))
    expect(tree.container.textContent).toContain('0s')
    expect(ticks.size).toBe(0)
    await tree.unmount()
  } finally {
    clock.mockRestore(); interval.mockRestore(); clear.mockRestore()
    if (visibility) Object.defineProperty(harness.document, 'hidden', visibility)
    else Reflect.deleteProperty(harness.document, 'hidden')
  }
})
