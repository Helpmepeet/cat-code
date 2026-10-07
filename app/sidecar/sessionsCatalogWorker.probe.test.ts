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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseSessionsCatalogWorkerResult } from '../shared/sessionsCatalogWorker.js'
import { selectMergedSessionRows } from '../renderer/src/sessionsCatalogState.js'
import { reduceSessionArchived, selectArchivedSidebarRows } from '../renderer/src/sidebarArchivedSessions.js'

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

test('unchanged catalogs skip engine startup while external transcript changes refresh them', async () => {
  const configHome = temp('catcode-catalog-worker-')
  const cwd = temp('catcode-catalog-cwd-')

  const run = async () => {
    const proc = Bun.spawn(['bun', 'run', worker, '--bare'], {
      cwd,
      env: { ...process.env, NODE_ENV: 'development', CLAUDE_CONFIG_DIR: configHome },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    })
    proc.stdin.end()
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
    return { code, records: stdout.trim().split('\n').filter(Boolean).map(line => parseSessionsCatalogWorkerResult(JSON.parse(line))) }
  }
  const first = await run()

  // Still functional: the enumeration itself does not depend on `init()`.
  expect(first.code).toBe(0)
  expect(first.records.length).toBeGreaterThan(0)
  expect(first.records.every(Boolean)).toBe(true)
  expect(first.records.some(record => record?.type === 'catalog')).toBe(true)
  const cache = join(configHome, 'desktop', 'sessions-catalog.json')
  const initialCacheInode = statSync(cache, { bigint: true }).ino
  const firstCapturedAtMs = JSON.parse(readFileSync(cache, 'utf8')).capturedAtMs

  // This worker used to import the full engine graph and rewrite/fsync the
  // cache on every timer tick even when the catalog content was unchanged.
  const second = await run()
  expect(second.code).toBe(0)
  expect(second.records).toEqual([{ type: 'unchanged', version: 1 }])
  expect(statSync(cache, { bigint: true }).ino).toBe(initialCacheInode)
  expect(JSON.parse(readFileSync(cache, 'utf8')).capturedAtMs).toBe(firstCapturedAtMs)

  // A terminal-created transcript changes the source fingerprint and must take
  // the ordinary engine enumeration path again.
  const projects = join(configHome, 'projects', '-tmp-catalog-probe')
  mkdirSync(projects, { recursive: true })
  const cwdPath = join(cwd, 'workspace')
  mkdirSync(cwdPath)
  writeFileSync(join(projects, '9b4b3ac5-ef6e-45f4-a111-a7e789d4f883.jsonl'), JSON.stringify({
    parentUuid: null,
    sessionId: '9b4b3ac5-ef6e-45f4-a111-a7e789d4f883',
    cwd: cwdPath,
    version: 'test',
    type: 'user',
    uuid: 'c1dd8834-840d-4516-9e4c-e02b0f35f24a',
    userType: 'external',
    timestamp: '2026-10-04T00:00:00.000Z',
    message: { role: 'user', content: 'probe prompt' },
  }) + '\n')
  const third = await run()
  expect(third.code).toBe(0)
  expect(third.records.find(record => record?.type === 'catalog')?.catalog.entries).toHaveLength(1)
  const changedCacheInode = statSync(cache, { bigint: true }).ino
  expect(changedCacheInode).not.toBe(initialCacheInode)
  const fourth = await run()
  expect(fourth.records).toEqual([{ type: 'unchanged', version: 1 }])
  expect(statSync(cache, { bigint: true }).ino).toBe(changedCacheInode)

  // A brief terminal resume without any prompt changes only the active lease
  // marker, yet must invalidate the worker fast path and return the archived row.
  const oldCatalog = third.records.find(record => record?.type === 'catalog')
  if (oldCatalog?.type !== 'catalog') throw new Error('Missing pre-resume catalog')
  const oldRows = selectMergedSessionRows([], oldCatalog.catalog)
  const archived = reduceSessionArchived([], oldRows[0]!, Date.now())
  expect(selectArchivedSidebarRows(oldRows, archived).archived).toHaveLength(1)
  const transcriptPath = join(projects, '9b4b3ac5-ef6e-45f4-a111-a7e789d4f883.jsonl')
  const beforeResume = readFileSync(transcriptPath, 'utf8')
  const leaseProbe = join(here, '../../src/utils/transcriptLease.probe.child.ts')
  const terminal = Bun.spawn([process.execPath, 'run', leaseProbe], {
    cwd,
    env: {
      PATH: process.env.PATH ?? '', NODE_ENV: 'development', CLAUDE_CONFIG_DIR: configHome,
      PROBE_SESSION_ID: '9b4b3ac5-ef6e-45f4-a111-a7e789d4f883', PROBE_ROLE: 'terminal',
    },
    stdout: 'pipe', stderr: 'pipe',
  })
  const [terminalCode, terminalOutput, terminalError] = await Promise.all([
    terminal.exited, new Response(terminal.stdout).text(), new Response(terminal.stderr).text(),
  ])
  expect({ terminalCode, terminalError }).toEqual({ terminalCode: 0, terminalError: '' })
  expect(terminalOutput).toContain('"outcome":"acquired"')
  expect(readFileSync(transcriptPath, 'utf8')).toBe(beforeResume)
  const resumed = await run()
  expect(resumed.code).toBe(0)
  const resumedCatalog = resumed.records.find(record => record?.type === 'catalog')
  expect(resumedCatalog?.type).toBe('catalog')
  if (resumedCatalog?.type === 'catalog') {
    expect(resumedCatalog.catalog.entries[0]?.modifiedAtMs).toBe(oldCatalog.catalog.entries[0]?.modifiedAtMs)
    expect(resumedCatalog.catalog.entries[0]?.sessionActivityAtMs).toBeGreaterThan(archived[0]!.archivedAt)
    const rows = selectMergedSessionRows([], resumedCatalog.catalog)
    expect(selectArchivedSidebarRows(rows, archived).archived).toEqual([])
    expect(selectArchivedSidebarRows(rows, archived).visible).toHaveLength(1)
  }
  expect((await run()).records).toEqual([{ type: 'unchanged', version: 1 }])

  // Relocation state affects the catalog's cwd/binding projection independently
  // from transcript bytes, so it participates in source invalidation as well.
  const targetCwd = join(cwd, 'relocated-workspace')
  mkdirSync(targetCwd)
  const managed = {
    cwd: cwdPath,
    binding: {
      kind: 'managed',
      storageRootId: '4fc474a0-38ba-4ed7-806a-a7ee9fd4cf86',
      storageId: '02bb2e86-a34b-4ec8-8a79-dbdad33db54a',
    },
  }
  const target = { cwd: targetCwd, binding: { kind: 'project' } }
  const relocationDir = join(configHome, 'session-relocations')
  mkdirSync(relocationDir, { recursive: true })
  writeFileSync(join(relocationDir, '9b4b3ac5-ef6e-45f4-a111-a7e789d4f883.json'), JSON.stringify({
    version: 1,
    engineSessionId: '9b4b3ac5-ef6e-45f4-a111-a7e789d4f883',
    appSessionId: '3f4ef76c-4b2a-41e4-990a-11aa5d8fa034',
    phase: 'complete',
    original: managed,
    source: managed,
    target,
    controls: { mode: 'default' },
    backup: join(configHome, 'backup.jsonl'),
    movedAt: Date.now(),
  }))
  const fifth = await run()
  const relocated = fifth.records.find(record => record?.type === 'catalog')
  expect(relocated?.type).toBe('catalog')
  if (relocated?.type === 'catalog') expect(relocated.catalog.entries[0]?.cwd).toBe(targetCwd)

  // One unreadable relocation must not poison unrelated history or leave the
  // cache perpetually stale. Preserve the record and its transcript for repair.
  const healthySessionId = '77838f57-3b52-4e49-8c89-2e3d7266a2b6'
  const movedTranscriptPath = join(projects, '9b4b3ac5-ef6e-45f4-a111-a7e789d4f883.jsonl')
  const movedTranscript = readFileSync(movedTranscriptPath, 'utf8')
  writeFileSync(join(projects, `${healthySessionId}.jsonl`), JSON.stringify({
    parentUuid: null,
    sessionId: healthySessionId,
    cwd: cwdPath,
    type: 'user',
    uuid: 'cb77da59-e1d9-4056-aa0e-e6d336ff73e2',
    timestamp: '2026-10-05T00:00:00.000Z',
    message: { role: 'user', content: 'healthy conversation' },
  }) + '\n')
  const recordPath = join(relocationDir, '9b4b3ac5-ef6e-45f4-a111-a7e789d4f883.json')
  const validRecord = readFileSync(recordPath, 'utf8')
  const { controls: _controls, ...withoutControls } = JSON.parse(validRecord)
  for (const text of [JSON.stringify(withoutControls), '{']) {
    writeFileSync(recordPath, text)
    const filtered = await run()
    expect(filtered.code).toBe(0)
    const catalog = filtered.records.find(record => record?.type === 'catalog')
    expect(catalog?.type).toBe('catalog')
    if (catalog?.type === 'catalog') {
      expect(catalog.catalog.entries.map(entry => entry.sessionId)).toEqual([healthySessionId])
      expect(catalog.catalog.truncated).toBe(false)
    }
    expect(readFileSync(recordPath, 'utf8')).toBe(text)
    expect(readFileSync(movedTranscriptPath, 'utf8')).toBe(movedTranscript)
    expect((await run()).records).toEqual([{ type: 'unchanged', version: 1 }])
  }
  writeFileSync(recordPath, validRecord)
  const repaired = (await run()).records.find(record => record?.type === 'catalog')
  expect(repaired?.type).toBe('catalog')
  if (repaired?.type === 'catalog') {
    expect(repaired.catalog.entries).toHaveLength(2)
    expect(repaired.catalog.entries.find(entry =>
      entry.sessionId === '9b4b3ac5-ef6e-45f4-a111-a7e789d4f883',
    )?.cwd).toBe(targetCwd)
  }

  // `init()` writes the global config (`recordFirstStartTime`) and materializes
  // the plans directory. Neither exists after an observation-only bootstrap, so
  // their absence is the proof that the account-pool machinery never started.
  const written = readdirSync(configHome)
  expect(written.filter(name => name.endsWith('.json'))).toEqual([])
  expect(existsSync(join(configHome, 'plans'))).toBe(false)
}, 180_000)
