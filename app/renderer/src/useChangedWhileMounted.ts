import { useLayoutEffect, useRef } from 'react'

/** True for the committed render in which value changes within this mount. */
export function useChangedWhileMounted<T>(value: T): boolean {
  const previous = useRef(value)
  const changed = !Object.is(previous.current, value)

  useLayoutEffect(() => {
    previous.current = value
  }, [value])

  return changed
}
