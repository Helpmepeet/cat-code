import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { executionTargets, instrumentExecutions, performanceMetricDeltas, performanceMetricNames, transcriptMode } from './streaming-benchmark-instrumentation.js'
import { additionalWorkloads, createFixture, manifest } from './streaming-benchmark-fixture.js'
import { benchmarkCountExecution, benchmarkObserverSnapshot, resetBenchmarkObserver } from './streaming-benchmark-observer.js'
import { createTranscriptState, projectServerFrames, selectNestedTranscriptRows } from '../renderer/src/transcriptProjector.js'
import { deriveFocusedTranscript } from '../renderer/src/focusedTranscriptLayout.js'

test('mode is explicit and rejects misspellings', () => {
  expect(transcriptMode(undefined)).toBe('full')
  expect(transcriptMode('focused')).toBe('focused')
  expect(() => transcriptMode('focus')).toThrow()
})
test('all real execution anchors are unique and injected only into their body', () => {
  for (const [file, names] of Object.entries(executionTargets)) {
    const source = readFileSync(resolve(import.meta.dir, '../renderer/src', file), 'utf8')
    const result = instrumentExecutions(source, file)
    for (const name of names) expect(result.split(`benchmarkCountExecution('${name}');`)).toHaveLength(2)
    expect(() => instrumentExecutions('', file)).toThrow('anchor drifted')
  }
})
test('counter snapshots are isolated and reset between scored windows', () => {
  resetBenchmarkObserver()
  benchmarkCountExecution('App')
  const snapshot = benchmarkObserverSnapshot()
  benchmarkCountExecution('App')
  expect(snapshot.executions.App).toBe(1)
  expect(benchmarkObserverSnapshot().executions.App).toBe(2)
  resetBenchmarkObserver()
  expect(benchmarkObserverSnapshot().executions).toEqual({})
})
test('CDP requires every scored metric and returns deltas, never lifetime totals', () => {
  const before = performanceMetricNames.map(name => ({ name, value: 10 }))
  const after = performanceMetricNames.map(name => ({ name, value: 12 }))
  expect(Object.values(performanceMetricDeltas(before, after))).toEqual([2, 2, 2, 2])
  expect(() => performanceMetricDeltas([], after)).toThrow()
})
test('extra workloads are opt-in, deterministic, and idle has no scored frames', () => {
  expect(manifest.workloads).toHaveLength(6)
  for (const workload of additionalWorkloads) {
    const fixture = createFixture(workload)
    expect(fixture.hash).toBe(createFixture(workload).hash)
    if (workload.id === 'idle-clock-8') expect(fixture.arrivals).toHaveLength(0)
    if (workload.id === 'completed-turn-history-8') expect(fixture.initial.some(frame => frame.kind === 'event' && frame.event.type === 'message' && frame.event.message.type === 'user')).toBe(true)
  }
})
test('runner retains profiles outside scratch and checks source stability after samples', () => {
  const runner = readFileSync(resolve(import.meta.dir, 'streaming-benchmark.ts'), 'utf8')
  expect(runner).toContain('copyFileSync(join(sample, \'renderer.cpuprofile\')')
  expect(runner).toContain("assertStableSources(hashesAfter, sourceHashes(), 'sampling')")
  expect(runner).toContain("['renderer', 'main', 'preload', 'shared']")
})

test('completed-turn fixture projects 120 completed work groups and a live tail per session', () => {
  const workload = additionalWorkloads.find(item => item.id === 'completed-turn-history-8')!
  const fixture = createFixture(workload)
  const state = projectServerFrames(createTranscriptState(), [
    ...fixture.initial, ...fixture.arrivals.filter(item => item.atMs < 100).map(item => item.frame),
  ])
  for (let session = 0; session < workload.sessions; session++) {
    const rows = selectNestedTranscriptRows(state, `benchmark-session-${session}`)
    const groups = deriveFocusedTranscript(rows, true).filter(item => item.kind === 'focused-turn')
    expect(groups).toHaveLength(121)
    expect(groups.filter(group => group.completed && !group.live)).toHaveLength(120)
    for (const group of groups.slice(0, 120)) {
      expect(group.rows.some(row => row.kind === 'thinking')).toBe(true)
      expect(group.rows.some(row => row.kind === 'tool-use' && row.status === 'success')).toBe(true)
    }
    expect(groups.at(-1)!.live).toBe(true)
    expect(groups.at(-1)!.completed).toBe(false)
  }
})
