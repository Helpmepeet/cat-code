import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

type TooltipGroup = 'rail' | 'tab'

// The caret keeps this far from the panel's corners so it never lands on a radius.
const CARET_INSET = 14

export function HoverTooltip({ anchor, placement, children }: {
  anchor: HTMLElement | null
  placement: TooltipGroup
  children: ReactNode
}) {
  const tooltipRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 0, top: 0, caret: 0 })
  useLayoutEffect(() => {
    if (!anchor) return
    const place = () => {
      const rect = anchor.getBoundingClientRect()
      const width = tooltipRef.current?.getBoundingClientRect().width ?? 0
      if (placement === 'rail') {
        setPosition({ left: (anchor.closest('aside')?.getBoundingClientRect().right ?? rect.right) + 6, top: rect.top + rect.height / 2, caret: 0 })
        return
      }
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
      // The caret points at the tab's centre, so a panel clamped away from the
      // tab (a tab near the window edge) still visibly belongs to it.
      const caret = Math.max(CARET_INSET, Math.min(rect.left + rect.width / 2 - left, Math.max(CARET_INSET, width - CARET_INSET)))
      setPosition({ left, top: rect.bottom + 8, caret })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchor, placement, children])
  if (!anchor) return null
  const style: CSSProperties & { '--tooltip-caret'?: string } = { left: position.left, top: position.top }
  if (placement === 'tab') style['--tooltip-caret'] = `${position.caret}px`
  return createPortal(
    <div
      ref={tooltipRef}
      role="tooltip"
      className={`pointer-events-none fixed z-[71] text-text-primary shadow-[var(--elev-popover)] ${placement === 'rail'
        ? '-translate-y-1/2 whitespace-nowrap rounded-md border border-shell-seam bg-surface-raised px-2 py-1 text-xs'
        : "min-w-[168px] max-w-[min(300px,calc(100vw-16px))] rounded-lg border border-accent/35 bg-surface-raised px-3 py-2 text-xs [overflow-wrap:anywhere] before:absolute before:-top-[6px] before:left-[var(--tooltip-caret)] before:size-2.5 before:-translate-x-1/2 before:rotate-45 before:border-l before:border-t before:border-accent/35 before:bg-surface-raised before:content-['']"}`}
      style={style}
    >
      {children}
    </div>,
    document.body,
  )
}
