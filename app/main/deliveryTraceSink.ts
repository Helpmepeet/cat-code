/** Private, bounded, metadata-only delivery tracing with anomaly accounting. */

import {
  chmodSync, closeSync, fstatSync, mkdirSync, openSync, readdirSync,
  statSync, symlinkSync, unlinkSync, writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  deliveryAnomalyScope,
  deliveryObservationKind,
  isDeliveryMessageKind,
  type DeliveryMessageKind,
  type DeliveryStage,
  type DeliveryTrace,
} from '../shared/deliveryTrace.js'
import { isServerFrameKind, type ServerFrame } from '../shared/protocol.js'

export const MAX_DELIVERY_TRACE_RECORD_BYTES = 2 * 1024
export const MAX_DELIVERY_TRACE_FILE_BYTES = 20 * 1024 * 1024
export const MAX_DELIVERY_TRACE_TOTAL_BYTES = 100 * 1024 * 1024
export const MAX_DELIVERY_TRACE_FILES = 6
export const MAX_DELIVERY_TRACE_AGE_MS = 72 * 60 * 60 * 1000
/**
 * The rollup lane's own files, and the whole reason it is a lane at all. Per-frame
 * detail costs ~8.1 KB per frame and burns 9.85 MB/min under load, so the 100 MB
 * per-frame budget holds about ten minutes of history exactly when the app is busy
 * (measured 2026-08-10, `docs/reports/2026-08-10-delivery-trace-retention-measurement.md`).
 * A summary sharing those files would be destroyed by the same pressure it exists
 * to outlive. These caps are sized for the 72h age cap instead: 630 B per record
 * measured against real identifier lengths, one per stream per minute at most, so
 * the whole three days of one continuously active stream is 2.7 MB. Concurrent
 * active streams divide that, since the cap is a total across all of them.
 *
 * The file cap is high on purpose. Lane files are named per launch, so a restart
 * always starts a new one and `retain()` drops the oldest on `count > maxFiles`
 * before age or bytes are consulted. At the original 4 that made the age cap
 * unreachable: this machine held four rollup files totalling 79 KB against the
 * 4 MB budget, and the 2026-08-14 freeze onset had already been evicted by
 * ordinary restarts the next day. Bytes and age are the intended governors; this
 * only bounds directory entries.
 */
export const MAX_DELIVERY_ROLLUP_FILE_BYTES = 1024 * 1024
export const MAX_DELIVERY_ROLLUP_TOTAL_BYTES = 4 * 1024 * 1024
export const MAX_DELIVERY_ROLLUP_FILES = 128
export const DELIVERY_TRACE_FILE_PREFIX = 'delivery-trace-'
export const DELIVERY_ROLLUP_FILE_PREFIX = 'delivery-rollup-'
/**
 * The anomaly kinds a rollup counts, named for the records they summarize so the
 * counter fields invent no second vocabulary. Shared with the export allowlist.
 */
export const DELIVERY_ANOMALY_KINDS = [
  'trace.sequence.gap',
  'trace.sequence.duplicate',
  'trace.sequence.out_of_order',
  'trace.source.incomplete',
  'trace.ack.rejected',
  'trace.stream.quiescent',
] as const
/** In-memory evidence is a bounded diagnostic ring, never a session history. */
export const MAX_DELIVERY_TRACE_SEQUENCES_PER_STREAM = 2_048
export const MAX_DELIVERY_TRACE_STREAMS = 128
/**
 * How long a stream may go without a single delivery mark before it counts as
 * quiet. Every anomaly above is arrival-driven — it needs a LATER frame to
 * fire — so the one shape this trace was built for, frames simply STOPPING,
 * wrote no record at all (2026-08-10 overnight hang). This is the threshold
 * that turns that silence into one record.
 */
export const DELIVERY_TRACE_QUIET_MS = 5 * 60 * 1000
/** How often quiescence is evaluated: a walk of at most 128 in-memory streams. */
export const DELIVERY_TRACE_SWEEP_MS = 60 * 1000

export type DeliveryComponent =
  | 'engine' | 'sidecar' | 'supervisor' | 'host' | 'attachment-gate'
  | 'ipc-bridge' | 'preload' | 'renderer'

export type DeliveryWatermarks = Readonly<{
  produced: number
  socketSent: number
  /**
   * Frame arrival observed on the Unix socket itself. `produced` and
   * `socketSent` ride the sidecar's deliberately lossy FD 3 descriptor, so they
   * are evidence about diagnostic coverage; only this one is evidence about
   * frames. Continuity is judged here.
   */
  socketReceived: number
  hostReceived: number
  ipcSent: number
  preloadReceived: number
  applied: number
  committed: number
  nextExpected: number
}>

