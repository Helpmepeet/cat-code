/**
 * The pure geometry model behind `VirtualLineList` (CC-59, `711-F4`).
 *
 * The first cut of this file assumed every logical line was exactly
 * `OUTPUT_LINE_HEIGHT` tall and multiplied. That is true for an UNWRAPPED body
 * and false for a wrapped one: a soft-wrapped logical line occupies as many
 * visual lines as it needs, so scroll position, spacer sums and search-match
 * centring all drifted by whatever the wrap added. Two geometries live here
 * instead of one:
 *
 * - `fixed`: no measurement deviates from the grid, so every offset is exact
 *   arithmetic and nothing is allocated. `VirtualLineList` gives the row box
 *   `MIN_ROW_HEIGHT_CLASS` while in this mode so an ordinary line matches the
 *   grid without clipping a wrapped line to that estimate for one frame.
 * - `measured`: at least one row (or one piece of interstitial chrome) reported
 *   a height the grid does not predict. Offsets come from a prefix index over
 *   the DEVIATIONS only, so a 100k-line body with 40 measured rows carries 40
 *   entries, not 100k.
 *
 * A measurement is qualified by the logical line index, the exact text measured
 * and a layout revision. The revision covers everything that changes a row's
 * box without changing its text: the container width and the container class
 * list, which is where the inspector's wrap toggle lives. Either moving
 * invalidates the wrapped measurements taken under the old layout; a line whose
 * text is unchanged keeps its own entry when a NEIGHBOUR's text changes.
 *
 * Three separate fixed budgets are deliberate, and none of them bounds retained
 * data. The model keeps the complete source; only mounted DOM is bounded.
 *   1. `MAX_MOUNTED_OUTPUT_LINES` — logical rows mounted at once.
 *   2. `MAX_MOUNTED_CHUNK_CHARS`  — characters mounted for ONE logical line.
 *   3. `MAX_RENDERED_HIGHLIGHT_SEGMENTS` (`outputSearchModel.ts`) — highlight
 *      descendants inside one mounted chunk.
 * A single logical line of several megabytes counts as one row against budget 1
 * and would still mount one enormous text node without budget 2; a repetitive
 * one-character query over that line would still build an unbounded segment
 * array without budget 3.
 */

/** Budget 1 of 3: logical rows mounted at once, in either geometry. */
export const MAX_MOUNTED_OUTPUT_LINES = 200

/**
 * Budget 2 of 3: characters mounted for one logical line.
 *
 * At 11.5px monospace an inspector row fits roughly 60 characters, so 4,000
 * characters is around 67 wrapped visual lines: more than any viewport shows at
 * once, and small enough that the browser never lays out a multi-megabyte text
 * node. Search and copy read the full string from the model, never from this.
 */
export const MAX_MOUNTED_CHUNK_CHARS = 4_000

/** The fixed grid an unwrapped body is laid out on. */
export const OUTPUT_LINE_HEIGHT = 20

/**
 * Gives an ordinary row the grid's `OUTPUT_LINE_HEIGHT` without forcing wrapped
 * content to that estimate. The bodies routed through `VirtualLineList` are
 * `text-[11.5px] leading-relaxed`, which computes to 18.6875px, so the fixed
 * arithmetic was wrong by 6.5% per row before this class existed. `min-height`
 * is load-bearing: `height` briefly clips a wrapped tool error to one visual line
 * before its first measurement, then expands the card on the next animation
 * frame. A literal, because an interpolated arbitrary value never reaches the
 * Tailwind JIT; `lineWindow.test.ts` pins it to the constant.
 */
export const MIN_ROW_HEIGHT_CLASS = 'min-h-[20px]'

/** Rows kept mounted on each side of the viewport. */
export const DEFAULT_OVERSCAN_LINES = 20

export type LineWindow = {
  start: number
  end: number
  topSpacerHeight: number
  bottomSpacerHeight: number
}

export type LineMeasurement = {
  /** Measured height of the logical row itself. */
  height: number
  /** Measured height of interstitial chrome mounted immediately BEFORE the row. */
  chromeHeight: number
  /** The exact text measured, so a changed line loses only its own entry. */
  text: string
  /** The layout revision the measurement was taken under. */
  layoutRevision: string
}

export type LineMeasureEntry = {
  index: number
  height: number
  chromeHeight: number
  layoutRevision: string
}

