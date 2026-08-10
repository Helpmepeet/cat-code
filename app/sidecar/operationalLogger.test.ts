import { expect, test } from 'bun:test'
import { closeSync, constants, mkdtempSync, openSync, readFileSync, readSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSidecarOperationalLogger } from './operationalLogger.js'
import {
  MAX_OPERATIONAL_FIELDS,
  MAX_OPERATIONAL_STRING_BYTES,
  parseOperationalRecord,
  type OperationalEvent,
} from '../shared/operationalLog.js'
import { mintDeliveryTrace } from '../shared/deliveryTrace.js'

test('sidecar operational descriptor persists only a legacy category, never the raw stderr line', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-sidecar-operational-'))
  const path = join(root, 'records.jsonl')
  const fd = openSync(path, 'w', 0o600)
  const logger = createSidecarOperationalLogger({ launchId: 'launch', processInstanceId: 'sidecar', fd })
  logger.legacy('engine failed while rendering prompt: secret transcript text')
  logger.write({ level: 'fatal', event: 'app.fatal', fields: { reason: 'uncaught_failure' } })
  await new Promise(resolve => setImmediate(resolve))
  closeSync(fd)

  const text = readFileSync(path, 'utf8')
  expect(text).not.toContain('secret transcript text')
  expect(text).toContain('legacy_failure')
  expect(text).toContain('uncaught_failure')
})

test('every sidecar record carries the session id the supervisor matches on', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-sidecar-operational-session-'))
  const path = join(root, 'records.jsonl')
  const fd = openSync(path, 'w', 0o600)
  const appSessionId = '000638f7-9f2c-4527-9828-f7ecb082c938'
  const logger = createSidecarOperationalLogger({
    launchId: 'launch', processInstanceId: 'sidecar', fd, appSessionId,
  })

  // The two paths that never stamped a session id: the legacy diagnostic stream
  // and the drop counter. The supervisor requires an exact match, so both were
  // discarded at that boundary as "invalid" — including, worst of all, the
  // record whose only job is to report that records are being dropped.
  logger.legacy('engine failed while rendering prompt')
  logger.write({ level: 'warn', event: 'log.suppressed', fields: { count: 3 } })
  // An explicit id still wins, so a record about another session cannot be
  // relabelled as this one.
  logger.write({
    level: 'info', event: 'process.started', appSessionId: 'other-session',
    fields: { role: 'sidecar', pid: 1 },
  })
  await new Promise(resolve => setImmediate(resolve))
  closeSync(fd)

  const lines = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(lines.length).toBe(3)
  for (const line of lines.slice(0, 2)) {
    const parsed = parseOperationalRecord(line)
    expect(parsed).not.toBeNull()
    // The three conditions `app/supervisor/supervisor.ts` rejects on.
    expect(parsed!.process).toBe('sidecar')
    expect(parsed!.appSessionId).toBe(appSessionId)
  }
  expect(parseOperationalRecord(lines[2])!.appSessionId).toBe('other-session')
})

test('a saturated sidecar descriptor queue accounts for what it dropped', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-sidecar-operational-drop-'))
  const path = join(root, 'records.jsonl')
  const fd = openSync(path, 'w', 0o600)
  const logger = createSidecarOperationalLogger({ launchId: 'launch', processInstanceId: 'sidecar', fd })

  // Past the bounded queue the records were discarded with no trace at all,
  // which reads as a quiet system rather than a lossy one.
  for (let index = 0; index < 70; index++) {
    logger.write({ level: 'info', event: 'diagnostic', fields: { source: 'sidecar', category: 'probe' } })
  }
  return new Promise<void>(resolve => {
    setImmediate(() => setImmediate(() => {
      closeSync(fd)
      const lines = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      const suppressed = lines.find(line => line.event === 'log.suppressed')
      expect(suppressed).toBeDefined()
      expect(suppressed.fields.count).toBe(6)
      resolve()
    }))
  })
})

