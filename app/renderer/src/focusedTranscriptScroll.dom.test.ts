import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { createFocusedTranscriptScroll } from './focusedTranscriptScroll.js'
import { _forTest, compensatePanePrefix } from './markdownScrollCoordinator.js'
import { registerTranscriptRowOffsets } from './transcriptRowNavigation.js'
import { selectCompositeChildWindow } from './compositeChildWindow.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterAll(async () => { await harness.teardown() })

function fixture(initialFollowing = true, reducedMotion = true) {
  const scroller = document.createElement('div')
  const column = document.createElement('div')
  scroller.append(column)
  document.body.append(scroller)
  let end = 1100
  Object.defineProperties(scroller, {
    clientHeight: { value: 500 }, clientWidth: { value: 300 },
    scrollHeight: { get: () => end + Number.parseFloat(scroller.lastElementChild?.getAttribute('style')?.match(/: ([\d.]+)px/)?.[1] ?? '0') },
  })
  scroller.getBoundingClientRect = () => ({ top: 80, left: 20 } as DOMRect)
  const addRow = (id: string, top: number) => {
    const row = document.createElement('div')
    row.setAttribute('data-row-key', id)
    row.getBoundingClientRect = () => ({ top: 80 + top - scroller.scrollTop } as DOMRect)
    column.append(row)
  }
  addRow('user', 1000)
  addRow('answer', 1050)
  const controller = createFocusedTranscriptScroll(scroller, { initialFollowing, reducedMotion: () => reducedMotion })
  return { scroller, controller, addRow, setEnd: (value: number) => { end = value },
    space: () => (scroller.lastElementChild as HTMLElement).style.getPropertyValue('--focused-transcript-space-height') || '0px',
    cleanup: () => { controller.dispose(); scroller.remove() } }
}

test('reserves a viewport with scroller-relative row geometry, follows overflow and returns to message for answer', () => {
  const f = fixture()
  f.controller.update({ generating: true, userRowId: 'user' })
  expect(f.space()).toBe('400px')
  expect(f.scroller.scrollTop).toBe(1000)
  f.setEnd(1800)
  f.controller.update({ generating: true, userRowId: 'user' })
  expect(f.space()).toBe('0px')
  expect(f.scroller.scrollTop).toBe(1300)
  f.controller.update({ generating: false, userRowId: 'user', answerRowId: 'answer' })
  expect(f.scroller.scrollTop).toBe(1000)
  expect(f.space()).toBe('0px')
  f.cleanup()
})

test('initial binding preserves retained position; new send resumes', () => {
  const f = fixture(false)
  f.scroller.scrollTop = 70
  f.controller.update({ generating: true, userRowId: 'user' })
  expect(f.scroller.scrollTop).toBe(70)
  expect(f.controller.isFollowing()).toBe(false)
  f.addRow('new', 1100)
  f.setEnd(1200)
  f.controller.update({ generating: true, userRowId: 'new' })
  expect(f.controller.isFollowing()).toBe(true)
  expect(f.scroller.scrollTop).toBe(1100)
  f.cleanup()
})

for (const kind of ['wheel', 'touch', 'ArrowUp', 'PageUp', 'Home', 'scrollbar']) {
  test(`${kind} immediately cancels send motion and geometry cannot reacquire`, async () => {
    const f = fixture(true, false)
    f.controller.update({ generating: true, userRowId: 'user' })
    f.addRow('new', 1100)
    f.controller.update({ generating: true, userRowId: 'new' })
    const event = kind === 'wheel' ? new WheelEvent('wheel', { deltaY: -0.01 })
      : kind === 'touch' ? new Event('touchmove')
        : kind === 'scrollbar' ? new PointerEvent('pointerdown', { clientX: 325 })
          : new KeyboardEvent('keydown', { key: kind })
    f.scroller.dispatchEvent(event)
    expect(f.controller.isFollowing()).toBe(false)
    const position = f.scroller.scrollTop
    f.setEnd(1900)
    f.controller.update({ generating: true, userRowId: 'new' })
    await harness.nextFrame()
    expect(f.scroller.scrollTop).toBe(position)
    expect(f.controller.isFollowing()).toBe(false)
    f.scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 1 }))
    f.scroller.scrollTop = f.scroller.scrollHeight - f.scroller.clientHeight
    f.scroller.dispatchEvent(new Event('scroll'))
    expect(f.controller.isFollowing()).toBe(true)
    f.cleanup()
  })
}

test('programmatic scroll stays following; completion has exactly zero reserved height', async () => {
  const f = fixture()
  f.controller.update({ generating: true, userRowId: 'user' })
  f.scroller.dispatchEvent(new Event('scroll'))
  expect(f.controller.isFollowing()).toBe(true)
  f.controller.update({ generating: false, userRowId: 'user' })
  expect(f.space()).toBe('0px')
  expect(f.scroller.scrollHeight).toBe(1100)
  f.cleanup()
  expect(_forTest.isPaneAttached(f.scroller)).toBe(false)
  expect(f.scroller.querySelector('.focused-transcript-space')).toBeNull()
  f.scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }))
  expect(f.controller.isFollowing()).toBe(true)
  await harness.nextFrame()
})

