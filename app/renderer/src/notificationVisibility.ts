import { useLayoutEffect } from 'react'
import type { NotificationVisibility } from '../../shared/notificationVisibility.js'
import { getBridge } from './bridge.js'

export function observeNotificationVisibility(
  sessionId: string | null,
  document: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>,
  send: (value: NotificationVisibility) => void,
) {
  let retry: ReturnType<typeof setTimeout> | undefined
  const report = () => {
    clearTimeout(retry)
    try {
      send({ sessionId, visible: document.visibilityState === 'visible' })
    } catch {
      // The shared preload rate guard may reject a transition. Retry the latest
      // state rather than leaving a formerly shown session quiet indefinitely.
      retry = setTimeout(report, 250)
    }
  }
  document.addEventListener('visibilitychange', report)
  report()
  return () => {
    clearTimeout(retry)
    document.removeEventListener('visibilitychange', report)
  }
}

export function useNotificationVisibility(sessionId: string | null) {
  useLayoutEffect(() => observeNotificationVisibility(
    sessionId, document, value => getBridge().reportNotificationVisibility?.(value),
  ), [sessionId])
}
