import { DEFAULT_NOTIFICATION_PREFERENCES, parseNotificationPreferences, type NotificationPreferences } from '../shared/notificationPreferences.js'
import { readPreferenceFile, writePreferenceFile } from './preferenceFile.js'

const NOTIFICATION_PREFERENCE_FILE = 'notification-preference.json'

export function readNotificationPreference(userDataDir: string): NotificationPreferences {
  return readPreferenceFile(userDataDir, NOTIFICATION_PREFERENCE_FILE, raw => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
    const value = raw as Record<string, unknown>
    return value.version === 1 && Object.keys(value).length === 2
      ? parseNotificationPreferences(value.preferences)
      : null
  }) ?? { ...DEFAULT_NOTIFICATION_PREFERENCES }
}

export function writeNotificationPreference(userDataDir: string, raw: unknown): NotificationPreferences {
  const preferences = parseNotificationPreferences(raw)
  if (!preferences) throw new TypeError('Invalid notification preferences')
  writePreferenceFile(userDataDir, NOTIFICATION_PREFERENCE_FILE, { version: 1, preferences })
  return preferences
}
