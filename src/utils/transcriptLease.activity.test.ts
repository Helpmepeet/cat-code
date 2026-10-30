import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  activateTranscriptLease,
  assertActiveTranscriptLease,
  readTranscriptActivationAtMs,
  releaseActiveTranscriptLease,
  withTranscriptHydrationLease,
  withUnownedTranscriptLease,
} from './transcriptLease.js'

const sessionId = '11111111-1111-4111-8111-111111111111'
const secondSessionId = '22222222-2222-4222-8222-222222222222'
let configHome: string
let previousConfigHome: string | undefined
let clock: ReturnType<typeof spyOn<typeof Date, 'now'>> | undefined
const marker = () => join(configHome, 'transcript-leases', `${sessionId}.activation.json`)

beforeEach(async () => {
  previousConfigHome = process.env.CLAUDE_CONFIG_DIR
  configHome = await mkdtemp(join(tmpdir(), 'transcript-activation-'))
  process.env.CLAUDE_CONFIG_DIR = configHome
})

afterEach(async () => {
  await releaseActiveTranscriptLease()
  clock?.mockRestore()
  clock = undefined
  if (previousConfigHome === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigHome
  await rm(configHome, { recursive: true, force: true })
})

test('real active acquisition persists across release; healthy repeated activation and unowned maintenance do not bump', async () => {
  clock = spyOn(Date, 'now').mockReturnValue(1000)
  await activateTranscriptLease(sessionId)
  assertActiveTranscriptLease(sessionId)
  expect(await readTranscriptActivationAtMs(sessionId)).toBe(1000)
  const first = await readFile(marker(), 'utf8')
  expect((await stat(marker())).mode & 0o777).toBe(0o600)
  expect((await stat(join(configHome, 'transcript-leases'))).mode & 0o777).toBe(0o700)
  expect((await readdir(join(configHome, 'transcript-leases'))).some(name => name.endsWith('.tmp'))).toBe(false)

  clock.mockReturnValue(2000)
  await activateTranscriptLease(sessionId)
  expect(await readFile(marker(), 'utf8')).toBe(first)
  expect(await withUnownedTranscriptLease(sessionId, async () => 'maintenance')).toEqual({ acquired: false })
  await releaseActiveTranscriptLease()
  expect(await readTranscriptActivationAtMs(sessionId)).toBe(1000)
  expect(await withUnownedTranscriptLease(sessionId, async () => 'maintenance')).toEqual({ acquired: true, value: 'maintenance' })
  expect(await readFile(marker(), 'utf8')).toBe(first)

  clock.mockReturnValue(3000)
  await activateTranscriptLease(sessionId)
  expect(await readTranscriptActivationAtMs(sessionId)).toBe(3000)
  await releaseActiveTranscriptLease()
  expect(await readTranscriptActivationAtMs(sessionId)).toBe(3000)
})

test('unowned maintenance without a prior active session creates no activation evidence', async () => {
  expect(await withUnownedTranscriptLease(sessionId, async () => 'maintenance')).toEqual({ acquired: true, value: 'maintenance' })
  expect(await readTranscriptActivationAtMs(sessionId)).toBeNull()
  expect(await readdir(join(configHome, 'transcript-leases'))).toEqual([])
})

test('source switch publishes each newly active session before returning', async () => {
  clock = spyOn(Date, 'now').mockReturnValue(1000)
  await activateTranscriptLease(sessionId)
  clock.mockReturnValue(2000)
  await activateTranscriptLease(secondSessionId)
  assertActiveTranscriptLease(secondSessionId)
  expect(await readTranscriptActivationAtMs(sessionId)).toBe(1000)
  expect(await readTranscriptActivationAtMs(secondSessionId)).toBe(2000)
})

test('read-only accessor rejects invalid identities and missing or malformed markers', async () => {
  expect(await readTranscriptActivationAtMs('../escape')).toBeNull()
  expect(await readTranscriptActivationAtMs(sessionId)).toBeNull()
  expect(await readdir(configHome)).toEqual([])
  await mkdir(join(configHome, 'transcript-leases'), { mode: 0o700 })
  for (const contents of [
    '', '{', 'null', '[]', '{}', '{"activatedAtMs":"1000"}',
    '{"activatedAtMs":-1}', '{"activatedAtMs":1e999}',
    '{"activatedAtMs":1000,"extra":true}', 'x'.repeat(129),
  ]) {
    await writeFile(marker(), contents, { mode: 0o600 })
    expect(await readTranscriptActivationAtMs(sessionId)).toBeNull()
  }
  await writeFile(marker(), '{"activatedAtMs":0}', { mode: 0o600 })
  expect(await readTranscriptActivationAtMs(sessionId)).toBe(0)
})

test('read-only accessor rejects public permissions and symbolic links', async () => {
  await mkdir(join(configHome, 'transcript-leases'), { mode: 0o700 })
  await writeFile(marker(), '{"activatedAtMs":1000}', { mode: 0o600 })
  await chmod(marker(), 0o644)
  expect(await readTranscriptActivationAtMs(sessionId)).toBeNull()
  const target = join(configHome, 'private.json')
  await writeFile(target, '{"activatedAtMs":1000}', { mode: 0o600 })
  await rm(marker())
  await symlink(target, marker())
  expect(await readTranscriptActivationAtMs(sessionId)).toBeNull()
})

test('marker publication failure is best-effort and does not fail resume or release', async () => {
  await mkdir(marker(), { recursive: true, mode: 0o700 })
  await activateTranscriptLease(sessionId)
  assertActiveTranscriptLease(sessionId)
  expect(await readTranscriptActivationAtMs(sessionId)).toBeNull()
  await releaseActiveTranscriptLease()
  expect(await withUnownedTranscriptLease(sessionId, async () => 'maintenance')).toEqual({ acquired: true, value: 'maintenance' })
})

test('hydration borrows the active target without releasing it on success or failure', async () => {
  await activateTranscriptLease(sessionId)
  await withTranscriptHydrationLease(sessionId, async assertHealthy => {
    assertHealthy()
    await activateTranscriptLease(sessionId)
    assertHealthy()
  })
  await expect(withTranscriptHydrationLease(sessionId, async () => {
    throw new Error('reader failed')
  })).rejects.toThrow('reader failed')
  expect(await withUnownedTranscriptLease(sessionId, async () => null)).toEqual({ acquired: false })
  assertActiveTranscriptLease(sessionId)
})

test('temporary hydration retains a different active lease and releases only its own guard', async () => {
  await activateTranscriptLease(sessionId)
  await withTranscriptHydrationLease(secondSessionId, async assertHealthy => {
    assertHealthy()
    assertActiveTranscriptLease(sessionId)
    // An attempted adoption must fail promptly, not deadlock behind its callback.
    await expect(activateTranscriptLease(secondSessionId)).rejects.toThrow('already open')
    assertHealthy()
  })
  assertActiveTranscriptLease(sessionId)
  expect(await withUnownedTranscriptLease(secondSessionId, async () => null)).toEqual({ acquired: true, value: null })
  expect(await withUnownedTranscriptLease(sessionId, async () => null)).toEqual({ acquired: false })
})

test('borrowed hydration detects release and transfer without blocking the transition queue', async () => {
  await activateTranscriptLease(sessionId)
  await expect(withTranscriptHydrationLease(sessionId, async assertHealthy => {
    await releaseActiveTranscriptLease()
    assertHealthy()
  })).rejects.toThrow('hydration lease released')
  await activateTranscriptLease(sessionId)
  await expect(withTranscriptHydrationLease(sessionId, async assertHealthy => {
    await activateTranscriptLease(secondSessionId)
    assertHealthy()
  })).rejects.toThrow('hydration lease released')
  assertActiveTranscriptLease(secondSessionId)
  expect(await withUnownedTranscriptLease(sessionId, async () => null)).toEqual({ acquired: true, value: null })
})
