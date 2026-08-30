import { expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mintDeliveryTrace } from '../shared/deliveryTrace.js'
import { PROTOCOL_VERSION, type ServerFrame } from '../shared/protocol.js'
import { SDK_MESSAGE_FIXTURE } from '../renderer/src/sdkMessageFixtures.js'
import {
  createDeliveryTraceSink, deliveryMessageKindOfFrame,
  MAX_DELIVERY_TRACE_SEQUENCES_PER_STREAM, MAX_DELIVERY_TRACE_STREAMS,
} from './deliveryTraceSink.js'

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

test('a produced frame that never arrived is not attributed to a hop it cannot be traced to', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-delivery-trace-unsent-'))
  const sink = createDeliveryTraceSink({ configDir: root, launchId: 'launch' })
  sink.mark({ sessionId: 'session', trace: mintDeliveryTrace(1, 'stream'), stage: 'engine.produced' })
  // This used to answer `sidecar.socket.sent`. The frame really did not reach
  // main, but the send marker rides FD 3, so its absence is equally explained by
  // a shed marker on a frame lost in transit. The watermarks beside this still
  // say precisely what arrived and what did not.
  expect(sink.stuckSessionSummaries()[0]?.firstMissingStage).toBe('unknown')
  expect(sink.stuckSessionSummaries()[0]?.watermarks).toMatchObject({ produced: 1, socketReceived: 0 })
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

test('a host-only session title does not pin renderer delivery watermarks', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-delivery-trace-host-only-'))
  const sink = createDeliveryTraceSink({ configDir: root, launchId: 'launch', sweepIntervalMs: 0 })
  const title = mintDeliveryTrace(1, 'stream')
  for (const stage of ['engine.produced', 'sidecar.socket.sent', 'supervisor.socket.received', 'host.received'] as const) {
    sink.mark({ sessionId: 'session', trace: title, stage, frameKind: 'session-title' })
  }
  const result = mintDeliveryTrace(2, 'stream')
  for (const stage of [
    'engine.produced', 'sidecar.socket.sent', 'supervisor.socket.received', 'host.received',
    'main.ipc.sent', 'preload.received', 'renderer.state.applied',
  ] as const) {
    sink.mark({ sessionId: 'session', trace: result, stage, frameKind: 'event', messageKind: 'result' })
  }

  expect(sink.summary('session')).toMatchObject({
    produced: 2,
    hostReceived: 2,
    ipcSent: 2,
    preloadReceived: 2,
    applied: 2,
    committed: 0,
  })
  sink.emitStreamRollups()
  expect(laneRecords(root, 'delivery-rollup-')[0]).toMatchObject({
    deliveryStatus: 'complete',
    produced: 2,
    hostReceived: 2,
    ipcSent: 2,
    preloadReceived: 2,
    applied: 2,
    committed: 0,
  })
  sink.close()
})

/**
 * A frame the way main holds it at a trace site, carrying a real engine message
 * out of the exhaustive SDK fixture rather than an invented shape.
 */
function messageFrame(message: (typeof SDK_MESSAGE_FIXTURE)['assistant'][number]['message'] | (typeof SDK_MESSAGE_FIXTURE)['result'][number]['message']): ServerFrame {
  return { kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'session', event: { type: 'message', message } }
}

const ASSISTANT_FRAME = messageFrame(SDK_MESSAGE_FIXTURE.assistant[0]!.message)
const RESULT_FRAME = messageFrame(SDK_MESSAGE_FIXTURE.result[0]!.message)

/** Trace one frame through the stages main marks for it, as `traceFrame` does. */
function traceThroughMain(sink: ReturnType<typeof createDeliveryTraceSink>, sequence: number, frame: ServerFrame): void {
  const trace = mintDeliveryTrace(sequence, 'stream')
  for (const stage of ['supervisor.socket.received', 'host.received', 'main.ipc.sent'] as const) {
    sink.mark({
      sessionId: 'session',
      trace,
      stage,
      frameKind: frame.kind,
      messageKind: deliveryMessageKindOfFrame(frame),
    })
  }
}

