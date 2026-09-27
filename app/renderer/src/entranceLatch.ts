import {
  useCallback,
  useLayoutEffect,
  useReducer,
  useRef,
  type AnimationEvent,
  type RefCallback,
} from 'react'

type EntranceRecord = {
  element: HTMLElement | null
  timeout: ReturnType<typeof setTimeout>
}

/** Long enough for the renderer's 120–200ms entrances when animationend is absent. */
const ENTRANCE_FALLBACK_MS = 260

/**
 * Keeps an entrance on its original DOM element until animationend. A replaced
 * element does not receive the remainder of that entrance, which prevents a
 * regroup from restarting it. The timeout covers reduced motion and removals.
 */
export function useEntranceLatch(freshKeys: ReadonlySet<string>) {
  const records = useRef(new Map<string, EntranceRecord>())
  const elements = useRef(new Map<string, HTMLElement>())
  const refs = useRef(new Map<string, RefCallback<HTMLElement>>())
  const [, redraw] = useReducer((value: number) => value + 1, 0)

  const finish = useCallback((key: string) => {
    const record = records.current.get(key)
    if (!record) return
    clearTimeout(record.timeout)
    records.current.delete(key)
    elements.current.delete(key)
    for (const callbackKey of refs.current.keys()) {
      if (callbackKey.startsWith(`${key}\0`)) refs.current.delete(callbackKey)
    }
    redraw()
  }, [])

  const active = new Set(records.current.keys())
  for (const key of freshKeys) active.add(key)

  useLayoutEffect(() => {
    for (const key of freshKeys) {
      if (records.current.has(key)) continue
      const timeout = setTimeout(() => finish(key), ENTRANCE_FALLBACK_MS)
      records.current.set(key, { element: elements.current.get(key) ?? null, timeout })
    }
  })

  useLayoutEffect(() => () => {
    for (const record of records.current.values()) clearTimeout(record.timeout)
    records.current.clear()
  }, [])

  const refFor = useCallback((key: string, className: string): RefCallback<HTMLElement> => {
    const callbackKey = `${key}\0${className}`
    let callback = refs.current.get(callbackKey)
    if (!callback) {
      callback = element => {
        if (!element) return
        const record = records.current.get(key)
        if (record?.element && record.element !== element) {
          element.classList.remove(className)
          finish(key)
          return
        }
        elements.current.set(key, element)
      }
      refs.current.set(callbackKey, callback)
    }
    return callback
  }, [finish])

  const onAnimationEnd = useCallback((key: string, event: AnimationEvent<HTMLElement>) => {
    if (event.target === event.currentTarget) finish(key)
  }, [finish])

  return { active, refFor, onAnimationEnd }
}

/** A one-element entrance triggered only by a committed value change. */
export function useEntranceOnChange<T>(value: T, eligible: boolean, className: string) {
  const previous = useRef({ value, generation: 0 })
  const changed = !Object.is(previous.current.value, value)
  const generation = previous.current.generation + (changed ? 1 : 0)
  const key = String(generation)
  const fresh = changed && eligible ? new Set([key]) : new Set<string>()
  useLayoutEffect(() => {
    previous.current = { value, generation }
  }, [value, generation])
  const latch = useEntranceLatch(fresh)
  return {
    active: latch.active.has(key),
    ref: latch.refFor(key, className),
    onAnimationEnd: (event: AnimationEvent<HTMLElement>) => latch.onAnimationEnd(key, event),
  }
}
