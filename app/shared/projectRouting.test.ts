import { expect, test } from 'bun:test'
import { parseProjectRouteCommand } from './projectRouting.js'

const sessionId = '93ad8a93-bc68-4954-8c3e-92115798fcce'
const submitId = '5b48eb57-5dc5-45ed-af3a-248863d962f2'

test('accepts only bounded project routing commands', () => {
  expect(parseProjectRouteCommand({ appSessionId: sessionId, submitId, choice: 'move' })).toEqual({ appSessionId: sessionId, submitId, choice: 'move' })
  expect(parseProjectRouteCommand({ appSessionId: sessionId, submitId, choice: 'move', cwd: '/tmp' })).toBeNull()
  expect(parseProjectRouteCommand({ appSessionId: sessionId, submitId, choice: 'unknown' })).toBeNull()
})