test('a traced run says which of its frames carried a result', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-delivery-trace-message-kind-'))
  const sink = createDeliveryTraceSink({ configDir: root, launchId: 'launch' })
  traceThroughMain(sink, 1, ASSISTANT_FRAME)
  traceThroughMain(sink, 2, ASSISTANT_FRAME)
  traceThroughMain(sink, 3, RESULT_FRAME)
  sink.close()

  // Every conversation frame is `frameKind: 'event'`, which is why the envelope
  // discriminant alone could not answer this.
  const records = kinds(root, 'delivery.trace')
  expect(new Set(records.map(record => record.frameKind))).toEqual(new Set(['event']))
  // The tag rides every stage record for its sequence, not only the first mark.
  expect(records.filter(record => record.messageKind === 'result').map(record => record.stage)).toEqual([
    'supervisor.socket.received', 'host.received', 'main.ipc.sent',
  ])
  expect([...new Set(records.map(record => `${record.sequence}:${record.messageKind}`))]).toEqual([
    '1:assistant', '2:assistant', '3:result',
  ])
})

test('a run that never produced a result is distinguishable from an untagged one', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-delivery-trace-no-result-'))
  const sink = createDeliveryTraceSink({ configDir: root, launchId: 'launch' })
  // The 2026-08-10 hang in miniature: six frames deliver perfectly and the turn
  // never ends. A reader must be able to say the result is ABSENT, which needs
  // the surviving frames to be positively tagged as something else.
  for (let sequence = 1; sequence <= 6; sequence++) traceThroughMain(sink, sequence, ASSISTANT_FRAME)
  sink.close()

  const records = kinds(root, 'delivery.trace')
  expect(records.every(record => record.messageKind === 'assistant')).toBe(true)
  expect(records.some(record => record.messageKind === 'result')).toBe(false)
})

test('frames carrying no SDK message get no message kind at all', () => {
  const lifecycle: ServerFrame = {
    kind: 'lifecycle', protocolVersion: PROTOCOL_VERSION, sessionId: 'session', status: 'exited',
  }
  const turnStatus: ServerFrame = {
    kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'session',
    event: { type: 'turn.status', activeTurn: true },
  }
  expect(deliveryMessageKindOfFrame(lifecycle)).toBeUndefined()
  expect(deliveryMessageKindOfFrame(turnStatus)).toBeUndefined()
  expect(deliveryMessageKindOfFrame(RESULT_FRAME)).toBe('result')

  const root = mkdtempSync(join(tmpdir(), 'cat-code-delivery-trace-untagged-'))
  const sink = createDeliveryTraceSink({ configDir: root, launchId: 'launch' })
  traceThroughMain(sink, 1, turnStatus)
  sink.close()
  expect(kinds(root, 'delivery.trace').every(record => !('messageKind' in record))).toBe(true)
})

test('a message kind outside the closed vocabulary is never persisted', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-delivery-trace-message-kind-gate-'))
  const sink = createDeliveryTraceSink({ configDir: root, launchId: 'launch' })
  sink.mark({
    sessionId: 'session',
    trace: mintDeliveryTrace(1, 'stream'),
    stage: 'host.received',
    frameKind: 'event',
    messageKind: 'acme-holdings-migration',
  })
  sink.close()
  expect(kinds(root, 'delivery.trace').every(record => !('messageKind' in record))).toBe(true)
})

/** A sink whose clock and sweep the test drives; no real interval is armed. */
function quiescenceSink(root: string, clock: { ms: number }) {
  return createDeliveryTraceSink({
    configDir: root,
    launchId: 'launch',
    quietMs: 300_000,
    sweepIntervalMs: 0,
    monotonicNow: () => clock.ms,
  })
}

