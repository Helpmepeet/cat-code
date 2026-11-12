import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode, type Ref } from 'react'
import { ownPaneHeightDelta, readNestedPaneHeights } from './paneHeightOwnership.js'
import {
  observePaneScroll,
  flushPaneScrollCorrections,
  compensatePanePrefix,
  reportPaneHeightCorrection,
  reportPaneLayoutChange,
} from './markdownScrollCoordinator.js'
import {
  createCompositeChildState,
  reduceCompositeChildState,
  sameCompositeChildWindow,
  selectCompositeChildEntries,
  selectCompositeChildWindow,
  selectInitialCompositeChildWindow,
  INITIAL_CHILD_VIEWPORT_HEIGHT,
  MAX_MOUNTED_COMPOSITE_CHILDREN,
  type CompositeChildMeasurement,
  type CompositeChildEntry,
  type CompositeChildWindow,
} from './compositeChildWindow.js'
import { registerTranscriptRowOffsets } from './transcriptRowNavigation.js'

/**
 * Mounts a bounded range of ONE composite container's children.
 *
 * Same division of labour as `BoundedMarkdown`: `compositeChildWindow.ts` owns
 * the range and the measurement state, and this owns geometry — where the
 * container sits relative to the pane viewport, and how measured heights
 * replace the estimate. The caller keeps its complete child list and every
 * count it prints; only the mounted range comes from here.
 *
 * Scroller observation goes through the SHARED pane coordinator, so a
 * transcript full of these adds no scroll listeners to the pane. The two
 * observers each container does own watch its own elements: its root box, and
 * its own direct children.
 */
