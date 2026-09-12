import { beforeEach, expect, test } from 'bun:test'
import type { ServerFrame } from '../shared/protocol.js'
import { benchmarkObserveBatch, benchmarkObserveCommit, benchmarkObserverSnapshot, benchmarkWrapRawReducer, resetBenchmarkObserver } from './streaming-benchmark-observer.js'
import { streamingBenchmarkTransform } from './streaming-benchmark.vite.config.js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

beforeEach(resetBenchmarkObserver)
function frame(sequence: number): ServerFrame {
  return { kind: 'pong', protocolVersion: 1, sessionId: 's', nonce: String(sequence), deliveryTrace: {
    streamEpoch: 'e', sequence, traceId: `t-${sequence}`, deliveryAttempt: 1, replay: false,
    sourceProcessInstanceId: 'p', sourceWallTimestamp: '2026-09-12T00:00:00.000Z', sourceMonotonicTimestampMs: sequence, connectionEpoch: 1,
  } }
}
type State = { sessions: { s: { messages: number[] } } }
const reduce = benchmarkWrapRawReducer<State>((state, action) => ({ sessions: { s: { messages: [...state.sessions.s.messages, Number((action as any).nonce)] } } }))

test('a later receipt cannot be claimed by an earlier committed reducer lineage', () => {
  const initial: State = { sessions: { s: { messages: [] } } }
  benchmarkObserveBatch([frame(1)])
  const afterA = reduce(initial, frame(1))
  benchmarkObserveBatch([frame(2)])
  benchmarkObserveCommit(10, afterA)
  expect(benchmarkObserverSnapshot().commits[0]?.frames.map(item => item.traceId)).toEqual(['t-1'])
  const afterB = reduce(afterA, frame(2))
  benchmarkObserveCommit(20, afterB)
  expect(benchmarkObserverSnapshot().commits[1]?.frames.map(item => item.traceId)).toEqual(['t-2'])
})

test('multiple reducer transitions in one render share the endpoint commit', () => {
  const initial: State = { sessions: { s: { messages: [] } } }
  const afterA = reduce(initial, frame(1))
  const afterB = reduce(afterA, frame(2))
  benchmarkObserveCommit(42, afterB)
  expect(benchmarkObserverSnapshot().commits[0]).toMatchObject({ atMs: 42, rawMessageCount: 2, frames: [{ traceId: 't-1' }, { traceId: 't-2' }] })
})

test('a genuine raw-log no-op receives no false commit timestamp', () => {
  const noOp = benchmarkWrapRawReducer<State>(state => state)
  const state: State = { sessions: { s: { messages: [] } } }
  benchmarkObserveCommit(5, noOp(state, frame(1)))
  expect(benchmarkObserverSnapshot()).toMatchObject({ commits: [], noRawStateChangeCount: 1, committedFrameCount: 0 })
})

test('the exact-checked transform instruments reducer lineage and layout endpoint', async () => {
  const path = resolve(import.meta.dir, '../renderer/src/App.tsx')
  const source = readFileSync(path, 'utf8')
  const result = await (streamingBenchmarkTransform().transform as Function)(source, path)
  expect(result.code).toContain('withBatch(benchmarkWrapRawReducer(reduceServerFrame))')
  expect(result.code).toContain('benchmarkObserveBatch(frames)')
  expect(result.code).toContain('benchmarkObserveCommit(performance.now(), state)')
})
