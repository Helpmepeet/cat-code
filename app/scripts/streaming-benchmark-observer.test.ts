import { beforeEach, expect, test } from 'bun:test'
import type { ServerFrame } from '../shared/protocol.js'
import { benchmarkObserveBatch, benchmarkObserveCommit, benchmarkObserverSnapshot, resetBenchmarkObserver } from './streaming-benchmark-observer.js'
import { streamingBenchmarkTransform } from './streaming-benchmark.vite.config.js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

beforeEach(resetBenchmarkObserver)

function frame(sequence: number): ServerFrame {
  return { kind: 'pong', protocolVersion: 1, sessionId: 's', nonce: String(sequence), deliveryTrace: {
    streamEpoch: 'e', sequence, traceId: `t-${sequence}`, deliveryAttempt: 1, replay: false,
    sourceProcessInstanceId: 'p', sourceWallTimestamp: '2026-09-12T00:00:00.000Z',
    sourceMonotonicTimestampMs: sequence, connectionEpoch: 1,
  } }
}

test('associates every received identity with the next layout commit', () => {
  benchmarkObserveBatch([frame(1), frame(2)])
  benchmarkObserveBatch([frame(3)])
  benchmarkObserveCommit(42, { sessions: { s: { messages: [{}, {}] } } })
  expect(benchmarkObserverSnapshot()).toEqual({ dispatchCount: 2, commitCount: 1, commits: [{ atMs: 42, rawMessageCount: 2, frames: [
    { traceId: 't-1', sequence: 1, sessionId: 's' }, { traceId: 't-2', sequence: 2, sessionId: 's' }, { traceId: 't-3', sequence: 3, sessionId: 's' },
  ] }], pending: [] })
})

test('empty React commits do not invent frame coverage', () => {
  benchmarkObserveCommit(1)
  expect(benchmarkObserverSnapshot().commits).toEqual([])
})

test('the exact-checked transform instruments App without changing production source', async () => {
  const path = resolve(import.meta.dir, '../renderer/src/App.tsx')
  const source = readFileSync(path, 'utf8')
  const plugin = streamingBenchmarkTransform()
  const result = await (plugin.transform as Function)(source, path)
  expect(result.code).toContain('benchmarkObserveBatch(frames)')
  expect(result.code).toContain('useLayoutEffect(() => { benchmarkObserveCommit(performance.now(), state) }, [state])')
})
