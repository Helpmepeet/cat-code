import { createContext } from 'react'
import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationPreferences } from '../../shared/notificationPreferences.js'

export type NotificationPreferencesBridge = {
  getNotificationPreferences: () => Promise<NotificationPreferences>
  setNotificationPreferences: (value: NotificationPreferences) => Promise<NotificationPreferences>
}

export type NotificationPreferencesContextValue = {
  preferences: NotificationPreferences
  setPreferences: (value: NotificationPreferences) => void
}

export const NotificationPreferencesContext = createContext<NotificationPreferencesContextValue>({
  preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES },
  setPreferences: () => {},
})
