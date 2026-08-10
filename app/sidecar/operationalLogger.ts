/** Sanitized sidecar → supervisor diagnostics descriptor (never stderr capture). */

import { randomUUID } from 'node:crypto'
import { createWriteStream, fstatSync, writeSync, type WriteStream } from 'node:fs'
import {
  createOperationalRecord,
  MAX_OPERATIONAL_STRING_BYTES,
  type OperationalRecordInput,
} from '../shared/operationalLog.js'
import type { DeliveryTrace, SidecarDeliveryStageRecord } from '../shared/deliveryTrace.js'

/**
 * Records do not all pay for a stalled reader equally. A record that explains
 * what a session did is worth far more after the fact than one that merely
 * samples its health, and shedding both at one threshold loses them with equal
 * probability: a single `queue_saturated` event shed 3,317 records on
 * 2026-08-10 and took the turn's shape with it. That figure is the requesting
 * investigation's measurement, filed as item B4 in
 * `docs/reports/2026-08-10-overnight-hang-log-request.md`.
 */
type RecordPriority = 'lifecycle' | 'anomaly' | 'sample'

/**
 * A closed "never shed under normal saturation" set rather than a default:
 * an event added to the shared vocabulary later falls to `sample`, which
 * costs resolution instead of raising the memory a stuck reader can pin.
 * `log.suppressed` sits here because it is the record that reports the
 * shedding; losing it makes every other loss unattributable.
 */
const LIFECYCLE_EVENTS: ReadonlySet<string> = new Set([
  'app.start', 'app.single_instance.refused', 'app.ready', 'app.shutdown.started',
  'app.shutdown.completed', 'app.fatal',
  'process.started', 'process.exited',
  'window.created',
  'renderer.load.started', 'renderer.load.ready', 'renderer.load.failed',
  'renderer.process.gone',
  'renderer.recovery.started', 'renderer.recovery.succeeded', 'renderer.recovery.exhausted',
  'registry.load.completed',
  'session.create.requested',
  'sidecar.spawn.started', 'sidecar.spawn.failed', 'sidecar.socket.connected',
  'sidecar.ready', 'sidecar.disconnected', 'sidecar.exit',
  'session.restore.started', 'session.restore.completed', 'session.restore.failed',
  'worker.started', 'worker.completed', 'worker.failed',
  'log.suppressed', 'log.coverage.incomplete',
])

/**
 * Level carries the anomaly signal: the same `diagnostic` event is a legacy
 * failure line at `warn` and routine narration at `info`, so the producer's
 * own severity is the only thing that separates them here.
 */
const priorityOf = (level: string, event: string): RecordPriority => {
  if (LIFECYCLE_EVENTS.has(event)) return 'lifecycle'
  return level === 'warn' || level === 'error' || level === 'fatal' ? 'anomaly' : 'sample'
}

export type SidecarOperationalLogger = {
  write(input: Omit<OperationalRecordInput, 'process'>): void
  deliveryStage(input: Omit<SidecarDeliveryStageRecord, 'recordKind' | 'wallTimestamp' | 'monotonicTimestampMs' | 'processInstanceId' | 'processStartedAt'>): void
  legacy(line: string): void
}

/**
 * FD 3 is supplied by the supervisor. Missing/broken descriptors intentionally
 * degrade to no persistent record; they never block engine execution or cause us
 * to copy raw stderr into a support artifact.
 */
