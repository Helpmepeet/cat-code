import { expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mintDeliveryTrace } from '../shared/deliveryTrace.js'
import { createDeliveryTraceSink } from './deliveryTraceSink.js'

test('delivery trace persists metadata-only stages under private permissions', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-delivery-trace-'))
  const sink = createDeliveryTraceSink({ configDir: root, launchId: 'launch' })
  const trace = mintDeliveryTrace(1, 'stream')
  sink.mark({ sessionId: 'session', trace, stage: 'engine.produced' })
  sink.mark({ sessionId: 'session', trace, stage: 'main.ipc.sent' })
  expect(sink.accepts('session', 'stream', 1, 'doc', 1)).toBe(true)
  expect(sink.summary('session')).toMatchObject({
    produced: 1,
    ipcSent: 1,
    preloadReceived: 0,
    applied: 0,
    committed: 0,
    // Nothing was marked at the socket, so sequence 1 is still outstanding as
    // far as frame arrival is concerned. A source marker alone cannot say a
    // frame arrived.
    nextExpected: 1,
  })
  sink.close()
  const dir = join(root, 'logs')
  expect(statSync(dir).mode & 0o777).toBe(0o700)
  const traceFile = readdirSync(dir).find(name => name.startsWith('delivery-trace-'))
  expect(traceFile).toBeDefined()
  expect(readFileSync(join(dir, traceFile as string), 'utf8')).not.toContain('event')
  expect(readdirSync(dir)).toContain('latest-delivery')
})

/** Every record the sink wrote, in order. */
function recordsWritten(root: string): Array<Record<string, unknown>> {
  const file = readdirSync(join(root, 'logs')).find(name => name.startsWith('delivery-trace-'))!
  return readFileSync(join(root, 'logs', file), 'utf8').trim().split('\n').map(line => JSON.parse(line))
}

function kinds(root: string, recordKind: string): Array<Record<string, unknown>> {
  return recordsWritten(root).filter(record => record.recordKind === recordKind)
}

test('a hole in the sidecar markers is reported as missing evidence, not a missing frame', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-delivery-trace-fd3-loss-'))
  const sink = createDeliveryTraceSink({ configDir: root, launchId: 'launch' })
  // The FD 3 queue shed the markers for sequences 2 and 3 while every frame
  // still crossed the socket. This is the 2026-08-09 incident in miniature.
  for (const sequence of [1, 2, 3, 4]) {
    const trace = mintDeliveryTrace(sequence, 'stream')
    if (sequence === 1 || sequence === 4) sink.mark({ sessionId: 'session', trace, stage: 'engine.produced' })
    sink.mark({ sessionId: 'session', trace, stage: 'supervisor.socket.received' })
    sink.mark({ sessionId: 'session', trace, stage: 'host.received' })
  }
  sink.close()

  expect(kinds(root, 'trace.sequence.gap')).toEqual([])
  expect(kinds(root, 'trace.source.incomplete')).toMatchObject([{
    stage: 'engine.produced',
    sequence: 4,
    expectedSequence: 2,
    observationKind: 'action',
    anomalyScope: 'stage_sequence',
  }])
  // The source watermark stays honestly pinned; frame continuity is intact.
  expect(sink.summary('session')).toMatchObject({ produced: 1, socketReceived: 4, nextExpected: 5 })
})

test('a frame that never crossed the socket is still reported as a sequence gap', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-delivery-trace-frame-loss-'))
  const sink = createDeliveryTraceSink({ configDir: root, launchId: 'launch' })
  for (const sequence of [1, 3]) {
    const trace = mintDeliveryTrace(sequence, 'stream')
    sink.mark({ sessionId: 'session', trace, stage: 'engine.produced' })
    sink.mark({ sessionId: 'session', trace, stage: 'supervisor.socket.received' })
  }
  sink.close()

  expect(kinds(root, 'trace.sequence.gap')).toMatchObject([{
    stage: 'supervisor.socket.received',
    sequence: 3,
    expectedSequence: 2,
    anomalyScope: 'source_sequence',
  }])
})

test('one hole costs one anomaly record however many frames follow it', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-delivery-trace-pinned-'))
  const sink = createDeliveryTraceSink({ configDir: root, launchId: 'launch' })
  sink.mark({ sessionId: 'session', trace: mintDeliveryTrace(1, 'stream'), stage: 'supervisor.socket.received' })
  // Sequence 2 never arrives, so the watermark pins and every later frame is
  // beyond it. Before the split this emitted one record per frame forever.
  for (let sequence = 3; sequence <= 40; sequence++) {
    sink.mark({ sessionId: 'session', trace: mintDeliveryTrace(sequence, 'stream'), stage: 'supervisor.socket.received' })
  }
  sink.close()

  expect(kinds(root, 'trace.sequence.gap')).toHaveLength(1)
})

