/**
 * The DOM half of the line virtualizer (CC-59, `711-F4`). Every decision it
 * makes lives in `lineWindow.ts`, because this package renders to static markup
 * and cannot run an effect, a `ResizeObserver` or a scroll.
 *
 * What this file owns is the wiring the model cannot express:
 *
 * - One `ResizeObserver` for the whole list, created once and never rebuilt for
 *   a source update, with mounted rows attached through per-index callback refs
 *   so a keyed replacement is observed immediately.
 * - A layout revision built from the container's width AND its class list. The
 *   class list carries the wrap mode (the inspector's Wrap button rewrites it),
 *   and a wrap toggle changes every row's height without changing one
 *   character of text, so both belong in the same revision.
 * - Interstitial chrome (the reveal band) mounted in its own measured box, so
 *   it lands in the prefix index instead of silently offsetting every row below
 *   it.
 * - Search centring in two passes: scroll to the estimate, which is what mounts
 *   the target and gets it measured, then apply ONE correction from the
 *   measurement.
 *
 * `renderLine` is handed a chunk bounded to `MAX_MOUNTED_CHUNK_CHARS`, not the
 * raw logical line, so a single line of several megabytes cannot become one
 * enormous text node. A consumer holding its own copy of the source (the
 * inspector, which anchors the chunk on the active match) re-derives from that
 * instead; the bound is the floor, not the ceiling.
 */

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  FIXED_ROW_HEIGHT_CLASS,
  createLineGeometryState,
  reduceLineGeometryState,
  selectCentredScrollTop,
  selectGeometryMode,
  selectIsMeasured,
  selectLineWindow,
  selectVisualChunk,
  type LineMeasureEntry,
} from './lineWindow.js'

const INITIAL_VIEWPORT_HEIGHT = 384

/** Marks a logical line the character budget cut. Plain text, never a control. */
const CHUNK_CUT = '…'

