/** Main-owned private JSONL sink for the desktop operational log. */

import { chmodSync, closeSync, fstatSync, fsyncSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  ensurePrivateDirectory,
  retainJsonlFiles,
  updateLatestSymlink,
} from './jsonlRetention.js'
import {
  createOperationalRecord,
  type OperationalRecord,
  type OperationalRecordInput,
} from '../shared/operationalLog.js'

export const OPERATIONAL_LOG_DIR = 'logs'
export const MAX_OPERATIONAL_LOG_BYTES = 512 * 1024
export const MAX_OPERATIONAL_RECORD_BYTES = 16 * 1024
export const MAX_OPERATIONAL_LOG_TOTAL_BYTES = 8 * 1024 * 1024
export const MAX_OPERATIONAL_LOG_FILES = 16
export const MAX_OPERATIONAL_LOG_AGE_MS = 14 * 24 * 60 * 60 * 1000

/**
 * Exempt from the one-second rate dedupe below. That dedupe keys on
 * `event:appSessionId:reason`, which is right for a failure repeating in a
 * loop and wrong for turn lifecycle: two quick turns in one session share all
 * three parts, so the second pair was suppressed and a real `started` /
 * `completed` became silence. These events are bounded by actual turns rather
 * than by failure duration, so they cannot run away (OBSERVABILITY-MINIMUM §5).
 *
 * `peer.message.routed` fails the same key for a structural reason rather than
 * a coincidental one. Its permitted fields are `from, to, kind, messageId,
 * outcome` (`operationalLog.ts`), so there is no `reason` and the third segment
 * is always empty; its `appSessionId` is deliberately always the SENDER's
 * (`peerRequestPlane.ts`), so the second segment is fixed for a whole fan-out.
 * Two different messages to different peers with different outcomes therefore
 * collide, and the second one is dropped. It is bounded the same way turn
 * lifecycle is (one line per message a model actually sent, and sends
 * serialize), so it cannot run away either. Re-keying on the varying fields is
 * the wrong lever: the same key serves `renderer.health.sample` and
 * `diagnostic`, whose fields vary by construction, so widening it would retire
 * the dedupe for the sampled events it exists for (PEER-SESSIONS §10).
 */
const DEDUPE_EXEMPT_EVENTS: ReadonlySet<string> = new Set([
  'session.turn.started',
  'session.turn.completed',
  'session.turn.stalled',
  'peer.message.routed',
])

export type OperationalLogSink = {
  readonly launchId: string
  readonly processInstanceId: string
  write(input: OperationalRecordInput): void
  writeRecord(record: OperationalRecord): void
  flushFatal(input: OperationalRecordInput): void
  getDirectory(): string
  close(): void
}

export function createOperationalLogSink({
  configDir,
  launchId = randomUUID(),
  processInstanceId = randomUUID(),
  now = () => new Date(),
  maxFileBytes = MAX_OPERATIONAL_LOG_BYTES,
  maxTotalBytes = MAX_OPERATIONAL_LOG_TOTAL_BYTES,
  maxFiles = MAX_OPERATIONAL_LOG_FILES,
  maxAgeMs = MAX_OPERATIONAL_LOG_AGE_MS,
}: {
  configDir: string
  launchId?: string
  processInstanceId?: string
  now?: () => Date
  maxFileBytes?: number
  maxTotalBytes?: number
  maxFiles?: number
  maxAgeMs?: number
}): OperationalLogSink {
  const directory = join(configDir, OPERATIONAL_LOG_DIR)
  const processStartedAt = now().toISOString()
  let fd: number | null = null
  let file = ''
  let failed = false
  let suppressed = 0
  const recent = new Map<string, { at: number; count: number }>()

  const ensureOpen = (): boolean => {
    if (failed) return false
    try {
      ensurePrivateDirectory(directory)
      if (fd === null) {
        file = join(directory, `operational-${launchId}-${Date.now()}.jsonl`)
        fd = openSync(file, 'a', 0o600)
        chmodSync(file, 0o600)
        updateLatestSymlink(directory, 'latest-operational', file)
        retainJsonlFiles({
          directory,
          prefix: 'operational-',
          current: now().getTime(),
          maxTotalBytes,
          maxFiles,
          maxAgeMs,
          activeFile: file,
        })
      }
      return true
    } catch {
      failed = true
      return false
    }
  }

  const append = (record: OperationalRecord, sync: boolean): void => {
    if (!ensureOpen() || fd === null) return
    const line = `${JSON.stringify(record)}\n`
    if (Buffer.byteLength(line) > MAX_OPERATIONAL_RECORD_BYTES) {
      return
    }
    try {
      if (fstatSync(fd).size + Buffer.byteLength(line) > maxFileBytes) {
        closeSync(fd)
        fd = null
        file = ''
        if (!ensureOpen() || fd === null) return
      }
      writeSync(fd, line)
      if (sync) {
        // `fsyncSync` is intentionally avoided for normal records. Fatal
        // evidence pays one bounded durability sync before close.
        fsyncSync(fd)
        closeSync(fd)
        fd = null
      }
    } catch {
      // A full disk or permissions change must not recursively log and crash app.
      failed = true
    }
  }

  const write = (input: OperationalRecordInput, sync = false): void => {
    const key = `${input.event}:${input.appSessionId ?? ''}:${input.fields?.reason ?? ''}`
    const current = now().getTime()
    const prior = recent.get(key)
    if (
      input.level !== 'fatal' &&
      !DEDUPE_EXEMPT_EVENTS.has(input.event) &&
      prior &&
      current - prior.at < 1_000
    ) {
      prior.count++
      suppressed++
      return
    }
    if (suppressed > 0 && input.event !== 'log.suppressed') {
      const count = suppressed
      suppressed = 0
      append(
        createOperationalRecord(
          { level: 'warn', event: 'log.suppressed', process: 'main', fields: { count, reason: 'rate_dedupe' } },
          { launchId, processInstanceId, now, processStartedAt },
        ),
        false,
      )
    }
    recent.set(key, { at: current, count: 0 })
    try {
      append(createOperationalRecord(input, { launchId, processInstanceId, now, processStartedAt }), sync)
    } catch {
      // Producer validation is deliberately fail-closed, but a malformed
      // best-effort diagnostic must never destabilize the desktop process.
    }
  }

  return {
    launchId,
    processInstanceId,
    write(input) {
      write(input)
    },
    writeRecord(record) {
      append(record, record.level === 'fatal')
    },
    flushFatal(input) {
      write({ ...input, level: 'fatal' }, true)
    },
    getDirectory() {
      return directory
    },
    close() {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          // Best effort during teardown.
        }
        fd = null
      }
    },
  }
}
