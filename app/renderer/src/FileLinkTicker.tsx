import { useLayoutEffect, useRef } from 'react'

/** The destination is display-only until its Markdown link closes. */
export function FileLinkTicker({ destination }: { destination: string }) {
  const path = destination.startsWith('<') ? destination.slice(1).replace(/>$/, '') : destination
  const ref = useRef<HTMLSpanElement>(null)
  const measureRef = useRef<() => void>(() => {})
  useLayoutEffect(() => {
    const ticker = ref.current
    const chip = ticker?.parentElement
    const line = chip?.closest('p, li, .md-prose')
    if (!ticker || !chip || !line) return
    const measure = () => {
      const available = Math.max(0, line.getBoundingClientRect().right - chip.getBoundingClientRect().right - 3)
      ticker.style.setProperty('--file-link-ticker-room', `${available}px`)
      ticker.toggleAttribute('data-clipped', (ticker.firstElementChild?.getBoundingClientRect().width ?? 0) > available)
      ticker.toggleAttribute('data-no-room', available < 24)
    }
    measureRef.current = measure
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(line)
    observer?.observe(chip)
    return () => {
      measureRef.current = () => {}
      observer?.disconnect()
    }
  }, [])
  useLayoutEffect(() => { measureRef.current() }, [destination])
  return (
    <span ref={ref} className="file-link-ticker" aria-hidden="true">
      <span>{path.slice(path.lastIndexOf('/') + 1)}</span>
    </span>
  )
}
