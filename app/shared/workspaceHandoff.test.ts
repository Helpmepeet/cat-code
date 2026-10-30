import { expect, test } from 'bun:test'
import {
  isResumeCheckpoint,
  isResumeCheckpointV1,
  isResumeCheckpointV2,
  isWorkspaceHandoffExecutionRecord,
  isWorkspaceHandoffSnapshot,
  type ResumeCheckpointV1,
  type ResumeCheckpointV2,
  type WorkspaceHandoffExecutionRecord,
  type WorkspaceHandoffSnapshot,
} from './workspaceHandoff.js'

// A saved V1 remains valid and has no new fields or reinterpretation.
const savedV1: ResumeCheckpointV1 = {
  version: 1,
  prefixBytes: 1024,
  prefixSha256: 'a'.repeat(64),
  activeTipUuid: '00000000-0000-4000-8000-000000000001',
  projectionSha256: 'b'.repeat(64),
  messageCount: 2,
}
const v2: ResumeCheckpointV2 = { ...savedV1, version: 2 }

test.each([savedV1, v2])('receiving record/snapshot validators accept checkpoint v$version and reject malformed nested evidence', checkpoint => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const identity = { appSessionId: id(1), engineSessionId: id(2), operationId: id(3),
    continuationId: id(4), sourceGeneration: id(5), admissionGeneration: id(6), operationSha256: 'c'.repeat(64) }
  const record: WorkspaceHandoffExecutionRecord = { ...identity, version: 1, origin: 'fresh',
    revision: 3, consumed: true, inputCommitted: true, cancellation: null,
    terminal: { outcome: 'failed', order: 1, checkpoint },
    notice: { displayUuid: id(7), contextUuid: id(8), outcome: 'continuation_failed', checkpoint },
    reconciliation: { noticeUuid: id(7), inputUuid: id(9), contextUuid: id(10), checkpoint },
  }
  const snapshot: WorkspaceHandoffSnapshot = { ...identity, observerGeneration: id(11), statusSeq: 1,
    execution: 'terminal', record: { kind: 'valid', record },
    gate: { mode: 'open', reservationOperationId: null, requiresUserReconciliation: false } }
  expect(isWorkspaceHandoffExecutionRecord(JSON.parse(JSON.stringify(record)))).toBe(true)
  expect(isWorkspaceHandoffSnapshot(JSON.parse(JSON.stringify(snapshot)))).toBe(true)
  for (const field of ['terminal', 'notice', 'reconciliation'] as const) {
    for (const malformed of [{ ...checkpoint, version: 3 }, { ...checkpoint, messageCount: -1 },
      { ...checkpoint, prefixSha256: 'broken' }, { ...checkpoint, extra: true }]) {
      const changed = structuredClone(record)
      Object.assign(changed[field]!, { checkpoint: malformed })
      expect(isWorkspaceHandoffExecutionRecord(changed)).toBe(false)
      expect(isWorkspaceHandoffSnapshot({ ...snapshot, record: { kind: 'valid', record: changed } })).toBe(false)
    }
  }
  const mixed = { ...record, terminal: { ...record.terminal!, checkpoint: savedV1 },
    notice: { ...record.notice!, checkpoint: v2 } }
  expect(isWorkspaceHandoffExecutionRecord(mixed)).toBe(true)
})

test('checkpoint validators preserve saved V1 and distinguish explicit V2 semantics', () => {
  const saved = JSON.parse(JSON.stringify(savedV1))
  expect(isResumeCheckpointV1(saved)).toBe(true)
  expect(isResumeCheckpointV2(saved)).toBe(false)
  expect(isResumeCheckpoint(saved)).toBe(true)
  expect(isResumeCheckpointV1(v2)).toBe(false)
  expect(isResumeCheckpointV2(v2)).toBe(true)
  expect(isResumeCheckpoint(v2)).toBe(true)
  expect(saved).toEqual(savedV1)
})

test.each([1, 2])('checkpoint version %s permits an empty filtered projection but requires a nonempty raw prefix', version => {
  expect(isResumeCheckpoint({ ...savedV1, version, messageCount: 0 })).toBe(true)
  expect(isResumeCheckpoint({ ...savedV1, version, prefixBytes: 0 })).toBe(false)
})

test.each([1, 2])('checkpoint version %s rejects malformed or open shapes', version => {
  const valid = { ...savedV1, version }
  const malformed: unknown[] = [null, [], 'checkpoint', {},
    { ...valid, version: 0 }, { ...valid, version: 3 }, { ...valid, version: '2' },
    { ...valid, prefixBytes: -1 }, { ...valid, prefixBytes: 1.5 },
    { ...valid, prefixBytes: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, prefixBytes: Infinity }, { ...valid, prefixBytes: '1024' },
    { ...valid, messageCount: -1 }, { ...valid, messageCount: 1.5 },
    { ...valid, messageCount: NaN }, { ...valid, messageCount: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, prefixSha256: 'a'.repeat(63) }, { ...valid, prefixSha256: 'A'.repeat(64) },
    { ...valid, projectionSha256: 'z'.repeat(64) }, { ...valid, projectionSha256: null },
    { ...valid, activeTipUuid: 'not-a-uuid' }, { ...valid, activeTipUuid: null },
    { ...valid, extra: true },
    ...Object.keys(valid).map(key => Object.fromEntries(Object.entries(valid).filter(([field]) => field !== key))),
  ]
  for (const candidate of malformed) {
    expect(isResumeCheckpoint(candidate)).toBe(false)
    expect(isResumeCheckpointV1(candidate)).toBe(false)
    expect(isResumeCheckpointV2(candidate)).toBe(false)
  }
})
