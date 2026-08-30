import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildDiagnosticsBundle,
  deriveProcessInstances,
  deriveRecordingCoverage,
  deriveStuckSessionSummaries,
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
  expect(bundle.stuckSessions).toEqual([])
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

test('second-pass trace parser keeps a real message kind and admits no other', () => {
  const base = {
    schemaVersion: 1, recordKind: 'delivery.trace', wallTimestamp: '2026-08-06T00:00:00.000Z', monotonicTimestampMs: 1,
    launchId: 'launch', component: 'host', processName: 'electron-main', processInstanceId: 'process', sessionId: 'session',
    streamEpoch: '018f0000-0000-4000-8000-000000000001', sequence: 1, traceId: '018f0000-0000-4000-8000-000000000002',
    deliveryAttempt: 1, replay: false, connectionEpoch: 1, frameKind: 'event', stage: 'host.received',
  }
  // An unlisted key is dropped by the whole record, so a field the producer
  // writes but the export schema never learned costs the record its export.
  expect(parseDeliveryTraceRecord({ ...base, messageKind: 'result' })).toMatchObject({ messageKind: 'result' })
  expect(parseDeliveryTraceRecord({ ...base, messageKind: 'assistant' })).not.toBeNull()
  expect(parseDeliveryTraceRecord(base)).not.toBeNull()
  expect(parseDeliveryTraceRecord({ ...base, messageKind: 'acme-holdings-migration' })).toBeNull()
  expect(parseDeliveryTraceRecord({ ...base, messageKind: '/Users/alice/secret' })).toBeNull()
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

const ROLLUP = {
  schemaVersion: 1, recordKind: 'trace.stream.rollup', wallTimestamp: '2026-08-06T00:00:00.000Z',
  monotonicTimestampMs: 1, launchId: 'launch', processName: 'electron-main', processInstanceId: 'process',
  sessionId: 'session', streamEpoch: '018f0000-0000-4000-8000-000000000001', sequence: 6,
  quietMs: 60000, lastMessageKind: 'assistant', deliveryStatus: 'complete',
  produced: 6, socketSent: 6, socketReceived: 6, hostReceived: 6, ipcSent: 6,
  preloadReceived: 6, applied: 0, committed: 0,
}

test('second-pass trace parser closes the stream rollup and its watermarks', () => {
  // Without the allowlist entry the whole record is rejected from every export,
  // so the lane that exists to outlive rotation would reach no bundle at all.
  expect(parseDeliveryTraceRecord(ROLLUP)).not.toBeNull()
  expect(parseDeliveryTraceRecord({ ...ROLLUP, 'trace.sequence.gap': 2, traceLossCount: 9 })).not.toBeNull()
  // A stream whose frames carried no SDK message has no tag to report, unlike
  // the quiescence record, which is only written for a stream that had one.
  expect(parseDeliveryTraceRecord(withoutKey(ROLLUP, 'lastMessageKind'))).not.toBeNull()
  expect(parseDeliveryTraceRecord({ ...ROLLUP, deliveryStatus: 'incomplete', stage: 'preload.received' })).not.toBeNull()

  expect(parseDeliveryTraceRecord({ ...ROLLUP, deliveryStatus: 'incomplete' })).toBeNull()
  expect(parseDeliveryTraceRecord({ ...ROLLUP, stage: 'preload.received' })).toBeNull()
  expect(parseDeliveryTraceRecord({ ...ROLLUP, lastMessageKind: 'acme-holdings-migration' })).toBeNull()
  expect(parseDeliveryTraceRecord({ ...ROLLUP, deliveryStatus: 'stalled-probably' })).toBeNull()
  // A watermark is a count, so zero is a real answer and a path is not one.
  expect(parseDeliveryTraceRecord({ ...ROLLUP, applied: '/Users/alice/secret' })).toBeNull()
  expect(parseDeliveryTraceRecord({ ...ROLLUP, committed: -1 })).toBeNull()
  expect(parseDeliveryTraceRecord(withoutKey(ROLLUP, 'produced'))).toBeNull()
  expect(parseDeliveryTraceRecord({ ...ROLLUP, 'trace.sequence.gap': 'many' })).toBeNull()
  expect(parseDeliveryTraceRecord({ ...ROLLUP, sessionCwd: '/Users/alice' })).toBeNull()
})

function withoutKey(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _dropped, ...rest } = record
  return rest
}

test('a rollup reaches the bundle even when per-frame records fill the export budget', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-diagnostics-rollup-budget-'))
  const logs = join(root, 'logs')
  mkdirSync(logs)
  writeFileSync(join(logs, 'delivery-rollup-launch-1.jsonl'), `${JSON.stringify(ROLLUP)}\n`)
  // Three full trace files, more than the general admission budget holds, and
  // all newer than the rollup so they are read first. This is the ordinary
  // state of the log directory under load, not a contrived one.
  const frame = (sequence: number) => JSON.stringify({
    schemaVersion: 1, recordKind: 'delivery.trace', wallTimestamp: '2026-08-06T00:00:01.000Z',
    monotonicTimestampMs: 1, launchId: 'launch', component: 'host', processName: 'electron-main',
    processInstanceId: 'process', sessionId: 'session', streamEpoch: '018f0000-0000-4000-8000-000000000001',
    sequence, traceId: '018f0000-0000-4000-8000-000000000002', deliveryAttempt: 1, replay: false,
    connectionEpoch: 1, frameKind: 'event', messageKind: 'assistant', stage: 'host.received',
  })
  for (const index of [1, 2, 3]) {
    const lines: string[] = []
    for (let sequence = 1; sequence <= 2000; sequence++) lines.push(frame(sequence))
    writeFileSync(join(logs, `delivery-trace-launch-${index}.jsonl`), `${lines.join('\n')}\n`)
  }
  // Older than the trace files so those are read first, but still inside the
  // retention window the bundle filters on. An absolute date here ages out of
  // that window on its own and turns this into a failure with no code change.
  const older = new Date(Date.now() - 60_000)
  utimesSync(join(logs, 'delivery-rollup-launch-1.jsonl'), older, older)

  const bundle = JSON.parse(buildDiagnosticsBundle({ logsDirectory: logs, appVersion: 'test', currentLaunchId: 'launch' }))
  expect(bundle.recordingCoverage.bundleLimitReached).toBe(true)
  expect(bundle.manifest.recordCounts.deliveryRollup).toBe(1)
  expect(bundle.streams.deliveryRollup[0]).toMatchObject({ recordKind: 'trace.stream.rollup', sequence: 6 })
  expect(bundle.manifest.limits.deliveryRollup.totalBytes).toBeLessThan(bundle.manifest.limits.deliveryTrace.totalBytes)
})

