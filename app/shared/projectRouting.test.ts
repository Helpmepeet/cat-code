import { expect, test } from 'bun:test'
import { parseProjectRouteCommand } from './projectRouting.js'

const sessionId = '93ad8a93-bc68-4954-8c3e-92115798fcce'
const submitId = '5b48eb57-5dc5-45ed-af3a-248863d962f2'

test('accepts only bounded project routing commands', () => {
  expect(parseProjectRouteCommand({ appSessionId: sessionId, submitId, choice: 'resend' })).toEqual({ appSessionId: sessionId, submitId, choice: 'resend' })
  expect(parseProjectRouteCommand({ appSessionId: sessionId, submitId, choice: 'resend', cwd: '/tmp' })).toBeNull()
  expect(parseProjectRouteCommand({ appSessionId: sessionId, submitId, choice: 'cancel' })).toEqual({ appSessionId: sessionId, submitId, choice: 'cancel' })
  for (const choice of ['move', 'stay', 'unknown']) {
    expect(parseProjectRouteCommand({ appSessionId: sessionId, submitId, choice })).toBeNull()
  }
})