export type StuckSessionSummary = Readonly<{
  sessionId: string
  streamEpoch: string
  lastProducedSequence: number
  watermarks: DeliveryWatermarks
  firstMissingStage: string | null
  traceLossCount: number
  anomalies: Readonly<Record<string, number>>
}>

export type DeliveryTraceSink = {
  readonly processInstanceId: string
  mark(input: {
    sessionId: string
    trace: DeliveryTrace
    stage: DeliveryStage
    /** Closed ServerFrame discriminant only; never the frame payload. */
    frameKind?: string
    /**
     * Closed SDK message-type tag for an `event` frame, from
     * `deliveryMessageKindOfFrame`; never the message itself.
     */
    messageKind?: string
    documentId?: string
  subscriptionEpoch?: number
  processInstanceId?: string
  processStartedAt?: string
  wallTimestamp?: string
  monotonicTimestampMs?: number
  }): void
  accepts(sessionId: string, streamEpoch: string, sequence: number, documentId: string, subscriptionEpoch: number): boolean
  traceFor(sessionId: string, streamEpoch: string, sequence: number): DeliveryTrace | null
  recordAcknowledgementRejected(input: {
    sessionId?: string
    streamEpoch?: string
    sequence?: number
    reason: 'invalid_shape' | 'unknown_sequence' | 'stale_document' | 'stale_attempt'
  }): void
  summary(sessionId: string): DeliveryWatermarks | null
  stuckSessionSummaries(): StuckSessionSummary[]
  /**
   * Emit one `trace.stream.quiescent` record per stream that has gone quiet.
   * Driven by this sink's own interval; exposed so a caller (and a test) can
   * evaluate on demand. Diagnosis only: it writes and returns, and never
   * touches a socket, a session, or a frame (OBSERVABILITY-MINIMUM.md §3).
   */
  sweepQuiescentStreams(): void
  /**
   * Emit one `trace.stream.rollup` per stream whose observable state has changed
   * since its last rollup, onto the rollup lane's own files. Rides the same
   * interval as `sweepQuiescentStreams`; exposed for the same reason. Diagnosis
   * only: it writes and returns, and never touches a socket, a session, or a
   * frame (OBSERVABILITY-MINIMUM.md §3).
   */
  emitStreamRollups(): void
  close(): void
}

type StreamState = {
  sessionId: string
  streamEpoch: string
  traces: Map<number, DeliveryTrace>
  frameKinds: Map<number, string>
  messageKinds: Map<number, DeliveryMessageKind>
  stages: Map<number, Set<string>>
  highestByStage: Map<string, number>
  watermarks: DeliveryWatermarks
  losses: number
  anomalies: Map<string, number>
  /**
   * The hole each detector has already reported, so one hole costs one record.
   * A pinned watermark otherwise re-reports the same hole for every frame that
   * follows it: the 2026-08-09 incident emitted thousands of `trace.sequence.gap`
   * records for a single lost run of markers.
   */
  reportedGapAt: number | null
  reportedSourceHoleAt: number | null
  lastTouched: number
  /** Monotonic clock at the last mark, so quiet time is a duration not a date. */
  lastMarkedAtMs: number
  highestSequence: number
  /**
   * The SDK message type of the last message-bearing frame (CC-48's tag). It is
   * what separates a session sitting idle after a `result` from one that went
   * quiet mid-turn, which is the whole difference between noise and the record
   * this sweep exists to write.
   */
  lastMessageKind: DeliveryMessageKind | null
  lastMessageKindSequence: number
  /** One record per quiet episode; cleared by the next mark (§5). */
  quiescenceReported: boolean
  /**
   * The observable state the last rollup reported. An interval that changed
   * nothing writes nothing, so the record count is bounded by the stream's work
   * rather than by how long it sits there (OBSERVABILITY-MINIMUM.md §5).
   */
  lastRollupFingerprint: string | null
}

/** An append-only JSONL file with its own rotation and its own retention. */
type LogLane = {
  append(record: Record<string, unknown>): boolean
  close(): void
}

