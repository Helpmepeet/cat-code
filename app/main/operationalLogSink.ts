/** Main-owned private JSONL sink for the desktop operational log. */

import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
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
        updateLatest(directory, file)
        retain(directory, now().getTime(), maxTotalBytes, maxFiles, maxAgeMs, file)
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
    if (input.level !== 'fatal' && prior && current - prior.at < 1_000) {
      prior.count++
      suppressed++
      return
    }
    if (suppressed > 0 && input.event !== 'log.suppressed') {
      const count = suppressed
      suppressed = 0
      append(
        createOperationalRecord(
          { level: 'warn', event: 'log.suppressed', process: 'main', fields: { count } },
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

function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
}

function retain(
  directory: string,
  current: number,
  maxTotalBytes: number,
  maxFiles: number,
  maxAgeMs: number,
  activeFile: string,
): void {
  const files = readdirSync(directory)
    .filter(name => /^operational-[A-Za-z0-9-]+-\d+\.jsonl$/.test(name))
    .map(name => ({ name, path: join(directory, name), stat: statSync(join(directory, name)) }))
    .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs)
  let total = files.reduce((sum, item) => sum + item.stat.size, 0)
  let count = files.length
  for (const item of files) {
    try {
      chmodSync(item.path, 0o600)
    } catch {
      // Retention and permission repair are best effort.
    }
    if (item.path === activeFile) continue
    if (item.stat.mtimeMs < current - maxAgeMs || count > maxFiles || total > maxTotalBytes) {
      try {
        unlinkSync(item.path)
        count--
        total -= item.stat.size
      } catch {
        // Retention is best effort; it must never delete the active launch file.
      }
    }
  }
}

function updateLatest(directory: string, activeFile: string): void {
  const latest = join(directory, 'latest-operational')
  try {
    unlinkSync(latest)
  } catch {
    // First write has no previous target.
  }
  try {
    symlinkSync(activeFile, latest)
  } catch {
    // A support convenience, never a logging failure.
  }
}
