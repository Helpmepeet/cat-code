/**
 * Bounded mounted children for the transcript's COMPOSITE containers: an
 * expanded nested agent transcript, a grouped tool run, and a delegate group.
 *
 * CC-59 bounded the LEAVES — `markdownRenderPlan.ts` slices one parsed document
 * into a bounded window of semantic leaves, `lineWindow.ts` bounds mounted
 * output rows and the characters inside one visual chunk. None of that helps a
 * container that mounts every child at once: one expanded agent transcript with
 * a few thousand child rows, or one grouped read run with a few thousand
 * members, re-creates the unbounded pane those two modules exist to prevent.
 * This module is the same shape one level up — a range over CHILDREN rather
 * than over leaves.
 *
 * WHAT IS BOUNDED IS THE DOM, NOT THE MODEL. Every caller keeps its complete
 * member list and every count it prints ("3 files", "N agents finished") is
 * still derived from that full list. A window narrows what mounts; it never
 * narrows what the container knows.
 *
 * HEIGHTS. A child's height is unknowable before it mounts, so a container
 * supplies one uniform estimate for its kind of child and the browser replaces
 * it per child as each one is measured. Retention is capped
 * (`MAX_RETAINED_CHILD_MEASUREMENTS`) with least-recently-measured eviction, so
 * a long scroll through a large container cannot turn the measurement cache
 * into the unbounded structure the mounted DOM stopped being.
 *
 * Kept pure and separate from `TranscriptView.tsx` for the reason
 * `inlineOutputWindow.ts` states: the SSR renderer suite can assert a first
 * paint but cannot scroll, so the range transitions are only provable against
 * these functions directly.
 */

/**
 * The most children one container mounts at once.
 *
 * Sized against the shortest child any of the three containers has: a tool-run
 * member row is a single ~24 px line, so 80 rows cover a ~800 px viewport plus
 * `COMPOSITE_CHILD_OVERSCAN` of lead-in and still leave the far side of the
 * viewport mounted. Taller children never reach the ceiling at all, because the
 * geometry loop below stops at the overscan boundary first. It is also below
 * `MAX_MOUNTED_MARKDOWN_LEAVES` (120), so one container's own contribution to
 * the pane stays smaller than one Markdown body's.
 */
export const MAX_MOUNTED_COMPOSITE_CHILDREN = 80

/**
 * Extra height mounted above and below the viewport. Deliberately half the
 * Markdown overscan: a composite child is far more expensive to mount than a
 * paragraph, and the ceiling above has to cover both sides of the viewport
 * within the same 80 children.
 */
export const COMPOSITE_CHILD_OVERSCAN = 400

/** Measured heights retained per container. Beyond this the oldest go. */
export const MAX_RETAINED_CHILD_MEASUREMENTS = 240

/** Viewport used before a real scroller has reported one. */
export const INITIAL_CHILD_VIEWPORT_HEIGHT = 800

export type CompositeChildEntry = {
  /** The child's stable identity: a row id, or a derivation id for a group. */
  key: string
  /** Measured height when this child has been measured, the estimate otherwise. */
  height: number
}

export type CompositeChildWindow = {
  /** First mounted index. */
  start: number
  /** One past the last mounted index. */
  end: number
  /** Height standing in for children before `start`. */
  topSpacerHeight: number
  /** Height standing in for children from `end` on. */
  bottomSpacerHeight: number
}

export type CompositeChildMeasurement = {
  key: string
  height: number
}

export type CompositeChildState = {
  /**
   * Heights measured in the browser, by child key. Insertion order is measurement
   * recency, which is what the eviction below consumes.
   */
  readonly heights: ReadonlyMap<string, number>
}

export type CompositeChildAction = {
  kind: 'measured'
  measurements: readonly CompositeChildMeasurement[]
}

export function createCompositeChildState(): CompositeChildState {
  return { heights: new Map() }
}

/**
 * Folds browser measurements in. Returns the SAME state object when nothing
 * moved, so a resize that reports the height a child already had cannot
 * re-render the container.
 */