/**
 * Ascending deviations from the fixed grid. Built at read time from the valid
 * measurements and cached on the state object that produced it, so a state that
 * nothing measured never allocates it at all.
 */
type LineDeltaIndex = {
  /** Logical line indices carrying chrome or a non-grid height, ascending. */
  indices: number[]
  /** Chrome mounted before `indices[k]`. */
  chrome: number[]
  /** `cumulative[k]` = summed deviation of `indices[0..k-1]`. */
  cumulative: number[]
  total: number
}

export type LineGeometryState = {
  readonly lines: readonly string[]
  readonly lineHeight: number
  readonly layoutRevision: string
  readonly measurements: ReadonlyMap<number, LineMeasurement>
  /**
   * The line a search step asked to centre on, held until one measured
   * correction has been applied. Estimate-scrolling mounts the target; the
   * measurement it produces is what makes the second, exact pass possible.
   */
  readonly pendingCentreIndex: number | null
  /** Read-time cache. Rebuilt on demand, never compared, never written by callers. */
  cachedIndex: LineDeltaIndex | null
}

export type LineGeometryAction =
  | { kind: 'lines'; lines: readonly string[] }
  | { kind: 'layout'; layoutRevision: string }
  | { kind: 'measure'; entries: readonly LineMeasureEntry[] }
  | { kind: 'centre'; index: number | null }
  /**
   * Carries the index it centred. Two search steps in one commit queue
   * `centre B` and `centred` together; an index-free acknowledgement clears
   * whatever is pending, so B would be dropped and the pane left on A.
   */
  | { kind: 'centred'; index: number }

export function createLineGeometryState(
  lines: readonly string[],
  options: { lineHeight?: number; layoutRevision?: string } = {},
): LineGeometryState {
  return {
    lines,
    lineHeight: options.lineHeight ?? OUTPUT_LINE_HEIGHT,
    layoutRevision: options.layoutRevision ?? '',
    measurements: new Map(),
    pendingCentreIndex: null,
    cachedIndex: null,
  }
}

export function reduceLineGeometryState(
  state: LineGeometryState,
  action: LineGeometryAction,
): LineGeometryState {
  switch (action.kind) {
    case 'lines': {
      if (action.lines === state.lines) return state
      // Prune: a line that left the source, or whose text changed, cannot keep
      // a height that was measured from different text.
      const measurements = new Map<number, LineMeasurement>()
      for (const [index, measurement] of state.measurements) {
        if (index >= action.lines.length) continue
        if (action.lines[index] !== measurement.text) continue
        measurements.set(index, measurement)
      }
      const pending =
        state.pendingCentreIndex !== null &&
        state.pendingCentreIndex >= action.lines.length
          ? null
          : state.pendingCentreIndex
      return {
        ...state,
        lines: action.lines,
        measurements,
        pendingCentreIndex: pending,
        cachedIndex: null,
      }
    }
    case 'layout': {
      if (action.layoutRevision === state.layoutRevision) return state
      const measurements = new Map<number, LineMeasurement>()
      for (const [index, measurement] of state.measurements) {
        if (measurement.layoutRevision !== action.layoutRevision) continue
        measurements.set(index, measurement)
      }
      return {
        ...state,
        layoutRevision: action.layoutRevision,
        measurements,
        cachedIndex: null,
      }
    }
    case 'measure': {
      let next: Map<number, LineMeasurement> | null = null
      for (const entry of action.entries) {
        if (entry.layoutRevision !== state.layoutRevision) continue
        if (entry.index < 0 || entry.index >= state.lines.length) continue
        if (!Number.isFinite(entry.height)) continue
        if (!Number.isFinite(entry.chromeHeight)) continue
        const text = state.lines[entry.index]
        const height = Math.max(0, entry.height)
        const chromeHeight = Math.max(0, entry.chromeHeight)
        const previous = state.measurements.get(entry.index)
        if (
          previous !== undefined &&
          previous.height === height &&
          previous.chromeHeight === chromeHeight &&
          previous.text === text &&
          previous.layoutRevision === entry.layoutRevision
        ) {
          continue
        }
        if (next === null) next = new Map(state.measurements)
        next.set(entry.index, {
          height,
          chromeHeight,
          text,
          layoutRevision: entry.layoutRevision,
        })
      }
      if (next === null) return state
      return { ...state, measurements: next, cachedIndex: null }
    }
    case 'centre': {
      if (action.index === state.pendingCentreIndex) return state
      return { ...state, pendingCentreIndex: action.index }
    }
    case 'centred': {
      if (state.pendingCentreIndex !== action.index) return state
      return { ...state, pendingCentreIndex: null }
    }
    default: {
      const unreachable: never = action
      return unreachable
    }
  }
}

