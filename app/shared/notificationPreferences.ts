export type NotificationPreferences = {
  notify: 'off' | 'waiting' | 'all'
  dockBadge: boolean
}

export const DEFAULT_NOTIFICATION_PREFERENCES: Readonly<NotificationPreferences> = {
  notify: 'all',
  dockBadge: true,
}

export function parseNotificationPreferences(raw: unknown): NotificationPreferences | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (Object.keys(value).length !== 2 || !Object.hasOwn(value, 'notify') || !Object.hasOwn(value, 'dockBadge')) return null
  if (value.notify !== 'off' && value.notify !== 'waiting' && value.notify !== 'all') return null
  if (typeof value.dockBadge !== 'boolean') return null
  return { notify: value.notify, dockBadge: value.dockBadge }
}
