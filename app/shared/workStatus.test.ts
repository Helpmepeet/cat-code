import { expect, test } from 'bun:test'
import { PROTOCOL_VERSION } from './protocol.js'
import {
  isWorkStatusFrame,
  isWorkStatusRequest,
  isWorkStatusSummary,
  WORK_STATUS_COUNT_LIMIT,
} from './workStatus.js'

const id = '0b8b8c9d-4e6f-4a51-9e1a-2b3c4d5e6f70'
const summary = {
  version: 1, available: true, hasUnfinishedWork: false, activeTurn: false,
  pendingContinuation: false, activeSubagents: 0, activeBackgroundTasks: 0,
  queuedWork: 0, waitingForApproval: false,
} as const

test('work status request is closed and generation-bound', () => {
  expect(isWorkStatusRequest({ type: 'work.status', requestId: id, forGeneration: id })).toBe(true)
  for (const invalid of [
    { type: 'work.status', requestId: 'not-uuid', forGeneration: id },
    { type: 'work.status', requestId: id, forGeneration: 1 },
    { type: 'work.status', requestId: id },
    { type: 'work.status', requestId: id, forGeneration: id, work: {} },
    ['work.status', id, id],
  ]) expect(isWorkStatusRequest(invalid)).toBe(false)
})

test('work summary rejects malformed counts and inconsistent empty facts', () => {
  expect(isWorkStatusSummary(summary)).toBe(true)
  expect(isWorkStatusSummary({
    ...summary, hasUnfinishedWork: true, activeTurn: true,
    activeSubagents: WORK_STATUS_COUNT_LIMIT,
  })).toBe(true)
  for (const count of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, WORK_STATUS_COUNT_LIMIT + 1]) {
    expect(isWorkStatusSummary({ ...summary, activeBackgroundTasks: count })).toBe(false)
  }
  expect(isWorkStatusSummary({ ...summary, version: 2 })).toBe(false)
  expect(isWorkStatusSummary({ ...summary, waitingForApproval: true })).toBe(false)
  expect(isWorkStatusSummary({ ...summary, queuedWork: 1 })).toBe(false)
  expect(isWorkStatusSummary({ ...summary, extra: true })).toBe(false)
})

test('work status response validates envelope, types, and serialized bound', () => {
  const frame = {
    kind: 'work.status', protocolVersion: PROTOCOL_VERSION, sessionId: id,
    requestId: id, generation: id, sequence: 1, work: summary,
  }
  expect(isWorkStatusFrame(frame)).toBe(true)
  for (const invalid of [
    { ...frame, sequence: 0 },
    { ...frame, sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...frame, requestId: 'bad' },
    { ...frame, protocolVersion: 999 },
    { ...frame, work: { ...summary, extra: 'x' } },
    { ...frame, work: { ...summary, activeTurn: true } },
    { ...frame, sessionId: 'x'.repeat(3000) },
    null, [], {},
  ]) expect(isWorkStatusFrame(invalid)).toBe(false)
})
