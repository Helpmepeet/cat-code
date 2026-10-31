import { afterAll, beforeEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'transcript-append-guard-'))
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

beforeEach(async () => {
  await lease.releaseActiveTranscriptLease()
  storage.resetProjectForTesting()
  bootstrap.switchSession(randomUUID() as never)
})

afterAll(async () => {
  await lease.releaseActiveTranscriptLease()
  storage.resetProjectForTesting()
  bootstrap.switchSession(previousSession, previousProject)
  if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfig
  if (originalPersistence === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  else process.env.TEST_ENABLE_SESSION_PERSISTENCE = originalPersistence
  rmSync(root, { recursive: true, force: true })
})

test('subagent markers written between queued transcript writes never find the lock held', async () => {
  const seed = createUserMessage({ content: 'seed' })
  await storage.recordTranscript([seed])
  await storage.flushCurrentTranscriptDurably(seed.uuid)
  const path = storage.getTranscriptPath()
  const messages = [seed]
  let markers = 0
  for (let index = 0; index < 100; index++) {
    messages.push(createUserMessage({ content: `row ${index}` }))
    await storage.recordTranscript(messages)
    let settled = false
    const flush = storage.flushSessionStorage().finally(() => { settled = true })
    while (!settled) {
      storage.appendSubagentTerminal(path, {
        sessionId: bootstrap.getSessionId(), agentId: 'a-marker' as never, toolUseId: `tool-${markers++}`,
        status: 'completed', durationMs: 1, endedAt: new Date().toISOString(),
      })
      await Bun.sleep(0)
    }
    await flush
  }
  const lines = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(lines.filter(line => line.type === 'subagent-terminal')).toHaveLength(markers)
  expect(lines.filter(line => line.type === 'user')).toHaveLength(messages.length)
}, 20_000)

test('a queued transcript write waits for a lock held by another writer', async () => {
  const dir = join(root, 'held')
  mkdirSync(dir)
  const path = join(dir, 'transcript.jsonl')
  const release = Promise.withResolvers<void>()
  const holder = guard.withTranscriptAppendGuard(path, () => release.promise)
  await Bun.sleep(20)
  const waiting = guard.appendFramedTranscript(path, '{"row":1}\n')
  await Bun.sleep(20)
  release.resolve()
  await Promise.all([holder, waiting])
  expect(readFileSync(path, 'utf8')).toBe('{"row":1}\n')
})
