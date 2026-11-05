import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

type TooltipGroup = 'rail' | 'tab'

export function HoverTooltip({ anchor, placement, children }: {
  anchor: HTMLElement | null
  placement: TooltipGroup
  children: ReactNode
}) {
  const tooltipRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  useLayoutEffect(() => {
    if (!anchor) return
    const place = () => {
      const rect = anchor.getBoundingClientRect()
      const width = tooltipRef.current?.getBoundingClientRect().width ?? 0
      setPosition(placement === 'rail'
        ? { left: (anchor.closest('aside')?.getBoundingClientRect().right ?? rect.right) + 6, top: rect.top + rect.height / 2 }
        : { left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), top: rect.bottom + 6 })
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
  return createPortal(
    <div
      ref={tooltipRef}
      role="tooltip"
      className={`pointer-events-none fixed z-[71] border border-shell-seam bg-surface-raised text-text-primary shadow-[var(--elev-popover)] ${placement === 'rail' ? '-translate-y-1/2 whitespace-nowrap rounded-md px-2 py-1 text-xs' : 'max-w-[min(300px,calc(100vw-16px))] rounded-lg px-2.5 py-1.5 text-xs [overflow-wrap:anywhere]'}`}
      style={{ left: position.left, top: position.top }}
    >
      {children}
    </div>,
    document.body,
  )
}
