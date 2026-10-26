export type NotificationVisibility = { sessionId: string | null; visible: boolean }

export function parseNotificationVisibility(raw: unknown): NotificationVisibility | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, 'sessionId') || !Object.hasOwn(value, 'visible') ||
      typeof value.visible !== 'boolean' ||
      (value.sessionId !== null && (typeof value.sessionId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.sessionId)))) return null
  return { sessionId: value.sessionId, visible: value.visible }
}

/** Window-local hint, deliberately outside the versioned session protocol. */
export interface NotificationVisibilityBridge {
  reportNotificationVisibility?(value: NotificationVisibility): void
}