function createLane({
  directory, prefix, latestName, launchId, maxRecordBytes, maxFileBytes, maxTotalBytes, maxFiles, maxAgeMs, now,
}: {
  directory: string
  prefix: string
  latestName: string
  launchId: string
  maxRecordBytes: number
  maxFileBytes: number
  maxTotalBytes: number
  maxFiles: number
  maxAgeMs: number
  now: () => Date
}): LogLane {
  let fd: number | null = null
  let file = ''

  const ensureOpen = (): boolean => {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      chmodSync(directory, 0o700)
      if (fd === null) {
        file = join(directory, `${prefix}${launchId}-${now().getTime()}.jsonl`)
        fd = openSync(file, 'a', 0o600)
        chmodSync(file, 0o600)
        updateLatest(directory, latestName, file)
        retain(directory, prefix, now().getTime(), maxTotalBytes, maxFiles, maxAgeMs, file)
      }
      return true
    } catch {
      return false
    }
  }

  return {
    append(record) {
      let line: string
      try {
        line = `${JSON.stringify(record)}\n`
      } catch {
        return false
      }
      if (Buffer.byteLength(line) > maxRecordBytes || !ensureOpen() || fd === null) return false
      try {
        const currentSize = fstatSync(fd).size
        if (currentSize > 0 && currentSize + Buffer.byteLength(line) > maxFileBytes) {
          closeSync(fd)
          fd = null
          file = ''
          if (!ensureOpen() || fd === null) return false
        }
        writeSync(fd, line)
        return true
      } catch {
        return false
      }
    },
    close() {
      if (fd !== null) {
        try { closeSync(fd) } catch {}
        fd = null
      }
    },
  }
}

