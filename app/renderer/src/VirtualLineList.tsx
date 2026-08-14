import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  OUTPUT_LINE_HEIGHT,
  selectLineWindow,
} from './lineWindow.js'

const INITIAL_VIEWPORT_HEIGHT = 384

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
  const lineWindow = useMemo(
    () => selectLineWindow(lines.length, scrollTop, viewportHeight),
    [lines.length, scrollTop, viewportHeight],
  )

  useEffect(() => {
    const root = rootRef.current
    if (!root || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setViewportHeight(root.clientHeight))
    observer.observe(root)
    setViewportHeight(root.clientHeight || INITIAL_VIEWPORT_HEIGHT)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const root = rootRef.current
    if (!root || activeIndex === null) return
    const activeTop = activeIndex * OUTPUT_LINE_HEIGHT
    const activeBottom = activeTop + OUTPUT_LINE_HEIGHT
    if (activeTop < root.scrollTop || activeBottom > root.scrollTop + root.clientHeight) {
      root.scrollTop = activeTop - root.clientHeight / 2 + OUTPUT_LINE_HEIGHT / 2
    }
  }, [activeIndex])

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
        return (
          <Fragment key={index}>
            {renderBeforeIndex?.(index)}
            {renderLine(line, index)}
          </Fragment>
        )
      })}
      {lineWindow.bottomSpacerHeight > 0 ? (
        <div aria-hidden style={{ height: `${lineWindow.bottomSpacerHeight}px` }} />
      ) : null}
    </div>
  )
}