function validMeasurement(
  state: LineGeometryState,
  index: number,
): LineMeasurement | null {
  const measurement = state.measurements.get(index)
  if (measurement === undefined) return null
  if (index >= state.lines.length) return null
  if (measurement.layoutRevision !== state.layoutRevision) return null
  if (measurement.text !== state.lines[index]) return null
  return measurement
}

function deltaIndex(state: LineGeometryState): LineDeltaIndex {
  const cached = state.cachedIndex
  if (cached !== null) return cached
  const valid: { index: number; measurement: LineMeasurement }[] = []
  for (const index of state.measurements.keys()) {
    const measurement = validMeasurement(state, index)
    if (measurement === null) continue
    const deviation =
      measurement.chromeHeight + measurement.height - state.lineHeight
    if (deviation === 0 && measurement.chromeHeight === 0) continue
    valid.push({ index, measurement })
  }
  valid.sort((left, right) => left.index - right.index)
  const indices: number[] = []
  const chrome: number[] = []
  const cumulative: number[] = [0]
  let running = 0
  for (const entry of valid) {
    indices.push(entry.index)
    chrome.push(entry.measurement.chromeHeight)
    running +=
      entry.measurement.chromeHeight +
      entry.measurement.height -
      state.lineHeight
    cumulative.push(running)
  }
  const built: LineDeltaIndex = { indices, chrome, cumulative, total: running }
  state.cachedIndex = built
  return built
}

/** Number of index entries strictly before `index`. */
function countBefore(indices: readonly number[], index: number): number {
  let low = 0
  let high = indices.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (indices[middle] < index) low = middle + 1
    else high = middle
  }
  return low
}

/**
 * `fixed` while every mounted row sat exactly on the grid and no interstitial
 * chrome was measured. Unwrapped output stays here for its whole life.
 */
export function selectGeometryMode(
  state: LineGeometryState,
): 'fixed' | 'measured' {
  return deltaIndex(state).indices.length === 0 ? 'fixed' : 'measured'
}

/**
 * Whether a row should keep `MIN_ROW_HEIGHT_CLASS`. Pinning only an unmeasured
 * row keeps ordinary output on the grid without constraining wrapped output.
 * Once measured, a row uses its natural height. This avoids retaining a
 * deviation entry for every ordinary line while `scrollHeight` still records
 * the final height of wrapped content.
 */
export function selectRowIsPinned(state: LineGeometryState, index: number): boolean {
  return validMeasurement(state, index) === null
}

export function selectTotalHeight(state: LineGeometryState): number {
  return state.lines.length * state.lineHeight + deltaIndex(state).total
}

/**
 * Top of the block occupied by line `index`, which starts at its interstitial
 * chrome rather than at the text. `selectBlockTop(state, lines.length)` is the
 * total height, so the two spacers always sum with the mounted rows.
 */
export function selectBlockTop(
  state: LineGeometryState,
  index: number,
): number {
  const clamped = Math.max(0, Math.min(index, state.lines.length))
  const built = deltaIndex(state)
  return (
    clamped * state.lineHeight +
    built.cumulative[countBefore(built.indices, clamped)]
  )
}

/** Measured height of interstitial chrome mounted immediately before `index`. */
export function selectChromeHeight(
  state: LineGeometryState,
  index: number,
): number {
  const built = deltaIndex(state)
  const at = countBefore(built.indices, index)
  return built.indices[at] === index ? built.chrome[at] : 0
}

/** Top of the line's own text, past any chrome mounted before it. */
export function selectLineTop(
  state: LineGeometryState,
  index: number,
): number {
  return selectBlockTop(state, index) + selectChromeHeight(state, index)
}

export function selectLineHeight(
  state: LineGeometryState,
  index: number,
): number {
  const measurement = validMeasurement(state, index)
  return measurement === null ? state.lineHeight : measurement.height
}

export function selectIsMeasured(
  state: LineGeometryState,
  index: number,
): boolean {
  return validMeasurement(state, index) !== null
}

