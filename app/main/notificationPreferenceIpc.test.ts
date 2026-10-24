import { expect, test } from 'bun:test'
import { CH_GET_NOTIFICATION_PREFERENCES, CH_SET_NOTIFICATION_PREFERENCES, CH_RETRY_TURN, CH_NOTIFICATION_RETRY_BLOCKED } from '../shared/ipcChannels.js'
import { registerNotificationPreferenceIpc, registerNotificationRetryIpc, registerNotificationRetryBlockedIpc } from './notificationPreferenceIpc.js'

test('notification preference IPC accepts only the window sender and closed payloads', () => {
  const handlers = new Map<string, (event: boolean, ...args: unknown[]) => unknown>()
  let value = { notify: 'all' as 'off' | 'waiting' | 'all', dockBadge: true }
  let changes = 0
  registerNotificationPreferenceIpc({
    handle: (channel, listener) => { handlers.set(channel, listener) },
    isTrustedSender: (event: boolean) => event,
    read: () => value,
    write: accepted => { value = accepted; return value },
    changed: () => { changes++ },
  })
  const read = handlers.get(CH_GET_NOTIFICATION_PREFERENCES)!
  const write = handlers.get(CH_SET_NOTIFICATION_PREFERENCES)!
  expect(read(true)).toEqual(value)
  expect(write(true, { notify: 'waiting', dockBadge: false })).toEqual({ notify: 'waiting', dockBadge: false })
  expect(changes).toBe(1)
  for (const payload of [null, [], {}, { notify: 'all' }, { notify: 'other', dockBadge: true }, { notify: 'all', dockBadge: 1 }, { notify: 'all', dockBadge: true, extra: true }]) {
    expect(() => write(true, payload)).toThrow()
  }
  expect(() => read(false)).toThrow()
  expect(() => read(true, {})).toThrow()
  expect(() => write(false, { notify: 'off', dockBadge: false })).toThrow()
  expect(() => write(true)).toThrow()
  expect(() => write(true, value, {})).toThrow()
  expect(changes).toBe(1)
  expect(value).toEqual({ notify: 'waiting', dockBadge: false })
})

test('Retry IPC accepts only a validated result selection from the window', () => {
  let handler!: (event: boolean, ...args: unknown[]) => boolean
  const calls: string[][] = []
  registerNotificationRetryIpc({
    handle: (channel, listener) => { expect(channel).toBe(CH_RETRY_TURN); handler = listener },
    isTrustedSender: (event: boolean) => event,
    retry: (sessionId, resultId) => { calls.push([sessionId, resultId]); return resultId === 'result:failed' },
  })
  const valid = { sessionId: '00000000-0000-4000-8000-000000000001', resultId: 'result:failed' }
  expect(handler(true, valid)).toBe(true)
  expect(handler(true, { ...valid, resultId: 'stale' })).toBe(false)
  const invalid = [null, [], {}, { ...valid, sessionId: '../bad' }, { ...valid, resultId: '' }, { ...valid, resultId: 'x'.repeat(1025) }, { ...valid, text: 'forged prompt' }]
  for (const raw of invalid) expect(() => handler(true, raw)).toThrow()
  expect(() => handler(false, valid)).toThrow()
  expect(() => handler(true, valid, {})).toThrow()
  expect(calls).toEqual([[valid.sessionId, 'result:failed'], [valid.sessionId, 'stale']])
})

test('retry-blocking hints accept only bounded session IDs from the window', () => {
  let handler!: (event: boolean, ...args: unknown[]) => void
  const reports: string[][] = []
  registerNotificationRetryBlockedIpc({
    on: (channel, listener) => { expect(channel).toBe(CH_NOTIFICATION_RETRY_BLOCKED); handler = listener },
    isTrustedSender: (event: boolean) => event,
    changed: ids => { reports.push(ids) },
  })
  const id = '00000000-0000-4000-8000-000000000001'
  handler(true, [id])
  handler(true, [])
  for (const invalid of [null, {}, ['../bad'], [id, id], [1], Array(1), Object.assign([id], { prompt: 'not accepted' }), Array(513).fill(id), { sessionIds: [id], prompt: 'not accepted' }]) {
    handler(true, invalid)
  }
  handler(false, [id])
  handler(true, [id], {})
  expect(reports).toEqual([[id], []])
})
