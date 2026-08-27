import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { _forTest } from './migrateFromUpstreamClaude.js'

const role = process.env.UPSTREAM_MIGRATION_PROBE_ROLE
const root = process.env.UPSTREAM_MIGRATION_PROBE_ROOT
const destination = process.env.UPSTREAM_MIGRATION_DESTINATION
const sourceDir = process.env.UPSTREAM_MIGRATION_SOURCE_DIR
const sourceJson = process.env.UPSTREAM_MIGRATION_SOURCE_JSON
if (
  (role !== 'crash-owner' && role !== 'contender') ||
  !root ||
  !destination ||
  !sourceDir ||
  !sourceJson
) {
  throw new Error('Missing upstream migration probe input')
}

if (role === 'crash-owner') {
  await _forTest.acquireMigrationLock(destination, error => {
    throw error
  })
  writeFileSync(join(root, 'ready-crash-owner'), String(process.pid))
  while (true) await Bun.sleep(10)
}

writeFileSync(join(root, 'ready-contender'), String(process.pid))
while (!existsSync(join(root, 'start'))) await Bun.sleep(5)
const startedAt = Date.now()
await _forTest.migrateFromPaths(destination, [
  { dir: sourceDir, json: sourceJson, keychainServices: [] },
])
process.stdout.write(
  `${JSON.stringify({ role, pid: process.pid, elapsedMs: Date.now() - startedAt })}\n`,
)
