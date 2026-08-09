import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildDiagnosticsBundle,
  deriveRecordingCoverage,
  parseDeliveryTraceRecord,
} from './diagnosticsBundle.js'

test('diagnostics bundle exports only closed operational and trace schemas', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-diagnostics-bundle-'))
  const logs = join(root, 'logs')
  mkdirSync(logs)
  writeFileSync(
    join(logs, 'operational-launch-1.jsonl'),
    `${JSON.stringify({
      version: 1, timestamp: '2026-08-06T00:00:00.000Z', level: 'info', event: 'app.start',
      launchId: 'launch', process: 'main', processInstanceId: 'process', pid: 123,
      processStartedAt: '2026-08-06T00:00:00.000Z', fields: { platform: 'test' },
    })}\n${JSON.stringify({ payload: 'must not be exported' })}\n`,
  )
  writeFileSync(
    join(logs, 'delivery-trace-launch-1.jsonl'),
    `${JSON.stringify({
      schemaVersion: 1, recordKind: 'delivery.trace', wallTimestamp: '2026-08-06T00:00:00.000Z',
      monotonicTimestampMs: 1, launchId: 'launch', component: 'engine', processName: 'bun-sidecar',
      processInstanceId: 'process', sessionId: 'session', streamEpoch: '018f0000-0000-4000-8000-000000000001', sequence: 1,
      traceId: '018f0000-0000-4000-8000-000000000002', deliveryAttempt: 1, replay: false, connectionEpoch: 1, frameKind: 'lifecycle', stage: 'engine.produced',
    })}\n${JSON.stringify({ recordKind: 'delivery.trace', content: 'must not be exported' })}\n`,
  )

  const bundle = JSON.parse(buildDiagnosticsBundle({
    logsDirectory: logs,
    appVersion: 'test',
    packaged: true,
    currentLaunchId: 'launch',
    buildId: '2026.08.06',
    commitId: 'abc1234',
  }))
  expect(bundle.streams.operational).toHaveLength(1)
  expect(bundle.streams.deliveryTrace).toHaveLength(1)
  expect(bundle.stuckSessions).toHaveLength(1)
  expect(bundle.stuckSessions[0].lastProducedFrameKind).toBe('lifecycle')
  expect(bundle.processInstances).toHaveLength(1)
  expect(bundle.processInstances[0]).toMatchObject({ pid: 123, status: 'observed' })
  // This asserted status 'incomplete' and an 'interrupted' launch only because
  // the call omitted currentLaunchId, so the live launch was misclassified. A
  // healthy in-progress export is active.
  expect(bundle.recordingCoverage).toMatchObject({
    status: 'active',
    launches: [{ launchId: 'launch', status: 'active' }],
  })
  expect(bundle.manifest).toMatchObject({
    build: { buildId: '2026.08.06', commitId: 'abc1234' },
    configuration: { packaged: true },
  })
  expect(JSON.stringify(bundle)).not.toContain('must not be exported')
})

test('second-pass trace parser rejects path-bearing stages and unbounded identifiers', () => {
  const base = {
    schemaVersion: 1, recordKind: 'delivery.trace', wallTimestamp: '2026-08-06T00:00:00.000Z', monotonicTimestampMs: 1,
    launchId: 'launch', component: 'engine', processName: 'bun-sidecar', processInstanceId: 'process', sessionId: 'session',
    streamEpoch: '018f0000-0000-4000-8000-000000000001', sequence: 1, traceId: '018f0000-0000-4000-8000-000000000002',
    deliveryAttempt: 1, replay: false, connectionEpoch: 1, frameKind: 'lifecycle', stage: 'engine.produced',
  }
  expect(parseDeliveryTraceRecord({ ...base, stage: '/Users/alice/secret' })).toBeNull()
  expect(parseDeliveryTraceRecord({ ...base, sessionId: '/var/db/private' })).toBeNull()
})

test('second-pass trace parser admits only a real frame kind', () => {
  const base = {
    schemaVersion: 1, recordKind: 'delivery.trace', wallTimestamp: '2026-08-06T00:00:00.000Z', monotonicTimestampMs: 1,
    launchId: 'launch', component: 'engine', processName: 'bun-sidecar', processInstanceId: 'process', sessionId: 'session',
    streamEpoch: '018f0000-0000-4000-8000-000000000001', sequence: 1, traceId: '018f0000-0000-4000-8000-000000000002',
    deliveryAttempt: 1, replay: false, connectionEpoch: 1, frameKind: 'lifecycle', stage: 'engine.produced',
  }
  expect(parseDeliveryTraceRecord(base)).not.toBeNull()
  // An identifier-shaped regex accepted any lowercase token here, so a project
  // or account label could be persisted and exported as a "frame kind".
  expect(parseDeliveryTraceRecord({ ...base, frameKind: 'acme-holdings-migration' })).toBeNull()
})

