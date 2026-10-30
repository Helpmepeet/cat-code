import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { randomUUID, type UUID } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SessionLocation } from './sessionRelocationState.js'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'recovery-relocation-')))
const previousConfig = process.env.CLAUDE_CONFIG_DIR
const previousPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
const bootstrap = await import('../bootstrap/state.js')
const oldSession = bootstrap.getSessionId()
const oldProject = bootstrap.getSessionProjectDir()
const { asSessionId } = await import('../types/ids.js')
const storage = await import('./sessionStorage.js')
const recovery = await import('./transcriptTailRecovery.js')
const { releaseActiveTranscriptLease } = await import('./transcriptLease.js')
const { relocateSession } = await import('./sessionRelocation.js')
const { readSessionRelocation } = await import('./sessionRelocationState.js')
const { createUserMessage } = await import('./messages.js')
const config = await import('./config.js')
let trust: { mockRestore(): void }
let id: string
let appId: string
let source: SessionLocation
let target: SessionLocation
let path: string
let contextUuid: string
const damaged = Buffer.from('{"unfinished":"preserved bytes')

beforeEach(async () => {
  await releaseActiveTranscriptLease()
  storage.resetProjectForTesting()
  id = randomUUID()
  appId = randomUUID()
  const chat = join(root, `${id}-chat`)
  const project = join(root, `${id}-project`)
  mkdirSync(chat); mkdirSync(project)
  source = { cwd: chat, binding: { kind: 'managed', storageRootId: randomUUID(), storageId: randomUUID() } }
  target = { cwd: project, binding: { kind: 'project' } }
  trust = spyOn(config, 'isPathTrusted').mockReturnValue(true)
  bootstrap.switchSession(asSessionId(id), storage.getProjectDir(source.cwd))
  await storage.recordTranscript([createUserMessage({ content: 'original saved work' })])
  await storage.flushCurrentTranscriptDurably()
  path = storage.getTranscriptPathForSession(id)
  appendFileSync(path, damaged)
  const state = await storage.prepareOwnedTranscriptForResume(id, path)
  contextUuid = state!.contextUuid
})
afterEach(async () => {
  trust.mockRestore()
  await releaseActiveTranscriptLease()
  storage.resetProjectForTesting()
})
afterAll(() => {
  bootstrap.switchSession(asSessionId(oldSession), oldProject)
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfig
  if (previousPersistence === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  else process.env.TEST_ENABLE_SESSION_PERSISTENCE = previousPersistence
  rmSync(root, { recursive: true, force: true })
})
function move(from: SessionLocation, to: SessionLocation, rollback = false) {
  return relocateSession({ engineSessionId: id, appSessionId: appId, source: from, target: to, controls: { mode: 'default' }, ...(rollback ? { rollback: true as const } : {}) })
}
async function review() {
  const loaded = await storage.loadTranscriptFile(path, { keepAllLeaves: true, strict: true })
  const active = storage.selectActiveConversation(loaded.messages, loaded.leafUuids, loaded.activeConversationTip)
  const input = createUserMessage({ content: 'genuine review before relocation' })
  await storage.recordTranscript([...active.messages, input])
  await storage.markActiveConversationTip(input.uuid as UUID)
  await storage.flushCurrentTranscriptDurably(input.uuid)
  recovery.acceptTailRecoveryReview(path, id, input.uuid)
  expect(recovery.readTailRecoveryState(path, id)?.reviewRequired).toBe(false)
}

test('actual relocation refuses pending review before moving or losing any evidence', async () => {
  const before = readFileSync(path)
  await releaseActiveTranscriptLease()
  await expect(move(source, target)).rejects.toThrow('Review the recovered history')
  expect(readFileSync(path)).toEqual(before)
  expect(readFileSync(join(recovery.transcriptRecoveryDirectory(path), 'tail.bin'))).toEqual(damaged)
  expect(existsSync(join(storage.getProjectDir(target.cwd), `${id}.jsonl`))).toBe(false)
  expect(readSessionRelocation(id)).toBeNull()
})

test('completed review and immutable backups survive actual relocation and rollback', async () => {
  await review()
  const originalBytes = readFileSync(path)
  await releaseActiveTranscriptLease()
  await move(source, target)
  const moved = join(storage.getProjectDir(target.cwd), `${id}.jsonl`)
  expect(readFileSync(moved)).toEqual(originalBytes)
  expect(recovery.readTailRecoveryState(moved, id)?.reviewRequired).toBe(false)
  expect(readFileSync(join(recovery.transcriptRecoveryDirectory(moved), 'tail.bin'))).toEqual(damaged)
  const record = readSessionRelocation(id)!
  expect(readFileSync(join(record.backup, id, 'transcript-recovery', 'tail.bin'))).toEqual(damaged)
  await move(target, source, true)
  expect(recovery.readTailRecoveryState(path, id)?.reviewRequired).toBe(false)
  expect(readFileSync(path)).toEqual(originalBytes)
})

test('missing portable evidence and journal-free copies/forks never silently clear the hold', async () => {
  const journal = recovery.transcriptRecoveryDirectory(path)
  renameSync(journal, `${journal}.preserved`)
  expect(() => recovery.readTailRecoveryState(path, id)).toThrow('evidence is missing')
  const copyId = randomUUID()
  const copied = join(dirname(path), `${copyId}.jsonl`)
  cpSync(path, copied, { force: false })
  expect(() => recovery.readTailRecoveryState(copied, copyId)).toThrow('evidence is missing')
  expect(readFileSync(join(`${journal}.preserved`, 'tail.bin'))).toEqual(damaged)
})

test('an input after the marker in file order cannot acknowledge a branch excluding its context', async () => {
  const input = createUserMessage({ content: 'input on the wrong branch' })
  const loaded = await storage.loadTranscriptFile(path, { keepAllLeaves: true, strict: true })
  const seed = [...loaded.messages.values()].find(row => row.type === 'user' && !row.isMeta)!
  const fakeBridge = randomUUID()
  appendFileSync(path, JSON.stringify({ type: 'queue-operation', operation: 'reserve', uuid: fakeBridge,
    parentUuid: contextUuid, sessionId: id, timestamp: new Date().toISOString() }) + '\n')
  appendFileSync(path, JSON.stringify({ ...input, sessionId: id, parentUuid: fakeBridge }) + '\n')
  await storage.markActiveConversationTip(input.uuid as UUID)
  await storage.flushCurrentTranscriptDurably(input.uuid)
  expect(() => recovery.acceptTailRecoveryReview(path, id, input.uuid)).toThrow('descending from its recovery context')
  expect(existsSync(join(recovery.transcriptRecoveryDirectory(path), 'accepted.json'))).toBe(false)
  expect(recovery.readTailRecoveryState(path, id)?.reviewRequired).toBe(true)
  expect(seed.uuid).not.toBe(contextUuid)
})

test('legacy adjacent evidence remains immutable through the actual completed move path', async () => {
  const portable = recovery.transcriptRecoveryDirectory(path)
  const manifest = JSON.parse(readFileSync(join(portable, 'manifest.json'), 'utf8'))
  manifest.version = 1
  const rows = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  for (const row of rows) delete row.transcriptRecovery
  writeFileSync(path, rows.map(row => JSON.stringify(row) + '\n').join(''))
  writeFileSync(join(portable, 'manifest.json'), JSON.stringify(manifest))
  const legacy = `${path}.recovery`
  renameSync(portable, legacy)
  await review()
  const evidence = readFileSync(join(legacy, 'manifest.json'))
  await releaseActiveTranscriptLease()
  await move(source, target)
  const moved = join(storage.getProjectDir(target.cwd), `${id}.jsonl`)
  expect(recovery.readTailRecoveryState(moved, id)?.reviewRequired).toBe(false)
  expect(readFileSync(join(`${moved}.recovery`, 'manifest.json'))).toEqual(evidence)
  expect(readFileSync(join(readSessionRelocation(id)!.backup, `${id}.jsonl.recovery`, 'tail.bin'))).toEqual(damaged)
})

test('actual branching refuses pending review and copies completed disclosure only as historical content', async () => {
  const { createFork } = await import('../commands/branch/branch.js')
  const before = readFileSync(path)
  await expect(createFork('pending recovery fork')).rejects.toThrow('Review the recovered history')
  expect(readFileSync(path)).toEqual(before)
  await review()
  const reviewed = readFileSync(path)
  const fork = await createFork('reviewed recovery fork')
  expect(recovery.readTailRecoveryState(fork.forkPath, fork.sessionId)).toBeNull()
  const rows = readFileSync(fork.forkPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(rows.some(row => row.content === recovery.RECOVERY_WARNING)).toBe(true)
  expect(rows.some(row => 'transcriptRecovery' in row)).toBe(false)
  expect(readFileSync(path)).toEqual(reviewed)
  expect(readFileSync(join(recovery.transcriptRecoveryDirectory(path), 'tail.bin'))).toEqual(damaged)
})
