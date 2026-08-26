/**
 * The arrival preview's delivery loop, as pure data.
 *
 * Extracted because the loop is what broke and timing is a bad way to test it.
 * The first version kept its step inside the effect's closure while the effect
 * depended on that step, so every advance reset the counter and the sample
 * re-delivered chunk one forever. A DOM test caught it but only by watching a
 * wall clock, which passed alone and failed in a loaded 256-file suite: at that
 * point the test was measuring machine load, not the loop.
 *
 * Everything here is derived from ONE integer, so the whole period can be
 * enumerated in a test with no timers at all. The component keeps only the
 * interval that advances that integer.
 */

/** Delivered in chunks that are not word-aligned, because real ones are not.
 *
 * Long enough to judge by. Four chunks was not: `flowing` staggers 25ms a word,
 * so a handful of words finished before the eye could separate it from `smooth`,
 * and `instant` had too little arriving to read as a rhythm at all. */
export const PROSE_PREVIEW_CHUNKS: readonly string[] = [
  'The loader resolves every entry ',
  'twice. The first pass walks the ',
  'module graph to build a depende',
  'ncy list, then throws the graph ',
  'away. The second pass rebuilds t',
  'hat same graph from scratch to c',
  'onsume the list, and nothing bet',
  'ween the two passes can invalida',
  'te it. Removing the first pass d',
  'rops the whole thing to a single',
  ' traversal.',
]

export const PROSE_PREVIEW_CHUNK_MS = 260

/** Extra ticks after the last chunk, so the settled result is readable. */
export const PROSE_PREVIEW_HOLD_TICKS = 6

/** The tick a freshly mounted preview starts on.
 *
 * Inside the hold, NOT on the last chunk: the first paint has to show settled
 * text with nothing marked, or opening Settings animates a chunk that did not
 * just arrive. */
export const PROSE_PREVIEW_START_TICK = PROSE_PREVIEW_CHUNKS.length + 1

const LAST_TICK = PROSE_PREVIEW_CHUNKS.length + PROSE_PREVIEW_HOLD_TICKS

export type ProsePreviewFrame = {
  /** The source delivered so far. */
  source: string
  /** Where the newest chunk began, or -1 when nothing just arrived. */
  priorLength: number
}

export function nextPreviewTick(tick: number): number {
  return tick >= LAST_TICK ? 0 : tick + 1
}

export function prosePreviewFrame(tick: number): ProsePreviewFrame {
  const delivered = Math.min(Math.max(tick, 0), PROSE_PREVIEW_CHUNKS.length)
  const source = PROSE_PREVIEW_CHUNKS.slice(0, delivered).join('')
  // -1 before anything is delivered and throughout the hold, so settled text is
  // never re-marked while it simply sits there.
  const priorLength =
    delivered === 0 || tick > PROSE_PREVIEW_CHUNKS.length
      ? -1
      : PROSE_PREVIEW_CHUNKS.slice(0, delivered - 1).join('').length
  return { source, priorLength }
}
