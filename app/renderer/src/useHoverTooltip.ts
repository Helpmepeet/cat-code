import { useCallback, useEffect, useRef, useState } from 'react'

type TooltipGroup = 'rail' | 'tab'
const lastHidden: Partial<Record<TooltipGroup, number>> = {}

export function useHoverTooltip(group: TooltipGroup, delay: number) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const visible = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }, [])
  const hide = useCallback(() => {
    clearTimer()
    if (visible.current) lastHidden[group] = Date.now()
    visible.current = false
    setAnchor(null)
  }, [clearTimer, group])
  const show = useCallback((element: HTMLElement, immediate = false) => {
    clearTimer()
    const reveal = () => {
      timer.current = null
      visible.current = true
      setAnchor(element)
    }
    const recent = lastHidden[group]
    if (immediate || (recent !== undefined && Date.now() - recent < 250)) reveal()
    else timer.current = setTimeout(reveal, delay)
  }, [clearTimer, delay, group])

  useEffect(() => () => {
    clearTimer()
    if (visible.current) lastHidden[group] = Date.now()
  }, [clearTimer, group])
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') hide()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [hide])

  return { anchor, show, hide }
}