/**
 * A pipe is the only descriptor with the userspace queue that sheds, and no
 * event-loop turn runs inside the synchronous write burst that follows, so
 * nothing drains while it is filling: every record written after the byte
 * ceiling is reached is dropped, which makes the expected per-type counts exact.
 */
function openSaturatingPipe(prefix: string): { readFd: number; fd: number } {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const fifo = join(root, 'pipe')
  execFileSync('mkfifo', [fifo])
  const readFd = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK)
  const fd = openSync(fifo, constants.O_WRONLY)
  return { readFd, fd }
}

async function drainUntilSuppressed(readFd: number): Promise<Array<Record<string, any>>> {
  let text = ''
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
    const buffer = Buffer.alloc(1024 * 1024)
    let bytes = 0
    try {
      bytes = readSync(readFd, buffer, 0, buffer.byteLength, null)
    } catch {
      bytes = 0
    }
    if (bytes > 0) text += buffer.subarray(0, bytes).toString('utf8')
    // Only whole lines: the reader can land mid-record, and a partial trailing
    // line would otherwise be counted as a missing one.
    const complete = text.slice(0, text.lastIndexOf('\n') + 1)
    if (complete.includes('"log.suppressed"')) {
      return complete.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line))
    }
  }
  throw new Error('no log.suppressed record arrived before the deadline')
}

function parseHistogram(category: unknown): Map<string, number> {
  return new Map(String(category).split(',').map(entry => {
    const separator = entry.lastIndexOf(':')
    return [entry.slice(0, separator), Number(entry.slice(separator + 1))] as const
  }))
}

test('the saturated-queue report attributes its drops by record type', async () => {
  const { readFd, fd } = openSaturatingPipe('cat-code-sidecar-operational-attribution-')
  const logger = createSidecarOperationalLogger({ launchId: 'launch', processInstanceId: 'sidecar', fd })

  const filler = 2000
  for (let index = 0; index < filler; index++) {
    logger.write({ level: 'info', event: 'diagnostic', fields: { source: 'sidecar', category: 'probe' } })
  }
  for (let index = 0; index < 5; index++) {
    logger.write({ level: 'info', event: 'session.restore.completed', fields: { messageCount: index } })
  }
  for (let index = 0; index < 3; index++) {
    logger.deliveryStage({
      sessionId: '000638f7-9f2c-4527-9828-f7ecb082c938',
      trace: mintDeliveryTrace(index),
      stage: 'engine.produced',
      frameKind: 'assistant',
    })
  }

  const records = await drainUntilSuppressed(readFd)
  closeSync(readFd)

  const received = new Map<string, number>()
  for (const record of records) {
    const type = record.recordKind === 'delivery.trace' ? 'delivery.trace' : record.event
    if (type === 'log.suppressed') continue
    received.set(type, (received.get(type) ?? 0) + 1)
  }
  const suppressed = records.find(record => record.event === 'log.suppressed')
  expect(suppressed).toBeDefined()
  expect(suppressed!.fields.reason).toBe('queue_saturated')
  const histogram = parseHistogram(suppressed!.fields.category)

  // Everything after the ceiling is shed, so these two phases are lost in full.
  expect(received.get('session.restore.completed')).toBeUndefined()
  expect(received.get('delivery.trace')).toBeUndefined()
  expect(histogram.get('session.restore.completed')).toBe(5)
  // A delivery-stage marker carries a stage, not an event, and shares the same
  // drop counter. Bucketing strictly by event name would have counted these
  // three in the total while leaving them out of the breakdown entirely.
  expect(histogram.get('delivery.trace')).toBe(3)
  expect(histogram.get('diagnostic')).toBe(filler - (received.get('diagnostic') ?? 0))
  expect([...histogram.values()].reduce((total, value) => total + value, 0)).toBe(suppressed!.fields.count)

  expect(Buffer.byteLength(String(suppressed!.fields.category), 'utf8')).toBeLessThanOrEqual(MAX_OPERATIONAL_STRING_BYTES)
  expect(Object.keys(suppressed!.fields).length).toBeLessThanOrEqual(MAX_OPERATIONAL_FIELDS)
  // The supervisor admits a sidecar record only through this parser, so the
  // breakdown has to survive the shared field allowlist to be worth anything.
  expect(parseOperationalRecord(suppressed)).not.toBeNull()
})