test('a stream that stops mid-turn is reported once, and says the pipeline delivered everything', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-delivery-trace-quiescent-'))
  const clock = { ms: 0 }
  const sink = quiescenceSink(root, clock)
  // The 2026-08-10 shape exactly: assistant frames deliver end to end, the
  // `result` never comes, and every arrival-driven detector above stays silent
  // because there is no later frame to fire on.
  for (const sequence of [1, 2, 3]) {
    const trace = mintDeliveryTrace(sequence, 'stream')
    for (const stage of ['engine.produced', 'sidecar.socket.sent', 'supervisor.socket.received', 'host.received', 'main.ipc.sent', 'preload.received', 'renderer.state.applied', 'renderer.ui.committed'] as const) {
      sink.mark({ sessionId: 'session', trace, stage, frameKind: 'event', messageKind: deliveryMessageKindOfFrame(ASSISTANT_FRAME) })
    }
  }
  clock.ms = 299_000
  sink.sweepQuiescentStreams()
  expect(kinds(root, 'trace.stream.quiescent')).toEqual([])

  clock.ms = 420_000
  sink.sweepQuiescentStreams()
  // Repeating the sweep is what a duration-scaled record would do. One quiet
  // episode costs one record (OBSERVABILITY-MINIMUM.md §5).
  sink.sweepQuiescentStreams()
  sink.sweepQuiescentStreams()
  sink.close()

  expect(kinds(root, 'trace.stream.quiescent')).toMatchObject([{
    sessionId: 'session',
    streamEpoch: 'stream',
    sequence: 3,
    quietMs: 420_000,
    lastMessageKind: 'assistant',
    deliveryStatus: 'complete',
  }])
  expect(kinds(root, 'trace.stream.quiescent')[0]).not.toHaveProperty('stage')
})

test('a session sitting idle after its result is never reported as quiet', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-delivery-trace-idle-'))
  const clock = { ms: 0 }
  const sink = quiescenceSink(root, clock)
  traceThroughMain(sink, 1, ASSISTANT_FRAME)
  traceThroughMain(sink, 2, RESULT_FRAME)
  clock.ms = 86_400_000
  sink.sweepQuiescentStreams()
  sink.close()
  expect(kinds(root, 'trace.stream.quiescent')).toEqual([])
})

test('a quiet stream whose frames stopped downstream names the stage they stopped at', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-delivery-trace-quiescent-stage-'))
  const clock = { ms: 0 }
  const sink = quiescenceSink(root, clock)
  traceThroughMain(sink, 1, ASSISTANT_FRAME)
  clock.ms = 600_000
  sink.close()

  expect(kinds(root, 'trace.stream.quiescent')).toMatchObject([{
    deliveryStatus: 'incomplete',
    stage: 'preload.received',
    lastMessageKind: 'assistant',
  }])
})

test('a renderer acknowledgement the renderer never sends is not read as a lost frame', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-delivery-trace-quiescent-acks-'))
  const clock = { ms: 0 }
  const sink = quiescenceSink(root, clock)
  // Delivered all the way to the preload and no further. `renderer.ui.committed`
  // is sent only for the ACTIVE session once its projection is terminal, so
  // across 144k real records on 2026-08-10 it appeared ZERO times. Counting its
  // absence would have made every stall verdict accuse the renderer.
  for (const stage of ['engine.produced', 'sidecar.socket.sent', 'supervisor.socket.received', 'host.received', 'main.ipc.sent', 'preload.received'] as const) {
    sink.mark({ sessionId: 'session', trace: mintDeliveryTrace(1, 'stream'), stage, frameKind: 'event', messageKind: 'assistant' })
  }
  clock.ms = 600_000
  sink.close()

  expect(kinds(root, 'trace.stream.quiescent')).toMatchObject([{ deliveryStatus: 'complete' }])
  // The forensic summary keeps the full chain: there the missing acknowledgement
  // is a fact about the renderer worth reading, just not a stall verdict.
  expect(sink.stuckSessionSummaries()[0]?.firstMissingStage).toBe('renderer.state.applied')
})

test('a stream that resumes and stops again is reported a second time', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-delivery-trace-requiet-'))
  const clock = { ms: 0 }
  const sink = quiescenceSink(root, clock)
  traceThroughMain(sink, 1, ASSISTANT_FRAME)
  clock.ms = 400_000
  sink.sweepQuiescentStreams()
  // A new mark clears the latch: the count is bounded by the number of quiet
  // episodes, which is work, not by how long any one of them lasts.
  traceThroughMain(sink, 2, ASSISTANT_FRAME)
  clock.ms = 900_000
  sink.sweepQuiescentStreams()
  sink.close()

  expect(kinds(root, 'trace.stream.quiescent').map(record => record.sequence)).toEqual([1, 2])
})

