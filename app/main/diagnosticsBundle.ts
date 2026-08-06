/** Local-only support export assembled from closed, redacted JSONL records. */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
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
  buildId,
  commitId,
}: {
  logsDirectory: string
  appVersion: string
  packaged?: boolean
  buildId?: string
  commitId?: string
}): string {
  const streams: { operational: unknown[]; deliveryTrace: TraceRecord[] } = { operational: [], deliveryTrace: [] }
  let includedBytes = 0
  if (existsSync(logsDirectory)) {
    for (const name of readdirSync(logsDirectory).sort()) {
      const target = name.startsWith('operational-')
        ? streams.operational
        : name.startsWith('delivery-trace-')
          ? streams.deliveryTrace
          : null
      if (!target) continue
      try {
        const text = readFileSync(join(logsDirectory, name), 'utf8').slice(0, MAX_FILE_BYTES)
        for (const line of text.split('\n')) {
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
      'connectionEpoch', 'frameKind', 'processStartedAt',
    ],
    'trace.loss': [
      'schemaVersion', 'recordKind', 'wallTimestamp', 'monotonicTimestampMs', 'launchId',
      'processName', 'processInstanceId', 'sequenceStart', 'sequenceEnd', 'droppedCount', 'reason',
      'sessionId', 'streamEpoch',
    ],
    'trace.sequence.gap': [
      'schemaVersion', 'recordKind', 'wallTimestamp', 'monotonicTimestampMs', 'launchId',
      'processName', 'processInstanceId', 'sessionId', 'streamEpoch', 'sequence', 'stage', 'expectedSequence',
    ],
    'trace.sequence.duplicate': [
      'schemaVersion', 'recordKind', 'wallTimestamp', 'monotonicTimestampMs', 'launchId',
      'processName', 'processInstanceId', 'sessionId', 'streamEpoch', 'sequence', 'stage',
    ],
    'trace.sequence.out_of_order': [
      'schemaVersion', 'recordKind', 'wallTimestamp', 'monotonicTimestampMs', 'launchId',
      'processName', 'processInstanceId', 'sessionId', 'streamEpoch', 'sequence', 'stage', 'expectedSequence',
    ],
    'trace.ack.rejected': [
      'schemaVersion', 'recordKind', 'wallTimestamp', 'monotonicTimestampMs', 'launchId',
      'processName', 'processInstanceId', 'sessionId', 'streamEpoch', 'sequence', 'reason',
    ],
  }
  if (typeof kind !== 'string' || !allowedByKind[kind] || Object.keys(item).some(key => !allowedByKind[kind]!.includes(key))) return null
  if (item.schemaVersion !== 1 || typeof item.wallTimestamp !== 'string' || Number.isNaN(Date.parse(item.wallTimestamp)) || typeof item.monotonicTimestampMs !== 'number' || typeof item.launchId !== 'string' || typeof item.processName !== 'string' || typeof item.processInstanceId !== 'string') return null
  if (kind === 'delivery.trace') {
    if (
      !['engine', 'sidecar', 'supervisor', 'host', 'attachment-gate', 'ipc-bridge', 'preload', 'renderer'].includes(item.component as string) ||
      !['bun-sidecar', 'electron-main', 'electron-renderer'].includes(item.processName as string) ||
      typeof item.sessionId !== 'string' || typeof item.streamEpoch !== 'string' ||
      !positiveInteger(item.sequence) || typeof item.traceId !== 'string' ||
      !positiveInteger(item.deliveryAttempt) || typeof item.replay !== 'boolean' || typeof item.stage !== 'string' ||
      !positiveInteger(item.connectionEpoch) ||
      (item.frameKind !== undefined && (typeof item.frameKind !== 'string' || !/^[a-z][a-z0-9.-]{0,95}$/.test(item.frameKind))) ||
      (item.processStartedAt !== undefined && (typeof item.processStartedAt !== 'string' || Number.isNaN(Date.parse(item.processStartedAt)))) ||
      (item.documentId !== undefined && typeof item.documentId !== 'string') ||
      (item.subscriptionEpoch !== undefined && !positiveInteger(item.subscriptionEpoch))
    ) return null
  } else if (kind === 'trace.loss') {
    if (
      !positiveInteger(item.sequenceStart) || !positiveInteger(item.sequenceEnd) ||
      !positiveInteger(item.droppedCount) || typeof item.reason !== 'string' ||
      (item.sessionId !== undefined && typeof item.sessionId !== 'string') ||
      (item.streamEpoch !== undefined && typeof item.streamEpoch !== 'string')
    ) return null
  } else if (kind === 'trace.ack.rejected') {
    if (
      typeof item.sessionId !== 'string' || typeof item.streamEpoch !== 'string' ||
      !positiveInteger(item.sequence) || typeof item.reason !== 'string'
    ) return null
  } else if (typeof item.sessionId !== 'string' || typeof item.streamEpoch !== 'string' || !positiveInteger(item.sequence) || typeof item.stage !== 'string') {
    return null
  }
  return item as TraceRecord
}

export function deriveStuckSessionSummaries(records: readonly TraceRecord[]): Array<Record<string, unknown>> {
  const sessions = new Map<string, {
    sessionId: string; streamEpoch: string; produced: number; lastProducedFrameKind: string | null; socketSent: number; hostReceived: number;
    ipcSent: number; preloadReceived: number; applied: number; committed: number; anomalies: Record<string, number>;
    traceLossCount: number;
  }>()
  let unassociatedTraceLossCount = 0
  for (const record of records) {
    if (record.recordKind === 'trace.loss') {
      const droppedCount = record.droppedCount as number
      if (typeof record.sessionId === 'string' && typeof record.streamEpoch === 'string') {
        const key = `${record.sessionId}\u0000${record.streamEpoch}`
        const state = sessions.get(key) ?? {
          sessionId: record.sessionId, streamEpoch: record.streamEpoch, produced: 0, lastProducedFrameKind: null, socketSent: 0,
          hostReceived: 0, ipcSent: 0, preloadReceived: 0, applied: 0, committed: 0, anomalies: {}, traceLossCount: 0,
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
      hostReceived: 0, ipcSent: 0, preloadReceived: 0, applied: 0, committed: 0, anomalies: {}, traceLossCount: 0,
    }
    const recordKind = record.recordKind
    if (typeof recordKind !== 'string') continue
    if (recordKind !== 'delivery.trace') {
      state.anomalies[recordKind] = (state.anomalies[recordKind] ?? 0) + 1
      sessions.set(key, state)
      continue
    }
    const sequence = record.sequence as number
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
    ...state,
    traceLossCount: state.traceLossCount + unassociatedTraceLossCount,
    firstMissingStage: state.produced > state.socketSent ? 'sidecar.socket.sent'
      : state.socketSent > state.hostReceived ? 'host.received'
      : state.hostReceived > state.ipcSent ? 'main.ipc.sent'
      : state.ipcSent > state.preloadReceived ? 'preload.received'
      : state.preloadReceived > state.applied ? 'renderer.state.applied'
      : state.applied > state.committed ? 'renderer.ui.committed' : null,
  }))
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

function bounded(value: string): string {
  return value.slice(0, 256)
}

/** Build IDs are release metadata, never arbitrary environment diagnostics. */
function safeBuildIdentifier(value: string | undefined): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : null
}
