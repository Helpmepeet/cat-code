import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createNotificationVisibility, registerNotificationVisibilityIpc } from './notificationVisibility.js'
import { CH_NOTIFICATION_VISIBILITY } from '../shared/ipcChannels.js'
import { createDesktopNotifications } from './desktopNotifications.js'
import { sessionDescriptorFixture } from '../shared/sessionDescriptor.fixture.js'
import type { ServerFrame } from '../shared/protocol.js'

const a = '00000000-0000-4000-8000-000000000001'
const b = '00000000-0000-4000-8000-000000000002'
const unknown = '00000000-0000-4000-8000-000000000003'

function harness() {
  const sessions = new Set([a, b])
  const changes: (string | null)[] = []
  let screenAvailable = true
  const visibility = createNotificationVisibility({
    hasSession: id => sessions.has(id),
    screenAvailable: () => screenAvailable,
    changed: id => { changes.push(id) },
  })
  let listener!: (event: boolean, ...args: unknown[]) => void
  registerNotificationVisibilityIpc<boolean>({
    on: (channel, receive) => { expect(channel).toBe(CH_NOTIFICATION_VISIBILITY); listener = receive },
    isTrustedSender: trusted => trusted,
    receive: visibility.receive,
  })
  return { visibility, changes, sessions, send: (...args: unknown[]) => listener(true, ...args),
    foreign: (...args: unknown[]) => listener(false, ...args),
    screen: (value: boolean) => { screenAvailable = value; visibility.refresh() } }
}

test('receiving boundary accepts only one closed typed payload from the main window and known sessions', () => {
  const h = harness()
  h.visibility.windowChanged(true)
  h.send({ sessionId: a, visible: true })
  expect(h.changes).toEqual([a])
  for (const raw of [
    null, [], {}, { sessionId: b }, { visible: true }, { sessionId: b, visible: 1 },
    { sessionId: '', visible: true }, { sessionId: 1, visible: true },
    { sessionId: 'x'.repeat(4096), visible: true }, { sessionId: unknown, visible: true },
    { sessionId: b, visible: true, permission: 'allow' },
    { sessionId: null, visible: false, extra: true },
  ]) h.send(raw)
  h.send()
  h.send({ sessionId: b, visible: true }, {})
  h.foreign({ sessionId: b, visible: true })
  expect(h.changes).toEqual([a])
  h.send({ sessionId: b, visible: true })
  h.send({ sessionId: null, visible: true })
  expect(h.changes).toEqual([a, b, null])
})

test('show:false startup, minimize/hide, occlusion/Spaces/display sleep, lock/suspend, and document loss gate attention', () => {
  const h = harness()
  h.send({ sessionId: a, visible: true })
  expect(h.changes).toEqual([])
  h.visibility.windowChanged(true)
  expect(h.changes.at(-1)).toBe(a)
  h.visibility.windowChanged(false)
  expect(h.changes.at(-1)).toBeNull()
  h.visibility.windowChanged(true)
  h.send({ sessionId: a, visible: false })
  expect(h.changes.at(-1)).toBeNull()
  h.send({ sessionId: a, visible: true })
  h.screen(false)
  expect(h.changes.at(-1)).toBeNull()
  h.send({ sessionId: b, visible: true })
  expect(h.changes.at(-1)).toBeNull()
  h.screen(true)
  expect(h.changes.at(-1)).toBe(b)
  h.visibility.reset()
  expect(h.changes.at(-1)).toBeNull()
  h.visibility.windowChanged(true)
  expect(h.changes.at(-1)).toBeNull()
  h.send({ sessionId: a, visible: true })
  h.sessions.delete(a)
  h.visibility.refresh()
  expect(h.changes.at(-1)).toBeNull()
})

test('a failure received with the screen unavailable is not acknowledged until the transcript is visible', () => {
  let badge = ''
  const notifications = createDesktopNotifications({
    getSession: id => id === a ? sessionDescriptorFixture({ appSessionId: a, cwd: '/tmp/notification-test' }) : undefined,
    isAppFocused: () => false,
    getPreferences: () => ({ notify: 'all', dockBadge: true }),
    createNotification: () => null,
    setBadge: value => { badge = value },
    openSession: () => {}, send: () => {},
  })
  let awake = false
  const visibility = createNotificationVisibility({
    hasSession: id => id === a, screenAvailable: () => awake,
    changed: notifications.onScreenChanged,
  })
  visibility.windowChanged(true)
  visibility.receive({ sessionId: a, visible: true })
  notifications.receive(a, { kind: 'event', sessionId: a, event: {
    type: 'message', message: { type: 'result', uuid: 'failure', subtype: 'error_during_execution', is_error: true },
  } } as ServerFrame)
  expect(badge).toBe('1')
  awake = true
  visibility.refresh()
  expect(badge).toBe('')
  visibility.receive({ sessionId: null, visible: true })
  expect(badge).toBe('')
})

test('production wiring retains macOS page visibility and clears stale renderer documents', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  expect(main).not.toContain('backgroundThrottling: false')
  const registration = main.slice(main.indexOf('registerNotificationVisibilityIpc<IpcMainEvent>({'), main.indexOf('  registerHostControlPlane()'))
  expect(registration).toContain('isMainWindowSender(event)')
  expect(registration).toContain('event.senderFrame === mainWindow?.webContents.mainFrame')
  for (const event of ['suspend', 'resume', 'lock-screen', 'unlock-screen', 'user-did-resign-active', 'user-did-become-active']) {
    expect(main).toContain(`powerMonitor.on('${event}'`)
  }
  expect(main.slice(main.indexOf("window.webContents.on('did-start-navigation'"))).toContain('notificationVisibility.reset()')
  expect(main.slice(main.indexOf("window.webContents.on('render-process-gone'"))).toContain('notificationVisibility.reset()')
})
