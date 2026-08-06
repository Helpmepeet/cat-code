/** Private, bounded, metadata-only delivery tracing with anomaly accounting. */

import {
  chmodSync, closeSync, fstatSync, mkdirSync, openSync, readdirSync,
  statSync, symlinkSync, unlinkSync, writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DeliveryStage, DeliveryTrace } from '../shared/deliveryTrace.js'

export const MAX_DELIVERY_TRACE_RECORD_BYTES = 2 * 1024
export const MAX_DELIVERY_TRACE_FILE_BYTES = 20 * 1024 * 1024
export const MAX_DELIVERY_TRACE_TOTAL_BYTES = 100 * 1024 * 1024
export const MAX_DELIVERY_TRACE_FILES = 6
export const MAX_DELIVERY_TRACE_AGE_MS = 72 * 60 * 60 * 1000
/** In-memory evidence is a bounded diagnostic ring, never a session history. */
export const MAX_DELIVERY_TRACE_SEQUENCES_PER_STREAM = 2_048
export const MAX_DELIVERY_TRACE_STREAMS = 128

export type DeliveryComponent =
  | 'engine' | 'sidecar' | 'supervisor' | 'host' | 'attachment-gate'
  | 'ipc-bridge' | 'preload' | 'renderer'

export type DeliveryWatermarks = Readonly<{
  produced: number
  socketSent: number
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
  close(): void
}

type StreamState = {
  traces: Map<number, DeliveryTrace>
  frameKinds: Map<number, string>
  stages: Map<number, Set<string>>
  highestByStage: Map<string, number>
  watermarks: DeliveryWatermarks
  losses: number
  anomalies: Map<string, number>
  lastTouched: number
}

export function createDeliveryTraceSink({
  configDir,
  launchId,
  maxRecordBytes = MAX_DELIVERY_TRACE_RECORD_BYTES,
  maxFileBytes = MAX_DELIVERY_TRACE_FILE_BYTES,
  maxTotalBytes = MAX_DELIVERY_TRACE_TOTAL_BYTES,
  maxFiles = MAX_DELIVERY_TRACE_FILES,
  maxAgeMs = MAX_DELIVERY_TRACE_AGE_MS,
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
  now?: () => Date
  monotonicNow?: () => number
}): DeliveryTraceSink {
  const directory = join(configDir, 'logs')
  const processInstanceId = randomUUID()
  const streams = new Map<string, StreamState>()
  let fd: number | null = null
  let file = ''
  let pendingLoss: {
    first: number; last: number; count: number; reason: string
    sessionId?: string; streamEpoch?: string
  } | null = null

  const ensureOpen = (): boolean => {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      chmodSync(directory, 0o700)
      if (fd === null) {
        file = join(directory, `delivery-trace-${launchId}-${Date.now()}.jsonl`)
        fd = openSync(file, 'a', 0o600)
        chmodSync(file, 0o600)
        updateLatest(directory, file)
        retain(directory, now().getTime(), maxTotalBytes, maxFiles, maxAgeMs, file)
      }
      return true
    } catch {
      return false
    }
  }

  const appendLine = (record: Record<string, unknown>): boolean => {
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
  }

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
        traces: new Map(),
        frameKinds: new Map(),
        stages: new Map(),
        highestByStage: new Map(),
        watermarks: {
          produced: 0, socketSent: 0, hostReceived: 0, ipcSent: 0,
          preloadReceived: 0, applied: 0, committed: 0, nextExpected: 1,
        },
        losses: 0,
        anomalies: new Map(),
        lastTouched: Date.now(),
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
    anomaly: 'trace.sequence.gap' | 'trace.sequence.duplicate' | 'trace.sequence.out_of_order',
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
      ...(expected === undefined ? {} : { expectedSequence: expected }),
    }, trace.sequence, { state, sessionId, streamEpoch: trace.streamEpoch })
  }

  return {
    processInstanceId,
    mark({ sessionId, trace, stage, frameKind, documentId, subscriptionEpoch, processInstanceId: stageInstanceId, processStartedAt: stageStartedAt, wallTimestamp: stageWallTimestamp, monotonicTimestampMs: stageMonotonicTimestampMs }) {
      const state = stateFor(sessionId, trace.streamEpoch)
      state.lastTouched = Date.now()
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
      if (stage === 'engine.produced') {
        if (trace.sequence > state.watermarks.nextExpected) {
          appendAnomaly(state, sessionId, trace, stage, 'trace.sequence.gap', state.watermarks.nextExpected)
        }
      }
      state.traces.set(trace.sequence, trace)
      if (frameKind && isSafeFrameKind(frameKind)) state.frameKinds.set(trace.sequence, frameKind)
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
        ...(state.frameKinds.get(trace.sequence) ? { frameKind: state.frameKinds.get(trace.sequence) } : {}),
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
    close() {
      flushPendingLoss()
      if (fd !== null) {
        try { closeSync(fd) } catch {}
        fd = null
      }
    },
  }
}

function updateWatermarks(state: StreamState, watermarks: DeliveryWatermarks): DeliveryWatermarks {
  const contiguous = (stage: DeliveryStage, current: number): number => {
    let next = current + 1
    while (hasStage(state, next, stage)) next++
    return next - 1
  }
  const produced = contiguous('engine.produced', watermarks.produced)
  return {
    produced,
    socketSent: contiguous('sidecar.socket.sent', watermarks.socketSent),
    hostReceived: contiguous('host.received', watermarks.hostReceived),
    ipcSent: contiguous('main.ipc.sent', watermarks.ipcSent),
    preloadReceived: contiguousEither(state, ['preload.received', 'renderer.subscription.received'], watermarks.preloadReceived),
    applied: contiguous('renderer.state.applied', watermarks.applied),
    committed: contiguous('renderer.ui.committed', watermarks.committed),
    nextExpected: produced + 1,
  }
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

function firstMissing(watermarks: DeliveryWatermarks): string | null {
  if (watermarks.produced > watermarks.socketSent) return 'sidecar.socket.sent'
  if (watermarks.socketSent > watermarks.hostReceived) return 'host.received'
  if (watermarks.hostReceived > watermarks.ipcSent) return 'main.ipc.sent'
  if (watermarks.ipcSent > watermarks.preloadReceived) return 'preload.received'
  if (watermarks.preloadReceived > watermarks.applied) return 'renderer.state.applied'
  if (watermarks.applied > watermarks.committed) return 'renderer.ui.committed'
  return null
}

/** Server-frame kinds are fixed protocol discriminants, not user-authored text. */
function isSafeFrameKind(value: string): boolean {
  return /^[a-z][a-z0-9.-]{0,95}$/.test(value)
}

function updateLatest(directory: string, activeFile: string): void {
  const latest = join(directory, 'latest-delivery')
  try { unlinkSync(latest) } catch {}
  try { symlinkSync(activeFile, latest) } catch {}
}

function retain(directory: string, current: number, maxTotalBytes: number, maxFiles: number, maxAgeMs: number, activeFile: string): void {
  const files = readdirSync(directory)
    .filter(name => /^delivery-trace-[A-Za-z0-9-]+-\d+\.jsonl$/.test(name))
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