/** Every record on one lane's files, oldest file first. Rotation spans files. */
function laneRecords(root: string, prefix: string): Array<Record<string, unknown>> {
  const dir = join(root, 'logs')
  return readdirSync(dir)
    .filter(name => name.startsWith(prefix))
    .sort()
    .flatMap(name => readFileSync(join(dir, name), 'utf8').trim().split('\n'))
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

/**
 * A sink whose per-frame lane is squeezed to what one busy minute costs in the
 * real one. The measured 100 MB budget holds ~12,300 frames and burns
 * 9.85 MB/min under load, so the per-frame files are what rotation reaches.
 */
function rotatingSink(root: string, clock: { ms: number }, wall: { value: number }) {
  return createDeliveryTraceSink({
    configDir: root,
    launchId: 'launch',
    maxFileBytes: 4096,
    maxTotalBytes: 8192,
    maxFiles: 1,
    sweepIntervalMs: 0,
    monotonicNow: () => clock.ms,
    now: () => new Date(wall.value++),
  })
}

test('a stream summary outlives the per-frame records it summarizes', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-delivery-rollup-retention-'))
  const clock = { ms: 0 }
  const wall = { value: 1_760_000_000_000 }
  const sink = rotatingSink(root, clock, wall)
  for (let sequence = 1; sequence <= 4; sequence++) traceThroughMain(sink, sequence, ASSISTANT_FRAME)
  clock.ms = 60_000
  sink.emitStreamRollups()

  // The pressure that ends the per-frame history. Nothing here is unusual: it is
  // ordinary traffic on the same stream, which is exactly why ten minutes of it
  // erased the onset of the 2026-08-10 hang before anyone read it.
  for (let sequence = 5; sequence <= 64; sequence++) traceThroughMain(sink, sequence, ASSISTANT_FRAME)
  sink.close()

  const perFrame = laneRecords(root, 'delivery-trace-')
  expect(perFrame.some(record => record.sequence === 1)).toBe(false)
  expect(perFrame.some(record => record.sequence === 4)).toBe(false)
  // Same directory, same launch, different lane: the summary written while those
  // records still existed is still on disk after they are gone.
  const rollups = laneRecords(root, 'delivery-rollup-')
  expect(rollups[0]).toMatchObject({
    recordKind: 'trace.stream.rollup',
    sessionId: 'session',
    streamEpoch: 'stream',
    sequence: 4,
    socketReceived: 4,
    ipcSent: 4,
    preloadReceived: 0,
    deliveryStatus: 'incomplete',
    stage: 'preload.received',
    lastMessageKind: 'assistant',
  })
})

test('a rollup outlives the restarts that follow it, not just the frames', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-delivery-rollup-launches-'))
  // Rollup files are named per launch, so restarts alone rotate this lane. At a
  // file cap of 4 that evicted the oldest launch on the fifth start, defeating
  // the 72h age cap the byte budget was sized for: the 2026-08-14 freeze onset
  // was gone the next day with the lane at 2% of its 4 MB budget.
  // Zero-padded: `laneRecords` sorts filenames lexicographically, so raising
  // this past 9 with bare numbers would fail on ordering rather than retention.
  const launches = 12
  const launchId = (index: number): string => `launch-${String(index).padStart(3, '0')}`
  for (let launch = 1; launch <= launches; launch++) {
    const clock = { ms: 0 }
    const sink = createDeliveryTraceSink({
      configDir: root, launchId: launchId(launch), sweepIntervalMs: 0, monotonicNow: () => clock.ms,
    })
    traceThroughMain(sink, launch, ASSISTANT_FRAME)
    clock.ms = 60_000
    sink.close()
  }

  const rollups = laneRecords(root, 'delivery-rollup-')
  expect(rollups.map(record => record.launchId)).toEqual(
    Array.from({ length: launches }, (_, index) => launchId(index + 1)),
  )
})