test('a pinned source watermark no longer accuses the sidecar of a stall', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-delivery-trace-attribution-'))
  const sink = createDeliveryTraceSink({ configDir: root, launchId: 'launch' })
  // Frames 1..3 all arrive and reach the IPC bridge; the renderer never
  // acknowledges them. The FD 3 queue shed the `sidecar.socket.sent` markers
  // for 2 and 3 but kept their `engine.produced` ones, which is precisely the
  // shape that used to make `produced > socketSent` accuse the sidecar.
  for (const sequence of [1, 2, 3]) {
    const trace = mintDeliveryTrace(sequence, 'stream')
    sink.mark({ sessionId: 'session', trace, stage: 'engine.produced' })
    if (sequence === 1) sink.mark({ sessionId: 'session', trace, stage: 'sidecar.socket.sent' })
    for (const stage of ['supervisor.socket.received', 'host.received', 'main.ipc.sent'] as const) {
      sink.mark({ sessionId: 'session', trace, stage })
    }
  }
  expect(sink.stuckSessionSummaries()[0]?.firstMissingStage).toBe('preload.received')
  sink.close()
})

test('source markers that outrun the socket still accuse the transport', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-delivery-trace-transport-'))
  const sink = createDeliveryTraceSink({ configDir: root, launchId: 'launch' })
  // FD 3 loss only ever depresses these watermarks, so a source stage that
  // still outruns arrival is trustworthy evidence the frame never landed.
  for (const sequence of [1, 2]) {
    const trace = mintDeliveryTrace(sequence, 'stream')
    sink.mark({ sessionId: 'session', trace, stage: 'engine.produced' })
    sink.mark({ sessionId: 'session', trace, stage: 'sidecar.socket.sent' })
  }
  expect(sink.stuckSessionSummaries()[0]?.firstMissingStage).toBe('supervisor.socket.received')
  sink.close()
})

test('a sidecar that produced but never sent is still named', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-delivery-trace-unsent-'))
  const sink = createDeliveryTraceSink({ configDir: root, launchId: 'launch' })
  sink.mark({ sessionId: 'session', trace: mintDeliveryTrace(1, 'stream'), stage: 'engine.produced' })
  expect(sink.stuckSessionSummaries()[0]?.firstMissingStage).toBe('sidecar.socket.sent')
  sink.close()
})

test('a repeated stage observation is still recorded as a duplicate', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-delivery-trace-anomaly-'))
  const sink = createDeliveryTraceSink({ configDir: root, launchId: 'launch' })
  const trace = mintDeliveryTrace(1, 'stream')
  sink.mark({ sessionId: 'session', trace, stage: 'engine.produced' })
  sink.mark({ sessionId: 'session', trace, stage: 'engine.produced' })
  sink.close()

  expect(kinds(root, 'trace.sequence.duplicate')).toMatchObject([{
    stage: 'engine.produced',
    observationKind: 'action',
    anomalyScope: 'stage_sequence',
  }])
})

test('delivery stages say whether main observed an action or received an acknowledgement', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-delivery-trace-observation-'))
  const sink = createDeliveryTraceSink({ configDir: root, launchId: 'launch' })
  const trace = mintDeliveryTrace(1, 'stream')
  sink.mark({ sessionId: 'session', trace, stage: 'main.ipc.sent' })
  sink.mark({ sessionId: 'session', trace, stage: 'renderer.state.applied' })
  sink.close()

  const file = readdirSync(join(root, 'logs')).find(name => name.startsWith('delivery-trace-'))!
  const records = readFileSync(join(root, 'logs', file), 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
    .filter(record => record.recordKind === 'delivery.trace')
  expect(records.map(record => [record.stage, record.observationKind])).toEqual([
    ['main.ipc.sent', 'action'],
    ['renderer.state.applied', 'acknowledgement'],
  ])
})

test('contiguous acknowledgements expose an earlier missing frame despite a later complete frame', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-delivery-trace-contiguous-'))
  const sink = createDeliveryTraceSink({ configDir: root, launchId: 'launch' })
  const first = mintDeliveryTrace(1, 'stream')
  const second = mintDeliveryTrace(2, 'stream')
  for (const stage of ['engine.produced', 'sidecar.socket.sent', 'host.received', 'main.ipc.sent'] as const) sink.mark({ sessionId: 'session', trace: first, stage })
  for (const stage of ['engine.produced', 'sidecar.socket.sent', 'host.received', 'main.ipc.sent', 'preload.received', 'renderer.state.applied', 'renderer.ui.committed'] as const) sink.mark({ sessionId: 'session', trace: second, stage })
  expect(sink.summary('session')).toMatchObject({ produced: 2, ipcSent: 2, preloadReceived: 0, applied: 0, committed: 0 })
  expect(sink.stuckSessionSummaries()[0]?.firstMissingStage).toBe('preload.received')
  sink.close()
})

test('delivery acknowledgement lookup cannot cross a recreated stream epoch', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-delivery-trace-epoch-'))
  const sink = createDeliveryTraceSink({ configDir: root, launchId: 'launch' })
  const first = mintDeliveryTrace(1, 'old-stream')
  const second = mintDeliveryTrace(1, 'new-stream')
  sink.mark({ sessionId: 'session', trace: first, stage: 'engine.produced' })
  sink.mark({ sessionId: 'session', trace: second, stage: 'engine.produced' })
  expect(sink.traceFor('session', 'old-stream', 1)?.traceId).toBe(first.traceId)
  expect(sink.traceFor('session', 'new-stream', 1)?.traceId).toBe(second.traceId)
  expect(sink.accepts('session', 'unknown-stream', 1, 'doc', 1)).toBe(false)
  sink.close()
})
