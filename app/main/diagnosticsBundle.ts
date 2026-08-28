/** Local-only support export assembled from closed, redacted JSONL records. */

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { release as osRelease } from 'node:os'
import { parseOperationalRecord } from '../shared/operationalLog.js'
import {
  DELIVERY_ANOMALY_KINDS,
  DELIVERY_ROLLUP_FILE_PREFIX,
  DELIVERY_TRACE_FILE_PREFIX,
  MAX_DELIVERY_ROLLUP_FILES,
  MAX_DELIVERY_ROLLUP_FILE_BYTES,
  MAX_DELIVERY_ROLLUP_TOTAL_BYTES,
  MAX_DELIVERY_TRACE_AGE_MS,
  MAX_DELIVERY_TRACE_FILES,
  MAX_DELIVERY_TRACE_FILE_BYTES,
  MAX_DELIVERY_TRACE_RECORD_BYTES,
  MAX_DELIVERY_TRACE_TOTAL_BYTES,
} from './deliveryTraceSink.js'
import {
  deliveryAnomalyScope,
  deliveryObservationKind,
  isDeliveryMessageKind,
  isDeliveryStage,
  isSafeDeliveryIdentifier,
} from '../shared/deliveryTrace.js'
import { isServerFrameKind } from '../shared/protocol.js'
import {
  MAX_OPERATIONAL_LOG_AGE_MS,
  MAX_OPERATIONAL_LOG_BYTES,
  MAX_OPERATIONAL_LOG_FILES,
  MAX_OPERATIONAL_LOG_TOTAL_BYTES,
  MAX_OPERATIONAL_RECORD_BYTES,
} from './operationalLogSink.js'

/** The last `MAX_FILE_BYTES` bytes of a file, without decoding the rest of it. */
function readTail(path: string, size: number): string {
  const length = Math.min(size, MAX_FILE_BYTES)
  const handle = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    readSync(handle, buffer, 0, length, Math.max(0, size - length))
    return buffer.toString('utf8')
  } finally {
    closeSync(handle)
  }
}

const MAX_BUNDLE_BYTES = 2 * 1024 * 1024
const MAX_FILE_BYTES = 512 * 1024
/**
 * The rollup lane's admission reserve, spent only by rollup records. Sharing the
 * general budget would undo on the export side what the separate files buy on the
 * retention side: one busy minute of per-frame records fills 1 MiB, and the
 * summaries that exist to outlive them would be squeezed out of every bundle.
 */
const MAX_BUNDLE_ROLLUP_BYTES = 256 * 1024

type TraceRecord = Record<string, string | number | boolean>

