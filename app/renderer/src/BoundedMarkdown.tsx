import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  planMarkdownLeaves,
  selectMarkdownLeafWindow,
  type MarkdownRenderLeaf,
  type MarkdownLeafWindow,
} from './markdownRenderPlan.js'

const INITIAL_VIEWPORT_HEIGHT = 800

export function BoundedMarkdown({
  sourceId,
  source,
  renderLeaf,
}: {
  sourceId: string
  source: string
  renderLeaf: (leaf: MarkdownRenderLeaf) => ReactNode
}): ReactNode {
  const leaves = useMemo(() => planMarkdownLeaves(sourceId, source), [sourceId, source])
  const [leafWindow, setLeafWindow] = useState<MarkdownLeafWindow>(() =>
    selectMarkdownLeafWindow(leaves, 0, INITIAL_VIEWPORT_HEIGHT),
  )
  const [copiedAtomicLeaf, setCopiedAtomicLeaf] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const root = rootRef.current
    if (!root || typeof window === 'undefined') return
    const scroller = findScrollParent(root)
    let frame = 0
    const update = () => {
      frame = 0
      const rootRect = root.getBoundingClientRect()
      const scrollerRect = scroller.getBoundingClientRect()
      const scrollOffset = scroller.scrollTop + scrollerRect.top - rootRect.top
      setLeafWindow(current => {
        const next = selectMarkdownLeafWindow(
          leaves,
          scrollOffset,
          scroller.clientHeight || INITIAL_VIEWPORT_HEIGHT,
        )
        return sameWindow(current, next) ? current : next
      })
    }
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(update)
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(root)
    observer.observe(scroller)
    scroller.addEventListener('scroll', schedule, { passive: true })
    schedule()
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame)
      observer.disconnect()
      scroller.removeEventListener('scroll', schedule)
    }
  }, [leaves])

  return (
    <div ref={rootRef}>
      {leafWindow.topSpacerHeight > 0 ? (
        <div aria-hidden style={{ height: `${leafWindow.topSpacerHeight}px` }} />
      ) : null}
      {leaves.slice(leafWindow.start, leafWindow.end).map(leaf =>
        leaf.kind === 'atomic-text' ? (
          <div
            className="my-2 rounded border border-shell-seam bg-shell-hover/40 p-3 font-mono text-xs text-text-muted"
            key={leaf.id}
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
                  void clipboard.writeText(source).then(() => setCopiedAtomicLeaf(leaf.id)).catch(() => {})
                }}
              >
                {copiedAtomicLeaf === leaf.id ? 'Copied' : 'Copy full text'}
              </button>
            </div>
            <pre className="whitespace-pre-wrap break-words">{leaf.content}</pre>
          </div>
        ) : (
          renderLeaf(leaf)
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