const LOSS = {
  schemaVersion: 1, recordKind: 'trace.loss', wallTimestamp: '2026-08-06T00:00:00.000Z',
  monotonicTimestampMs: 1, launchId: 'launch', processName: 'electron-main', processInstanceId: 'process',
  sessionId: 'session', streamEpoch: '018f0000-0000-4000-8000-000000000001',
  sequenceStart: 1, sequenceEnd: 4, droppedCount: 4, reason: 'stream_evicted',
}

test('a surviving rollup is enough for the bundle to report observed loss', () => {
  // Coverage saw only the detailed lane, so once the per-frame files rotated
  // away the bundle reported no loss beside a rollup that asserted nine.
  const root = mkdtempSync(join(tmpdir(), 'cat-code-diagnostics-rollup-loss-'))
  const logs = join(root, 'logs')
  mkdirSync(logs)
  writeFileSync(join(logs, 'delivery-rollup-launch-1.jsonl'), `${JSON.stringify({ ...ROLLUP, traceLossCount: 9 })}\n`)

  const bundle = JSON.parse(buildDiagnosticsBundle({ logsDirectory: logs, appVersion: 'test', currentLaunchId: 'launch' }))
  expect(bundle.streams.deliveryTrace).toEqual([])
  expect(bundle.recordingCoverage).toMatchObject({
    status: 'loss_observed',
    lossObserved: true,
    deliveryTraceRecordsLost: 9,
  })
})