export function createDeliveryTraceSink({
  configDir,
  launchId,
  maxRecordBytes = MAX_DELIVERY_TRACE_RECORD_BYTES,
  maxFileBytes = MAX_DELIVERY_TRACE_FILE_BYTES,
  maxTotalBytes = MAX_DELIVERY_TRACE_TOTAL_BYTES,
  maxFiles = MAX_DELIVERY_TRACE_FILES,
  maxAgeMs = MAX_DELIVERY_TRACE_AGE_MS,
  rollupFileBytes = MAX_DELIVERY_ROLLUP_FILE_BYTES,
  rollupTotalBytes = MAX_DELIVERY_ROLLUP_TOTAL_BYTES,
  rollupFiles = MAX_DELIVERY_ROLLUP_FILES,
  quietMs = DELIVERY_TRACE_QUIET_MS,
  sweepIntervalMs = DELIVERY_TRACE_SWEEP_MS,
  now = () => new Date(),
  monotonicNow = () => performance.now(),
}: {
  configDir: string
  launchId: string
  maxRecordBytes?: number
  maxFileBytes?: number
  maxTotalBytes?: number
  maxFiles?: number
  maxAgeMs?: number
  /** Deliberately separate from the per-frame caps: see the constants above. */
  rollupFileBytes?: number
  rollupTotalBytes?: number
  rollupFiles?: number
  quietMs?: number
  /** Zero or less leaves the sweep unarmed, for a caller that drives it itself. */
  sweepIntervalMs?: number
  now?: () => Date
  monotonicNow?: () => number
}): DeliveryTraceSink {
  const directory = join(configDir, 'logs')
  const processInstanceId = randomUUID()
  const streams = new Map<string, StreamState>()
  let pendingLoss: {
    first: number; last: number; count: number; reason: string
    sessionId?: string; streamEpoch?: string
  } | null = null

  const traceLane = createLane({
    directory, prefix: DELIVERY_TRACE_FILE_PREFIX, latestName: 'latest-delivery', launchId,
    maxRecordBytes, maxFileBytes, maxTotalBytes, maxFiles, maxAgeMs, now,
  })
  const rollupLane = createLane({
    directory, prefix: DELIVERY_ROLLUP_FILE_PREFIX, latestName: 'latest-delivery-rollup', launchId,
    maxRecordBytes, maxFileBytes: rollupFileBytes, maxTotalBytes: rollupTotalBytes, maxFiles: rollupFiles,
    maxAgeMs, now,
  })
  const appendLine = (record: Record<string, unknown>): boolean => traceLane.append(record)

  const noteLoss = (
    sequence: number,
    reason: string,
    attribution?: { state: StreamState; sessionId: string; streamEpoch: string },
  ): void => {
    if (attribution) attribution.state.losses++
    if (
      pendingLoss &&
      pendingLoss.reason === reason &&
      pendingLoss.sessionId === attribution?.sessionId &&
      pendingLoss.streamEpoch === attribution?.streamEpoch &&
      sequence === pendingLoss.last + 1
    ) {
      pendingLoss.last = sequence
      pendingLoss.count++
      return
    }
    pendingLoss = {
      first: sequence, last: sequence, count: 1, reason,
      ...(attribution ? { sessionId: attribution.sessionId, streamEpoch: attribution.streamEpoch } : {}),
    }
  }

  const write = (
    record: Record<string, unknown>,
    sequence: number,
    attribution?: { state: StreamState; sessionId: string; streamEpoch: string },
  ): void => {
    if (pendingLoss) {
      const loss = pendingLoss
      if (appendLine({
        schemaVersion: 1,
        recordKind: 'trace.loss',
        wallTimestamp: now().toISOString(),
        monotonicTimestampMs: monotonicNow(),
        launchId,
        processName: 'electron-main',
        processInstanceId,
        sequenceStart: loss.first,
        sequenceEnd: loss.last,
        droppedCount: loss.count,
        reason: loss.reason,
        ...(loss.sessionId ? { sessionId: loss.sessionId } : {}),
        ...(loss.streamEpoch ? { streamEpoch: loss.streamEpoch } : {}),
      })) pendingLoss = null
    }
    if (!appendLine(record)) noteLoss(sequence, 'writer_unavailable_or_record_oversize', attribution)
  }

  const flushPendingLoss = (): void => {
    if (!pendingLoss) return
    const loss = pendingLoss
    if (appendLine({
      schemaVersion: 1,
      recordKind: 'trace.loss',
      wallTimestamp: now().toISOString(),
      monotonicTimestampMs: monotonicNow(),
      launchId,
      processName: 'electron-main',
      processInstanceId,
      sequenceStart: loss.first,
      sequenceEnd: loss.last,
      droppedCount: loss.count,
      reason: loss.reason,
      ...(loss.sessionId ? { sessionId: loss.sessionId } : {}),
      ...(loss.streamEpoch ? { streamEpoch: loss.streamEpoch } : {}),
    })) pendingLoss = null
  }

  const stateFor = (sessionId: string, streamEpoch: string): StreamState => {
    const key = `${sessionId}\u0000${streamEpoch}`
    let state = streams.get(key)
    if (!state) {
      state = {
        sessionId,
        streamEpoch,
        traces: new Map(),
        frameKinds: new Map(),
        messageKinds: new Map(),
        stages: new Map(),
        highestByStage: new Map(),
        watermarks: {
          produced: 0, socketSent: 0, socketReceived: 0, hostReceived: 0, ipcSent: 0,
          preloadReceived: 0, applied: 0, committed: 0, nextExpected: 1,
        },
        losses: 0,
        anomalies: new Map(),
        reportedGapAt: null,
        reportedSourceHoleAt: null,
        lastTouched: Date.now(),
        lastMarkedAtMs: monotonicNow(),
        highestSequence: 0,
        lastMessageKind: null,
        lastMessageKindSequence: 0,
        quiescenceReported: false,
        lastRollupFingerprint: null,
      }
      streams.set(key, state)
    }
    return state
  }

  const appendAnomaly = (
    state: StreamState,
    sessionId: string,
    trace: DeliveryTrace,
    stage: DeliveryStage,
    anomaly: 'trace.sequence.gap' | 'trace.sequence.duplicate' | 'trace.sequence.out_of_order'
      | 'trace.source.incomplete',
    expected?: number,
  ): void => {
    state.anomalies.set(anomaly, (state.anomalies.get(anomaly) ?? 0) + 1)
    write({
      schemaVersion: 1,
      recordKind: anomaly,
      wallTimestamp: now().toISOString(),
      monotonicTimestampMs: monotonicNow(),
      launchId,
      processName: 'electron-main',
      processInstanceId,
      sessionId,
      streamEpoch: trace.streamEpoch,
      sequence: trace.sequence,
      stage,
      observationKind: deliveryObservationKind(stage),
      anomalyScope: deliveryAnomalyScope(anomaly),
      ...(expected === undefined ? {} : { expectedSequence: expected }),
    }, trace.sequence, { state, sessionId, streamEpoch: trace.streamEpoch })
  }

  const sweepQuiescentStreams = (): void => {
    const nowMs = monotonicNow()
    for (const [key, state] of streams) {
      if (state.quiescenceReported) continue
      const quiet = nowMs - state.lastMarkedAtMs
      if (quiet < quietMs) continue
      // Latch either way: a stream that is quiet by design costs one evaluation
      // per episode rather than one per sweep, and the next mark clears it.
      state.quiescenceReported = true
      // A stream whose last SDK message was the turn's `result` has finished and
      // is idle. Reporting that as a stall is the mistake OBSERVABILITY-MINIMUM
      // §4 names: a designed terminal state must stay distinguishable from a
      // failure to reach one. A stream that carried no message at all has no
      // turn to be mid-way through.
      if (state.lastMessageKind === null || state.lastMessageKind === 'result') continue
      const { sessionId, streamEpoch } = state
      const verdict = deliveryVerdict(state.watermarks)
      state.anomalies.set('trace.stream.quiescent', (state.anomalies.get('trace.stream.quiescent') ?? 0) + 1)
      write({
        schemaVersion: 1,
        recordKind: 'trace.stream.quiescent',
        wallTimestamp: now().toISOString(),
        monotonicTimestampMs: nowMs,
        launchId,
        processName: 'electron-main',
        processInstanceId,
        sessionId: sessionId!,
        streamEpoch: streamEpoch!,
        sequence: state.highestSequence,
        quietMs: Math.round(quiet),
        lastMessageKind: state.lastMessageKind,
        // `complete` is the load-bearing verdict: every frame the engine
        // produced reached the renderer and the stream still went quiet, so the
        // engine stopped producing and the pipeline is exonerated. That is the
        // 2026-08-10 shape, and reading it off a perfect trace took hours.
        ...verdict,
      }, state.highestSequence, { state, sessionId: sessionId!, streamEpoch: streamEpoch! })
    }
  }

  const emitStreamRollups = (): void => {
    const nowMs = monotonicNow()
    for (const state of streams.values()) {
      // A stream with no marked frame has no watermark to summarize; its rollup
      // would be an all-zero record standing for nothing observed.
      if (state.highestSequence < 1) continue
      const verdict = deliveryVerdict(state.watermarks)
      const anomalies = Object.fromEntries(
        DELIVERY_ANOMALY_KINDS
          .map(kind => [kind, state.anomalies.get(kind) ?? 0] as const)
          .filter(([, count]) => count > 0),
      )
      // Everything the record asserts, and nothing time-derived: `quietMs` grows
      // every interval by definition, so including it would defeat suppression
      // and put the record count back on the clock.
      const fingerprint = JSON.stringify([
        state.highestSequence, state.watermarks, state.lastMessageKind, verdict, anomalies, state.losses,
      ])
      if (fingerprint === state.lastRollupFingerprint) continue
      const written = rollupLane.append({
        schemaVersion: 1,
        recordKind: 'trace.stream.rollup',
        wallTimestamp: now().toISOString(),
        monotonicTimestampMs: nowMs,
        launchId,
        processName: 'electron-main',
        processInstanceId,
        sessionId: state.sessionId,
        streamEpoch: state.streamEpoch,
        sequence: state.highestSequence,
        quietMs: Math.max(0, Math.round(nowMs - state.lastMarkedAtMs)),
        ...(state.lastMessageKind ? { lastMessageKind: state.lastMessageKind } : {}),
        ...verdict,
        produced: state.watermarks.produced,
        socketSent: state.watermarks.socketSent,
        socketReceived: state.watermarks.socketReceived,
        hostReceived: state.watermarks.hostReceived,
        ipcSent: state.watermarks.ipcSent,
        preloadReceived: state.watermarks.preloadReceived,
        applied: state.watermarks.applied,
        committed: state.watermarks.committed,
        ...(state.losses > 0 ? { traceLossCount: state.losses } : {}),
        ...anomalies,
      })
      // Left unset on a failed write, so the next interval retries this state
      // instead of suppressing it as already reported. The rollup lane carries
      // no `trace.loss` of its own: a lost summary is re-derivable from state
      // that is still in memory, which is exactly what makes the retry correct.
      if (written) state.lastRollupFingerprint = fingerprint
    }
  }

  const sweepTimer = sweepIntervalMs > 0
    ? setInterval(() => {
      sweepQuiescentStreams()
      emitStreamRollups()
    }, sweepIntervalMs)
    : null
  sweepTimer?.unref?.()

  return {
    processInstanceId,
    mark({ sessionId, trace, stage, frameKind, messageKind, documentId, subscriptionEpoch, processInstanceId: stageInstanceId, processStartedAt: stageStartedAt, wallTimestamp: stageWallTimestamp, monotonicTimestampMs: stageMonotonicTimestampMs }) {
      const state = stateFor(sessionId, trace.streamEpoch)
      state.lastTouched = Date.now()
      state.lastMarkedAtMs = monotonicNow()
      state.quiescenceReported = false
      state.highestSequence = Math.max(state.highestSequence, trace.sequence)
      const seenStages = state.stages.get(trace.sequence) ?? new Set<string>()
      const stageKey = `${trace.deliveryAttempt}:${stage}`
      if (seenStages.has(stageKey)) {
        appendAnomaly(state, sessionId, trace, stage, 'trace.sequence.duplicate')
      }
      seenStages.add(stageKey)
      state.stages.set(trace.sequence, seenStages)

      const previousAtStage = state.highestByStage.get(stage) ?? 0
      if (trace.sequence < previousAtStage) {
        appendAnomaly(state, sessionId, trace, stage, 'trace.sequence.out_of_order', previousAtStage + 1)
      }
      state.highestByStage.set(stage, Math.max(previousAtStage, trace.sequence))
      // Frame continuity is judged where frames actually arrive. A hole here
      // means a conversation frame did not cross the socket.
      if (stage === 'supervisor.socket.received' && trace.sequence > state.watermarks.nextExpected) {
        if (state.reportedGapAt !== state.watermarks.nextExpected) {
          state.reportedGapAt = state.watermarks.nextExpected
          appendAnomaly(state, sessionId, trace, stage, 'trace.sequence.gap', state.watermarks.nextExpected)
        }
      }
      // A hole in the sidecar's own markers means the FD 3 diagnostics queue
      // shed them (`app/sidecar/operationalLogger.ts` drops on saturation by
      // design). That is missing evidence, not a missing frame, and saying so
      // is the whole point of keeping the two apart.
      if (stage === 'engine.produced' && trace.sequence > state.watermarks.produced + 1) {
        if (state.reportedSourceHoleAt !== state.watermarks.produced + 1) {
          state.reportedSourceHoleAt = state.watermarks.produced + 1
          appendAnomaly(state, sessionId, trace, stage, 'trace.source.incomplete', state.watermarks.produced + 1)
        }
      }
      state.traces.set(trace.sequence, trace)
      if (frameKind && isSafeFrameKind(frameKind)) state.frameKinds.set(trace.sequence, frameKind)
      // Gated against the closed vocabulary exactly as `frameKind` is: this
      // field is persisted and exported, so it is never an arbitrary string.
      if (messageKind && isDeliveryMessageKind(messageKind)) {
        state.messageKinds.set(trace.sequence, messageKind)
        // Keyed on the sequence, not on arrival order: a renderer acknowledgement
        // for an older frame is marked after newer ones, and it must not make an
        // earlier `assistant` look like the stream's last word.
        if (trace.sequence >= state.lastMessageKindSequence) {
          state.lastMessageKindSequence = trace.sequence
          state.lastMessageKind = messageKind
        }
      }
      state.watermarks = updateWatermarks(state, state.watermarks)

      const component = componentFor(stage)
      const sourceStage = component === 'engine' || component === 'sidecar'
      write({
        schemaVersion: 1,
        recordKind: 'delivery.trace',
        wallTimestamp: stageWallTimestamp ?? (sourceStage ? trace.sourceWallTimestamp : now().toISOString()),
        monotonicTimestampMs: stageMonotonicTimestampMs ?? (sourceStage ? trace.sourceMonotonicTimestampMs : monotonicNow()),
        launchId,
        component,
        processName: sourceStage ? 'bun-sidecar' : component === 'preload' || component === 'renderer' ? 'electron-renderer' : 'electron-main',
        processInstanceId: stageInstanceId ?? (sourceStage ? trace.sourceProcessInstanceId : processInstanceId),
        ...(stageStartedAt ? { processStartedAt: stageStartedAt } : {}),
        sessionId,
        streamEpoch: trace.streamEpoch,
        sequence: trace.sequence,
        traceId: trace.traceId,
        deliveryAttempt: trace.deliveryAttempt,
        replay: trace.replay,
        connectionEpoch: trace.connectionEpoch,
        stage,
        observationKind: deliveryObservationKind(stage),
        ...(state.frameKinds.get(trace.sequence) ? { frameKind: state.frameKinds.get(trace.sequence) } : {}),
        ...(state.messageKinds.get(trace.sequence) ? { messageKind: state.messageKinds.get(trace.sequence) } : {}),
        ...(documentId ? { documentId } : {}),
        ...(subscriptionEpoch === undefined ? {} : { subscriptionEpoch }),
      }, trace.sequence, { state, sessionId, streamEpoch: trace.streamEpoch })
      trimState(state, sessionId, trace.streamEpoch, trace.sequence, noteLoss)
      if (streams.size > MAX_DELIVERY_TRACE_STREAMS) {
        const oldest = [...streams.entries()].sort((a, b) => a[1].lastTouched - b[1].lastTouched)[0]
        if (oldest && oldest[0] !== `${sessionId}\u0000${trace.streamEpoch}`) {
          const [oldSession, oldEpoch] = oldest[0].split('\u0000')
          const sequence = Math.max(...oldest[1].traces.keys(), 1)
          noteLoss(sequence, 'stream_evicted', { state: oldest[1], sessionId: oldSession!, streamEpoch: oldEpoch! })
          streams.delete(oldest[0])
        }
      }
    },
    accepts(sessionId, streamEpoch, sequence, _documentId, _subscriptionEpoch) {
      return streams.get(`${sessionId}\u0000${streamEpoch}`)?.traces.has(sequence) ?? false
    },
    traceFor(sessionId, streamEpoch, sequence) {
      return streams.get(`${sessionId}\u0000${streamEpoch}`)?.traces.get(sequence) ?? null
    },
    recordAcknowledgementRejected({ sessionId, streamEpoch, sequence, reason }) {
      if (!sessionId || !streamEpoch || !sequence) return
      const state = stateFor(sessionId, streamEpoch)
      const kind = 'trace.ack.rejected'
      state.anomalies.set(kind, (state.anomalies.get(kind) ?? 0) + 1)
      write({
        schemaVersion: 1,
        recordKind: kind,
        wallTimestamp: now().toISOString(),
        monotonicTimestampMs: monotonicNow(),
        launchId,
        processName: 'electron-main',
        processInstanceId,
        sessionId,
        streamEpoch,
        sequence,
        reason,
      }, sequence, { state, sessionId, streamEpoch })
    },
    summary(sessionId) {
      for (const [key, state] of streams) if (key.startsWith(`${sessionId}\u0000`)) return state.watermarks
      return null
    },
    stuckSessionSummaries() {
      return [...streams.entries()].map(([key, state]) => {
        const [sessionId, streamEpoch] = key.split('\u0000')
        const watermarks = state.watermarks
        const firstMissingStage = firstMissing(watermarks)
        return {
          sessionId: sessionId!,
          streamEpoch: streamEpoch!,
          lastProducedSequence: watermarks.produced,
          watermarks,
          firstMissingStage,
          traceLossCount: state.losses,
          anomalies: Object.fromEntries(state.anomalies),
        }
      })
    },
    sweepQuiescentStreams,
    emitStreamRollups,
    close() {
      // A quit between two sweeps would otherwise lose the only account of a
      // stream that had already gone quiet. The per-episode latch keeps this
      // from double-reporting one that the interval already named.
      sweepQuiescentStreams()
      // After the sweep, so the last rollup carries the quiescence it just
      // counted; suppressed when the interval already reported this state.
      emitStreamRollups()
      flushPendingLoss()
      if (sweepTimer) clearInterval(sweepTimer)
      traceLane.close()
      rollupLane.close()
    },
  }
}