test('second-pass trace parser closes anomaly records, not only delivery stages', () => {
  const loss = {
    schemaVersion: 1, recordKind: 'trace.loss', wallTimestamp: '2026-08-06T00:00:00.000Z', monotonicTimestampMs: 1,
    launchId: 'launch', processName: 'electron-main', processInstanceId: 'process', sessionId: 'session',
    streamEpoch: '018f0000-0000-4000-8000-000000000001',
    sequenceStart: 1, sequenceEnd: 2, droppedCount: 1, reason: 'stream_evicted',
  }
  expect(parseDeliveryTraceRecord(loss)).not.toBeNull()
  // The opaque-id grammar ran only on the delivery.trace branch, so an anomaly
  // record carried a path or a free-form reason straight into the bundle.
  expect(parseDeliveryTraceRecord({ ...loss, processInstanceId: '/Users/alice/private' })).toBeNull()
  expect(parseDeliveryTraceRecord({ ...loss, launchId: '/var/db/private' })).toBeNull()
  expect(parseDeliveryTraceRecord({ ...loss, reason: 'https://example.com/private' })).toBeNull()
  expect(parseDeliveryTraceRecord({ ...loss, processName: 'whatever-i-like' })).toBeNull()
})

test('second-pass trace parser validates the sequence-anomaly expectation field', () => {
  const gap = {
    schemaVersion: 1, recordKind: 'trace.sequence.gap', wallTimestamp: '2026-08-06T00:00:00.000Z', monotonicTimestampMs: 1,
    launchId: 'launch', processName: 'electron-main', processInstanceId: 'process', sessionId: 'session',
    streamEpoch: '018f0000-0000-4000-8000-000000000001', sequence: 1, stage: 'engine.produced',
  }
  expect(parseDeliveryTraceRecord(gap)).not.toBeNull()
  expect(parseDeliveryTraceRecord({ ...gap, expectedSequence: 5 })).not.toBeNull()
  // The gap and out_of_order kinds allow this field, and no branch checked it,
  // so a rooted path in it was exported verbatim.
  expect(parseDeliveryTraceRecord({ ...gap, expectedSequence: '/Users/alice/private' })).toBeNull()
})

test('second-pass trace parser validates observation kind and anomaly scope', () => {
  const trace = {
    schemaVersion: 1, recordKind: 'delivery.trace', wallTimestamp: '2026-08-06T00:00:00.000Z', monotonicTimestampMs: 1,
    launchId: 'launch', component: 'renderer', processName: 'electron-renderer', processInstanceId: 'process', sessionId: 'session',
    streamEpoch: '018f0000-0000-4000-8000-000000000001', sequence: 1, traceId: '018f0000-0000-4000-8000-000000000002',
    deliveryAttempt: 1, replay: false, connectionEpoch: 1, stage: 'renderer.state.applied',
    observationKind: 'acknowledgement',
  }
  expect(parseDeliveryTraceRecord(trace)).not.toBeNull()
  expect(parseDeliveryTraceRecord({ ...trace, observationKind: 'action' })).toBeNull()

  const gap = {
    schemaVersion: 1, recordKind: 'trace.sequence.gap', wallTimestamp: '2026-08-06T00:00:00.000Z', monotonicTimestampMs: 1,
    launchId: 'launch', processName: 'electron-main', processInstanceId: 'process', sessionId: 'session',
    streamEpoch: '018f0000-0000-4000-8000-000000000001', sequence: 2, stage: 'engine.produced',
    expectedSequence: 1, observationKind: 'action', anomalyScope: 'source_sequence',
  }
  expect(parseDeliveryTraceRecord(gap)).not.toBeNull()
  expect(parseDeliveryTraceRecord({ ...gap, anomalyScope: 'stage_sequence' })).toBeNull()
})

test('recording coverage distinguishes known loss, active output, and interrupted launches', () => {
  const coverage = deriveRecordingCoverage(
    [
      { launchId: 'current', timestamp: '2026-08-06T01:00:00.000Z', event: 'app.start', fields: {} },
      { launchId: 'current', timestamp: '2026-08-06T01:01:00.000Z', event: 'log.suppressed', fields: { count: 3 } },
      { launchId: 'current', timestamp: '2026-08-06T01:02:00.000Z', event: 'log.coverage.incomplete', fields: {} },
      { launchId: 'prior', timestamp: '2026-08-06T00:00:00.000Z', event: 'app.start', fields: {} },
    ],
    [{ recordKind: 'trace.loss', droppedCount: 2 }],
    'current',
    { sourceWindowTruncated: true },
  )

  expect(coverage).toMatchObject({
    status: 'incomplete',
    lossObserved: true,
    operationalRecordsSuppressed: 3,
    deliveryTraceRecordsLost: 2,
    incompleteStreamCount: 1,
    sourceWindowTruncated: true,
    launches: [
      { launchId: 'current', status: 'active' },
      { launchId: 'prior', status: 'interrupted' },
    ],
  })
})

