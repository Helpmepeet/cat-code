import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PluggableList } from 'unified'
import {
  MAX_RETAINED_MARKDOWN_MEASUREMENTS,
  createMarkdownPlanCache,
  mergeMountedMarkdownLeaves,
  planMarkdownLeaves,
  planPlainTextLeaves,
  resolveMarkdownMeasurements,
  selectMarkdownLeafWindow,
  type MarkdownRenderLeaf,
  type MarkdownLeafWindow,
  type MountedMarkdownLeaf,
} from './markdownRenderPlan.js'
import {
  observePaneScroll,
  reportPaneHeightCorrection,
} from './markdownScrollCoordinator.js'

const INITIAL_VIEWPORT_HEIGHT = 800

/**
 * Mounts a bounded range of ONE parsed Markdown document. The plan owns the
 * parse and the semantic slicing; this component owns geometry: which range is
 * near the pane viewport, how tall the unmounted remainder is, and how measured
 * heights replace estimates.
 */
export function BoundedMarkdown({
  sourceId,
  source,
  rehypePlugins,
  renderLeaf,
}: {
  sourceId: string
  source: string
  rehypePlugins?: PluggableList
  renderLeaf: (leaf: MountedMarkdownLeaf) => ReactNode
}): ReactNode {
  const cacheRef = useRef(createMarkdownPlanCache())
  const leaves = useMemo(() => {
    try {
      return planMarkdownLeaves(sourceId, source, {
        rehypePlugins,
        cache: cacheRef.current,
      })
    } catch {
      // Display degrades gracefully: an unreadable document still shows its
      // author's text rather than taking the transcript down with it.
      return planPlainTextLeaves(sourceId, source)
    }
  }, [sourceId, source, rehypePlugins])

  const [unitHeights, setUnitHeights] = useState<ReadonlyMap<string, number>>(new Map())
  const measurement = useMemo(
    () => resolveMarkdownMeasurements(leaves, unitHeights),
    [leaves, unitHeights],
  )
  const measuredLeaves = useMemo(
    () =>
      leaves.map(leaf => ({
        ...leaf,
        estimatedHeight: measurement.heights.get(leaf.id) ?? leaf.estimatedHeight,
      })),
    [leaves, measurement],
  )
  const [leafWindow, setLeafWindow] = useState<MarkdownLeafWindow>(() =>
    selectMarkdownLeafWindow(leaves, 0, INITIAL_VIEWPORT_HEIGHT),
  )
  const [copiedAtomicLeaf, setCopiedAtomicLeaf] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const measuredLeavesRef = useRef<readonly MarkdownRenderLeaf[]>(measuredLeaves)
  const scheduleRef = useRef<() => void>(() => {})
  const scrollerRef = useRef<HTMLElement | null>(null)
  const geometryRef = useRef<{ height: number; topSpacer: number } | null>(null)

  const mounted = useMemo(
    () => mergeMountedMarkdownLeaves(measuredLeaves, leafWindow.start, leafWindow.end),
    [measuredLeaves, leafWindow.start, leafWindow.end],
  )
  // Identity only. `measurementKey` carries the content revision, which changes
  // on every streamed token, so keying the observer on it would tear down and
  // rebuild every observation per token inside the loop this file bounds.
  const mountedKeys = mounted.map(unit => unit.key).join('|')

  useEffect(() => {
    measuredLeavesRef.current = measuredLeaves
    scheduleRef.current()
  }, [measuredLeaves])

  // Attaches once for the lifetime of the body. Streamed source updates reach
  // the window through the ref above, so they never detach and re-attach the
  // shared pane scroller.
  useEffect(() => {
    const root = rootRef.current
    if (!root || typeof window === 'undefined') return
    const scroller = findScrollParent(root)
    let frame = 0
    const update = () => {
      frame = 0
      const rootRect = root.getBoundingClientRect()
      const scrollerRect = scroller.getBoundingClientRect()
      const scrollOffset = scrollerRect.top - rootRect.top
      setLeafWindow(current => {
        const next = selectMarkdownLeafWindow(
          measuredLeavesRef.current,
          scrollOffset,
          scroller.clientHeight || INITIAL_VIEWPORT_HEIGHT,
        )
        return sameWindow(current, next) ? current : next
      })
    }
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(update)
    }
    scheduleRef.current = schedule
    scrollerRef.current = scroller
    const rootObserver = new ResizeObserver(schedule)
    rootObserver.observe(root)
    const releasePane = observePaneScroll(scroller, schedule)
    schedule()
    return () => {
      scheduleRef.current = () => {}
      scrollerRef.current = null
      if (frame !== 0) window.cancelAnimationFrame(frame)
      rootObserver.disconnect()
      releasePane()
    }
  }, [])

  // Reports this body's own height change to the pane, on EVERY commit and with
  // no dependency list on purpose. A measured height replaces an estimate one or
  // more frames after the commit that used the estimate, so no value in this
  // component's render inputs marks the commit where the document actually grew
  // or shrank; only the rendered box does. The pane decides what to do with it.
  useEffect(() => {
    const root = rootRef.current
    const scroller = scrollerRef.current
    if (root === null || scroller === null) return
    const rect = root.getBoundingClientRect()
    const previous = geometryRef.current
    geometryRef.current = { height: rect.height, topSpacer: leafWindow.topSpacerHeight }
    // The first commit is where this body's box came into existence, which is
    // layout rather than a correction of anything.
    if (previous === null) return
    const delta = rect.height - previous.height
    if (delta === 0) return
    // The change cannot be above the shorter of the two top spacers: that band
    // is blank in both layouts, so everything before it kept its position.
    const unchangedPrefix = Math.min(previous.topSpacer, leafWindow.topSpacerHeight)
    const offset =
      rect.top - scroller.getBoundingClientRect().top + scroller.scrollTop + unchangedPrefix
    reportPaneHeightCorrection(scroller, { offset, delta })
  })

  // Keyed on the mounted leaf identities rather than the numeric window, so a
  // replacement node inside an unchanged window is observed immediately.
  useEffect(() => {
    const root = rootRef.current
    if (!root || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      setUnitHeights(current => {
        let next: Map<string, number> | null = null
        for (const entry of entries) {
          const key = entry.target.getAttribute('data-markdown-leaf')
          if (key === null) continue
          const height = Math.ceil(entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height)
          if (height <= 0 || Math.abs((current.get(key) ?? 0) - height) < 1) continue
          if (next === null) next = new Map(current)
          next.delete(key)
          next.set(key, height)
        }
        if (next === null) return current
        // Pruning only drops runs whose content changed. An unchanged group
        // keeps a key for every distinct run its window has ever framed, which
        // grows with the square of its leaf count, so the map needs its own
        // ceiling. Nothing measured in this flush is a candidate.
        const measured = new Set(
          entries
            .map(entry => entry.target.getAttribute('data-markdown-leaf'))
            .filter((key): key is string => key !== null),
        )
        for (const key of next.keys()) {
          if (next.size <= MAX_RETAINED_MARKDOWN_MEASUREMENTS) break
          if (measured.has(key)) continue
          next.delete(key)
        }
        return next
      })
    })
    for (const element of root.querySelectorAll<HTMLElement>('[data-markdown-leaf]')) {
      observer.observe(element)
    }
    return () => observer.disconnect()
  }, [mountedKeys])

  // Heights measured for runs that have left the plan must not accumulate.
  useEffect(() => {
    setUnitHeights(current => {
      if (current.size === 0) return current
      let next: Map<string, number> | null = null
      for (const key of current.keys()) {
        if (measurement.live.has(key)) continue
        if (next === null) next = new Map(current)
        next.delete(key)
      }
      return next ?? current
    })
  }, [measurement])

  return (
    <div ref={rootRef}>
      {leafWindow.topSpacerHeight > 0 ? (
        <div aria-hidden style={{ height: `${leafWindow.topSpacerHeight}px` }} />
      ) : null}
      {mounted.map(unit =>
        unit.kind === 'atomic-text' ? (
          <div
            data-markdown-leaf={unit.measurementKey}
            className="my-2 rounded border border-shell-seam bg-shell-hover/40 p-3 font-mono text-xs text-text-muted"
            key={unit.key}
          >
            <div className="mb-2 flex items-center justify-between gap-3">
              <span>Long unbroken text is shown in parts.</span>
              <button
                type="button"
                className="shrink-0 text-accent hover:text-accent-soft"
                onClick={() => {
                  const clipboard =
                    typeof navigator === 'undefined' ? undefined : navigator.clipboard
                  if (!clipboard) return
                  void clipboard
                    .writeText(source)
                    .then(() => {
                      setCopiedAtomicLeaf(unit.key)
                      // Matches `CodeBlock`'s acknowledgement window; without a
                      // reset the label reads Copied for the rest of the session.
                      window.setTimeout(() => setCopiedAtomicLeaf(null), 1200)
                    })
                    .catch(() => {})
                }}
              >
                {copiedAtomicLeaf === unit.key ? 'Copied' : 'Copy full text'}
              </button>
            </div>
            <pre className="whitespace-pre-wrap break-words">{unit.text}</pre>
          </div>
        ) : (
          <div data-markdown-leaf={unit.measurementKey} key={unit.key}>
            {renderLeaf(unit)}
          </div>
        ),
      )}
      {leafWindow.bottomSpacerHeight > 0 ? (
        <div aria-hidden style={{ height: `${leafWindow.bottomSpacerHeight}px` }} />
      ) : null}
    </div>
  )
}

function findScrollParent(element: HTMLElement): HTMLElement {
  let current: HTMLElement | null = element.parentElement
  while (current !== null) {
    const style = window.getComputedStyle(current)
    if (/(auto|scroll)/.test(style.overflowY)) return current
    current = current.parentElement
  }
  return document.documentElement
}

function sameWindow(left: MarkdownLeafWindow, right: MarkdownLeafWindow): boolean {
  return (
    left.start === right.start &&
    left.end === right.end &&
    left.topSpacerHeight === right.topSpacerHeight &&
    left.bottomSpacerHeight === right.bottomSpacerHeight
  )
}
