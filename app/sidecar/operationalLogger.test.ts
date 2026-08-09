import { expect, test } from 'bun:test'
import { closeSync, constants, mkdtempSync, openSync, readFileSync, readSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSidecarOperationalLogger } from './operationalLogger.js'

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
