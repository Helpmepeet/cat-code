/**
 * Delivery tracing in Electron main, driven through the production sink with
 * production limits and a private temporary log directory per repetition.
 *
 * `traceFrame` and the acknowledgement handler live inside `app/main/main.ts`
 * and are not exported; `traceFrame` and `acknowledge` below mirror them.
 * Re-check both against main.ts when the source revision changes. The
 * operational warning main also logs on a rejected acknowledgement is omitted:
 * its sink deduplicates repeated keys for one second.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeliveryTraceSink, deliveryMessageKindOfFrame, type DeliveryTraceSink } from '../../../../app/main/deliveryTraceSink.js'
import {
  mintDeliveryTrace,
  replayDeliveryTrace,
  type DeliveryStage,
  type DeliveryTrace,
} from '../../../../app/shared/deliveryTrace.js'
import type { ServerFrame } from '../../../../app/shared/protocol.js'
import { messageFrames, streamEventFrame, SESSION_ID } from '../fixtures.js'
import { emit, median, probeConfig, repeat, round, summarize, type CaseResult } from '../timing.js'

const config = probeConfig()
const heavy = { ...config, reps: Math.min(config.reps, 3) }
const cases: CaseResult[] = []

const STREAM_EPOCH = '00000000-0000-4000-8000-00000000e9c0'
const SOURCE_INSTANCE = '00000000-0000-4000-8000-00000000501c'
const ACK_STAGES = [
  'preload.received', 'renderer.subscription.received', 'renderer.state.queued', 'renderer.state.applied',
] as const satisfies readonly DeliveryStage[]

type Doc = { documentId: string; subscriptionEpoch: number }
type Traced = ServerFrame & { deliveryTrace: DeliveryTrace }

function traceFrame(sink: DeliveryTraceSink, frame: Traced, stage: DeliveryStage, doc: Doc): Traced {
  const trace = stage === 'attachment.replayed' ? replayDeliveryTrace(frame.deliveryTrace) : frame.deliveryTrace
  sink.mark({
    sessionId: frame.sessionId,
    trace,
    stage,
    frameKind: frame.kind,
    messageKind: deliveryMessageKindOfFrame(frame),
    documentId: doc.documentId,
    subscriptionEpoch: doc.subscriptionEpoch,
  })
  return trace === frame.deliveryTrace ? frame : { ...frame, deliveryTrace: trace }
}

let rejected = 0
function acknowledge(sink: DeliveryTraceSink, frame: Traced, stage: DeliveryStage, doc: Doc): void {
  const { sequence, streamEpoch, deliveryAttempt, traceId } = frame.deliveryTrace
  if (!sink.accepts(frame.sessionId, streamEpoch, sequence, doc.documentId, doc.subscriptionEpoch)) {
    rejected++
    sink.recordAcknowledgementRejected({ sessionId: frame.sessionId, streamEpoch, sequence, reason: 'unknown_sequence' })
    return
  }
  const trace = sink.traceFor(frame.sessionId, streamEpoch, sequence)
  if (!trace || trace.deliveryAttempt !== deliveryAttempt || trace.streamEpoch !== streamEpoch || trace.traceId !== traceId) {
    rejected++
    sink.recordAcknowledgementRejected({ sessionId: frame.sessionId, streamEpoch, sequence, reason: 'stale_attempt' })
    return
  }
  sink.mark({ sessionId: frame.sessionId, trace, stage, documentId: doc.documentId, subscriptionEpoch: doc.subscriptionEpoch })
}

type RecordStats = { records: number; bytes: number; kinds: Record<string, number> }

function traceRecordStats(directory: string): RecordStats {
  const logs = join(directory, 'logs')
  let records = 0
  let bytes = 0
  const kinds: Record<string, number> = {}
  for (const name of readdirSync(logs)) {
    if (!name.startsWith('delivery-trace-')) continue
    const text = readFileSync(join(logs, name), 'utf8')
    bytes += Buffer.byteLength(text)
    for (const line of text.split('\n')) {
      if (!line) continue
      records++
      const kind = String((JSON.parse(line) as { recordKind?: unknown }).recordKind)
      kinds[kind] = (kinds[kind] ?? 0) + 1
    }
  }
  return { records, bytes, kinds }
}

function kindDelta(before: RecordStats, after: RecordStats): Record<string, number> {
  return Object.fromEntries(Object.entries(after.kinds)
    .map(([kind, count]) => [kind, count - (before.kinds[kind] ?? 0)] as const)
    .filter(([, count]) => count > 0))
}

function withSink<T>(run: (sink: DeliveryTraceSink, directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'catcode-perf-trace-'))
  const sink = createDeliveryTraceSink({ configDir: directory, launchId: 'perf-probe', sweepIntervalMs: 0 })
  try {
    return run(sink, directory)
  } finally {
    sink.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

/** Finished messages, each preceded on the live stream by `partials` streamed partials. */
function liveStream(messages: number, partials: number): { live: Traced[]; finished: Traced[] } {
  const live: Traced[] = []
  const finished: Traced[] = []
  let sequence = 0
  for (const frame of messageFrames(messages, 300)) {
    for (let p = 0; p < partials; p++) {
      live.push({ ...streamEventFrame(SESSION_ID), deliveryTrace: mintDeliveryTrace(++sequence, STREAM_EPOCH, SOURCE_INSTANCE) } as Traced)
    }
    const traced = { ...frame, deliveryTrace: mintDeliveryTrace(++sequence, STREAM_EPOCH, SOURCE_INSTANCE) } as Traced
    live.push(traced)
    finished.push(traced)
  }
  return { live, finished }
}