export function buildDiagnosticsBundle({
  logsDirectory,
  appVersion,
  packaged = false,
  currentLaunchId,
  buildId,
  commitId,
}: {
  logsDirectory: string
  appVersion: string
  packaged?: boolean
  /** Required: omitting it classified the live launch as interrupted. */
  currentLaunchId: string
  buildId?: string
  commitId?: string
}): string {
  const streams: { operational: unknown[]; deliveryTrace: TraceRecord[]; deliveryRollup: TraceRecord[] } =
    { operational: [], deliveryTrace: [], deliveryRollup: [] }
  let includedBytes = 0
  let rollupBytes = 0
  let rollupLimitReached = false
  let sourceWindowTruncated = false
  let bundleLimitReached = false
  let sourceReadFailures = 0
  let recordsRejected = 0
  if (existsSync(logsDirectory)) {
    const now = Date.now()
    const candidates: Array<{ name: string; mtimeMs: number; size: number }> = []
    for (const name of readdirSync(logsDirectory)) {
      try {
        const stat = statSync(join(logsDirectory, name))
        if (stat.isFile() && now - stat.mtimeMs <= Math.max(MAX_OPERATIONAL_LOG_AGE_MS, MAX_DELIVERY_TRACE_AGE_MS)) {
          candidates.push({ name, mtimeMs: stat.mtimeMs, size: stat.size })
        }
      } catch {}
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const { name, size } of candidates) {
      // The inner break only ends one file. Without this the remaining
      // candidates, up to six 20 MiB trace files, were still read whole and
      // parsed synchronously on the Electron main thread after the admission
      // budget was already spent, freezing the UI inside the export handler.
      if (bundleLimitReached && rollupLimitReached) break
      const isRollup = name.startsWith(DELIVERY_ROLLUP_FILE_PREFIX)
      const target = name.startsWith('operational-')
        ? streams.operational
        : isRollup
          ? streams.deliveryRollup
          : name.startsWith(DELIVERY_TRACE_FILE_PREFIX)
            ? streams.deliveryTrace
            : null
      if (!target) continue
      // Skipped before the tail read, for the same reason the break above exists:
      // a lane whose budget is spent must not cost the main thread a file parse.
      if (isRollup ? rollupLimitReached : bundleLimitReached) continue
      try {
        if (size > MAX_FILE_BYTES) sourceWindowTruncated = true
        // Take the tail and parse newest complete records first, so an incident
        // immediately before export wins admission over old retained history.
        // Read only the tail: decoding a whole 20 MiB trace file to keep its last
        // 512 KiB cost the main thread the entire file. Seeking also makes the
        // truncation check exact, since both sides are now bytes.
        const text = readTail(join(logsDirectory, name), size)
        for (const line of text.split('\n').reverse()) {
          if (!line) continue
          // Taking a tail almost always cuts the oldest line in half, so an
          // unparseable line is an expected boundary artifact. It must not abort
          // the rest of the file, and it is counted rather than hidden.
          let value: unknown
          try {
            value = JSON.parse(line)
          } catch {
            recordsRejected++
            continue
          }
          const safe = target === streams.operational
            ? parseOperationalRecord(value)
            : parseDeliveryTraceRecord(value)
          // Reported so a reader knows the bundle is not the whole file, but it
          // does not decide `status`: a rejected line means something wrote
          // something odd, not that evidence we needed went missing.
          if (!safe) {
            recordsRejected++
            continue
          }
          const bytes = Buffer.byteLength(JSON.stringify(safe))
          if (isRollup) {
            if (rollupBytes + bytes > MAX_BUNDLE_ROLLUP_BYTES) {
              rollupLimitReached = true
              break
            }
            rollupBytes += bytes
          } else {
            if (includedBytes + bytes > MAX_BUNDLE_BYTES / 2) {
              bundleLimitReached = true
              break
            }
            includedBytes += bytes
          }
          target.push(safe)
        }
      } catch {
        // A concurrently rotated/broken log is omitted rather than failing export.
        sourceReadFailures++
      }
    }
  }
  const result = {
    format: 'cat-code-diagnostics-v2',
    createdAt: new Date().toISOString(),
    manifest: {
      appVersion: bounded(appVersion),
      build: {
        ...(safeBuildIdentifier(buildId) ? { buildId: safeBuildIdentifier(buildId) } : {}),
        ...(safeBuildIdentifier(commitId) ? { commitId: safeBuildIdentifier(commitId) } : {}),
      },
      os: { platform: process.platform, arch: process.arch, release: bounded(osRelease()) },
      runtime: { node: bounded(process.versions.node), electron: bounded(process.versions.electron ?? 'unavailable') },
      configuration: { packaged },
      schemas: { operational: 1, deliveryTrace: 1, deliveryRollup: 1 },
      limits: {
        operational: { recordBytes: MAX_OPERATIONAL_RECORD_BYTES, fileBytes: MAX_OPERATIONAL_LOG_BYTES, totalBytes: MAX_OPERATIONAL_LOG_TOTAL_BYTES, files: MAX_OPERATIONAL_LOG_FILES, ageMs: MAX_OPERATIONAL_LOG_AGE_MS },
        deliveryTrace: { recordBytes: MAX_DELIVERY_TRACE_RECORD_BYTES, fileBytes: MAX_DELIVERY_TRACE_FILE_BYTES, totalBytes: MAX_DELIVERY_TRACE_TOTAL_BYTES, files: MAX_DELIVERY_TRACE_FILES, ageMs: MAX_DELIVERY_TRACE_AGE_MS },
        deliveryRollup: { recordBytes: MAX_DELIVERY_TRACE_RECORD_BYTES, fileBytes: MAX_DELIVERY_ROLLUP_FILE_BYTES, totalBytes: MAX_DELIVERY_ROLLUP_TOTAL_BYTES, files: MAX_DELIVERY_ROLLUP_FILES, ageMs: MAX_DELIVERY_TRACE_AGE_MS },
      },
      recordCounts: {
        operational: streams.operational.length,
        deliveryTrace: streams.deliveryTrace.length,
        deliveryRollup: streams.deliveryRollup.length,
      },
    },
    // Rollups included: when the per-frame files have rotated away, they may be
    // the only remaining evidence that a process observed anything at all.
    processInstances: deriveProcessInstances(streams.operational, [...streams.deliveryTrace, ...streams.deliveryRollup]),
    recordingCoverage: deriveRecordingCoverage(
      streams.operational,
      streams.deliveryTrace,
      currentLaunchId,
      { sourceWindowTruncated, bundleLimitReached: bundleLimitReached || rollupLimitReached, sourceReadFailures, recordsRejected },
    ),
    stuckSessions: deriveStuckSessionSummaries(streams.deliveryTrace),
    streams,
    excluded: [
      'transcripts', 'transcript caches', 'settings', 'vaults', 'account files',
      'raw engine debug logs', 'renderer debug state', 'environment', 'raw stderr',
    ],
    redaction: 'Records are reparsed through closed operational/trace schemas before export.',
  }
  // Entry admission is capped at half the bundle budget, so a normal manifest
  // cannot make the JSON invalid by requiring a post-serialization slice.
  return JSON.stringify(result, null, 2)
}