export function reduceCompositeChildState(
  state: CompositeChildState,
  action: CompositeChildAction,
): CompositeChildState {
  switch (action.kind) {
    case 'measured': {
      let next: Map<string, number> | null = null
      for (const measurement of action.measurements) {
        const height = Math.ceil(measurement.height)
        if (!Number.isFinite(height) || height <= 0) continue
        const current = state.heights.get(measurement.key)
        if (current === height) continue
        next ??= new Map(state.heights)
        // Delete before set so a re-measured child moves to the END of the map:
        // insertion order is what makes the eviction below least-recently-measured
        // rather than first-seen.
        next.delete(measurement.key)
        next.set(measurement.key, height)
      }
      if (next === null) return state
      while (next.size > MAX_RETAINED_CHILD_MEASUREMENTS) {
        const oldest = next.keys().next()
        if (oldest.done === true) break
        next.delete(oldest.value)
      }
      return { heights: next }
    }
    default: {
      // Closed-union tripwire (house rule): a new action kind breaks the build
      // here until it is handled deliberately.
      const _exhaustive: never = action.kind
      void _exhaustive
      return state
    }
  }
}

/**
 * The entries a window is selected over: one per child, in order, carrying the
 * measured height when there is one and the container's estimate otherwise.
 *
 * A height retained for a key that has left the list is simply never looked up,
 * which is why removal needs no separate pruning pass.
 */
export function selectCompositeChildEntries(
  keys: readonly string[],
  estimatedHeight: number,
  state: CompositeChildState,
): CompositeChildEntry[] {
  const estimate = Math.max(1, Math.round(estimatedHeight))
  return keys.map(key => ({ key, height: state.heights.get(key) ?? estimate }))
}

/**
 * The window for a container whose geometry is known.
 *
 * `scrollOffset` is how far the container's own top sits above the top of the
 * pane viewport, so 0 means "the container starts exactly at the top of the
 * visible area" and a positive value means it has scrolled up past it.
 */
export function selectCompositeChildWindow(
  entries: readonly CompositeChildEntry[],
  scrollOffset: number,
  viewportHeight: number,
  overscan: number = COMPOSITE_CHILD_OVERSCAN,
  maxMounted: number = MAX_MOUNTED_COMPOSITE_CHILDREN,
): CompositeChildWindow {
  if (entries.length === 0) {
    return { start: 0, end: 0, topSpacerHeight: 0, bottomSpacerHeight: 0 }
  }

  const startOffset = Math.max(0, scrollOffset - overscan)
  const endOffset = Math.max(startOffset, scrollOffset + viewportHeight + overscan)
  let offset = 0
  let start = 0
  while (start < entries.length && offset + entries[start].height < startOffset) {
    offset += entries[start].height
    start += 1
  }

  let end = start
  let covered = offset
  while (end < entries.length && covered < endOffset && end - start < maxMounted) {
    covered += entries[end].height
    end += 1
  }

  // A container scrolled entirely out of view still keeps one child mounted, so
  // the range never collapses to an empty body the reader could mistake for a
  // container with nothing in it.
  if (end === start) {
    start = Math.max(0, Math.min(start, entries.length - 1))
    end = start + 1
  }

  return {
    start,
    end,
    topSpacerHeight: sumHeights(entries, 0, start),
    bottomSpacerHeight: sumHeights(entries, end, entries.length),
  }
}

/**
 * The first-paint window, before any geometry exists.
 *
 * Server rendering and the first client commit have no scroller and no
 * measurements, so a geometry slice would be computed entirely from estimates
 * and could cut a small container that would have fitted. The leading prefix
 * under the mount ceiling is bounded by construction and needs no estimate to
 * be right; geometry takes over on the first animation frame after mount.
 */
export function selectInitialCompositeChildWindow(
  entries: readonly CompositeChildEntry[],
  maxMounted: number = MAX_MOUNTED_COMPOSITE_CHILDREN,
): CompositeChildWindow {
  const end = Math.min(entries.length, Math.max(0, maxMounted))
  return {
    start: 0,
    end,
    topSpacerHeight: 0,
    bottomSpacerHeight: sumHeights(entries, end, entries.length),
  }
}

export function sameCompositeChildWindow(
  left: CompositeChildWindow,
  right: CompositeChildWindow,
): boolean {
  return (
    left.start === right.start &&
    left.end === right.end &&
    left.topSpacerHeight === right.topSpacerHeight &&
    left.bottomSpacerHeight === right.bottomSpacerHeight
  )
}

function sumHeights(
  entries: readonly CompositeChildEntry[],
  from: number,
  to: number,
): number {
  let total = 0
  for (let index = from; index < to; index += 1) total += entries[index].height
  return total
}