type PhaseTimes = { replayed: number; queued: number; sent: number; acks: number }

/** The three synchronous passes main runs for an existing-buffer replay, then the renderer's acknowledgements. */
function reattach(sink: DeliveryTraceSink, frames: Traced[], doc: Doc): { times: PhaseTimes; evicted: number } {
  let start = performance.now()
  const replayed = frames.map(frame => traceFrame(sink, frame, 'attachment.replayed', doc))
  const tReplayed = performance.now() - start
  start = performance.now()
  const queued = replayed.map(frame => traceFrame(sink, frame, 'main.ipc.queued', doc))
  const tQueued = performance.now() - start
  start = performance.now()
  for (const frame of queued) traceFrame(sink, frame, 'main.ipc.sent', doc)
  const tSent = performance.now() - start
  const evicted = queued.filter(f => !sink.accepts(f.sessionId, f.deliveryTrace.streamEpoch, f.deliveryTrace.sequence, doc.documentId, doc.subscriptionEpoch)).length
  start = performance.now()
  for (const stage of ACK_STAGES) for (const frame of queued) acknowledge(sink, frame, stage, doc)
  const tAcks = performance.now() - start
  return { times: { replayed: tReplayed, queued: tQueued, sent: tSent, acks: tAcks }, evicted }
}

function phaseDetail(all: { times: PhaseTimes; evicted: number; records: number; bytes: number; rejected: number; kinds: Record<string, number> }[]) {
  return {
    replayedPassMedianMs: round(median(all.map(r => r.times.replayed))),
    queuedPassMedianMs: round(median(all.map(r => r.times.queued))),
    sentPassMedianMs: round(median(all.map(r => r.times.sent))),
    acknowledgementMedianMs: round(median(all.map(r => r.times.acks))),
    evictedAfterPasses: all.at(-1)?.evicted,
    rejectedAcknowledgements: all.at(-1)?.rejected,
    traceRecordsWritten: all.at(-1)?.records,
    traceBytesWritten: all.at(-1)?.bytes,
    traceRecordsByKind: all.at(-1)?.kinds,
  }
}