export function parseDeliveryTraceRecord(value: unknown): TraceRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  const kind = item.recordKind
  const allowedByKind: Record<string, readonly string[]> = {
    'delivery.trace': [
      'schemaVersion', 'recordKind', 'wallTimestamp', 'monotonicTimestampMs', 'launchId',
      'component', 'processName', 'processInstanceId', 'sessionId', 'streamEpoch',
      'sequence', 'traceId', 'deliveryAttempt', 'replay', 'stage', 'documentId', 'subscriptionEpoch',
      'connectionEpoch', 'frameKind', 'messageKind', 'processStartedAt', 'observationKind',
    ],
    'trace.loss': [
      'schemaVersion', 'recordKind', 'wallTimestamp', 'monotonicTimestampMs', 'launchId',
      'processName', 'processInstanceId', 'sequenceStart', 'sequenceEnd', 'droppedCount', 'reason',
      'sessionId', 'streamEpoch',
    ],
    'trace.sequence.gap': [
      'schemaVersion', 'recordKind', 'wallTimestamp', 'monotonicTimestampMs', 'launchId',
      'processName', 'processInstanceId', 'sessionId', 'streamEpoch', 'sequence', 'stage',
      'expectedSequence', 'observationKind', 'anomalyScope',
    ],
    // Missing sidecar markers, i.e. incomplete diagnostic coverage. Deliberately
    // a separate kind from `trace.sequence.gap`, which means a missing frame.
    'trace.source.incomplete': [
      'schemaVersion', 'recordKind', 'wallTimestamp', 'monotonicTimestampMs', 'launchId',
      'processName', 'processInstanceId', 'sessionId', 'streamEpoch', 'sequence', 'stage',
      'expectedSequence', 'observationKind', 'anomalyScope',
    ],
    'trace.sequence.duplicate': [
      'schemaVersion', 'recordKind', 'wallTimestamp', 'monotonicTimestampMs', 'launchId',
      'processName', 'processInstanceId', 'sessionId', 'streamEpoch', 'sequence', 'stage',
      'observationKind', 'anomalyScope',
    ],
    'trace.sequence.out_of_order': [
      'schemaVersion', 'recordKind', 'wallTimestamp', 'monotonicTimestampMs', 'launchId',
      'processName', 'processInstanceId', 'sessionId', 'streamEpoch', 'sequence', 'stage',
      'expectedSequence', 'observationKind', 'anomalyScope',
    ],
    'trace.ack.rejected': [
      'schemaVersion', 'recordKind', 'wallTimestamp', 'monotonicTimestampMs', 'launchId',
      'processName', 'processInstanceId', 'sessionId', 'streamEpoch', 'sequence', 'reason',
    ],
    // The only record in this stream that is not arrival-driven: a stream that
    // stopped producing writes nothing, so this one is written by a sweep. Its
    // absence from this allowlist would reject it from every export.
    'trace.stream.quiescent': [
      'schemaVersion', 'recordKind', 'wallTimestamp', 'monotonicTimestampMs', 'launchId',
      'processName', 'processInstanceId', 'sessionId', 'streamEpoch', 'sequence',
      'quietMs', 'lastMessageKind', 'deliveryStatus', 'stage',
    ],
    // The periodic per-stream summary, written to its own files on its own
    // retention budget so it outlives the per-frame detail it summarizes. It
    // reaches a bundle only through this entry: an unlisted kind is rejected
    // whole and silently, which is the fail-before this row was written against.
    'trace.stream.rollup': [
      'schemaVersion', 'recordKind', 'wallTimestamp', 'monotonicTimestampMs', 'launchId',
      'processName', 'processInstanceId', 'sessionId', 'streamEpoch', 'sequence',
      'quietMs', 'lastMessageKind', 'deliveryStatus', 'stage',
      'produced', 'socketSent', 'socketReceived', 'hostReceived', 'ipcSent',
      'preloadReceived', 'applied', 'committed', 'traceLossCount',
      ...DELIVERY_ANOMALY_KINDS,
    ],
  }
  if (typeof kind !== 'string' || !allowedByKind[kind] || Object.keys(item).some(key => !allowedByKind[kind]!.includes(key))) return null
  // The bundle's promise is that a second pass re-validates every retained
  // record, so the identifier grammar belongs here rather than only on the
  // delivery.trace branch: an anomaly record carrying a path in its
  // processInstanceId would otherwise be exported unchanged.
  if (
    item.schemaVersion !== 1 || typeof item.wallTimestamp !== 'string' || Number.isNaN(Date.parse(item.wallTimestamp)) ||
    typeof item.monotonicTimestampMs !== 'number' || !Number.isFinite(item.monotonicTimestampMs) || item.monotonicTimestampMs < 0 ||
    !opaqueId(item.launchId) || !opaqueId(item.processInstanceId) ||
    !['bun-sidecar', 'electron-main', 'electron-renderer'].includes(item.processName as string)
  ) return null
  if (kind === 'delivery.trace') {
    if (
      !['engine', 'sidecar', 'supervisor', 'host', 'attachment-gate', 'ipc-bridge', 'preload', 'renderer'].includes(item.component as string) ||
      !['bun-sidecar', 'electron-main', 'electron-renderer'].includes(item.processName as string) ||
      !opaqueId(item.launchId) || !opaqueId(item.processInstanceId) ||
      !opaqueId(item.sessionId) || !isSafeDeliveryIdentifier(item.streamEpoch) ||
      !positiveInteger(item.sequence) || !isSafeDeliveryIdentifier(item.traceId) ||
      !positiveInteger(item.deliveryAttempt) || typeof item.replay !== 'boolean' || typeof item.stage !== 'string' ||
      !isDeliveryStage(item.stage) ||
      !positiveInteger(item.connectionEpoch) ||
      (item.frameKind !== undefined && !isServerFrameKind(item.frameKind)) ||
      (item.messageKind !== undefined && !isDeliveryMessageKind(item.messageKind)) ||
      (item.processStartedAt !== undefined && (typeof item.processStartedAt !== 'string' || Number.isNaN(Date.parse(item.processStartedAt)))) ||
      (item.documentId !== undefined && !opaqueId(item.documentId)) ||
      (item.subscriptionEpoch !== undefined && !positiveInteger(item.subscriptionEpoch)) ||
      (
        item.observationKind !== undefined &&
        item.observationKind !== deliveryObservationKind(item.stage)
      )
    ) return null
  } else if (kind === 'trace.loss') {
    if (
      !positiveInteger(item.sequenceStart) || !positiveInteger(item.sequenceEnd) ||
      !positiveInteger(item.droppedCount) ||
      !['writer_unavailable_or_record_oversize', 'stream_evicted', 'in_memory_eviction'].includes(item.reason as string) ||
      (item.sessionId !== undefined && !opaqueId(item.sessionId)) ||
      (item.streamEpoch !== undefined && !isSafeDeliveryIdentifier(item.streamEpoch))
    ) return null
  } else if (kind === 'trace.stream.quiescent') {
    if (
      !opaqueId(item.sessionId) || !isSafeDeliveryIdentifier(item.streamEpoch) ||
      !positiveInteger(item.sequence) ||
      typeof item.quietMs !== 'number' || !Number.isFinite(item.quietMs) || item.quietMs < 0 ||
      !isDeliveryMessageKind(item.lastMessageKind) ||
      !['complete', 'incomplete', 'unknown'].includes(item.deliveryStatus as string) ||
      // A named stage is exactly what `incomplete` means. Either without the
      // other is a producer bug, and exporting it would put a stage label on a
      // verdict that did not attribute one.
      (item.deliveryStatus === 'incomplete') !== (item.stage !== undefined) ||
      (item.stage !== undefined && !isDeliveryStage(item.stage))
    ) return null
  } else if (kind === 'trace.stream.rollup') {
    if (
      !opaqueId(item.sessionId) || !isSafeDeliveryIdentifier(item.streamEpoch) ||
      !positiveInteger(item.sequence) ||
      typeof item.quietMs !== 'number' || !Number.isFinite(item.quietMs) || item.quietMs < 0 ||
      // Absent where no frame in the stream carried an SDK message. Unlike the
      // quiescence record, which is only ever written for a stream that had one.
      (item.lastMessageKind !== undefined && !isDeliveryMessageKind(item.lastMessageKind)) ||
      !['complete', 'incomplete', 'unknown'].includes(item.deliveryStatus as string) ||
      (item.deliveryStatus === 'incomplete') !== (item.stage !== undefined) ||
      (item.stage !== undefined && !isDeliveryStage(item.stage)) ||
      // A watermark of zero is the meaningful case, so these are counts, not ids.
      !WATERMARK_FIELDS.every(field => nonNegativeInteger(item[field])) ||
      (item.traceLossCount !== undefined && !positiveInteger(item.traceLossCount)) ||
      DELIVERY_ANOMALY_KINDS.some(anomaly => item[anomaly] !== undefined && !positiveInteger(item[anomaly]))
    ) return null
  } else if (kind === 'trace.ack.rejected') {
    if (
      !opaqueId(item.sessionId) || !isSafeDeliveryIdentifier(item.streamEpoch) ||
      !positiveInteger(item.sequence) ||
      !['invalid_shape', 'unknown_sequence', 'stale_document', 'stale_attempt'].includes(item.reason as string)
    ) return null
  } else if (
    !opaqueId(item.sessionId) || !isSafeDeliveryIdentifier(item.streamEpoch) ||
    !positiveInteger(item.sequence) || !isDeliveryStage(item.stage) ||
    (
      item.observationKind !== undefined &&
      item.observationKind !== deliveryObservationKind(item.stage)
    ) ||
    (
      item.anomalyScope !== undefined &&
      item.anomalyScope !== deliveryAnomalyScope(kind)
    ) ||
    // The gap and out_of_order kinds carry this too, and nothing else validated
    // it, so a rooted path in expectedSequence reached the export unchanged.
    (item.expectedSequence !== undefined && !positiveInteger(item.expectedSequence))
  ) {
    return null
  }
  return item as TraceRecord
}

