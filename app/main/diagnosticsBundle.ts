/** Local-only support export assembled from closed, redacted JSONL records. */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { release as osRelease } from 'node:os'
import { parseOperationalRecord } from '../shared/operationalLog.js'
import {
  MAX_DELIVERY_TRACE_AGE_MS,
  MAX_DELIVERY_TRACE_FILES,
  MAX_DELIVERY_TRACE_FILE_BYTES,
  MAX_DELIVERY_TRACE_RECORD_BYTES,
  MAX_DELIVERY_TRACE_TOTAL_BYTES,
} from './deliveryTraceSink.js'
import {
  deliveryObservationKind,
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

const MAX_BUNDLE_BYTES = 2 * 1024 * 1024
const MAX_FILE_BYTES = 512 * 1024

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
  currentLaunchId?: string
  buildId?: string
  commitId?: string
}): string {
  const streams: { operational: unknown[]; deliveryTrace: TraceRecord[] } = { operational: [], deliveryTrace: [] }
  let includedBytes = 0
  if (existsSync(logsDirectory)) {
    const now = Date.now()
    const candidates: Array<{ name: string; mtimeMs: number }> = []
    for (const name of readdirSync(logsDirectory)) {
      try {
        const stat = statSync(join(logsDirectory, name))
        if (stat.isFile() && now - stat.mtimeMs <= Math.max(MAX_OPERATIONAL_LOG_AGE_MS, MAX_DELIVERY_TRACE_AGE_MS)) {
          candidates.push({ name, mtimeMs: stat.mtimeMs })
        }
      } catch {}
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const { name } of candidates) {
      const target = name.startsWith('operational-')
        ? streams.operational
        : name.startsWith('delivery-trace-')
          ? streams.deliveryTrace
          : null
      if (!target) continue
      try {
        // Take the tail and parse newest complete records first, so an incident
        // immediately before export wins admission over old retained history.
        const text = readFileSync(join(logsDirectory, name), 'utf8').slice(-MAX_FILE_BYTES)
        for (const line of text.split('\n').reverse()) {
          if (!line) continue
          const value = JSON.parse(line) as unknown
          const safe = target === streams.operational
            ? parseOperationalRecord(value)
            : parseDeliveryTraceRecord(value)
          if (!safe) continue
          const bytes = Buffer.byteLength(JSON.stringify(safe))
          if (includedBytes + bytes > MAX_BUNDLE_BYTES / 2) break
          target.push(safe)
          includedBytes += bytes
        }
      } catch {
        // A concurrently rotated/broken log is omitted rather than failing export.
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
      schemas: { operational: 1, deliveryTrace: 1 },
      limits: {
        operational: { recordBytes: MAX_OPERATIONAL_RECORD_BYTES, fileBytes: MAX_OPERATIONAL_LOG_BYTES, totalBytes: MAX_OPERATIONAL_LOG_TOTAL_BYTES, files: MAX_OPERATIONAL_LOG_FILES, ageMs: MAX_OPERATIONAL_LOG_AGE_MS },
        deliveryTrace: { recordBytes: MAX_DELIVERY_TRACE_RECORD_BYTES, fileBytes: MAX_DELIVERY_TRACE_FILE_BYTES, totalBytes: MAX_DELIVERY_TRACE_TOTAL_BYTES, files: MAX_DELIVERY_TRACE_FILES, ageMs: MAX_DELIVERY_TRACE_AGE_MS },
      },
      recordCounts: { operational: streams.operational.length, deliveryTrace: streams.deliveryTrace.length },
    },
    processInstances: deriveProcessInstances(streams.operational, streams.deliveryTrace),
    recordingCoverage: deriveRecordingCoverage(
      streams.operational,
      streams.deliveryTrace,
      currentLaunchId,
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
      'connectionEpoch', 'frameKind', 'processStartedAt', 'observationKind',
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
      item.anomalyScope !== (kind === 'trace.sequence.gap' ? 'source_sequence' : 'stage_sequence')
    ) ||
    // The gap and out_of_order kinds carry this too, and nothing else validated
    // it, so a rooted path in expectedSequence reached the export unchanged.
    (item.expectedSequence !== undefined && !positiveInteger(item.expectedSequence))
  ) {
    return null
  }
  return item as TraceRecord
}

export function deriveRecordingCoverage(
  operationalRecords: readonly unknown[],
  traceRecords: readonly TraceRecord[],
  currentLaunchId?: string,
): Record<string, unknown> {
  const launches = new Map<string, {
    launchId: string
    startedAt: string | null
    lastRecordAt: string
    completed: boolean
  }>()
  let operationalRecordsSuppressed = 0
  let deliveryTraceRecordsLost = 0
  let incompleteStreamCount = 0

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
    if (item.event === 'log.coverage.incomplete') incompleteStreamCount++
    if (item.event === 'log.suppressed') {
      const fields = item.fields as Record<string, unknown>
      if (typeof fields.count === 'number') operationalRecordsSuppressed += fields.count
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
  const incomplete = incompleteStreamCount > 0 ||
    launchCoverage.some(launch => launch.status === 'interrupted')
  const active = launchCoverage.some(launch => launch.status === 'active')

  return {
    status: incomplete
      ? 'incomplete'
      : knownLoss
        ? 'loss_observed'
        : active
          ? 'active'
          : launchCoverage.length > 0
            ? 'complete'
            : 'unknown',
    lossObserved: knownLoss,
    operationalRecordsSuppressed,
    deliveryTraceRecordsLost,
    incompleteStreamCount,
    launches: launchCoverage,
  }
}

export function deriveStuckSessionSummaries(records: readonly TraceRecord[]): Array<Record<string, unknown>> {
  const sessions = new Map<string, {
    sessionId: string; streamEpoch: string; produced: number; lastProducedFrameKind: string | null; socketSent: number; hostReceived: number;
    ipcSent: number; preloadReceived: number; applied: number; committed: number; anomalies: Record<string, number>;
    traceLossCount: number; coverage: Map<number, Set<string>>;
  }>()
  let unassociatedTraceLossCount = 0
  for (const record of records) {
    if (record.recordKind === 'trace.loss') {
      const droppedCount = record.droppedCount as number
      if (typeof record.sessionId === 'string' && typeof record.streamEpoch === 'string') {
        const key = `${record.sessionId}\u0000${record.streamEpoch}`
        const state = sessions.get(key) ?? {
          sessionId: record.sessionId, streamEpoch: record.streamEpoch, produced: 0, lastProducedFrameKind: null, socketSent: 0,
          hostReceived: 0, ipcSent: 0, preloadReceived: 0, applied: 0, committed: 0, anomalies: {} as Record<string, number>, traceLossCount: 0, coverage: new Map(),
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
      hostReceived: 0, ipcSent: 0, preloadReceived: 0, applied: 0, committed: 0, anomalies: {} as Record<string, number>, traceLossCount: 0, coverage: new Map(),
    }
    const recordKind = record.recordKind
    if (typeof recordKind !== 'string') continue
    if (recordKind !== 'delivery.trace') {
      state.anomalies[recordKind] = (state.anomalies[recordKind] ?? 0) + 1
      sessions.set(key, state)
      continue
    }
    const sequence = record.sequence as number
    const coverage = state.coverage.get(sequence) ?? new Set<string>()
    coverage.add(record.stage as string)
    state.coverage.set(sequence, coverage)
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
  return [...sessions.values()].map(state => ({
    ...withoutCoverage(state),
    watermarks: contiguousBundleWatermarks(state.coverage),
    traceLossCount: state.traceLossCount + unassociatedTraceLossCount,
    firstMissingStage: firstMissingFromCoverage(state.coverage),
  }))
}

function withoutCoverage<T extends { coverage: unknown }>(state: T): Omit<T, 'coverage'> {
  const { coverage: _coverage, ...rest } = state
  return rest
}

function contiguousBundleWatermarks(coverage: ReadonlyMap<number, ReadonlySet<string>>): Record<string, number> {
  const through = (stages: readonly string[]): number => {
    let sequence = 1
    while (stages.some(stage => coverage.get(sequence)?.has(stage))) sequence++
    return sequence - 1
  }
  return {
    produced: through(['engine.produced']), socketSent: through(['sidecar.socket.sent']),
    hostReceived: through(['host.received']), ipcSent: through(['main.ipc.sent']),
    preloadReceived: through(['preload.received', 'renderer.subscription.received']),
    applied: through(['renderer.state.applied']), committed: through(['renderer.ui.committed']),
  }
}

function firstMissingFromCoverage(coverage: ReadonlyMap<number, ReadonlySet<string>>): string | null {
  const produced = contiguousBundleWatermarks(coverage).produced
  for (let sequence = 1; sequence <= produced; sequence++) {
    const stages = coverage.get(sequence) ?? new Set<string>()
    if (!stages.has('sidecar.socket.sent')) return 'sidecar.socket.sent'
    if (!stages.has('host.received')) return 'host.received'
    if (!stages.has('main.ipc.sent')) return 'main.ipc.sent'
    if (!stages.has('preload.received') && !stages.has('renderer.subscription.received')) return 'preload.received'
    if (!stages.has('renderer.state.applied')) return 'renderer.state.applied'
    if (!stages.has('renderer.ui.committed')) return 'renderer.ui.committed'
  }
  return null
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

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
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
