/** Sanitized sidecar → supervisor diagnostics descriptor (never stderr capture). */

import { randomUUID } from 'node:crypto'
import { writeSync } from 'node:fs'
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
}: {
  launchId?: string
  fd?: number
  processInstanceId?: string
} = {}): SidecarOperationalLogger {
  const writable = typeof launchId === 'string' && launchId.length > 0 && Number.isInteger(fd) && fd >= 3
  const processStartedAt = new Date().toISOString()
  let pendingWrites = 0
  const MAX_PENDING_WRITES = 64
  const write = (input: Omit<OperationalRecordInput, 'process'>): void => {
    if (!writable) return
    try {
      const record = createOperationalRecord(
        { ...input, process: 'sidecar' },
        { launchId: launchId as string, processInstanceId, processStartedAt },
      )
      const line = `${JSON.stringify(record)}\n`
      // A blocked diagnostics descriptor must never hold up a turn. Normal
      // records use a tiny bounded async queue; fatal evidence deliberately
      // takes the synchronous best-effort path immediately before process exit.
      if (record.level === 'fatal') {
        writeSync(fd as number, line)
      } else if (pendingWrites < MAX_PENDING_WRITES) {
        pendingWrites++
        setImmediate(() => {
          try {
            writeSync(fd as number, line)
          } catch {
            // The descriptor is diagnostics-only.
          } finally {
            pendingWrites--
          }
        })
      }
    } catch {
      // The pipe is diagnostics-only. Backpressure/error must not alter session IO.
    }
  }
  const deliveryStage = (input: Omit<SidecarDeliveryStageRecord, 'recordKind' | 'wallTimestamp' | 'monotonicTimestampMs' | 'processInstanceId' | 'processStartedAt'>): void => {
    if (!writable) return
    try {
      // The caller supplies only closed delivery metadata.  This is deliberately
      // synchronous: a process death after a socket failure must not erase the
      // causal marker that identifies the failed hop.
      const record: SidecarDeliveryStageRecord = {
        recordKind: 'delivery.trace',
        ...input,
        wallTimestamp: new Date().toISOString(),
        monotonicTimestampMs: performance.now(),
        processInstanceId,
        processStartedAt,
      }
      writeSync(fd as number, `${JSON.stringify(record)}\n`)
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