test('the saturated-queue report caps its buckets and leads with the largest', async () => {
  const { readFd, fd } = openSaturatingPipe('cat-code-sidecar-operational-cap-')
  const logger = createSidecarOperationalLogger({ launchId: 'launch', processInstanceId: 'sidecar', fd })

  for (let index = 0; index < 2000; index++) {
    logger.write({ level: 'info', event: 'diagnostic', fields: { source: 'sidecar', category: 'probe' } })
  }
  const ranked: Array<readonly [OperationalEvent, number]> = [
    ['window.created', 8],
    ['renderer.load.ready', 7],
    ['renderer.recovery.succeeded', 6],
    ['renderer.unresponsive', 5],
    ['sidecar.socket.connected', 4],
    ['session.restore.started', 3],
    ['worker.started', 2],
    ['worker.completed', 1],
  ]
  for (const [event, count] of ranked) {
    for (let index = 0; index < count; index++) logger.write({ level: 'info', event })
  }

  const records = await drainUntilSuppressed(readFd)
  closeSync(readFd)

  const suppressed = records.find(record => record.event === 'log.suppressed')
  expect(suppressed).toBeDefined()
  const histogram = parseHistogram(suppressed!.fields.category)

  // Nine types dropped, six emitted: the filler leads, then the five largest.
  expect([...histogram.keys()]).toEqual([
    'diagnostic',
    'window.created',
    'renderer.load.ready',
    'renderer.recovery.succeeded',
    'renderer.unresponsive',
    'sidecar.socket.connected',
  ])
  const counts = [...histogram.values()]
  expect(counts).toEqual([...counts].sort((left, right) => right - left))
  expect(Buffer.byteLength(String(suppressed!.fields.category), 'utf8')).toBeLessThanOrEqual(MAX_OPERATIONAL_STRING_BYTES)
})

test('a full pipe with a stalled reader does not block the sidecar, and records still arrive', async () => {
  // Electron main blocks its own loop on synchronous reads while assembling a
  // support bundle, which stops draining FD 3. A synchronous write would wait
  // for that reader and stall the turn. The second assertion is the one that
  // matters most: a queue that never blocks because it silently discards
  // everything would satisfy the timing check on its own.
  const root = mkdtempSync(join(tmpdir(), 'cat-code-sidecar-operational-pipe-'))
  const fifo = join(root, 'pipe')
  execFileSync('mkfifo', [fifo])
  const readFd = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK)
  const fd = openSync(fifo, constants.O_WRONLY)

  const logger = createSidecarOperationalLogger({ launchId: 'launch', processInstanceId: 'sidecar', fd })
  const started = performance.now()
  for (let index = 0; index < 200; index++) {
    logger.write({ level: 'info', event: 'diagnostic', fields: { source: 'sidecar', category: 'probe' } })
  }
  const elapsed = performance.now() - started
  expect(elapsed).toBeLessThan(5_000)

  await new Promise(resolve => setTimeout(resolve, 100))
  const drained = Buffer.alloc(1024 * 1024)
  let bytes = 0
  try {
    bytes = readSync(readFd, drained, 0, drained.byteLength, null)
  } catch {
    bytes = 0
  }
  closeSync(readFd)
  const received = drained.subarray(0, bytes).toString('utf8').trim()
  expect(received.length).toBeGreaterThan(0)
  expect(JSON.parse(received.split('\n')[0]).event).toBe('diagnostic')
})
