/**
 * Real-process proof for the sessions-catalog worker's OBSERVATION-ONLY
 * bootstrap. Main re-spawns this worker every 30 s, and it used to run the full
 * engine `init()`, which fires `void initAccountPool()` — periodic token
 * refresh, a 1-second quarantine probe, and a usage POST with real OAuth
 * tokens — none of which enumerating transcripts needs, and any of which the
 * worker's unconditional `process.exit(0)` can hard-kill mid-write.
 *
 * The run is fully isolated: `CLAUDE_CONFIG_DIR` points at an empty temp home,
 * so nothing here reads or writes the operator's real config, vault, or
 * credentials.
 */

import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseSessionsCatalogWorkerResult } from '../shared/sessionsCatalogWorker.js'

const here = dirname(fileURLToPath(import.meta.url))
const worker = join(here, 'sessionsCatalogWorker.ts')
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

test('the catalog worker emits a catalog and never runs the full engine bootstrap', async () => {
  const configHome = temp('catcode-catalog-worker-')
  const cwd = temp('catcode-catalog-cwd-')

  const proc = Bun.spawn(['bun', 'run', worker, '--bare'], {
    cwd,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      CLAUDE_CONFIG_DIR: configHome,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  proc.stdin.end()
  const [code, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
  ])

  // Still functional: the enumeration itself does not depend on `init()`.
  expect(code).toBe(0)
  const records = stdout
    .trim()
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => parseSessionsCatalogWorkerResult(JSON.parse(line)))
  expect(records.length).toBeGreaterThan(0)
  expect(records.every(Boolean)).toBe(true)
  expect(records.some(record => record?.type === 'catalog')).toBe(true)

  // `init()` writes the global config (`recordFirstStartTime`) and materializes
  // the plans directory. Neither exists after an observation-only bootstrap, so
  // their absence is the proof that the account-pool machinery never started.
  const written = readdirSync(configHome)
  expect(written.filter(name => name.endsWith('.json'))).toEqual([])
  expect(existsSync(join(configHome, 'plans'))).toBe(false)
}, 180_000)
