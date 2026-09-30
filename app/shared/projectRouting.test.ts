import { expect, test } from 'bun:test'
import {
  parseProjectRouteCommand,
  parseProjectRouteWorkerRequest,
  parseProjectRouteWorkerResult,
  projectRouteText,
} from './projectRouting.js'

const sessionId = '93ad8a93-bc68-4954-8c3e-92115798fcce'
const submitId = '5b48eb57-5dc5-45ed-af3a-248863d962f2'

test('accepts only bounded project routing commands', () => {
  expect(parseProjectRouteCommand({ appSessionId: sessionId, submitId, choice: 'move' })).toEqual({ appSessionId: sessionId, submitId, choice: 'move' })
  expect(parseProjectRouteCommand({ appSessionId: sessionId, submitId, choice: 'move', cwd: '/tmp' })).toBeNull()
  expect(parseProjectRouteCommand({ appSessionId: sessionId, submitId, choice: 'unknown' })).toBeNull()
})

test('validates a closed worker request and result', () => {
  expect(parseProjectRouteWorkerRequest({
    type: 'project-route', version: 1, text: 'fix cat-code', previousUserMessages: [],
    knownProjectRoots: ['/Users/pt/cat-code'], suppressedRoots: [], model: 'gpt-6.1-sol',
  })).not.toBeNull()
  expect(parseProjectRouteWorkerRequest({
    type: 'project-route', version: 1, text: 'fix cat-code', previousUserMessages: [],
    knownProjectRoots: ['/Users/pt/cat-code'], suppressedRoots: [], model: 'gpt-6.1-sol', cwd: '/tmp',
  })).toBeNull()
  expect(parseProjectRouteWorkerResult({ type: 'project-route-result', version: 1, decision: { kind: 'stay' } })).not.toBeNull()
  expect(parseProjectRouteWorkerResult({
    type: 'project-route-result', version: 1,
    decision: { kind: 'auto', cwd: '/Users/pt/cat-code', name: 'cat-code', explicit: true },
  })).not.toBeNull()
  expect(parseProjectRouteWorkerResult({
    type: 'project-route-result', version: 1,
    decision: { kind: 'auto', cwd: '/tmp', name: 'cat-code', explicit: true, injected: true },
  })).toBeNull()
})

test('uses only text blocks for classifier input', () => {
  expect(projectRouteText([
    { type: 'text', text: 'fix this' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
  ])).toBe('fix this')
})