function updateWatermarks(state: StreamState, watermarks: DeliveryWatermarks): DeliveryWatermarks {
  const contiguous = (stage: DeliveryStage, current: number): number => {
    let next = current + 1
    while (hasStage(state, next, stage)) next++
    return next - 1
  }
  const socketReceived = contiguous('supervisor.socket.received', watermarks.socketReceived)
  const hostReceived = contiguous('host.received', watermarks.hostReceived)
  return {
    produced: contiguous('engine.produced', watermarks.produced),
    socketSent: contiguous('sidecar.socket.sent', watermarks.socketSent),
    socketReceived,
    hostReceived,
    ipcSent: contiguous('main.ipc.sent', watermarks.ipcSent),
    preloadReceived: contiguousEither(state, ['preload.received', 'renderer.subscription.received'], watermarks.preloadReceived),
    applied: contiguous('renderer.state.applied', watermarks.applied),
    committed: contiguous('renderer.ui.committed', watermarks.committed),
    nextExpected: arrived(socketReceived, hostReceived) + 1,
  }
}

/**
 * Main marks `supervisor.socket.received` and then `host.received` back to back
 * for every frame off the socket (`app/main/main.ts`), and neither rides FD 3.
 * Take the furthest of the two so attribution stays truthful for a caller that
 * marks only one of them.
 */