export type RecordingCoverageStatus =
  | 'incomplete'
  | 'loss_observed'
  | 'active'
  | 'complete'
  | 'unknown'

export type LaunchCoverageStatus = 'complete' | 'active' | 'interrupted'

/**
 * `currentLaunchId` is required: omitting it silently classified the live launch
 * as interrupted, which is the difference between "this export is trustworthy"
 * and "something crashed".
 */
export function deriveRecordingCoverage(
  operationalRecords: readonly unknown[],
  traceRecords: readonly TraceRecord[],
  currentLaunchId: string,
  exportLimits: {
    sourceWindowTruncated?: boolean
    bundleLimitReached?: boolean
    sourceReadFailures?: number
    recordsRejected?: number
  } = {},
): Record<string, unknown> {
  const launches = new Map<string, {
    launchId: string
    startedAt: string | null
    lastRecordAt: string
    completed: boolean
  }>()
  let operationalRecordsSuppressed = 0
  let operationalRecordsDeduped = 0
  let deliveryTraceRecordsLost = 0
  let incompleteStreamCount = 0
  let currentLaunchIncomplete = 0

  for (const record of operationalRecords) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue
    const item = record as Record<string, unknown>
    if (typeof item.launchId !== 'string' || typeof item.timestamp !== 'string') continue
    const launch = launches.get(item.launchId) ?? {
      launchId: item.launchId,
      startedAt: null,
      lastRecordAt: item.timestamp,
      completed: false,
    }
    if (item.timestamp > launch.lastRecordAt) launch.lastRecordAt = item.timestamp
    if (item.event === 'app.start') launch.startedAt = item.timestamp
    if (item.event === 'app.shutdown.completed') launch.completed = true
    if (item.event === 'log.coverage.incomplete') {
      incompleteStreamCount++
      if (item.launchId === currentLaunchId) currentLaunchIncomplete++
    }
    if (item.event === 'log.suppressed') {
      const fields = item.fields as Record<string, unknown>
      // Two very different things used to share this counter: main deliberately
      // collapsing duplicates inside one second, and the sidecar dropping records
      // it could not keep up with. Only the second is evidence going missing, so
      // only the second may decide `lossObserved`.
      if (typeof fields.count === 'number') {
        if (fields.reason === 'rate_dedupe') operationalRecordsDeduped += fields.count
        else operationalRecordsSuppressed += fields.count
      }
    }
    launches.set(item.launchId, launch)
  }
  for (const record of traceRecords) {
    if (record.recordKind === 'trace.loss' && typeof record.droppedCount === 'number') {
      deliveryTraceRecordsLost += record.droppedCount
    }
  }

  const launchCoverage = [...launches.values()]
    .map(launch => ({
      launchId: launch.launchId,
      status: launch.completed
        ? 'complete'
        : launch.launchId === currentLaunchId
          ? 'active'
          : 'interrupted',
      startedAt: launch.startedAt,
      lastRecordAt: launch.lastRecordAt,
    }))
    .sort((a, b) => b.lastRecordAt.localeCompare(a.lastRecordAt))
  const knownLoss = operationalRecordsSuppressed + deliveryTraceRecordsLost > 0
  // Scoped to the CURRENT launch. A crash inside the retention window is real
  // history and stays in `launches[]`, but letting it decide this field made a
  // fortnight of exports report the live evidence as untrustworthy.
  const currentLaunch = launchCoverage.find(launch => launch.launchId === currentLaunchId)
  const evidenceMissing = currentLaunchIncomplete > 0 ||
    (exportLimits.sourceReadFailures ?? 0) > 0
  // A tail-based export is bounded by construction, so truncation and admission
  // limits describe the export's shape, not the evidence's integrity. Folding
  // them in left `status` unable to tell a good bundle from a bad one.
  const exportBounded = exportLimits.sourceWindowTruncated === true ||
    exportLimits.bundleLimitReached === true

  const status: RecordingCoverageStatus = evidenceMissing
    ? 'incomplete'
    : knownLoss
      ? 'loss_observed'
      : currentLaunch?.status === 'active'
        ? 'active'
        : currentLaunch?.status === 'complete'
          ? 'complete'
          : launchCoverage.length > 0
            ? 'active'
            : 'unknown'

  return {
    status,
    lossObserved: knownLoss,
    operationalRecordsSuppressed,
    operationalRecordsDeduped,
    deliveryTraceRecordsLost,
    incompleteStreamCount,
    currentLaunchIncompleteCount: currentLaunchIncomplete,
    interruptedLaunchCount: launchCoverage.filter(launch => launch.status === 'interrupted').length,
    exportBounded,
    sourceWindowTruncated: exportLimits.sourceWindowTruncated ?? false,
    bundleLimitReached: exportLimits.bundleLimitReached ?? false,
    sourceReadFailures: exportLimits.sourceReadFailures ?? 0,
    recordsRejected: exportLimits.recordsRejected ?? 0,
    launches: launchCoverage,
  }
}