test('a rollup and the loss records it summarizes are not counted twice', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-diagnostics-rollup-loss-both-'))
  const logs = join(root, 'logs')
  mkdirSync(logs)
  writeFileSync(join(logs, 'delivery-rollup-launch-1.jsonl'), `${JSON.stringify({ ...ROLLUP, traceLossCount: 9 })}\n`)
  // The same nine, told from the other end: a rollup's count is cumulative for
  // its stream, each loss record covers one batch of it.
  writeFileSync(
    join(logs, 'delivery-trace-launch-1.jsonl'),
    `${JSON.stringify(LOSS)}\n${JSON.stringify({ ...LOSS, sequenceStart: 5, sequenceEnd: 9, droppedCount: 5 })}\n`,
  )

  const bundle = JSON.parse(buildDiagnosticsBundle({ logsDirectory: logs, appVersion: 'test', currentLaunchId: 'launch' }))
  expect(bundle.streams.deliveryTrace).toHaveLength(2)
  expect(bundle.recordingCoverage.deliveryTraceRecordsLost).toBe(9)

  // A second stream is separate evidence and still adds, and so does a loss no
  // stream owns: no rollup ever counted it.
  const other = { ...ROLLUP, sessionId: 'other', traceLossCount: 2 }
  const orphan = { recordKind: 'trace.loss', droppedCount: 4 }
  expect(deriveRecordingCoverage(
    [],
    [{ ...ROLLUP, traceLossCount: 9 }, LOSS, other, orphan],
    'launch',
  ).deliveryTraceRecordsLost).toBe(15)
})

test('second-pass trace parser closes the quiescence record and its verdict', () => {
  const quiet = {
    schemaVersion: 1, recordKind: 'trace.stream.quiescent', wallTimestamp: '2026-08-06T00:00:00.000Z',
    monotonicTimestampMs: 1, launchId: 'launch', processName: 'electron-main', processInstanceId: 'process',
    sessionId: 'session', streamEpoch: '018f0000-0000-4000-8000-000000000001', sequence: 6,
    quietMs: 420000, lastMessageKind: 'assistant', deliveryStatus: 'complete',
  }
  // Without the allowlist entry the whole record is rejected from every export,
  // so the one record written for a stall would never reach a bundle.
  expect(parseDeliveryTraceRecord(quiet)).not.toBeNull()
  expect(parseDeliveryTraceRecord({ ...quiet, deliveryStatus: 'incomplete', stage: 'preload.received' })).not.toBeNull()
  expect(parseDeliveryTraceRecord({ ...quiet, deliveryStatus: 'incomplete' })).toBeNull()
  expect(parseDeliveryTraceRecord({ ...quiet, stage: 'preload.received' })).toBeNull()
  expect(parseDeliveryTraceRecord({ ...quiet, deliveryStatus: 'incomplete', stage: '/Users/alice/secret' })).toBeNull()
  expect(parseDeliveryTraceRecord({ ...quiet, lastMessageKind: 'acme-holdings-migration' })).toBeNull()
  expect(parseDeliveryTraceRecord({ ...quiet, deliveryStatus: 'stalled-probably' })).toBeNull()
  expect(parseDeliveryTraceRecord({ ...quiet, quietMs: -1 })).toBeNull()
})

test('only an unresolved quiescent episode is exported as a stuck session', () => {
  const base = {
    schemaVersion: 1, recordKind: 'delivery.trace', wallTimestamp: '2026-08-06T00:00:00.000Z', monotonicTimestampMs: 1,
    launchId: 'launch', component: 'host', processName: 'electron-main', processInstanceId: 'process',
    sessionId: 'session', streamEpoch: '018f0000-0000-4000-8000-000000000001',
    traceId: '018f0000-0000-4000-8000-000000000002', deliveryAttempt: 1, replay: false, connectionEpoch: 1,
    frameKind: 'event',
  }
  const records = [
    'engine.produced', 'host.received', 'main.ipc.sent', 'preload.received',
    'renderer.state.applied',
  ].map(stage => ({ ...base, sequence: 1, stage }))
  expect(deriveStuckSessionSummaries(records)).toEqual([])

  const quiet = {
    schemaVersion: 1, recordKind: 'trace.stream.quiescent', wallTimestamp: '2026-08-06T00:06:00.000Z',
    monotonicTimestampMs: 360_000, launchId: 'launch', processName: 'electron-main', processInstanceId: 'process',
    sessionId: 'session', streamEpoch: base.streamEpoch, sequence: 1, quietMs: 360_000,
    lastMessageKind: 'assistant', deliveryStatus: 'complete',
  }
  expect(deriveStuckSessionSummaries([...records, quiet])[0]).toMatchObject({
    firstMissingStage: null,
    applied: 1,
    committed: 0,
  })

  const result = {
    ...base,
    wallTimestamp: '2026-08-06T00:07:00.000Z',
    sequence: 2,
    stage: 'renderer.state.applied',
    messageKind: 'result',
  }
  expect(deriveStuckSessionSummaries([...records, quiet, result])).toEqual([])
})