test('pooled correction reaching the end does not resume a released reader', () => {
  const f = fixture(false)
  f.controller.update({ generating: true, userRowId: 'user' })
  compensatePanePrefix(f.scroller, f.scroller.scrollHeight - f.scroller.clientHeight)
  f.scroller.dispatchEvent(new Event('scroll'))
  expect(f.controller.isFollowing()).toBe(false)
  f.cleanup()
})

test('a browser scroll event caused by document shrink cannot reacquire after an upward wheel', () => {
  const f = fixture()
  f.controller.update({ generating: true, userRowId: 'user' })
  f.scroller.dispatchEvent(new Event('scroll'))
  f.scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -0.01 }))
  f.setEnd(1000)
  f.scroller.scrollTop = f.scroller.scrollHeight - f.scroller.clientHeight
  f.scroller.dispatchEvent(new Event('scroll'))
  expect(f.controller.isFollowing()).toBe(false)
  f.cleanup()
})

test('opening a work disclosure preserves the reader position through its layout change', () => {
  const f = fixture()
  f.controller.update({ generating: true, userRowId: 'user' })
  const head = document.createElement('button')
  head.className = 'focused-step-head'
  f.scroller.firstElementChild!.append(head)
  head.click()
  const top = f.scroller.scrollTop
  f.setEnd(1800)
  f.controller.update({ generating: true, userRowId: 'user' })
  expect(f.controller.isFollowing()).toBe(false)
  expect(f.scroller.scrollTop).toBe(top)
  f.cleanup()
})

test('animated collapse ends at zero and dispose cancels outstanding motion', async () => {
  const f = fixture(true, false)
  f.controller.update({ generating: true, userRowId: 'user' })
  f.controller.update({ generating: false, userRowId: 'user' })
  await new Promise(resolve => setTimeout(resolve, 370))
  expect(f.space()).toBe('0px')
  f.controller.update({ generating: true, userRowId: 'user' })
  f.addRow('new', 1100)
  f.controller.update({ generating: true, userRowId: 'new' })
  f.cleanup()
  const top = f.scroller.scrollTop
  await harness.nextFrame()
  expect(f.scroller.scrollTop).toBe(top)
  expect(_forTest.isPaneAttached(f.scroller)).toBe(false)
})

for (const input of ['wheel', 'PageDown']) {
  test(`completed answers permit downward reading with ${input}`, async () => {
    const f = fixture()
    try {
      f.setEnd(2400)
      f.controller.update({ generating: true, userRowId: 'user' })
      f.controller.update({ generating: false, userRowId: 'user', answerRowId: 'answer' })
      expect(f.scroller.scrollTop).toBe(1000)
      f.scroller.dispatchEvent(input === 'wheel' ? new WheelEvent('wheel', { deltaY: 100 }) : new KeyboardEvent('keydown', { key: input }))
      f.scroller.scrollTop = 1200
      f.scroller.dispatchEvent(new Event('scroll'))
      await harness.nextFrame()
      await harness.nextFrame()
      expect(f.scroller.scrollTop).toBe(1200)
      expect(f.controller.isFollowing()).toBe(false)
    } finally { f.cleanup() }
  })
}

test('resume during completion clears reserved space instead of cancelling its cleanup', async () => {
  const f = fixture(true, false)
  try {
    f.controller.update({ generating: true, userRowId: 'user' })
    expect(f.space()).toBe('400px')
    f.controller.release()
    f.controller.update({ generating: false, userRowId: 'user', answerRowId: 'answer' })
    f.controller.resume()
    expect(f.space()).toBe('0px')
    await new Promise(resolve => setTimeout(resolve, 370))
    expect(f.space()).toBe('0px')
  } finally { f.cleanup() }
})

test('completion uses virtual offsets when a long answer has unmounted both message roots', () => {
  const f = fixture()
  const entries = [{ key: 'user', height: 60 }, { key: 'work', height: 1800 }, { key: 'answer', height: 2200 }, { key: 'result', height: 30 }]
  expect(selectCompositeChildWindow(entries, 3590, 500).start).toBe(2)
  const unregister = registerTranscriptRowOffsets(f.scroller, key => key === 'user' ? 1000 : null)
  try {
    f.setEnd(5090)
    f.scroller.querySelector('[data-row-key="user"]')!.remove()
    f.scroller.querySelector('[data-row-key="answer"]')!.remove()
    f.controller.update({ generating: true, userRowId: 'user' })
    f.controller.update({ generating: false, userRowId: 'user', answerRowId: 'answer' })
    expect(f.scroller.scrollTop).toBe(1000)
  } finally { unregister(); f.cleanup() }
})
