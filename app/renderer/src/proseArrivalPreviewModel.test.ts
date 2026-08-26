import { expect, test } from 'bun:test'
import {
  PROSE_PREVIEW_CHUNKS,
  PROSE_PREVIEW_HOLD_TICKS,
  PROSE_PREVIEW_START_TICK,
  nextPreviewTick,
  prosePreviewFrame,
} from './proseArrivalPreviewModel.js'

/** Every frame of one period, starting from a fresh mount. */
function onePeriod(): ReturnType<typeof prosePreviewFrame>[] {
  const frames = []
  let tick = PROSE_PREVIEW_START_TICK
  // One full lap plus a margin, so a loop that fails to wrap is visible rather
  // than merely truncated.
  for (let step = 0; step < PROSE_PREVIEW_CHUNKS.length + PROSE_PREVIEW_HOLD_TICKS + 4; step += 1) {
    frames.push(prosePreviewFrame(tick))
    tick = nextPreviewTick(tick)
  }
  return frames
}

test('the loop advances through every chunk instead of repeating one', () => {
  // THE regression. The shipped loop reset its counter on every advance, so the
  // sample reached chunk one and re-delivered it forever; every option looked
  // identical because none of them ever moved. Counting distinct sources over a
  // period catches that with no clock involved.
  const sources = new Set(onePeriod().map(frame => frame.source))
  expect(sources.size).toBe(PROSE_PREVIEW_CHUNKS.length + 1) // each prefix, plus empty
})

test('a fresh mount shows settled text with nothing marked', () => {
  // Opening Settings must not animate a chunk that did not just arrive.
  const first = prosePreviewFrame(PROSE_PREVIEW_START_TICK)
  expect(first.source).toBe(PROSE_PREVIEW_CHUNKS.join(''))
  expect(first.priorLength).toBe(-1)
})

test('the marked range is exactly the newest chunk, never more', () => {
  for (let delivered = 1; delivered <= PROSE_PREVIEW_CHUNKS.length; delivered += 1) {
    const { source, priorLength } = prosePreviewFrame(delivered)
    expect(source.slice(priorLength)).toBe(PROSE_PREVIEW_CHUNKS[delivered - 1])
  }
})

test('nothing is marked while the settled result is held', () => {
  for (let held = 1; held <= PROSE_PREVIEW_HOLD_TICKS; held += 1) {
    const frame = prosePreviewFrame(PROSE_PREVIEW_CHUNKS.length + held)
    expect(frame.source).toBe(PROSE_PREVIEW_CHUNKS.join(''))
    expect(frame.priorLength).toBe(-1)
  }
})

test('the period wraps back to empty and starts over', () => {
  const last = PROSE_PREVIEW_CHUNKS.length + PROSE_PREVIEW_HOLD_TICKS
  expect(nextPreviewTick(last)).toBe(0)
  expect(prosePreviewFrame(0).source).toBe('')
  expect(prosePreviewFrame(0).priorLength).toBe(-1)
  // And the tick after the wrap delivers again, rather than stalling at empty.
  expect(prosePreviewFrame(nextPreviewTick(0)).source).toBe(PROSE_PREVIEW_CHUNKS[0])
})

test('the sample is long enough for flowing to be told apart', () => {
  // `flowing` staggers 25ms a word. Four chunks finished before the difference
  // from `smooth` was legible, which is why the sample was replaced.
  const words = PROSE_PREVIEW_CHUNKS.join('').trim().split(/\s+/).length
  expect(words).toBeGreaterThan(40)
})

test('chunks are not word-aligned, because real deltas are not', () => {
  // A batch that ends mid-word is the case the marking has to survive, so the
  // preview must actually contain some.
  const midWord = PROSE_PREVIEW_CHUNKS.slice(0, -1).filter(
    chunk => !/\s$/.test(chunk),
  )
  expect(midWord.length).toBeGreaterThan(0)
})