test('a host-only session title is not a downstream hole in an exported stuck summary', () => {
  const base = {
    schemaVersion: 1, recordKind: 'delivery.trace', wallTimestamp: '2026-08-06T00:00:00.000Z', monotonicTimestampMs: 1,
    launchId: 'launch', component: 'host', processName: 'electron-main', processInstanceId: 'process',
    sessionId: 'session', streamEpoch: '018f0000-0000-4000-8000-000000000001',
    traceId: '018f0000-0000-4000-8000-000000000002', deliveryAttempt: 1, replay: false, connectionEpoch: 1,
  }
  const title = [
    'engine.produced', 'sidecar.socket.sent', 'supervisor.socket.received', 'host.received',
  ].map(stage => ({ ...base, sequence: 1, stage, frameKind: 'session-title' }))
  const assistant = [
    'engine.produced', 'sidecar.socket.sent', 'supervisor.socket.received', 'host.received',
    'main.ipc.sent', 'preload.received', 'renderer.state.applied',
  ].map(stage => ({ ...base, sequence: 2, stage, frameKind: 'event', messageKind: 'assistant' }))
  const quiet = {
    schemaVersion: 1, recordKind: 'trace.stream.quiescent', wallTimestamp: '2026-08-06T00:06:00.000Z',
    monotonicTimestampMs: 360_000, launchId: 'launch', processName: 'electron-main', processInstanceId: 'process',
    sessionId: 'session', streamEpoch: base.streamEpoch, sequence: 2, quietMs: 360_000,
    lastMessageKind: 'assistant', deliveryStatus: 'complete',
  }

  expect(deriveStuckSessionSummaries([...title, ...assistant, quiet])[0]).toMatchObject({
    firstMissingStage: null,
    watermarks: {
      produced: 2,
      socketSent: 2,
      hostReceived: 2,
      ipcSent: 2,
      preloadReceived: 2,
      applied: 2,
      committed: 0,
    },
  })
})

test('an exited process keeps its exit whatever order its records arrive in', () => {
  const started = {
    version: 1, timestamp: '2026-08-06T00:00:00.000Z', level: 'info', event: 'process.started',
    launchId: 'launch', process: 'worker', processInstanceId: 'worker', pid: 4242,
    processStartedAt: '2026-08-06T00:00:00.000Z', fields: { role: 'catalog', pid: 4242 },
  }
  const exited = {
    version: 1, timestamp: '2026-08-06T00:05:00.000Z', level: 'error', event: 'process.exited',
    launchId: 'launch', process: 'worker', processInstanceId: 'worker', pid: 4242,
    processStartedAt: '2026-08-06T00:00:00.000Z',
    fields: { role: 'catalog', exitCode: 9, signal: 'SIGKILL', expected: false },
  }
  const timeline = {
    processInstanceId: 'worker', role: 'worker', pid: 4242,
    startedAt: '2026-08-06T00:00:00.000Z', lastObservedAt: '2026-08-06T00:05:00.000Z',
    lastEvent: 'process.exited', status: 'exited', exitCode: 9, signal: 'SIGKILL', expected: false,
  }
  // Newest first is the order the export actually produces, since it reads each
  // file's tail in reverse. Rebuilding the summary from the current record let
  // the older start overwrite the exit that had already been seen, leaving a row
  // that read 'exited' with no exit code and 'process.started' as its last event.
  expect(deriveProcessInstances([exited, started], [])).toEqual([timeline])
  // Oldest first proves the fix is order-independent rather than merely flipped.
  expect(deriveProcessInstances([started, exited], [])).toEqual([timeline])
})
