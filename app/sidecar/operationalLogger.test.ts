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

  // Lifecycle keeps its own, far higher ceiling, so the records that explain
  // the session survive a queue already saturated with samples.
  expect(received.get('session.restore.completed')).toBe(5)
  expect(histogram.get('session.restore.completed')).toBeUndefined()
  // Delivery-stage markers are samples and are shed with the rest of them.
  expect(received.get('delivery.trace')).toBeUndefined()
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

test('turn lifecycle survives a saturated queue', async () => {
  const { readFd, fd } = openSaturatingPipe('cat-code-sidecar-operational-turn-')
  const logger = createSidecarOperationalLogger({ launchId: 'launch', processInstanceId: 'sidecar', fd })

  for (let index = 0; index < 2000; index++) {
    logger.write({ level: 'info', event: 'diagnostic', fields: { source: 'sidecar', category: 'probe' } })
  }
  // `info`, so these were `sample` class and shed with the filler. They are the
  // only durable account of what a turn did, and a failed turn is logged at
  // `info` too, so losing them under pressure loses the failure itself.
  for (let index = 0; index < 4; index++) {
    logger.write({ level: 'info', event: 'session.turn.started', fields: {} })
    logger.write({ level: 'info', event: 'session.turn.completed', fields: { durationMs: index, reason: 'failed' } })
  }

  const records = await drainUntilSuppressed(readFd)
  closeSync(readFd)

  const received = new Map<string, number>()
  for (const record of records) {
    if (record.recordKind === 'delivery.trace' || record.event === 'log.suppressed') continue
    received.set(record.event, (received.get(record.event) ?? 0) + 1)
  }
  expect(received.get('session.turn.started')).toBe(4)
  expect(received.get('session.turn.completed')).toBe(4)

  const suppressed = records.find(record => record.event === 'log.suppressed')
  expect(suppressed).toBeDefined()
  const histogram = parseHistogram(suppressed!.fields.category)
  expect(histogram.get('session.turn.started')).toBeUndefined()
  expect(histogram.get('session.turn.completed')).toBeUndefined()
})

test('the saturated-queue report caps its buckets and leads with the largest', async () => {
  const { readFd, fd } = openSaturatingPipe('cat-code-sidecar-operational-cap-')
  const logger = createSidecarOperationalLogger({ launchId: 'launch', processInstanceId: 'sidecar', fd })

  for (let index = 0; index < 2000; index++) {
    logger.write({ level: 'info', event: 'diagnostic', fields: { source: 'sidecar', category: 'probe' } })
  }
  // All sample-class: only records that actually shed reach the histogram.
  const ranked: Array<readonly [OperationalEvent, number]> = [
    ['renderer.health.sample', 8],
    ['renderer.health.recovered', 7],
    ['renderer.health.flight_recorder', 6],
    ['renderer.navigation.started', 5],
    ['window.visibility.changed', 4],
    ['registry.orphan.swept', 3],
    ['registry.rows.reaped', 2],
    ['renderer.responsive', 1],
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
    'renderer.health.sample',
    'renderer.health.recovered',
    'renderer.health.flight_recorder',
    'renderer.navigation.started',
    'window.visibility.changed',
  ])
  const counts = [...histogram.values()]
  expect(counts).toEqual([...counts].sort((left, right) => right - left))
  expect(Buffer.byteLength(String(suppressed!.fields.category), 'utf8')).toBeLessThanOrEqual(MAX_OPERATIONAL_STRING_BYTES)
})

