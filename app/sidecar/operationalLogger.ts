/** Sanitized sidecar → supervisor diagnostics descriptor (never stderr capture). */

import { randomUUID } from 'node:crypto'
import { createWriteStream, fstatSync, writeSync, type WriteStream } from 'node:fs'
import {
  createOperationalRecord,
  type OperationalRecordInput,
} from '../shared/operationalLog.js'
import type { DeliveryTrace, SidecarDeliveryStageRecord } from '../shared/deliveryTrace.js'

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
  const MAX_PENDING_WRITES = 64
  const MAX_PENDING_BYTES = 256 * 1024
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
  const enqueue = (text: string): boolean => {
    if (!streaming) return false
    if (streaming.writableLength > MAX_PENDING_BYTES) return false
    streaming.write(text)
    return true
  }
  /**
   * Silent loss reads as a quiet system. The count is the only thing the record
   * carries, so a saturated queue stays visible without widening the vocabulary.
   */
  const reportDrops = (): void => {
    if (droppedRecords === 0 || reportingDrops) return
    const count = droppedRecords
    droppedRecords = 0
    reportingDrops = true
    try {
      write({ level: 'warn', event: 'log.suppressed', fields: { count } })
    } finally {
      reportingDrops = false
    }
  }
  const write = (input: Omit<OperationalRecordInput, 'process'>): void => {
    if (!writable) return
    try {
      const record = createOperationalRecord(
        {
          ...input,
          process: 'sidecar',
          ...(input.appSessionId ?? appSessionId
            ? { appSessionId: input.appSessionId ?? appSessionId }
            : {}),
        },
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
        if (!enqueue(line)) droppedRecords++
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
        droppedRecords++
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
      else if (!enqueue(line)) droppedRecords++
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
