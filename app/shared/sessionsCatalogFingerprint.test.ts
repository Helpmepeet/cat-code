import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { catalogFingerprintForSnapshot, inspectSessionsCatalogSources } from './sessionsCatalogFingerprint.js'
import type { SessionsCatalogSnapshot } from './protocol.js'

const sessionId = '11111111-1111-4111-8111-111111111111'
let configHome: string
let previousConfigHome: string | undefined
const catalog: SessionsCatalogSnapshot = { entries: [], truncated: false, capturedAtMs: 1000 }

beforeEach(async () => {
  previousConfigHome = process.env.CLAUDE_CONFIG_DIR
  configHome = await mkdtemp(join(tmpdir(), 'catalog-activation-fingerprint-'))
  process.env.CLAUDE_CONFIG_DIR = configHome
})

afterEach(async () => {
  if (previousConfigHome === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigHome
  await rm(configHome, { recursive: true, force: true })
})

async function cacheCurrentSources(): Promise<string> {
  const { fingerprint } = await inspectSessionsCatalogSources()
  const dir = join(configHome, 'desktop')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(join(dir, 'sessions-catalog.json'), JSON.stringify({
    ...catalog,
    sourceFingerprint: catalogFingerprintForSnapshot(fingerprint, catalog),
  }), { mode: 0o600 })
  expect((await inspectSessionsCatalogSources()).unchanged).toBe(true)
  return fingerprint
}

test('active acquisition creation, replacement and removal invalidate unchanged-source cache', async () => {
  await cacheCurrentSources()
  const dir = join(configHome, 'transcript-leases')
  await mkdir(dir, { mode: 0o700 })
  const marker = join(dir, `${sessionId}.activation.json`)
  await writeFile(marker, '{"activatedAtMs":1000}', { mode: 0o600 })
  expect((await inspectSessionsCatalogSources()).unchanged).toBe(false)
  const first = await cacheCurrentSources()
  const firstStat = await stat(marker)
  await writeFile(marker, '{"activatedAtMs":2000}', { mode: 0o600 })
  await utimes(marker, firstStat.atime, firstStat.mtime)
  const rewritten = await inspectSessionsCatalogSources()
  expect(rewritten.fingerprint).not.toBe(first)
  expect(rewritten.unchanged).toBe(false)
  await cacheCurrentSources()
  await rm(marker)
  expect((await inspectSessionsCatalogSources()).unchanged).toBe(false)
})

test('lease heartbeats, maintenance targets, temporary and unrelated files do not dirty catalog', async () => {
  const first = await cacheCurrentSources()
  const dir = join(configHome, 'transcript-leases')
  await mkdir(dir, { mode: 0o700 })
  const target = join(dir, `${sessionId}.lease`)
  const lock = `${target}.lock`
  await writeFile(target, '', { mode: 0o600 })
  await mkdir(lock)
  await writeFile(join(dir, `.${sessionId}.activation.json.pending.tmp`), 'partial')
  await writeFile(join(dir, 'not-a-session.activation.json'), '{"activatedAtMs":9000}')
  await mkdir(join(dir, '22222222-2222-4222-8222-222222222222.activation.json'))
  await utimes(lock, new Date(), new Date())
  expect(await inspectSessionsCatalogSources()).toEqual({ fingerprint: first, unchanged: true })
  await rm(lock, { recursive: true })
  await rm(target)
  expect(await inspectSessionsCatalogSources()).toEqual({ fingerprint: first, unchanged: true })
})
