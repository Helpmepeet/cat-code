/**
 * Inline tool-output windowing (P4-36).
 *
 * `ToolCardBody` is handed the FULL `row.result.content` — the same untruncated
 * string `describeToolForInspector` republishes as `output`
 * (`toolInspectorModel.ts`) and the inspector drawer reads. The projector never
 * truncates, so any narrowing an inline body performs is purely a render-layer
 * window and MUST be disclosed: otherwise the last visible line reads as the end
 * of the output and the user forms a wrong belief with no signal.
 *
 * The shape is the prototype's `BashOutputCard` head+tail window
 * (`~/catcode_prototype/cat-app/Messages.jsx:398,438-457,546-556`): a head that
 * grows one reveal at a time, a fixed tail so the LAST lines stay visible however
 * long the output is, and a reveal band in the gap between them.
 *
 * Kept pure and separate from `TranscriptView.tsx` because the renderer test
 * suite is SSR-only: it can assert the first paint but cannot click the reveal
 * control, so progressive reveal is only provable against these functions.
 */

/** Lines shown above the band on first paint (prototype `HEAD0`). */
export const INLINE_HEAD_LINES = 30

/**
 * Lines pinned to the end of the body. The reason the window is head+tail rather
 * than a flat cap: a truncated output whose tail is hidden looks finished
 * (prototype `TAIL`).
 */
export const INLINE_TAIL_LINES = 6

/** Lines a single reveal adds to the head (prototype `STEP`). */
export const INLINE_REVEAL_STEP = 100

export type InlineOutputWindow = {
  /** Leading lines, rendered above the band. The whole body when nothing is hidden. */
  head: string[]
  /** Trailing lines, rendered below the band. Empty when nothing is hidden. */
  tail: string[]
  /** 1-based line number of `tail[0]`, so a numbered body labels the tail truthfully. */
  tailStartLine: number
  /** Lines in the gap that nothing on screen shows. */
  hidden: number
  /** Lines the next reveal would add, never more than are actually hidden. */
  revealStep: number
  /** `hidden > 0`: the band renders and the tail splits off. */
  truncated: boolean
}

/**
 * Split `lines` into the visible head/tail pair for a head of `headShown` lines.
 *
 * Collapses to "render everything, no band" whenever the gap is empty, which
 * covers the three quiet states as one case: output under the window, output
 * shorter than the tail, and a head grown past the end by repeated reveals.
 */
export function selectInlineOutputWindow(
  lines: string[],
  headShown: number,
): InlineOutputWindow {
  const head = Math.max(0, Math.min(headShown, lines.length))
  const hidden = Math.max(0, lines.length - head - INLINE_TAIL_LINES)
  if (hidden === 0) {
    return {
      head: lines,
      tail: [],
      tailStartLine: lines.length + 1,
      hidden: 0,
      revealStep: 0,
      truncated: false,
    }
  }
  return {
    head: lines.slice(0, head),
    tail: lines.slice(lines.length - INLINE_TAIL_LINES),
    tailStartLine: lines.length - INLINE_TAIL_LINES + 1,
    hidden,
    revealStep: Math.min(INLINE_REVEAL_STEP, hidden),
    truncated: true,
  }
}

/**
 * The `headShown` a reveal produces. Clamped to `totalLines` so repeated reveals
 * settle on the whole body instead of growing an index past the content.
 */
export function revealMoreLines(headShown: number, totalLines: number): number {
  return Math.min(headShown + INLINE_REVEAL_STEP, Math.max(0, totalLines))
}
