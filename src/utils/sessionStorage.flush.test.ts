import { expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'concurrent-transcript-flush-'))
const originalConfig = process.env.CLAUDE_CONFIG_DIR
const originalPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
const bootstrap = await import('../bootstrap/state.js')
const storage = await import('./sessionStorage.js')
const guard = await import('./transcriptAppendGuard.js')
const lease = await import('./transcriptLease.js')
const { createUserMessage } = await import('./messages.js')
const previousSession = bootstrap.getSessionId(), previousProject = bootstrap.getSessionProjectDir()

test('concurrent flushers cannot return over a later drain started after their shared predecessor', async () => {
  const firstEntered = Promise.withResolvers<void>(), releaseFirst = Promise.withResolvers<void>()
  const secondEntered = Promise.withResolvers<void>(), releaseSecond = Promise.withResolvers<void>()
  let writes = 0
  let completeSecond = false, completeThird = false
  const pending: Promise<void>[] = []
  let interception: { mockRestore(): void } | undefined
  try {
    storage.resetProjectForTesting()
    bootstrap.switchSession(randomUUID() as never)
    const seed = createUserMessage({ content: 'seed' })
    await storage.recordTranscript([seed]); await storage.flushCurrentTranscriptDurably(seed.uuid)
    const original = guard.withTranscriptAppendGuard
    interception = spyOn(guard, 'withTranscriptAppendGuard').mockImplementation(async (path, action) => {
      if (++writes === 1) { firstEntered.resolve(); await releaseFirst.promise }
      else if (writes === 2) { secondEntered.resolve(); await releaseSecond.promise }
      return original(path, action)
    })
    const first = createUserMessage({ content: 'first queued write' })
    await storage.recordTranscript([seed, first])
    pending.push(storage.flushSessionStorage())
    await firstEntered.promise
    const second = createUserMessage({ content: 'later write must not be hidden by an empty drain' })
    await storage.recordTranscript([seed, first, second])
    pending.push(storage.flushSessionStorage().then(() => { completeSecond = true }))
    pending.push(storage.flushSessionStorage().then(() => { completeThird = true }))
    releaseFirst.resolve()
    await secondEntered.promise
    await Bun.sleep(0)
    expect(completeSecond).toBe(false)
    expect(completeThird).toBe(false)
    releaseSecond.resolve()
    await Promise.all(pending)
    await storage.flushCurrentTranscriptDurably(second.uuid)
    const loaded = await storage.loadTranscriptFile(storage.getTranscriptPath(), { strict: true, keepAllLeaves: true })
    expect(loaded.messages.has(second.uuid as never)).toBe(true)
  } finally {
    releaseFirst.resolve(); releaseSecond.resolve()
    await Promise.allSettled(pending)
    interception?.mockRestore()
    await lease.releaseActiveTranscriptLease()
    storage.resetProjectForTesting()
    bootstrap.switchSession(previousSession, previousProject)
    if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfig
    if (originalPersistence === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    else process.env.TEST_ENABLE_SESSION_PERSISTENCE = originalPersistence
    rmSync(root, { recursive: true, force: true })
  }
}, 10_000)