export function deriveStuckSessionSummaries(records: readonly TraceRecord[]): Array<Record<string, unknown>> {
  const sessions = new Map<string, {
    sessionId: string; streamEpoch: string; produced: number; lastProducedFrameKind: string | null; socketSent: number; hostReceived: number;
    ipcSent: number; preloadReceived: number; applied: number; committed: number; anomalies: Record<string, number>;
    traceLossCount: number; coverage: Map<number, Set<string>>; frameKinds: Map<number, string>;
    latestDeliveryAt: string | null;
    latestQuiescence: { at: string; deliveryStatus: string; stage: string | null } | null;
  }>()
  let unassociatedTraceLossCount = 0
  for (const record of records) {
    if (record.recordKind === 'trace.loss') {
      const droppedCount = record.droppedCount as number
      if (typeof record.sessionId === 'string' && typeof record.streamEpoch === 'string') {
        const key = `${record.sessionId}\u0000${record.streamEpoch}`
        const state = sessions.get(key) ?? {
          sessionId: record.sessionId, streamEpoch: record.streamEpoch, produced: 0, lastProducedFrameKind: null, socketSent: 0,
          hostReceived: 0, ipcSent: 0, preloadReceived: 0, applied: 0, committed: 0, anomalies: {} as Record<string, number>, traceLossCount: 0,
          coverage: new Map(), frameKinds: new Map(), latestDeliveryAt: null, latestQuiescence: null,
        }
        state.traceLossCount = (state.traceLossCount ?? 0) + droppedCount
        sessions.set(key, state)
      } else {
        unassociatedTraceLossCount += droppedCount
      }
      continue
    }
    if (typeof record.sessionId !== 'string' || typeof record.streamEpoch !== 'string') continue
    const key = `${record.sessionId}\u0000${record.streamEpoch}`
    const state = sessions.get(key) ?? {
      sessionId: record.sessionId, streamEpoch: record.streamEpoch, produced: 0, lastProducedFrameKind: null, socketSent: 0,
      hostReceived: 0, ipcSent: 0, preloadReceived: 0, applied: 0, committed: 0, anomalies: {} as Record<string, number>, traceLossCount: 0,
      coverage: new Map(), frameKinds: new Map(), latestDeliveryAt: null, latestQuiescence: null,
    }
    const recordKind = record.recordKind
    if (typeof recordKind !== 'string') continue
    if (recordKind !== 'delivery.trace') {
      if (
        recordKind === 'trace.stream.quiescent' &&
        typeof record.wallTimestamp === 'string' &&
        typeof record.deliveryStatus === 'string' &&
        (
          state.latestQuiescence === null ||
          record.wallTimestamp > state.latestQuiescence.at
        )
      ) {
        state.latestQuiescence = {
          at: record.wallTimestamp,
          deliveryStatus: record.deliveryStatus,
          stage: typeof record.stage === 'string' ? record.stage : null,
        }
      }
      state.anomalies[recordKind] = (state.anomalies[recordKind] ?? 0) + 1
      sessions.set(key, state)
      continue
    }
    const sequence = record.sequence as number
    const coverage = state.coverage.get(sequence) ?? new Set<string>()
    coverage.add(record.stage as string)
    state.coverage.set(sequence, coverage)
    if (typeof record.frameKind === 'string') state.frameKinds.set(sequence, record.frameKind)
    if (
      typeof record.wallTimestamp === 'string' &&
      (state.latestDeliveryAt === null || record.wallTimestamp > state.latestDeliveryAt)
    ) {
      state.latestDeliveryAt = record.wallTimestamp
    }
    switch (record.stage) {
      case 'engine.produced':
        if (sequence >= state.produced) {
          state.produced = sequence
          state.lastProducedFrameKind = typeof record.frameKind === 'string' ? record.frameKind : null
        }
        break
      case 'sidecar.socket.sent': state.socketSent = Math.max(state.socketSent, sequence); break
      case 'host.received': state.hostReceived = Math.max(state.hostReceived, sequence); break
      case 'main.ipc.sent': state.ipcSent = Math.max(state.ipcSent, sequence); break
      case 'preload.received':
      case 'renderer.subscription.received': state.preloadReceived = Math.max(state.preloadReceived, sequence); break
      case 'renderer.state.applied': state.applied = Math.max(state.applied, sequence); break
      case 'renderer.ui.committed': state.committed = Math.max(state.committed, sequence); break
    }
    sessions.set(key, state)
  }
  return [...sessions.values()]
    .filter(state =>
      state.latestQuiescence !== null &&
      (
        state.latestDeliveryAt === null ||
        state.latestQuiescence.at > state.latestDeliveryAt
      ),
    )
    .map(state => ({
      ...withoutDerivedState(state),
      watermarks: contiguousBundleWatermarks(state.coverage, state.frameKinds),
      traceLossCount: state.traceLossCount + unassociatedTraceLossCount,
      firstMissingStage: state.latestQuiescence!.deliveryStatus === 'complete'
        ? null
        : state.latestQuiescence!.deliveryStatus === 'unknown'
          ? 'unknown'
          : state.latestQuiescence!.stage ?? 'unknown',
    }))
}

