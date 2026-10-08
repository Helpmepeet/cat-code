import { useEffect, useReducer } from 'react'
import { isCacheExpiryTimestamp } from '../../shared/promptCacheEstimate.js'

export function useCacheExpiredEstimate(
  expiresAt: number | null | undefined,
  snapshotExpired?: boolean | null,
): boolean {
  const [, refresh] = useReducer((value: number) => value + 1, 0)
  const deadline = isCacheExpiryTimestamp(expiresAt) ? expiresAt : null
  useEffect(() => {
    if (deadline === null) return
    let timer: number | undefined
    const update = () => {
      if (timer !== undefined) window.clearTimeout(timer)
      refresh()
      const remaining = deadline - Date.now()
      if (remaining > 0) {
        timer = window.setTimeout(update, Math.min(remaining, 2_147_483_647))
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') update()
    }
    update()
    window.addEventListener('focus', update)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
      window.removeEventListener('focus', update)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [deadline])
  return deadline !== null
    ? Date.now() >= deadline
    : expiresAt == null && snapshotExpired === true
}
