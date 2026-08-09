import { expect, test } from 'bun:test'
import { closeSync, mkdtempSync, openSync, readFileSync } from 'node:fs'
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