test('a saturating queue sheds samples first, anomalies next, and still admits lifecycle', async () => {
  const { readFd, fd } = openSaturatingPipe('cat-code-sidecar-operational-priority-')
  const logger = createSidecarOperationalLogger({ launchId: 'launch', processInstanceId: 'sidecar', fd })

  // One synchronous burst: no event-loop turn runs inside it, so nothing drains
  // while it fills and every phase below sees the queue the prior phase left.
  const samples = 600
  for (let index = 0; index < samples; index++) {
    logger.write({ level: 'info', event: 'renderer.health.sample' })
  }
  for (let index = 0; index < 3; index++) {
    logger.deliveryStage({
      sessionId: '000638f7-9f2c-4527-9828-f7ecb082c938',
      trace: mintDeliveryTrace(index),
      stage: 'engine.produced',
      frameKind: 'assistant',
    })
  }
  // Past the sample ceiling the queue still has room for an anomaly.
  for (let index = 0; index < 4; index++) {
    logger.write({ level: 'warn', event: 'renderer.unresponsive' })
  }
  // Fill past the anomaly ceiling too, then prove lifecycle still gets through.
  const anomalies = 2000
  for (let index = 0; index < anomalies; index++) {
    logger.write({ level: 'error', event: 'renderer.component.failed' })
  }
  for (let index = 0; index < 4; index++) {
    logger.write({ level: 'info', event: 'sidecar.ready', fields: { pid: index } })
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
  const histogram = parseHistogram(suppressed!.fields.category)

  // Samples shed first: the delivery markers written after the sample ceiling
  // are lost in full even though the queue still had room for other classes.
  expect(received.get('delivery.trace')).toBeUndefined()
  expect(histogram.get('delivery.trace')).toBe(3)
  expect(received.get('renderer.health.sample') ?? 0).toBeLessThan(samples)
  expect(histogram.get('renderer.health.sample')).toBe(samples - (received.get('renderer.health.sample') ?? 0))

  // Anomalies shed later: the four written while only samples were saturating
  // all survive, and the flood that follows is what finally reaches that class.
  expect(received.get('renderer.unresponsive')).toBe(4)
  expect(histogram.get('renderer.unresponsive')).toBeUndefined()
  expect(histogram.get('renderer.component.failed')).toBeGreaterThan(0)

  // Lifecycle survives a queue that is shedding both of the other classes.
  expect(received.get('sidecar.ready')).toBe(4)
  expect(histogram.get('sidecar.ready')).toBeUndefined()

  expect([...histogram.values()].reduce((total, value) => total + value, 0)).toBe(suppressed!.fields.count)
})

test('lifecycle raises the ceiling rather than removing it, and drops at it stay attributed', async () => {
  // Enqueueing lifecycle unconditionally would let a wedged reader grow this
  // queue without bound, which is the failure the queue exists to prevent. So
  // the claim under test has two halves: the lifecycle ceiling is far above the
  // sample one, and it is still a ceiling that counts what it sheds.
  const flood = 8000
  const floodWith = async (prefix: string, event: OperationalEvent) => {
    const { readFd, fd } = openSaturatingPipe(prefix)
    const logger = createSidecarOperationalLogger({ launchId: 'launch', processInstanceId: 'sidecar', fd })
    for (let index = 0; index < flood; index++) logger.write({ level: 'info', event })
    const records = await drainUntilSuppressed(readFd)
    closeSync(readFd)
    return {
      arrived: records.filter(record => record.event === event).length,
      suppressed: records.find(record => record.event === 'log.suppressed')!,
    }
  }

  const sample = await floodWith('cat-code-sidecar-operational-sample-cap-', 'renderer.health.sample')
  const lifecycle = await floodWith('cat-code-sidecar-operational-lifecycle-cap-', 'sidecar.ready')

  // Records are within a few bytes of each other, so the admitted counts track
  // the ceilings directly. A shared ceiling would put these two side by side.
  expect(lifecycle.arrived).toBeGreaterThan(sample.arrived * 2)

  expect(lifecycle.arrived).toBeLessThan(flood)
  expect(lifecycle.suppressed.fields.reason).toBe('queue_saturated')
  expect(parseHistogram(lifecycle.suppressed.fields.category).get('sidecar.ready'))
    .toBe(flood - lifecycle.arrived)
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
