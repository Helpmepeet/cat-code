import { expect, test } from 'bun:test'
import { parseNotificationOpenEvent } from './notificationNavigation.js'

test('notification navigation admits only a closed session address and accounts flag', () => {
  const valid = { type: 'notification-open', appSessionId: '00000000-0000-4000-8000-000000000001', accounts: false } as const
  expect(parseNotificationOpenEvent(valid)).toEqual(valid)
  expect(parseNotificationOpenEvent({ ...valid, accounts: true })?.accounts).toBe(true)
  for (const raw of [null, [], {}, { ...valid, type: 'other' }, { ...valid, appSessionId: '' }, { ...valid, appSessionId: '../session' }, { ...valid, appSessionId: 1 }, { ...valid, accounts: 'yes' }, { ...valid, extra: true }, { type: valid.type, appSessionId: valid.appSessionId }]) {
    expect(parseNotificationOpenEvent(raw)).toBeNull()
  }
})