// Scenario 1, reproducing the report: frames buffered before the first renderer
// readiness (source, socket, host and buffered stages only), then replayed.
for (const count of config.smoke ? [100] : [2_048, 3_000, 4_000, 8_000]) {
  const runs: Parameters<typeof phaseDetail>[0] = []
  const samples = repeat(heavy, () => withSink((sink, directory) => {
    const { finished } = liveStream(count, 0)
    const boot: Doc = { documentId: 'doc-boot', subscriptionEpoch: 0 }
    for (const frame of finished) {
      for (const stage of ['engine.produced', 'supervisor.socket.received', 'host.received', 'attachment.buffered'] as const) {
        traceFrame(sink, frame, stage, boot)
      }
    }
    const before = traceRecordStats(directory)
    rejected = 0
    const result = reattach(sink, finished, { documentId: 'doc-ready', subscriptionEpoch: 1 })
    const after = traceRecordStats(directory)
    runs.push({ ...result, records: after.records - before.records, bytes: after.bytes - before.bytes, rejected, kinds: kindDelta(before, after) })
    return result.times.replayed + result.times.queued + result.times.sent
  }))
  cases.push(summarize(`buffered-initial/${count}`, { frames: count, scoredValue: 'three passes, ms' }, samples, phaseDetail(runs)))
}

// Scenario 2: a reload after live delivery. The live stream carried partials,
// the replay buffer kept only finished messages (compaction), and the renderer
// acknowledged everything it received live.
const LIVE = config.smoke
  ? [{ messages: 50, partials: 3 }]
  : [
    { messages: 300, partials: 0 }, { messages: 1_000, partials: 0 }, { messages: 3_000, partials: 0 },
    { messages: 100, partials: 19 }, { messages: 300, partials: 19 }, { messages: 1_000, partials: 19 }, { messages: 3_000, partials: 19 },
  ]
for (const { messages, partials } of LIVE) {
  const runs: Parameters<typeof phaseDetail>[0] = []
  const livePerFrame: number[] = []
  const samples = repeat(heavy, () => withSink((sink, directory) => {
    const { live, finished } = liveStream(messages, partials)
    const liveDoc: Doc = { documentId: 'doc-live', subscriptionEpoch: 1 }
    const liveStart = performance.now()
    for (const frame of live) {
      sink.mark({ sessionId: frame.sessionId, trace: frame.deliveryTrace, stage: 'engine.produced' })
      traceFrame(sink, frame, 'supervisor.socket.received', liveDoc)
      traceFrame(sink, frame, 'host.received', liveDoc)
      traceFrame(sink, frame, 'main.ipc.queued', liveDoc)
      traceFrame(sink, frame, 'main.ipc.sent', liveDoc)
      for (const stage of ACK_STAGES) acknowledge(sink, frame, stage, liveDoc)
    }
    livePerFrame.push((performance.now() - liveStart) / live.length)
    const before = traceRecordStats(directory)
    rejected = 0
    const result = reattach(sink, finished, { documentId: 'doc-reloaded', subscriptionEpoch: 1 })
    const after = traceRecordStats(directory)
    runs.push({ ...result, records: after.records - before.records, bytes: after.bytes - before.bytes, rejected, kinds: kindDelta(before, after) })
    return result.times.replayed + result.times.queued + result.times.sent + result.times.acks
  }))
  cases.push(summarize(`reload-after-live/${messages}-messages/${partials}-partials`, {
    finishedMessages: messages,
    partialsPerMessage: partials,
    liveFrames: messages * (partials + 1),
    scoredValue: 'three passes plus acknowledgements, ms',
  }, samples, { ...phaseDetail(runs), liveTracingMedianMsPerFrame: round(median(livePerFrame), 4) }))
}

emit('tracing', cases, [
  'Synchronous main-process work only; IPC transfer and renderer execution are not included.',
  'Partials per message (19) follows the 95% partial share quoted in app/main/replayBuffer.ts; tier B samples the real share.',
])
