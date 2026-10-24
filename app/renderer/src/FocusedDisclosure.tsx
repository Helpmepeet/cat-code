import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/** Keep the closing body mounted until its height transition has finished. */
export function FocusedDisclosure({ open, id, children, className = '', animateArrival = false, exitMs = 260 }: {
  open: boolean
  id: string
  children: ReactNode
  className?: string
  animateArrival?: boolean
  /** Must cover the stylesheet's closing transition, including any delay. */
  exitMs?: number
}) {
  const [mounted, setMounted] = useState(open)
  const [visible, setVisible] = useState(open && !animateArrival)
  const frame = useRef(0)
  useLayoutEffect(() => {
    if (open) {
      setMounted(true)
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        setVisible(true)
        return
      }
      frame.current = requestAnimationFrame(() => setVisible(true))
      return () => cancelAnimationFrame(frame.current)
    }
    setVisible(false)
    if (!mounted) return
    const timer = setTimeout(() => setMounted(false),
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : exitMs)
    return () => clearTimeout(timer)
  }, [open])
  return (
    <div className={`focused-disclosure ${className}`} data-open={visible ? '' : undefined} id={id} aria-hidden={!open} inert={!open}>
      <div className="focused-disclosure-clip">{mounted ? children : null}</div>
    </div>
  )
}