function withoutDerivedState<T extends {
  coverage: unknown
  frameKinds: unknown
  latestDeliveryAt: unknown
  latestQuiescence: unknown
}>(state: T): Omit<T, 'coverage' | 'frameKinds' | 'latestDeliveryAt' | 'latestQuiescence'> {
  const {
    coverage: _coverage,
    frameKinds: _frameKinds,
    latestDeliveryAt: _latestDeliveryAt,
    latestQuiescence: _latestQuiescence,
    ...rest
  } = state
  return rest
}

function contiguousBundleWatermarks(
  coverage: ReadonlyMap<number, ReadonlySet<string>>,
  frameKinds: ReadonlyMap<number, string>,
): Record<string, number> {
  const through = (stages: readonly string[], skipHostHandled = false): number => {
    let sequence = 1
    while (
      stages.some(stage => coverage.get(sequence)?.has(stage)) ||
      (skipHostHandled && frameKinds.get(sequence) === 'session-title')
    ) sequence++
    return sequence - 1
  }
  return {
    produced: through(['engine.produced']), socketSent: through(['sidecar.socket.sent']),
    hostReceived: through(['host.received']), ipcSent: through(['main.ipc.sent'], true),
    preloadReceived: through(['preload.received', 'renderer.subscription.received'], true),
    applied: through(['renderer.state.applied'], true), committed: through(['renderer.ui.committed']),
  }
}

