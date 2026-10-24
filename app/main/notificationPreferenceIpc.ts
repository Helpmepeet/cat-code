import { CH_GET_NOTIFICATION_PREFERENCES, CH_SET_NOTIFICATION_PREFERENCES, CH_RETRY_TURN, CH_NOTIFICATION_RETRY_BLOCKED } from '../shared/ipcChannels.js'
import { parseNotificationPreferences, type NotificationPreferences } from '../shared/notificationPreferences.js'
import { parseTurnRetryRequest, parseNotificationRetryBlocked } from '../shared/notificationNavigation.js'

export function registerNotificationPreferenceIpc<E>(options: {
  handle: (channel: string, listener: (event: E, ...args: unknown[]) => NotificationPreferences) => void
  isTrustedSender: (event: E) => boolean
  read: () => NotificationPreferences
  write: (value: NotificationPreferences) => NotificationPreferences
  changed: () => void
}): void {
  options.handle(CH_GET_NOTIFICATION_PREFERENCES, (event, ...args) => {
    if (!options.isTrustedSender(event) || args.length !== 0) throw new TypeError('Invalid notification preferences request')
    return options.read()
  })
  options.handle(CH_SET_NOTIFICATION_PREFERENCES, (event, ...args) => {
    if (!options.isTrustedSender(event) || args.length !== 1) throw new TypeError('Invalid notification preferences request')
    const preferences = parseNotificationPreferences(args[0])
    if (!preferences) throw new TypeError('Invalid notification preferences')
    const accepted = options.write(preferences)
    options.changed()
    return accepted
  })
}

export function registerNotificationRetryIpc<E>(options: {
  handle: (channel: string, listener: (event: E, ...args: unknown[]) => boolean) => void
  isTrustedSender: (event: E) => boolean
  retry: (sessionId: string, resultId: string) => boolean
}): void {
  options.handle(CH_RETRY_TURN, (event, ...args) => {
    if (!options.isTrustedSender(event) || args.length !== 1) throw new TypeError('Invalid retry request')
    const request = parseTurnRetryRequest(args[0])
    if (!request) throw new TypeError('Invalid retry request')
    return options.retry(request.sessionId, request.resultId)
  })
}

export function registerNotificationRetryBlockedIpc<E>(options: {
  on: (channel: string, listener: (event: E, ...args: unknown[]) => void) => void
  isTrustedSender: (event: E) => boolean
  changed: (sessionIds: string[]) => void
}): void {
  options.on(CH_NOTIFICATION_RETRY_BLOCKED, (event, ...args) => {
    if (!options.isTrustedSender(event) || args.length !== 1) return
    const sessionIds = parseNotificationRetryBlocked(args[0])
    if (sessionIds) options.changed(sessionIds)
  })
}