test('a rollup carries the stream facts an investigation opens first', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-delivery-rollup-facts-'))
  const clock = { ms: 0 }
  const sink = createDeliveryTraceSink({
    configDir: root, launchId: 'launch', sweepIntervalMs: 0, monotonicNow: () => clock.ms,
  })
  // Sequence 2 never crossed the socket, so a gap fires on 3. How far the stream
  // got, what fired, and where it stopped are the three facts, and they are
  // stream-level: none of them needs the per-frame records to be readable.
  for (const sequence of [1, 3]) traceThroughMain(sink, sequence, ASSISTANT_FRAME)
  clock.ms = 60_000
  sink.emitStreamRollups()
  sink.close()

  expect(laneRecords(root, 'delivery-rollup-')[0]).toMatchObject({
    sequence: 3,
    produced: 0,
    socketReceived: 1,
    hostReceived: 1,
    ipcSent: 1,
    applied: 0,
    committed: 0,
    quietMs: 60_000,
    deliveryStatus: 'incomplete',
    stage: 'preload.received',
    'trace.sequence.gap': 1,
  })
  // Counters for anomalies that never fired are absent, not zero: this record is
  // written once a minute per stream, and the whole point is that it is cheap.
  expect(laneRecords(root, 'delivery-rollup-')[0]).not.toHaveProperty('trace.sequence.duplicate')
})

test('the rollup rides the sweep the sink already owns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-delivery-rollup-timer-'))
  const sink = createDeliveryTraceSink({ configDir: root, launchId: 'launch', sweepIntervalMs: 5 })
  traceThroughMain(sink, 1, ASSISTANT_FRAME)
  // Nothing drives the sweep here. A lane armed to no timer writes nothing in
  // production and still passes every test that calls the method by hand.
  await new Promise(resolve => setTimeout(resolve, 60))
  const written = laneRecords(root, 'delivery-rollup-')
  sink.close()
  expect(written).toHaveLength(1)
})

test('an interval in which a stream did nothing writes no rollup', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-delivery-rollup-idle-'))
  const clock = { ms: 0 }
  const sink = createDeliveryTraceSink({
    configDir: root, launchId: 'launch', sweepIntervalMs: 0, monotonicNow: () => clock.ms,
  })
  traceThroughMain(sink, 1, ASSISTANT_FRAME)
  for (const minute of [1, 2, 3, 4, 5]) {
    clock.ms = minute * 60_000
    sink.emitStreamRollups()
  }
  // A record per minute for a stream doing nothing is bounded by elapsed time
  // rather than by work, which OBSERVABILITY-MINIMUM.md §5 calls the defect.
  expect(laneRecords(root, 'delivery-rollup-')).toHaveLength(1)

  traceThroughMain(sink, 2, ASSISTANT_FRAME)
  clock.ms = 360_000
  sink.emitStreamRollups()
  sink.close()
  expect(laneRecords(root, 'delivery-rollup-').map(record => record.sequence)).toEqual([1, 2])
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

test('both losses a single mark attributes are persisted, not just the last', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-delivery-trace-two-losses-'))
  const sink = createDeliveryTraceSink({ configDir: root, launchId: 'launch', sweepIntervalMs: 0 })
  // Fill one stream's sequence ring to the brim, so the next mark on it trims.
  for (let sequence = 1; sequence <= MAX_DELIVERY_TRACE_SEQUENCES_PER_STREAM; sequence++) {
    sink.mark({ sessionId: 'session', trace: mintDeliveryTrace(sequence, 'stream'), stage: 'engine.produced' })
  }
  // A rejected acknowledgement creates stream state without ever consulting the
  // stream cap, so the map is already over it when that next mark runs.
  for (let index = 0; index < MAX_DELIVERY_TRACE_STREAMS; index++) {
    sink.recordAcknowledgementRejected({
      sessionId: 'session', streamEpoch: `idle-${index}`, sequence: 1, reason: 'unknown_sequence',
    })
  }
  // Eviction picks the least recently touched stream by wall-clock milliseconds,
  // so it names an idle one only once they are strictly older than this mark.
  const until = Date.now() + 3
  while (Date.now() < until) {}
  sink.mark({
    sessionId: 'session',
    trace: mintDeliveryTrace(MAX_DELIVERY_TRACE_SEQUENCES_PER_STREAM + 1, 'stream'),
    stage: 'engine.produced',
  })
  sink.close()

  // One mark, two evictions, two reasons. A single pending slot kept only the
  // second, and the sequence range the first would have named is unrecoverable
  // from the per-stream counter that survives it.
  expect(kinds(root, 'trace.loss')).toMatchObject([
    { reason: 'in_memory_eviction', sequenceStart: 1, sequenceEnd: 1, droppedCount: 1, streamEpoch: 'stream' },
    { reason: 'stream_evicted', sequenceStart: 1, sequenceEnd: 1, droppedCount: 1, streamEpoch: 'idle-0' },
  ])
})
