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
 * - A layout revision built from the container's relevant width and class list. The
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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  MIN_ROW_HEIGHT_CLASS,
  createLineGeometryState,
  reduceLineGeometryState,
  selectCentredScrollTop,
  selectGeometryMode,
  selectRowIsPinned,
  selectIsMeasured,
  selectLineWindow,
  selectLineTop,
  selectLineAtOffset,
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
  label,
  renderBeforeIndex,
  activeRequest,
  align = 'center',
  initialTopLine,
  initialScrollLeft,
  onPosition,
  scrollerRef,
  renderLine,
  widthAffectsRowHeight = true,
}: {
  lines: readonly string[]
  activeIndex: number | null
  activeRequest?: number
  align?: 'center' | 'start'
  initialTopLine?: number
  initialScrollLeft?: number
  onPosition?: (position: { x: number; y: number; topLine: number }) => void
  scrollerRef?: React.RefObject<HTMLDivElement | null>
  className: string
  /** Opt out only when rows and interstitial chrome cannot wrap with width. */
  widthAffectsRowHeight?: boolean
  /**
   * Names the scroller and makes it a focusable region. A list that IS the body
   * of its surface needs this so the keyboard can scroll it; one inline in a
   * card leaves it unset and stays out of the tab order.
   */
  label?: string
  renderBeforeIndex?: (index: number) => ReactNode
  renderLine: (line: string, index: number) => ReactNode
}): ReactNode {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const position = useRef({ topLine: initialTopLine ?? 1, atBottom: false })
  const previousLines = useRef(lines)
  const initialized = useRef(false)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(INITIAL_VIEWPORT_HEIGHT)
  const [contentWidth, setContentWidth] = useState(0)
  const dimensions = useRef({ width: 0, height: INITIAL_VIEWPORT_HEIGHT })
  const [committed, setCommitted] = useState(() =>
    createLineGeometryState(lines),
  )

  const layoutRevision = `${widthAffectsRowHeight ? contentWidth : 'fixed-width'}|${className}`
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
      if (node.scrollHeight === 0) continue
      const chromeNode = chromeNodes.current.get(index)
      entries.push({
        index,
        // `scrollHeight` and not `clientHeight`: the minimum-height grid keeps
        // ordinary rows exact while wrapped rows take their natural height on
        // the first layout. `scrollHeight` records either shape for geometry.
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

  // A mode change can invalidate measurements without resizing a mounted row.
  useEffect(() => { schedule() }, [layoutRevision, schedule])

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
      // display:none is not a new layout. Keep the last usable viewport and
      // measurements until reveal supplies real dimensions again.
      const height = root.clientHeight
      const width = root.clientWidth
      if (height <= 0 || width <= 0) return
      if (height !== dimensions.current.height) {
        dimensions.current.height = height
        setViewportHeight(height)
      }
      if (widthAffectsRowHeight && width !== dimensions.current.width) {
        dimensions.current.width = width
        setContentWidth(width)
      }
    }
    const observer = new ResizeObserver(apply)
    observer.observe(root)
    apply()
    return () => observer.disconnect()
  }, [widthAffectsRowHeight])

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
  }, [activeIndex, activeRequest])

  useEffect(() => {
    const root = rootRef.current
    const index = geometry.pendingCentreIndex
    if (!root || index === null) return
    root.scrollTop = align === 'start' ? selectLineTop(geometry, index) : selectCentredScrollTop(
      geometry, index, root.clientHeight || viewportHeight,
    )
    if (align === 'start') root.scrollLeft = 0
    setScrollTop(root.scrollTop)
    position.current = { topLine: selectLineAtOffset(geometry, root.scrollTop) + 1, atBottom: root.scrollHeight - root.scrollTop - root.clientHeight <= 2 }
    // Fixed geometry is exact on the first pass; measured geometry needs the
    // target mounted and measured first, and this is the one correction.
    if (
      selectGeometryMode(geometry) === 'fixed' ||
      selectIsMeasured(geometry, index)
    ) {
      setCommitted(state => reduceLineGeometryState(state, { kind: 'centred', index }))
    }
  }, [geometry, viewportHeight, align])

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    if (!initialized.current) {
      initialized.current = true
      root.scrollLeft = initialScrollLeft ?? 0
      if (activeIndex === null && initialTopLine !== undefined) root.scrollTop = selectLineTop(geometry, initialTopLine - 1)
    } else if (previousLines.current !== lines && root.clientHeight > 0) {
      root.scrollTop = position.current.atBottom ? root.scrollHeight : selectLineTop(geometry, position.current.topLine - 1)
    }
    if (!initialized.current || previousLines.current === lines && root.clientHeight > 0) position.current = { topLine: selectLineAtOffset(geometry, root.scrollTop) + 1, atBottom: root.scrollHeight - root.scrollTop - root.clientHeight <= 2 }
    previousLines.current = lines
    setScrollTop(root.scrollTop)
  }, [lines, geometry, activeIndex, initialTopLine, initialScrollLeft])

  return (
    <div
      ref={element => { rootRef.current = element; if (scrollerRef) scrollerRef.current = element }}
      className={className}
      role={label === undefined ? undefined : 'region'}
      aria-label={label}
      tabIndex={label === undefined ? undefined : 0}
      onScroll={event => {
        const root = event.currentTarget
        if (root.clientHeight === 0) return
        setScrollTop(root.scrollTop)
        const topLine = selectLineAtOffset(geometry, root.scrollTop) + 1
        position.current = { topLine, atBottom: root.scrollHeight - root.scrollTop - root.clientHeight <= 2 }
        onPosition?.({ x: root.scrollLeft, y: root.scrollTop, topLine })
      }}
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
              className={
                selectRowIsPinned(geometry, index) ? MIN_ROW_HEIGHT_CLASS : undefined
              }
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