export function BoundedChildList({
  keys,
  estimatedChildHeight,
  childGap = 0,
  renderChild,
  className,
  initialAnchorKey,
  revealRequest = null,
  containerRef,
  dataCardStyle,
  transcriptEntries = false,
  directChildren = false,
  cascading = false,
  footer,
}: {
  /** One stable identity per child, in order. Length is the true child count. */
  keys: readonly string[]
  estimatedChildHeight: number
  childGap?: number
  /** Draws the child at an index into `keys`. Called only for mounted children. */
  renderChild: (index: number) => ReactNode
  /** Layout classes the replaced wrapper carried, so spacing is unchanged. */
  className?: string
  initialAnchorKey?: string | null
  revealRequest?: { key: string; sequence: number } | null
  containerRef?: Ref<HTMLDivElement>
  dataCardStyle?: string
  transcriptEntries?: boolean
  /** Children carry their own measurement marker and must remain direct siblings. */
  directChildren?: boolean
  cascading?: boolean
  footer?: ReactNode
}) {
  const [state, dispatch] = useReducer(
    reduceCompositeChildState,
    undefined,
    createCompositeChildState,
  )
  const entries = useMemo(
    () => selectCompositeChildEntries(keys, estimatedChildHeight, state),
    [keys, estimatedChildHeight, state],
  )
  const [childWindow, setChildWindow] = useState<CompositeChildWindow>(() =>
    initialAnchorKey
      ? selectCompositeChildWindow(
          entries,
          entries.slice(0, keys.indexOf(initialAnchorKey) < 0
            ? Math.max(0, entries.length - 1)
            : keys.indexOf(initialAnchorKey)).reduce((total, entry) => total + entry.height + childGap, 0),
          INITIAL_CHILD_VIEWPORT_HEIGHT,
          undefined,
          undefined,
          childGap,
        )
      : transcriptEntries
        ? selectCompositeChildWindow(
            entries,
            Math.max(0, entries.reduce((sum, entry) => sum + entry.height, 0) - INITIAL_CHILD_VIEWPORT_HEIGHT),
            INITIAL_CHILD_VIEWPORT_HEIGHT,
            undefined,
            undefined,
            childGap,
          )
        : selectInitialCompositeChildWindow(entries, undefined, childGap),
  )
  const rootRef = useRef<HTMLDivElement | null>(null)
  const entriesRef = useRef(entries)
  const previousEntriesRef = useRef(entries)
  const entriesChangedRef = useRef(false)
  const childWindowRef = useRef(childWindow)
  const scheduleRef = useRef<() => void>(() => {})
  const paneScrollerRef = useRef<HTMLElement | null>(null)
  const focusedEntryKeyRef = useRef<string | null>(null)
  const boxRef = useRef<{
    height: number
    topSpacer: number
    entries: readonly CompositeChildEntry[]
    nestedHeights: ReadonlyMap<Element, number>
  } | null>(null)
  const compensatedPrefixDeltaRef = useRef(0)

  useLayoutEffect(() => {
    const previousEntries = previousEntriesRef.current
    if (previousEntries !== entries) entriesChangedRef.current = true
    const previousWindow = childWindowRef.current
    const retainedKey = previousEntries[previousWindow.start]?.key
    const retainedIndex = retainedKey === undefined
      ? -1
      : entries.findIndex(entry => entry.key === retainedKey)
    if (retainedIndex >= 0 && retainedIndex !== previousWindow.start && paneScrollerRef.current) {
      const oldPrefix = previousEntries.slice(0, previousWindow.start).reduce((sum, entry) => sum + entry.height + childGap, 0)
      const newPrefix = entries.slice(0, retainedIndex).reduce((sum, entry) => sum + entry.height + childGap, 0)
      const delta = newPrefix - oldPrefix
      if (delta !== 0) {
        compensatePanePrefix(paneScrollerRef.current, delta)
        compensatedPrefixDeltaRef.current += delta
      }
      const root = rootRef.current
      const scroller = paneScrollerRef.current
      if (root && scroller) {
        const offset = scroller.getBoundingClientRect().top - root.getBoundingClientRect().top
        setChildWindow(current => {
          const next = selectCompositeChildWindow(
            entries,
            offset,
            scroller.clientHeight || INITIAL_CHILD_VIEWPORT_HEIGHT,
            undefined,
            undefined,
            childGap,
          )
          return sameCompositeChildWindow(current, next) ? current : next
        })
      }
    }
    previousEntriesRef.current = entries
    entriesRef.current = entries
    childWindowRef.current = childWindow
    scheduleRef.current()
  }, [entries, childGap])

  useEffect(() => {
    childWindowRef.current = childWindow
  }, [childWindow])

  // Attaches once for the lifetime of the container. Streamed child arrivals
  // reach the window through the ref above, so a growing run never detaches and
  // re-attaches the shared pane scroller.
  useEffect(() => {
    const root = rootRef.current
    if (root === null || typeof window === 'undefined') return
    const scroller = findPaneScroller(root)
    paneScrollerRef.current = scroller
    const releaseRowOffsets = transcriptEntries ? registerTranscriptRowOffsets(scroller, key => {
      const index = entriesRef.current.findIndex(entry => entry.key === key)
      if (index < 0) return null
      const prefix = entriesRef.current.slice(0, index).reduce((sum, entry) => sum + entry.height + childGap, 0)
      return root.getBoundingClientRect().top - scroller.getBoundingClientRect().top
        - scroller.clientTop + scroller.scrollTop + (Number.parseFloat(getComputedStyle(root).paddingTop) || 0) + prefix
    }) : () => {}
    let frame = 0
    let hasObservedScroll = false
    const update = () => {
      frame = 0
      // A hidden Focused body has no viewport to replace its retained tail with.
      if (directChildren && scroller.clientHeight <= 0 && !hasObservedScroll) return
      if (!hasObservedScroll && initialAnchorKey === null && scroller.clientHeight <= 0 && !entriesChangedRef.current) return
      flushPaneScrollCorrections(scroller)
      const rootRect = root.getBoundingClientRect()
      const scrollerRect = scroller.getBoundingClientRect()
      // A remounted row can replace its retained estimate before ResizeObserver
      // commits its measurement. Window against the current boxes, otherwise a
      // shorter prefix can evict the visible answer using the old row heights.
      let windowEntries = entriesRef.current
      if (transcriptEntries) {
        const measurements: CompositeChildMeasurement[] = []
        for (const child of root.children) {
          const key = child.getAttribute('data-transcript-entry')
          if (key === null) continue
          const height = child.getBoundingClientRect().height +
            (Number.parseFloat(getComputedStyle(child).marginBlockEnd) || 0)
          if (height > 0) measurements.push({ key, height })
        }
        const heights = new Map(measurements.map(measurement => [measurement.key, measurement.height]))
        windowEntries = windowEntries.map(entry => ({ ...entry, height: heights.get(entry.key) ?? entry.height }))
        if (measurements.length) dispatch({ kind: 'measured', measurements })
      }
      setChildWindow(current => {
        const next = selectCompositeChildWindow(
          windowEntries,
          scrollerRect.top - rootRect.top,
          scroller.clientHeight || INITIAL_CHILD_VIEWPORT_HEIGHT,
          undefined,
          undefined,
          childGap,
        )
        return sameCompositeChildWindow(current, next) ? current : next
      })
      entriesChangedRef.current = false
    }
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(update)
    }
    scheduleRef.current = schedule
    const rootObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    rootObserver?.observe(root)
    const releasePane = observePaneScroll(scroller, () => {
      hasObservedScroll = true
      schedule()
    })
    schedule()
    return () => {
      scheduleRef.current = () => {}
      paneScrollerRef.current = null
      if (frame !== 0) window.cancelAnimationFrame(frame)
      rootObserver?.disconnect()
      releasePane()
      releaseRowOffsets()
    }
  }, [])

  // Reports this container's own height change to the pane, on EVERY commit and
  // with no dependency list, for the same reason `BoundedMarkdown` does: a
  // measured child height replaces an estimate frames after the commit that used
  // it, so only the rendered box marks where the document actually moved. Outer
  // row replacements correct before paint so remounting a prefix cannot flash a
  // different part of the answer while the shared frame is still pending.
  useLayoutEffect(() => {
    const root = rootRef.current
    const scroller = paneScrollerRef.current
    if (root === null || scroller === null) return
    const rect = root.getBoundingClientRect()
    const previous = boxRef.current
    const nestedHeights = readNestedPaneHeights(root)
    boxRef.current = { height: rect.height, topSpacer: childWindow.topSpacerHeight, entries, nestedHeights }
    const compensatedPrefixDelta = compensatedPrefixDeltaRef.current
    compensatedPrefixDeltaRef.current = 0
    if (previous === null) return
    if (rect.height > 0 || previous.height > 0) reportPaneLayoutChange(scroller)
    // Exclude only the prefix movement the keyed anchor already compensated.
    // Scrolling changes the spacer partition without changing document height.
    const delta = ownPaneHeightDelta(
      rect.height - previous.height,
      previous.nestedHeights,
      nestedHeights,
    ) - compensatedPrefixDelta
    if (delta === 0) {
      if (transcriptEntries) flushPaneScrollCorrections(scroller)
      return
    }
    let commonPrefix = 0
    while (
      commonPrefix < previous.entries.length && commonPrefix < entries.length &&
      previous.entries[commonPrefix].key === entries[commonPrefix].key &&
      previous.entries[commonPrefix].height === entries[commonPrefix].height
    ) commonPrefix += 1
    // An append changes the document below the viewport, not at the current
    // window's leading spacer. Locate list edits at their first changed entry.
    const unchangedPrefix = commonPrefix < Math.max(previous.entries.length, entries.length)
      ? entries.slice(0, commonPrefix).reduce((sum, entry) => sum + entry.height + childGap, 0)
      : Math.min(previous.topSpacer, childWindow.topSpacerHeight)
    reportPaneHeightCorrection(scroller, {
      delta,
      readOffset: () => scroller.contains(root)
        ? root.getBoundingClientRect().top - scroller.getBoundingClientRect().top +
          scroller.scrollTop + unchangedPrefix
        : null,
    })
    if (transcriptEntries) flushPaneScrollCorrections(scroller)
  })

  useLayoutEffect(() => {
    if (!revealRequest?.key) return
    const index = entriesRef.current.findIndex(entry => entry.key === revealRequest.key)
    const root = rootRef.current
    if (index < 0 || !root) return
    const scroller = findPaneScroller(root)
    const offset = entriesRef.current.slice(0, index).reduce((sum, entry) => sum + entry.height + childGap, 0)
    const navigate = () => {
      scroller.scrollTop += root.getBoundingClientRect().top - scroller.getBoundingClientRect().top + offset
      setChildWindow(selectCompositeChildWindow(entriesRef.current, offset,
        scroller.clientHeight || INITIAL_CHILD_VIEWPORT_HEIGHT, undefined, undefined, childGap))
    }
    let frame: number
    if (transcriptEntries) {
      navigate()
      frame = requestAnimationFrame(() => {
        const element = [...root.children].find(child => child.getAttribute('data-transcript-entry') === revealRequest.key)
        element?.scrollIntoView?.({ block: 'start', behavior: 'instant' })
      })
    } else {
      // Let the outer turn land first; its navigation would otherwise undo
      // the nested command window's reveal in the same commit.
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(navigate) })
    }
    return () => cancelAnimationFrame(frame)
  }, [revealRequest?.key, revealRequest?.sequence, childGap, transcriptEntries])

  const mounted = useMemo(
    () => directChildren && entries.length <= MAX_MOUNTED_COMPOSITE_CHILDREN
      ? entries : entries.slice(childWindow.start, childWindow.end),
    [entries, childWindow.start, childWindow.end, directChildren],
  )
  const pinsFocus = transcriptEntries || directChildren
  const pinnedFocusKey = pinsFocus ? focusedEntryKeyRef.current : null
  const pinnedFocusIndex = pinnedFocusKey === null ? -1 : entries.findIndex(entry => entry.key === pinnedFocusKey)
  const pinnedFocusEntry = pinsFocus && pinnedFocusIndex >= 0 ? entries[pinnedFocusIndex] : undefined
  const mountedSignature = `${mounted.map(entry => entry.key).join('|')}|${pinnedFocusEntry?.key ?? ''}|${footer ? 'footer' : ''}`
  const sumEntryHeights = (from: number, to: number): number => {
    let total = 0
    for (let index = from; index < to; index += 1) total += entries[index]?.height ?? 0
    return total
  }
  const renderTranscriptWindow = (): ReactNode[] => {
    const start = directChildren && entries.length <= MAX_MOUNTED_COMPOSITE_CHILDREN
      ? 0 : Math.min(childWindow.start, entries.length)
    const end = directChildren && entries.length <= MAX_MOUNTED_COMPOSITE_CHILDREN
      ? entries.length : Math.min(childWindow.end, entries.length)
    const indices = Array.from({ length: Math.max(0, end - start) },
      (_unused, offset) => start + offset)
    if (pinnedFocusEntry && !indices.includes(pinnedFocusIndex)) {
      if (directChildren && indices.length >= MAX_MOUNTED_COMPOSITE_CHILDREN) {
        if (pinnedFocusIndex < start) indices.pop()
        else indices.shift()
      }
      indices.push(pinnedFocusIndex)
      indices.sort((left, right) => left - right)
    }
    const children: ReactNode[] = []
    let cursor = 0
    for (const index of indices) {
      if (index > cursor) {
        children.push(<div aria-hidden key={`spacer:${cursor}:${index}`} style={{ height: `${sumEntryHeights(cursor, index)}px` }} />)
      }
      children.push(renderChild(index))
      cursor = index + 1
    }
    if (cursor < entries.length) {
      children.push(<div aria-hidden key={`spacer:${cursor}:${entries.length}`} style={{ height: `${sumEntryHeights(cursor, entries.length)}px` }} />)
    }
    return children
  }

  // Keyed on the mounted identities rather than the numeric range, so a child
  // replaced inside an unchanged window is observed immediately.
  useEffect(() => {
    const root = rootRef.current
    if (root === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(records => {
      const measurements: CompositeChildMeasurement[] = []
      for (const record of records) {
        const key = record.target.getAttribute('data-transcript-child') ??
          record.target.getAttribute('data-transcript-entry')
        if (key === null) continue
        const height = (record.borderBoxSize[0]?.blockSize ?? record.contentRect.height) +
          (Number.parseFloat(getComputedStyle(record.target).marginBlockEnd) || 0)
        measurements.push({ key, height })
      }
      if (measurements.length > 0) dispatch({ kind: 'measured', measurements })
    })
    // DIRECT children only. A descendant query would also reach a nested
    // container's children and file their heights under this container's cache.
    for (const element of root.children) {
      if (!(element instanceof HTMLElement)) continue
      if (
        element.getAttribute('data-transcript-child') === null &&
        element.getAttribute('data-transcript-entry') === null
      ) continue
      observer.observe(element)
    }
    return () => observer.disconnect()
  }, [mountedSignature])

  return (
    <div className={className} data-card-style={dataCardStyle} data-cascade={cascading ? '' : undefined} data-pane-height-owner="" onFocusCapture={event => {
      if (!pinsFocus || !(event.target instanceof Element)) return
      if (transcriptEntries) {
        focusedEntryKeyRef.current = event.target.closest('[data-transcript-entry]')
          ?.getAttribute('data-transcript-entry') ?? null
      } else {
        let child: Element = event.target
        while (child.parentElement && child.parentElement !== rootRef.current) child = child.parentElement
        focusedEntryKeyRef.current = child.parentElement === rootRef.current
          ? child.getAttribute('data-transcript-child') : null
      }
    }} onBlurCapture={event => {
      if (!pinsFocus) return
      if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) return
      focusedEntryKeyRef.current = null
      scheduleRef.current()
    }} ref={node => {
      rootRef.current = node
      if (typeof containerRef === 'function') containerRef(node)
      else if (containerRef) containerRef.current = node
    }}>
      {transcriptEntries || directChildren ? renderTranscriptWindow() : <>
        {childWindow.topSpacerHeight > 0 ? (
          <div aria-hidden style={{ height: `${childWindow.topSpacerHeight}px` }} />
        ) : null}
        {mounted.map((entry, offset) => (
          <div data-transcript-child={entry.key} key={entry.key}>
            {renderChild(childWindow.start + offset)}
          </div>
        ))}
        {childWindow.bottomSpacerHeight > 0 ? (
          <div aria-hidden style={{ height: `${childWindow.bottomSpacerHeight}px` }} />
        ) : null}
      </>}
      {footer}
    </div>
  )
}

/**
 * The pane scroller this container lives in. Same walk `BoundedMarkdown` does;
 * duplicated rather than shared because that module is a component file and may
 * not export a helper under the Fast Refresh boundary rule.
 */
function findPaneScroller(element: HTMLElement): HTMLElement {
  let current: HTMLElement | null = element.parentElement
  while (current !== null) {
    if (/(auto|scroll)/.test(window.getComputedStyle(current).overflowY)) return current
    current = current.parentElement
  }
  return document.documentElement
}