export function VirtualLineList({
  lines,
  activeIndex,
  className,
  renderBeforeIndex,
  renderLine,
}: {
  lines: readonly string[]
  activeIndex: number | null
  className: string
  renderBeforeIndex?: (index: number) => ReactNode
  renderLine: (line: string, index: number) => ReactNode
}): ReactNode {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(INITIAL_VIEWPORT_HEIGHT)
  const [contentWidth, setContentWidth] = useState(0)
  const [committed, setCommitted] = useState(() =>
    createLineGeometryState(lines),
  )

  const layoutRevision = `${contentWidth}|${className}`
  const layoutRevisionRef = useRef(layoutRevision)
  const linesRef = useRef(lines)
  useEffect(() => {
    layoutRevisionRef.current = layoutRevision
    linesRef.current = lines
  }, [layoutRevision, lines])

  // Normalize during render so the window is never one frame behind the source,
  // then commit the normalized value so measurements accumulate against it.
  const geometry = useMemo(
    () =>
      reduceLineGeometryState(
        reduceLineGeometryState(committed, { kind: 'lines', lines }),
        { kind: 'layout', layoutRevision },
      ),
    [committed, lines, layoutRevision],
  )
  useEffect(() => {
    if (geometry !== committed) setCommitted(geometry)
  }, [geometry, committed])

  const rowNodes = useRef(new Map<number, HTMLElement>())
  const chromeNodes = useRef(new Map<number, HTMLElement>())
  const observerRef = useRef<ResizeObserver | null>(null)
  const frameRef = useRef<number | null>(null)

  const flush = useCallback(() => {
    frameRef.current = null
    const revision = layoutRevisionRef.current
    const entries: LineMeasureEntry[] = []
    for (const [index, node] of rowNodes.current) {
      const chromeNode = chromeNodes.current.get(index)
      entries.push({
        index,
        // `scrollHeight` and not `clientHeight`: while the geometry is fixed the
        // row box is pinned to the grid, so the natural height of a row that
        // does not fit shows up only as overflow. That overflow is exactly the
        // signal that this body wraps.
        height: node.scrollHeight,
        chromeHeight: chromeNode === undefined ? 0 : chromeNode.scrollHeight,
        layoutRevision: revision,
      })
    }
    if (entries.length === 0) return
    setCommitted(state =>
      reduceLineGeometryState(
        reduceLineGeometryState(
          reduceLineGeometryState(state, {
            kind: 'lines',
            lines: linesRef.current,
          }),
          { kind: 'layout', layoutRevision: revision },
        ),
        { kind: 'measure', entries },
      ),
    )
  }, [])

  const schedule = useCallback(() => {
    if (frameRef.current !== null) return
    if (typeof requestAnimationFrame === 'undefined') {
      flush()
      return
    }
    frameRef.current = requestAnimationFrame(flush)
  }, [flush])

  // Created once for the life of the list: a streamed source update must not
  // rebuild the observer, only re-register the rows it replaced.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => schedule())
    observerRef.current = observer
    for (const node of rowNodes.current.values()) observer.observe(node)
    for (const node of chromeNodes.current.values()) observer.observe(node)
    schedule()
    return () => {
      observer.disconnect()
      observerRef.current = null
      if (frameRef.current !== null && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(frameRef.current)
      }
      frameRef.current = null
    }
  }, [schedule])

  useEffect(() => {
    const root = rootRef.current
    if (!root || typeof ResizeObserver === 'undefined') return
    const apply = (): void => {
      setViewportHeight(root.clientHeight || INITIAL_VIEWPORT_HEIGHT)
      setContentWidth(root.clientWidth)
    }
    const observer = new ResizeObserver(apply)
    observer.observe(root)
    apply()
    return () => observer.disconnect()
  }, [])

  const rowRefs = useRef(new Map<number, (node: HTMLDivElement | null) => void>())
  const chromeRefs = useRef(
    new Map<number, (node: HTMLDivElement | null) => void>(),
  )

  const boxRef = useCallback(
    (
      cache: Map<number, (node: HTMLDivElement | null) => void>,
      nodes: Map<number, HTMLElement>,
      index: number,
    ) => {
      const existing = cache.get(index)
      if (existing !== undefined) return existing
      // Stable per index: a fresh closure every render would make React detach
      // and re-attach every row, and with it unobserve and re-observe it.
      const attach = (node: HTMLDivElement | null): void => {
        const previous = nodes.get(index)
        if (previous !== undefined && previous !== node) {
          observerRef.current?.unobserve(previous)
        }
        if (node === null) {
          nodes.delete(index)
          return
        }
        nodes.set(index, node)
        observerRef.current?.observe(node)
        schedule()
      }
      cache.set(index, attach)
      return attach
    },
    [schedule],
  )

  const lineWindow = useMemo(
    () => selectLineWindow(geometry, scrollTop, viewportHeight),
    [geometry, scrollTop, viewportHeight],
  )

  useEffect(() => {
    for (const index of rowRefs.current.keys()) {
      if (index < lineWindow.start || index >= lineWindow.end) {
        rowRefs.current.delete(index)
        chromeRefs.current.delete(index)
      }
    }
  }, [lineWindow.start, lineWindow.end])

  useEffect(() => {
    setCommitted(state =>
      reduceLineGeometryState(state, { kind: 'centre', index: activeIndex }),
    )
  }, [activeIndex])

  useEffect(() => {
    const root = rootRef.current
    const index = geometry.pendingCentreIndex
    if (!root || index === null) return
    root.scrollTop = selectCentredScrollTop(
      geometry,
      index,
      root.clientHeight || viewportHeight,
    )
    // Fixed geometry is exact on the first pass; measured geometry needs the
    // target mounted and measured first, and this is the one correction.
    if (
      selectGeometryMode(geometry) === 'fixed' ||
      selectIsMeasured(geometry, index)
    ) {
      setCommitted(state => reduceLineGeometryState(state, { kind: 'centred' }))
    }
  }, [geometry, viewportHeight])

  const rowClass =
    selectGeometryMode(geometry) === 'fixed' ? FIXED_ROW_HEIGHT_CLASS : undefined

  return (
    <div
      ref={rootRef}
      className={className}
      onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
    >
      {lineWindow.topSpacerHeight > 0 ? (
        <div aria-hidden style={{ height: `${lineWindow.topSpacerHeight}px` }} />
      ) : null}
      {lines.slice(lineWindow.start, lineWindow.end).map((line, offset) => {
        const index = lineWindow.start + offset
        const chrome = renderBeforeIndex?.(index) ?? null
        const chunk = selectVisualChunk(line)
        const text =
          chunk.truncatedStart || chunk.truncatedEnd
            ? `${chunk.truncatedStart ? CHUNK_CUT : ''}${chunk.text}${
                chunk.truncatedEnd ? CHUNK_CUT : ''
              }`
            : chunk.text
        return (
          <Fragment key={index}>
            {chrome === null ? null : (
              <div ref={boxRef(chromeRefs.current, chromeNodes.current, index)}>
                {chrome}
              </div>
            )}
            <div
              ref={boxRef(rowRefs.current, rowNodes.current, index)}
              className={rowClass}
            >
              {renderLine(text, index)}
            </div>
          </Fragment>
        )
      })}
      {lineWindow.bottomSpacerHeight > 0 ? (
        <div
          aria-hidden
          style={{ height: `${lineWindow.bottomSpacerHeight}px` }}
        />
      ) : null}
    </div>
  )
}