export function createSidecarOperationalLogger({
  launchId = process.env.CATCODE_OPERATIONAL_LAUNCH_ID,
  fd = Number(process.env.CATCODE_OPERATIONAL_FD),
  processInstanceId = randomUUID(),
  appSessionId,
}: {
  launchId?: string
  fd?: number
  processInstanceId?: string
  /**
   * Stamped on every record that does not carry its own. The supervisor accepts
   * a sidecar record only when `appSessionId` matches the session it spawned
   * (`app/supervisor/supervisor.ts`), so a record without one is discarded at
   * that boundary — which silently ate both the `legacy` stream and the
   * `log.suppressed` counter that reports the dropping.
   */
  appSessionId?: string
} = {}): SidecarOperationalLogger {
  const writable = typeof launchId === 'string' && launchId.length > 0 && Number.isInteger(fd) && fd >= 3
  const processStartedAt = new Date().toISOString()
  let pendingWrites = 0
  let droppedRecords = 0
  let reportingDrops = false
  /**
   * Keyed by the operational event, or by `delivery.trace` for a delivery-stage
   * marker, which carries a stage rather than an event. Bucketing strictly by
   * event name would leave exactly those markers unaccounted for while still
   * counting them in `droppedRecords`.
   */
  const droppedByType = new Map<string, number>()
  const MAX_PENDING_WRITES = 64
  /**
   * The threshold governs the drop decision, not the write order: samples stop
   * being accepted well before anomalies, and anomalies well before lifecycle,
   * so a stalled reader costs resolution before it costs the timeline.
   *
   * Lifecycle gets a high ceiling rather than none. An unconditional enqueue
   * turns a stuck reader into an unbounded leak, which is the exact failure
   * this non-blocking queue exists to prevent. One megabyte holds on the order
   * of three thousand lifecycle records, far past what any real session emits,
   * while bounding what one wedged sidecar can pin.
   */
  const MAX_PENDING_BYTES: Readonly<Record<RecordPriority, number>> = {
    lifecycle: 1024 * 1024,
    anomaly: 256 * 1024,
    sample: 64 * 1024,
  }
  const MAX_DROP_BUCKETS = 6
  /**
   * Only a pipe or socket can make a write wait for the reader. FD 3 is a pipe
   * in production, and its reader is Electron main, which blocks its own loop on
   * synchronous reads while assembling a support bundle. A synchronous write
   * would then stall a turn, so those descriptors get a userspace queue that
   * never waits. A regular file cannot block that way and keeps the direct path,
   * which is also what the tests exercise.
   */
  const streaming = ((): WriteStream | null => {
    if (!writable) return null
    try {
      const stats = fstatSync(fd as number)
      if (!stats.isFIFO() && !stats.isSocket()) return null
      const stream = createWriteStream('', { fd: fd as number, autoClose: false })
      stream.on('error', () => {
        // The descriptor is diagnostics-only; a broken pipe cannot alter session IO.
      })
      stream.on('drain', () => reportDrops())
      return stream
    } catch {
      return null
    }
  })()
  /**
   * A descriptor may accept fewer bytes than the record. Ignoring the return
   * value leaves a truncated line, which corrupts the NDJSON that follows it
   * rather than losing one record cleanly.
   */
  const writeAll = (descriptor: number, text: string): void => {
    const payload = Buffer.from(text, 'utf8')
    let offset = 0
    while (offset < payload.byteLength) {
      const written = writeSync(descriptor, payload, offset, payload.byteLength - offset)
      if (written <= 0) return
      offset += written
    }
  }
  /** Returns false when the record was dropped rather than queued. */
  const enqueue = (text: string, priority: RecordPriority): boolean => {
    if (!streaming) return false
    if (streaming.writableLength > MAX_PENDING_BYTES[priority]) return false
    streaming.write(text)
    return true
  }
  const noteDrop = (type: string): void => {
    droppedRecords++
    droppedByType.set(type, (droppedByType.get(type) ?? 0) + 1)
  }
  /**
   * Fields are flat scalars, so the breakdown travels as one compact string in
   * the existing `category` slot. Whole buckets are left out rather than leaning
   * on `sanitizeOperationalText`, which truncates silently and would leave a
   * corrupt trailing entry in place of a missing one.
   */
  const formatDroppedByType = (): string => {
    const ordered = [...droppedByType.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, MAX_DROP_BUCKETS)
    let text = ''
    for (const [type, count] of ordered) {
      const entry = `${text.length > 0 ? ',' : ''}${type}:${count}`
      if (Buffer.byteLength(text, 'utf8') + Buffer.byteLength(entry, 'utf8') > MAX_OPERATIONAL_STRING_BYTES) break
      text += entry
    }
    return text
  }
  /**
   * Silent loss reads as a quiet system, and a bare count leaves what was lost
   * unknowable after the fact. The count plus the per-type breakdown keeps a
   * saturated queue attributable without widening the vocabulary.
   */
  const reportDrops = (): void => {
    if (droppedRecords === 0 || reportingDrops) return
    const count = droppedRecords
    const category = formatDroppedByType()
    droppedRecords = 0
    droppedByType.clear()
    reportingDrops = true
    try {
      write({
        level: 'warn',
        event: 'log.suppressed',
        fields: { count, reason: 'queue_saturated', category },
      })
    } finally {
      reportingDrops = false
    }
  }
  const write = (input: Omit<OperationalRecordInput, 'process'>): void => {
    if (!writable) return
    try {
      const record = createOperationalRecord(
        // `createOperationalRecord` already drops a falsy `appSessionId`, so this
        // needs no conditional spread of its own.
        { ...input, process: 'sidecar', appSessionId: input.appSessionId ?? appSessionId },
        { launchId: launchId as string, processInstanceId, processStartedAt },
      )
      const line = `${JSON.stringify(record)}\n`
      // A blocked diagnostics descriptor must never hold up a turn. Fatal
      // evidence deliberately takes the synchronous best-effort path immediately
      // before process exit, accepting a brief stall in a process that is ending
      // rather than losing the record that explains why.
      if (record.level === 'fatal') {
        writeAll(fd as number, line)
      } else if (streaming) {
        if (!enqueue(line, priorityOf(record.level, record.event))) noteDrop(record.event)
      } else if (pendingWrites < MAX_PENDING_WRITES) {
        pendingWrites++
        setImmediate(() => {
          try {
            writeAll(fd as number, line)
          } catch {
            // The descriptor is diagnostics-only.
          } finally {
            pendingWrites--
            if (pendingWrites === 0) reportDrops()
          }
        })
      } else {
        noteDrop(record.event)
      }
    } catch {
      // The pipe is diagnostics-only. Backpressure/error must not alter session IO.
    }
  }
  const deliveryStage = (input: Omit<SidecarDeliveryStageRecord, 'recordKind' | 'wallTimestamp' | 'monotonicTimestampMs' | 'processInstanceId' | 'processStartedAt'>): void => {
    if (!writable) return
    try {
      // The caller supplies only closed delivery metadata. These markers sit
      // directly in the frame path, which is exactly where a synchronous write
      // to a full pipe would stall a turn, so on a pipe they queue like any
      // other record. The original intent was that a process death must not
      // erase the marker for the failed hop; that now yields to not stalling
      // the hop in the first place, and a regular file still writes directly.
      const record: SidecarDeliveryStageRecord = {
        recordKind: 'delivery.trace',
        ...input,
        wallTimestamp: new Date().toISOString(),
        monotonicTimestampMs: performance.now(),
        processInstanceId,
        processStartedAt,
      }
      const line = `${JSON.stringify(record)}\n`
      if (!streaming) writeAll(fd as number, line)
      // A stage marker carries a stage, not an event, so it cannot be classified
      // by the table above. It is `sample`: one marker per frame per hop makes it
      // the highest-volume producer on this descriptor, and its value is
      // statistical — the population shows where frames stop arriving, no single
      // marker explains a session.
      else if (!enqueue(line, 'sample')) noteDrop(record.recordKind)
    } catch {
      // Descriptor evidence is best effort and cannot alter engine IO.
    }
  }
  return {
    write,
    deliveryStage,
    legacy(line) {
      write({
        level: /fatal|fail|error|invalid|overflow/i.test(line) ? 'warn' : 'info',
        event: 'diagnostic',
        // A sidecar's legacy line can contain raw engine diagnostics. Keep the
        // category, never the line itself, on the side-channel.
        fields: {
          source: 'sidecar',
          category: /fatal|fail|error|invalid|overflow/i.test(line) ? 'legacy_failure' : 'legacy_notice',
        },
      })
    },
  }
}