/** The line whose block contains `offset`. */
export function selectLineAtOffset(
  state: LineGeometryState,
  offset: number,
): number {
  const count = state.lines.length
  if (count <= 0) return 0
  if (selectGeometryMode(state) === 'fixed') {
    return Math.max(
      0,
      Math.min(count - 1, Math.floor(Math.max(0, offset) / state.lineHeight)),
    )
  }
  let low = 0
  let high = count - 1
  let best = 0
  while (low <= high) {
    const middle = (low + high) >> 1
    if (selectBlockTop(state, middle) <= offset) {
      best = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return best
}

export function selectLineWindow(
  state: LineGeometryState,
  scrollTop: number,
  viewportHeight: number,
  overscanLines: number = DEFAULT_OVERSCAN_LINES,
  maxMountedLines: number = MAX_MOUNTED_OUTPUT_LINES,
): LineWindow {
  const count = state.lines.length
  if (count <= 0) {
    return { start: 0, end: 0, topSpacerHeight: 0, bottomSpacerHeight: 0 }
  }
  const top = Math.max(0, scrollTop)
  const bottom = top + Math.max(0, viewportHeight)
  let start: number
  let end: number
  if (selectGeometryMode(state) === 'fixed') {
    start = Math.max(0, Math.floor(top / state.lineHeight) - overscanLines)
    end = Math.min(count, Math.ceil(bottom / state.lineHeight) + overscanLines)
  } else {
    start = Math.max(0, selectLineAtOffset(state, top) - overscanLines)
    end = Math.min(count, selectLineAtOffset(state, bottom) + 1 + overscanLines)
  }
  end = Math.max(start + 1, end)
  if (end - start > maxMountedLines) end = start + maxMountedLines
  if (end > count) {
    end = count
    start = Math.max(0, end - maxMountedLines)
  }
  const total = selectTotalHeight(state)
  return {
    start,
    end,
    topSpacerHeight: selectBlockTop(state, start),
    bottomSpacerHeight: Math.max(0, total - selectBlockTop(state, end)),
  }
}

/**
 * Scroll offset that puts line `index` in the middle of the viewport.
 *
 * Called twice per search step by design: once against the estimate, which is
 * what mounts the target and gets it measured, then once against the
 * measurement. The second call is the single correction, not a settling loop.
 */
export function selectCentredScrollTop(
  state: LineGeometryState,
  index: number,
  viewportHeight: number,
): number {
  const height = Math.max(0, viewportHeight)
  const target =
    selectLineTop(state, index) + selectLineHeight(state, index) / 2 - height / 2
  const furthest = Math.max(0, selectTotalHeight(state) - height)
  return Math.min(Math.max(0, target), furthest)
}

/** A bounded slice of one logical line, with the offset it was cut from. */
export type VisualChunk = {
  text: string
  startOffset: number
  truncatedStart: boolean
  truncatedEnd: boolean
}

/**
 * Bound the characters mounted for ONE logical line, keeping `anchorOffset`
 * inside the slice so a search match on a pathological line is still reachable.
 * The caller keeps the full string: this decides what is painted, never what is
 * searched or copied.
 */
export function selectVisualChunk(
  line: string,
  anchorOffset: number = 0,
  maxChars: number = MAX_MOUNTED_CHUNK_CHARS,
): VisualChunk {
  const limit = Math.max(1, Math.floor(maxChars))
  if (line.length <= limit) {
    return {
      text: line,
      startOffset: 0,
      truncatedStart: false,
      truncatedEnd: false,
    }
  }
  const anchor = Number.isFinite(anchorOffset)
    ? Math.max(0, Math.min(Math.floor(anchorOffset), line.length))
    : 0
  const start = alignToCodePoint(
    line,
    Math.max(0, Math.min(anchor - Math.floor(limit / 2), line.length - limit)),
  )
  const end = alignToCodePoint(line, start + limit)
  return {
    text: line.slice(start, end),
    startOffset: start,
    truncatedStart: start > 0,
    truncatedEnd: end < line.length,
  }
}

/** Never cut between a surrogate pair: a lone half paints as a replacement glyph. */
function alignToCodePoint(line: string, at: number): number {
  if (at <= 0 || at >= line.length) return at
  const code = line.charCodeAt(at)
  return code >= 0xdc00 && code <= 0xdfff ? at - 1 : at
}
