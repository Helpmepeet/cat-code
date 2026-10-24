import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { DEFAULT_NOTIFICATION_PREFERENCES, parseNotificationPreferences, type NotificationPreferences } from '../../shared/notificationPreferences.js'
import { getBridge } from './bridge.js'
import { NotificationPreferencesContext, type NotificationPreferencesBridge } from './notificationPreferences.js'

export function NotificationPreferencesProvider({ children, bridge }: {
  children: ReactNode
  bridge?: NotificationPreferencesBridge
}) {
  const [preferences, updatePreferences] = useState<NotificationPreferences>({ ...DEFAULT_NOTIFICATION_PREFERENCES })
  const revision = useRef(0)
  const confirmed = useRef(preferences)
  const pending = useRef(Promise.resolve())
  const api = useCallback(() => bridge ?? getBridge(), [bridge])

  useEffect(() => {
    let active = true
    const current = revision.current
    void (async () => {
      try {
        const value = parseNotificationPreferences(await api().getNotificationPreferences())
        if (active && revision.current === current && value) {
          confirmed.current = value
          updatePreferences(value)
        }
      } catch {
        // Keep defaults when the main-owned preference cannot be read.
      }
    })()
    return () => { active = false }
  }, [api])

  const setPreferences = useCallback((raw: NotificationPreferences) => {
    const value = parseNotificationPreferences(raw)
    if (!value) return
    const current = ++revision.current
    updatePreferences(value)
    // Preserve write order even when the operator changes both controls quickly.
    pending.current = pending.current.then(async () => {
      try {
        const saved = parseNotificationPreferences(await api().setNotificationPreferences(value))
        if (!saved) throw new TypeError('Invalid notification preferences response')
        confirmed.current = saved
        if (revision.current === current) updatePreferences(saved)
      } catch {
        if (revision.current === current) updatePreferences(confirmed.current)
      }
    })
  }, [api])
  const value = useMemo(() => ({ preferences, setPreferences }), [preferences, setPreferences])
  return <NotificationPreferencesContext.Provider value={value}>{children}</NotificationPreferencesContext.Provider>
}