export function deriveProcessInstances(
  operationalRecords: readonly unknown[],
  traceRecords: readonly TraceRecord[],
): Array<Record<string, unknown>> {
  const processes = new Map<string, Record<string, unknown>>()
  for (const record of operationalRecords) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue
    const item = record as Record<string, unknown>
    if (typeof item.processInstanceId !== 'string' || typeof item.process !== 'string') continue
    const previous = processes.get(item.processInstanceId)
    const fields = item.fields && typeof item.fields === 'object' && !Array.isArray(item.fields)
      ? item.fields as Record<string, unknown>
      : {}
    const isExit = item.event === 'process.exited'
    processes.set(item.processInstanceId, {
      processInstanceId: item.processInstanceId,
      role: item.process,
      pid: typeof item.pid === 'number' ? item.pid : 0,
      startedAt: previous?.startedAt ?? (typeof item.processStartedAt === 'string' ? item.processStartedAt : null),
      lastObservedAt: typeof item.timestamp === 'string' ? item.timestamp : null,
      lastEvent: typeof item.event === 'string' ? item.event : 'unknown',
      status: isExit ? 'exited' : previous?.status ?? 'observed',
      ...(isExit ? {
        exitCode: typeof fields.exitCode === 'number' ? fields.exitCode : null,
        signal: typeof fields.signal === 'string' ? fields.signal : null,
        expected: typeof fields.expected === 'boolean' ? fields.expected : null,
      } : {}),
    })
  }
  for (const record of traceRecords) {
    const id = record.processInstanceId
    if (typeof id !== 'string' || processes.has(id)) continue
    processes.set(id, {
      processInstanceId: id,
      role: typeof record.processName === 'string' ? record.processName : 'unknown',
      pid: null,
      startedAt: typeof record.processStartedAt === 'string' ? record.processStartedAt : null,
      lastObservedAt: typeof record.wallTimestamp === 'string' ? record.wallTimestamp : null,
      lastEvent: 'delivery.trace',
      status: 'observed',
    })
  }
  return [...processes.values()]
}

/** Every watermark a rollup carries; all required, and zero is a real answer. */
const WATERMARK_FIELDS = [
  'produced', 'socketSent', 'socketReceived', 'hostReceived',
  'ipcSent', 'preloadReceived', 'applied', 'committed',
] as const

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function opaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

function bounded(value: string): string {
  return value.slice(0, 256)
}

/** Build IDs are release metadata, never arbitrary environment diagnostics. */
function safeBuildIdentifier(value: string | undefined): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : null
}
