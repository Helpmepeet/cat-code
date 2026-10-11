import { useContext, useLayoutEffect, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { AccentThemeContext } from './accentTheme.js'
import './composerPopover.css'

/** Keep the menu out of the pane's clipping ancestors while retaining React events. */
export function ComposerPopoverPanel({
  children,
  panelRef,
  triggerRef,
  align = 'start',
  gap = 8,
}: {
  children: ReactNode
  panelRef: RefObject<HTMLDivElement | null>
  triggerRef: RefObject<HTMLButtonElement | null>
  align?: 'start' | 'end'
  gap?: number
}) {
  const { accent } = useContext(AccentThemeContext)
  useLayoutEffect(() => {
    const panel = panelRef.current
    const trigger = triggerRef.current
    if (!panel || !trigger) return
    const content = panel.firstElementChild as HTMLElement | null
    if (!content) return
    const place = () => {
      const anchor = trigger.getBoundingClientRect()
      const margin = 8
      const width = content.offsetWidth
      const height = content.offsetHeight
      const above = Math.max(0, anchor.top - gap - margin)
      const below = Math.max(0, window.innerHeight - anchor.bottom - gap - margin)
      const placeAbove = height <= above || above >= below
      const available = Math.max(1, placeAbove ? above : below)
      const left = Math.max(margin, Math.min(
        align === 'end' ? anchor.right - width : anchor.left,
        window.innerWidth - margin - width,
      ))
      const top = placeAbove
        ? Math.max(margin, anchor.top - gap - Math.min(height, available))
        : Math.max(margin, anchor.bottom + gap)
      // Measured geometry belongs in CSS variables; visual styling stays in CSS.
      panel.style.setProperty('--composer-popover-left', `${left}px`)
      panel.style.setProperty('--composer-popover-top', `${top}px`)
      panel.style.setProperty('--composer-popover-height', `${available}px`)
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(trigger)
    observer.observe(content)
    const pane = trigger.closest('.session-pane')
    if (pane) observer.observe(pane)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [align, gap, panelRef, triggerRef])

  if (typeof document === 'undefined') return children
  return createPortal(
    <div ref={panelRef} className="composer-popover" data-accent={accent}>{children}</div>,
    document.body,
  )
}