function arrived(socketReceived: number, hostReceived: number): number {
  return Math.max(socketReceived, hostReceived)
}

function contiguousEither(state: StreamState, stages: readonly DeliveryStage[], current: number): number {
  let next = current + 1
  while (stages.some(stage => hasStage(state, next, stage))) next++
  return next - 1
}

function hasStage(state: StreamState, sequence: number, stage: DeliveryStage): boolean {
  return [...(state.stages.get(sequence) ?? [])].some(value => value.endsWith(`:${stage}`))
}

function trimState(
  state: StreamState,
  sessionId: string,
  streamEpoch: string,
  sequence: number,
  noteLoss: (sequence: number, reason: string, attribution?: { state: StreamState; sessionId: string; streamEpoch: string }) => void,
): void {
  while (state.traces.size > MAX_DELIVERY_TRACE_SEQUENCES_PER_STREAM) {
    const oldest = Math.min(...state.traces.keys())
    state.traces.delete(oldest)
    state.frameKinds.delete(oldest)
    state.messageKinds.delete(oldest)
    state.stages.delete(oldest)
    noteLoss(oldest, 'in_memory_eviction', { state, sessionId, streamEpoch })
  }
}

function componentFor(stage: DeliveryStage): DeliveryComponent {
  if (stage === 'engine.produced') return 'engine'
  if (stage.startsWith('sidecar.')) return 'sidecar'
  if (stage.startsWith('supervisor.')) return 'supervisor'
  if (stage.startsWith('host.')) return 'host'
  if (stage.startsWith('attachment.')) return 'attachment-gate'
  if (stage.startsWith('main.')) return 'ipc-bridge'
  if (stage.startsWith('preload.')) return 'preload'
  return 'renderer'
}

