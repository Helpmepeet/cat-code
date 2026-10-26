import { CH_NOTIFICATION_VISIBILITY } from '../shared/ipcChannels.js'
import { parseNotificationVisibility, type NotificationVisibility } from '../shared/notificationVisibility.js'

/** This renderer-authored hint can only quiet notices and change their badge. */
export function createNotificationVisibility(options: {
  hasSession: (id: string) => boolean
  screenAvailable: () => boolean
  changed: (id: string | null) => void
}) {
  let report: NotificationVisibility | null = null
  let windowVisible = false
  let last: string | null = null
  function refresh() {
    const id = windowVisible && options.screenAvailable() && report?.visible &&
      report.sessionId !== null && options.hasSession(report.sessionId) ? report.sessionId : null
    if (last === id) return
    last = id
    options.changed(id)
  }
  return {
    receive(raw: unknown) {
      const value = parseNotificationVisibility(raw)
      if (!value || (value.sessionId !== null && !options.hasSession(value.sessionId))) return
      report = value
      refresh()
    },
    windowChanged(visible: boolean) { windowVisible = visible; refresh() },
    reset() { report = null; refresh() },
    refresh,
  }
}

export function registerNotificationVisibilityIpc<E>(options: {
  on: (channel: string, listener: (event: E, ...args: unknown[]) => void) => void
  isTrustedSender: (event: E) => boolean
  receive: (raw: unknown) => void
}) {
  options.on(CH_NOTIFICATION_VISIBILITY, (event, ...args) => {
    if (!options.isTrustedSender(event) || args.length !== 1) return
    options.receive(args[0])
  })
}
