import { useLayoutEffect, useRef } from 'react'

/** The destination is display-only until its Markdown link closes. */
export function FileLinkTicker({ destination }: { destination: string }) {
  const rawPath = destination.trimEnd()
  const path = rawPath.startsWith('<') ? rawPath.slice(1).replace(/>$/, '') : rawPath
  const ref = useRef<HTMLSpanElement>(null)
  const measureRef = useRef<() => void>(() => {})
  useLayoutEffect(() => {
    const ticker = ref.current
    const chip = ticker?.parentElement
    const line = chip?.closest('p, li, td, th, .md-prose')
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
  // Preceding text can move the chip without changing any observed size.
  useLayoutEffect(() => { measureRef.current() })
  return (
    <span ref={ref} className="file-link-ticker" aria-hidden="true">
      <span>{path.slice(path.lastIndexOf('/') + 1)}</span>
    </span>
  )
}