/**
 * `deliveredOnly` stops the chain at the preload, which is the last hop every
 * frame is unconditionally marked at (measured 2026-08-10 across 144k real
 * records: `preload.received` tracks `main.ipc.sent` one for one). The two
 * renderer stages after it are acknowledgements sent by POLICY — `App.tsx`
 * emits `renderer.ui.committed` only for the ACTIVE session and only once its
 * projection is terminal, so it is absent for essentially every conversation
 * frame. A stall verdict that read that absence as a lost frame would accuse
 * the renderer on every stall it ever reported.
 */
function firstMissing(watermarks: DeliveryWatermarks, deliveredOnly = false): string | null {
  // FD 3 loss only ever depresses the source watermarks, never inflates them,
  // so a source watermark that still EXCEEDS what arrived is trustworthy in
  // that one direction: those frames really did not reach main. The reverse
  // comparison is not evidence of anything, which is why the old chain accused
  // the sidecar of a stall whenever the diagnostics queue shed a run.
  const reached = arrived(watermarks.socketReceived, watermarks.hostReceived)
  if (watermarks.socketSent > reached) return 'supervisor.socket.received'
  // `produced` outruns arrival with no send marker to place the frame. That is
  // trustworthy about ONE thing — the frame never reached main — and silent
  // about which of the two hops swallowed it: the sidecar may never have sent
  // it, or FD 3 may have shed the send marker for a frame lost in transit. The
  // comparison cannot separate them, so naming the sidecar here was a label
  // read off absent evidence (OBSERVABILITY-MINIMUM.md §4). The watermarks that
  // travel beside this verdict still say what did and did not arrive.
  if (watermarks.produced > reached) return 'unknown'
  if (reached > watermarks.hostReceived) return 'host.received'
  if (watermarks.hostReceived > watermarks.ipcSent) return 'main.ipc.sent'
  if (watermarks.ipcSent > watermarks.preloadReceived) return 'preload.received'
  if (deliveredOnly) return null
  if (watermarks.preloadReceived > watermarks.applied) return 'renderer.state.applied'
  if (watermarks.applied > watermarks.committed) return 'renderer.ui.committed'
  return null
}