test('a source file larger than the export window is reported as truncated', () => {
  // The flag was only ever passed into deriveRecordingCoverage directly, so the
  // detection in buildDiagnosticsBundle could be deleted with the suite staying
  // green. This drives it from a real oversized file instead.
  const root = mkdtempSync(join(tmpdir(), 'cat-code-diagnostics-truncated-'))
  const logs = join(root, 'logs')
  mkdirSync(logs)
  const record = (index: number) => JSON.stringify({
    version: 1, timestamp: '2026-08-06T00:00:00.000Z', level: 'info', event: 'diagnostic',
    launchId: 'launch', process: 'main', processInstanceId: 'process', pid: index,
    processStartedAt: '2026-08-06T00:00:00.000Z', fields: { source: 'main', category: 'probe' },
  })
  const lines: string[] = []
  let bytes = 0
  while (bytes < 700 * 1024) {
    const line = record(lines.length + 1)
    lines.push(line)
    bytes += line.length + 1
  }
  writeFileSync(join(logs, 'operational-launch-1.jsonl'), `${lines.join('\n')}\n`)

  const bundle = JSON.parse(buildDiagnosticsBundle({
    logsDirectory: logs,
    appVersion: 'test',
    currentLaunchId: 'launch',
  }))
  expect(bundle.recordingCoverage.sourceWindowTruncated).toBe(true)
  expect(bundle.recordingCoverage.exportBounded).toBe(true)
})

test('an ordinary launch is not reported as incomplete, and real loss is not masked', () => {
  // status had four always-on triggers, so it read 'incomplete' for every real
  // export and 'loss_observed' was unreachable.
  const ordinary = [
    { launchId: 'L1', timestamp: '2026-08-09T12:00:00.000Z', event: 'app.start', fields: {} },
    { launchId: 'L1', timestamp: '2026-08-09T12:00:02.000Z', event: 'app.shutdown.completed', fields: {} },
  ]
  expect(deriveRecordingCoverage(ordinary, [], 'L1').status).toBe('complete')

  const withLoss = [...ordinary, {
    launchId: 'L1', timestamp: '2026-08-09T12:00:03.000Z', event: 'log.suppressed', fields: { count: 42 },
  }]
  expect(deriveRecordingCoverage(withLoss, [], 'L1').status).toBe('loss_observed')

  // A crash inside the retention window is history, not a verdict on today.
  const withOldCrash = [
    { launchId: 'OLD', timestamp: '2026-08-01T12:00:00.000Z', event: 'app.start', fields: {} },
    ...ordinary,
  ]
  const stale = deriveRecordingCoverage(withOldCrash, [], 'L1')
  expect(stale.status).toBe('complete')
  expect(stale.interruptedLaunchCount).toBe(1)

  // Missing evidence for the CURRENT launch still wins.
  const broken = [...ordinary, {
    launchId: 'L1', timestamp: '2026-08-09T12:00:04.000Z', event: 'log.coverage.incomplete',
    fields: { source: 'sidecar', reason: 'buffer_overflow', expected: false },
  }]
  expect(deriveRecordingCoverage(broken, [], 'L1').status).toBe('incomplete')
})

test('deliberate dedupe is not reported as lost evidence', () => {
  // Main collapses duplicates inside one second; the sidecar drops records it
  // cannot keep up with. Both used to emit log.suppressed with only a count, so
  // one counter meant two opposite things and lossObserved was true in any
  // ordinary run.
  const base = [
    { launchId: 'L1', timestamp: '2026-08-09T12:00:00.000Z', event: 'app.start', fields: {} },
    { launchId: 'L1', timestamp: '2026-08-09T12:00:02.000Z', event: 'app.shutdown.completed', fields: {} },
  ]
  const deduped = deriveRecordingCoverage([...base, {
    launchId: 'L1', timestamp: '2026-08-09T12:00:01.000Z', event: 'log.suppressed',
    fields: { count: 5937, reason: 'rate_dedupe' },
  }], [], 'L1')
  expect(deduped.status).toBe('complete')
  expect(deduped.lossObserved).toBe(false)
  expect(deduped.operationalRecordsDeduped).toBe(5937)

  const dropped = deriveRecordingCoverage([...base, {
    launchId: 'L1', timestamp: '2026-08-09T12:00:01.000Z', event: 'log.suppressed',
    fields: { count: 12, reason: 'queue_saturated' },
  }], [], 'L1')
  expect(dropped.status).toBe('loss_observed')
  expect(dropped.operationalRecordsSuppressed).toBe(12)
})
