import type { HostEvent } from './hostApi.js'

type NotificationOpenEvent = Extract<HostEvent, { type: 'notification-open' }>

export function parseNotificationRetryBlocked(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > 512 || Object.keys(raw).length !== raw.length) return null
  const ids = [...raw]
  if (ids.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) ||
    new Set(ids).size !== ids.length) return null
  return ids
}

export function parseNotificationOpenEvent(raw: unknown): NotificationOpenEvent | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (Object.keys(value).length !== 3 || value.type !== 'notification-open' ||
      typeof value.appSessionId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.appSessionId) ||
      typeof value.accounts !== 'boolean') return null
  return { type: 'notification-open', appSessionId: value.appSessionId, accounts: value.accounts }
}

export function parseTurnRetryRequest(raw: unknown): { sessionId: string; resultId: string } | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (Object.keys(value).length !== 2 ||
      typeof value.sessionId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.sessionId) ||
      typeof value.resultId !== 'string' || !value.resultId.length || value.resultId.length > 1024) return null
  return { sessionId: value.sessionId, resultId: value.resultId }
}