/**
 * The delivered-through verdict both non-arrival records carry. `complete` means
 * every frame the engine produced reached the renderer, which exonerates the
 * pipeline; `unknown` is the deliberate non-answer where the evidence cannot
 * separate two hops (OBSERVABILITY-MINIMUM.md §4). A named stage rides only
 * `incomplete`, so the pairing is what the export validates.
 */
function deliveryVerdict(watermarks: DeliveryWatermarks): { deliveryStatus: string; stage?: string } {
  const missing = firstMissing(watermarks, true)
  if (missing === null) return { deliveryStatus: 'complete' }
  if (missing === 'unknown') return { deliveryStatus: 'unknown' }
  return { deliveryStatus: 'incomplete', stage: missing }
}

/** Server-frame kinds are fixed protocol discriminants, not user-authored text. */
function isSafeFrameKind(value: string): boolean {
  return isServerFrameKind(value)
}

/**
 * The SDK message type an `event` frame carries, read off the frame main already
 * holds. Nothing new crosses the wire: the sidecar already ships the whole
 * `AppSessionEvent` (raw-fidelity, TRANSPORT-DECISION.md §2), so the tag is
 * derivable at every main-side mark site and `protocol.ts` stays untouched.
 * Undefined for every frame that carries no SDK message.
 */
export function deliveryMessageKindOfFrame(frame: ServerFrame): DeliveryMessageKind | undefined {
  if (frame.kind !== 'event' || frame.event.type !== 'message') return undefined
  const messageKind = frame.event.message.type
  return isDeliveryMessageKind(messageKind) ? messageKind : undefined
}

function updateLatest(directory: string, latestName: string, activeFile: string): void {
  const latest = join(directory, latestName)
  try { unlinkSync(latest) } catch {}
  try { symlinkSync(activeFile, latest) } catch {}
}

/**
 * Retention is per lane: the pattern is anchored on the caller's own prefix, so
 * pressure on the per-frame files can never reach a rollup file and the reverse.
 */
function retain(directory: string, prefix: string, current: number, maxTotalBytes: number, maxFiles: number, maxAgeMs: number, activeFile: string): void {
  const pattern = new RegExp(`^${prefix}[A-Za-z0-9-]+-\\d+\\.jsonl$`)
  const files = readdirSync(directory)
    .filter(name => pattern.test(name))
    .map(name => ({ path: join(directory, name), stat: statSync(join(directory, name)) }))
    .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs)
  let total = files.reduce((sum, item) => sum + item.stat.size, 0)
  let count = files.length
  for (const item of files) {
    try { chmodSync(item.path, 0o600) } catch {}
    if (item.path === activeFile) continue
    if (item.stat.mtimeMs < current - maxAgeMs || count > maxFiles || total > maxTotalBytes) {
      try {
        unlinkSync(item.path)
        count--
        total -= item.stat.size
      } catch {}
    }
  }
}
