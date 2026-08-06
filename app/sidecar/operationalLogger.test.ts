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
