import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { randomUUID, type UUID } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, ftruncateSync, mkdtempSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'tail-recovery-test-'))
const previousConfig = process.env.CLAUDE_CONFIG_DIR
const previousPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
const bootstrap = await import('../bootstrap/state.js')
const originalSession = bootstrap.getSessionId()
const originalProject = bootstrap.getSessionProjectDir()
const { asSessionId } = await import('../types/ids.js')
const storage = await import('./sessionStorage.js')
const lease = await import('./transcriptLease.js')
const { createUserMessage } = await import('./messages.js')
const guard = await import('./transcriptAppendGuard.js')
const recovery = await import('./transcriptTailRecovery.js')
const { updateWorkspaceHandoffExecution } = await import('./workspaceHandoffExecutionState.js')
let path: string
let sessionId: string
let seed: ReturnType<typeof createUserMessage>
let intact = Buffer.alloc(0)
const torn = Buffer.from('{"type":"assistant","message":{"content":"private damaged material')

beforeEach(async () => {
  await lease.releaseActiveTranscriptLease()
  storage.resetProjectForTesting()
  sessionId = randomUUID()
  const project = join(root, sessionId)
  mkdirSync(project, { mode: 0o700 })
  bootstrap.switchSession(asSessionId(sessionId), project)
  seed = createUserMessage({ content: 'intact user request' })
  await storage.recordTranscript([seed])
  await storage.flushCurrentTranscriptDurably()
  path = storage.getTranscriptPathForSession(sessionId)
  intact = readFileSync(path)
})
afterEach(async () => {
  await lease.releaseActiveTranscriptLease()
  storage.resetProjectForTesting()
})
afterAll(() => {
  bootstrap.switchSession(asSessionId(originalSession), originalProject)
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfig
  if (previousPersistence === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  else process.env.TEST_ENABLE_SESSION_PERSISTENCE = previousPersistence
  rmSync(root, { recursive: true, force: true })
})
function prepare(fault?: Parameters<typeof recovery.prepareOwnedTranscriptTail>[2]['fault']) {
  return recovery.prepareOwnedTranscriptTail(path, sessionId, {
    verifyCheckpoint: checkpoint => storage.verifyResumeCheckpoint(checkpoint, path, sessionId),
    validateRetained: async prefixBytes => {
      const loaded = await storage.loadTranscriptFile(path, { prefixBytes, strict: true, keepAllLeaves: true })
      const active = storage.selectActiveConversation(loaded.messages, loaded.leafUuids, loaded.activeConversationTip)
      expect(active.messages.some(message => message.uuid === seed.uuid)).toBe(true)
      return active.tip!.uuid
    }, fault,
  })
}

async function acknowledgeRecovery() {
  // Owned resume clears this cache after publishing its out-of-band disclosure.
  storage.clearSessionMessagesCache()
  const loaded = await storage.loadTranscriptFile(path, { strict: true, keepAllLeaves: true })
  const active = storage.selectActiveConversation(loaded.messages, loaded.leafUuids, loaded.activeConversationTip)
  const input = createUserMessage({ content: 'genuine review of the current recovered history' })
  await storage.recordTranscript([...active.messages, input])
  await storage.markActiveConversationTip(input.uuid as UUID)
  await storage.flushCurrentTranscriptDurably(input.uuid)
  recovery.acceptTailRecoveryReview(path, sessionId, input.uuid)
  return input
}

test('an archived V2 receipt cannot clear review on a different selected branch', async () => {
  appendFileSync(path, torn)
  await prepare()
  await acknowledgeRecovery()
  expect(recovery.readTailRecoveryState(path, sessionId)?.reviewRequired).toBe(false)
  await storage.markActiveConversationTip(seed.uuid as UUID)
  await storage.flushCurrentTranscriptDurably()
  const loaded = await storage.loadTranscriptFile(path, { strict: true, keepAllLeaves: true })
  expect(storage.selectActiveConversation(loaded.messages, loaded.leafUuids, loaded.activeConversationTip)
    .messages.map(row => row.uuid)).toEqual([seed.uuid])
  expect(recovery.readTailRecoveryState(path, sessionId)?.reviewRequired).toBe(true)
})

test('explicit compact-boundary lineage preserves a reviewed receipt without granting it to another branch', async () => {
  appendFileSync(path, torn)
  await prepare()
  const input = await acknowledgeRecovery()
  const boundary = randomUUID(), summary = randomUUID()
  appendFileSync(path, [
    { type: 'system', subtype: 'compact_boundary', uuid: boundary, sessionId, parentUuid: null,
      logicalParentUuid: input.uuid, isSidechain: false, timestamp: new Date().toISOString(),
      content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 1000 } },
    { ...createUserMessage({ content: 'preserved summary', isMeta: true }), uuid: summary,
      sessionId, parentUuid: boundary, isSidechain: false },
    { type: 'active-conversation-tip', sessionId, tipUuid: summary },
  ].map(row => JSON.stringify(row) + '\n').join(''))
  expect(recovery.readTailRecoveryState(path, sessionId)?.reviewRequired).toBe(false)
  await storage.markActiveConversationTip(seed.uuid as UUID)
  await storage.flushCurrentTranscriptDurably()
  expect(recovery.readTailRecoveryState(path, sessionId)?.reviewRequired).toBe(true)
})

test.each(['backup', 'backup-sync', 'manifest', 'manifest-sync', 'truncate', 'truncate-sync', 'disclosure', 'disclosure-sync', 'partial'] as const)('later recovery preserves earlier evidence and restarts after %s', async stage => {
  appendFileSync(path, torn)
  const first = await prepare()
  await acknowledgeRecovery()
  const firstRoot = recovery.transcriptRecoveryDirectory(path)
  const preserved = new Map(['manifest.json', 'tail.bin', 'accepted.json'].map(name =>
    [name, readFileSync(join(firstRoot, name))]))
  const secondTail = Buffer.from('{"type":"assistant","unfinished":"second interruption')
  appendFileSync(path, secondTail)
  await expect(prepare(observed => {
    if (observed === stage || stage === 'partial' && observed === 'disclosure') {
      if (stage === 'partial') {
        const manifest = JSON.parse(readFileSync(join(recovery.transcriptRecoveryDirectory(path), 'manifest.json'), 'utf8'))
        const fd = openSync(path, 'r+')
        try { ftruncateSync(fd, manifest.boundary + 20) } finally { closeSync(fd) }
      }
      throw new Error(`later crash at ${stage}`)
    }
  })).rejects.toThrow('later crash at')
  const second = await prepare()
  expect(second?.reviewRequired).toBe(true)
  expect(second?.warningUuid).not.toBe(first?.warningUuid)
  expect(readFileSync(join(recovery.transcriptRecoveryDirectory(path), 'tail.bin'))).toEqual(secondTail)
  for (const [name, bytes] of preserved) expect(readFileSync(join(firstRoot, name))).toEqual(bytes)
  expect(readFileSync(path, 'utf8').split(recovery.RECOVERY_WARNING)).toHaveLength(3)
  await acknowledgeRecovery()
  expect(recovery.readTailRecoveryState(path, sessionId)?.reviewRequired).toBe(false)
  const completed = readFileSync(path)
  await prepare()
  expect(readFileSync(path)).toEqual(completed)
})

test('later episode evidence cannot be hidden by a missing selection pointer', async () => {
  appendFileSync(path, torn)
  await prepare()
  await acknowledgeRecovery()
  const base = recovery.transcriptRecoveryDirectory(path)
  const original = readFileSync(join(base, 'tail.bin'))
  appendFileSync(path, '{"unfinished":"second episode')
  await prepare()
  const latest = recovery.transcriptRecoveryDirectory(path)
  expect(latest).not.toBe(base)
  renameSync(join(base, 'current.json'), join(base, 'current.preserved.json'))
  const bytes = readFileSync(path)
  expect(() => recovery.readTailRecoveryState(path, sessionId)).toThrow('episode evidence is missing')
  await expect(prepare()).rejects.toThrow('episode evidence is missing')
  expect(readFileSync(path)).toEqual(bytes)
  expect(readFileSync(join(base, 'tail.bin'))).toEqual(original)
})

test('three successive recoveries retain all prior immutable episodes', async () => {
  const roots: string[] = []
  const tails: Buffer[] = []
  for (let episode = 0; episode < 3; episode++) {
    const tail = Buffer.from(`{"unfinished":"episode ${episode}`)
    appendFileSync(path, tail)
    await prepare()
    roots.push(recovery.transcriptRecoveryDirectory(path))
    tails.push(tail)
    expect(recovery.readTailRecoveryState(path, sessionId)?.reviewRequired).toBe(true)
    await acknowledgeRecovery()
  }
  expect(new Set(roots).size).toBe(3)
  roots.forEach((root, index) => expect(readFileSync(join(root, 'tail.bin'))).toEqual(tails[index]!))
  expect(recovery.readTailRecoveryState(path, sessionId)?.reviewRequired).toBe(false)
})

test('valid JSON with invalid recovery evidence is not reclassified as a damaged tail', async () => {
  appendFileSync(path, JSON.stringify({ type: 'system', sessionId, uuid: randomUUID(), transcriptRecovery: { forged: true } }))
  const bytes = readFileSync(path)
  await expect(prepare()).rejects.toThrow('Invalid recovery disclosure')
  expect(readFileSync(path)).toEqual(bytes)
  expect(existsSync(recovery.transcriptRecoveryDirectory(path))).toBe(false)
})

test('framing distinguishes missing separator, invalid UTF-8 tail and terminated corruption', () => {
  expect(guard.inspectTranscriptFraming(Buffer.from('{"type":"tag"}')).needsSeparator).toBe(true)
  expect(guard.inspectTranscriptFraming(Buffer.concat([intact, Buffer.from([0xff, 0xfe])])).suffix).toEqual(Buffer.from([0xff, 0xfe]))
  for (const bytes of [Buffer.concat([intact, Buffer.from('{broken}\n')]), Buffer.from('{broken}\n{"valid":true}\n')]) {
    expect(() => guard.inspectTranscriptFraming(bytes)).toThrow('malformed terminated')
  }
})

test('ordinary append preserves a valid JSON record without LF and refuses a damaged tail unchanged', () => {
  writeFileSync(path, '{"type":"tag","tag":"kept"}', { mode: 0o600 })
  guard.appendFramedTranscriptSync(path, '{"type":"tag","tag":"later"}\n')
  expect(readFileSync(path, 'utf8')).toBe('{"type":"tag","tag":"kept"}\n{"type":"tag","tag":"later"}\n')
  appendFileSync(path, torn)
  const before = readFileSync(path)
  expect(() => guard.appendFramedTranscriptSync(path, '{"later":true}\n')).toThrow('unfinished record')
  expect(readFileSync(path)).toEqual(before)
})

test('LF-ended intact history above the recovery budget needs one byte of append inspection', async () => {
  const fs = await import('node:fs')
  const block = Buffer.from(JSON.stringify({ type: 'tag', sessionId, tag: 'x'.repeat(1024 * 1024) }) + '\n')
  const fd = openSync(path, 'a')
  try { for (let i = 0; i < 513; i++) guard.writeTranscriptBytes(fd, block) } finally { closeSync(fd) }
  expect(fs.statSync(path).size).toBeGreaterThan(512 * 1024 * 1024)
  const realRead = fs.readSync
  let inspectedBytes = 0
  const read = spyOn(fs, 'readSync').mockImplementation(((descriptor: number, buffer: NodeJS.ArrayBufferView,
    offset: number, length: number, position: number | null) => {
    const count = realRead(descriptor, buffer, offset, length, position)
    inspectedBytes += count
    return count
  }) as typeof fs.readSync)
  try {
    guard.appendFramedTranscriptSync(path, '{\"type\":\"tag\",\"tag\":\"appended without a full history scan\"}\n')
    expect(inspectedBytes).toBe(1)
  } finally { read.mockRestore() }
}, 30_000)

test.each(['backup', 'backup-sync', 'manifest', 'manifest-sync', 'truncate', 'truncate-sync', 'disclosure', 'disclosure-sync', 'partial'] as const)('durable recovery restarts idempotently after %s crash cut', async stage => {
  appendFileSync(path, torn)
  await expect(prepare(observed => {
    if (observed === stage || stage === 'partial' && observed === 'disclosure') {
      if (stage === 'partial') {
        const manifest = JSON.parse(readFileSync(join(recovery.transcriptRecoveryDirectory(path), "manifest.json"), 'utf8'))
        const fd = openSync(path, 'r+')
        try { ftruncateSync(fd, manifest.boundary + 20) } finally { closeSync(fd) }
      }
      throw new Error(`crash at ${stage}`)
    }
  })).rejects.toThrow('crash at')
  const result = await prepare()
  expect(result?.reviewRequired).toBe(true)
  expect(readFileSync(join(recovery.transcriptRecoveryDirectory(path), "tail.bin"))).toEqual(torn)
  const recovered = readFileSync(path)
  expect(recovered.subarray(0, intact.length)).toEqual(intact)
  expect(recovered.toString()).not.toContain('private damaged material')
  expect(recovered.toString()).toContain(recovery.RECOVERY_WARNING)
  expect(recovered.toString()).toContain(recovery.RECOVERY_CONTEXT)
  await prepare()
  expect(readFileSync(path)).toEqual(recovered)
  if (stage === 'partial') expect(readdirSync(recovery.transcriptRecoveryDirectory(path)).some(name => name.startsWith('partial-'))).toBe(true)
})

test('recovery requires affirmative correct ownership, a private file and no symlink', async () => {
  appendFileSync(path, torn)
  const damaged = readFileSync(path)
  await lease.releaseActiveTranscriptLease()
  await expect(prepare()).rejects.toThrow('ownership required')
  await lease.activateTranscriptLease(randomUUID())
  await expect(prepare()).rejects.toThrow('ownership required')
  await lease.activateTranscriptLease(sessionId)
  chmodSync(path, 0o644)
  await expect(prepare()).rejects.toThrow('Unsafe transcript')
  chmodSync(path, 0o600)
  const link = `${path}.link`
  symlinkSync(path, link)
  await expect(recovery.prepareOwnedTranscriptTail(link, sessionId, { verifyCheckpoint: async () => {}, validateRetained: async () => seed.uuid })).rejects.toThrow('Unsafe transcript')
  expect(readFileSync(path)).toEqual(damaged)
})

test('a replaced stale lease cannot authorize truncation', async () => {
  appendFileSync(path, torn)
  const damaged = readFileSync(path)
  const lockPath = join(process.env.CLAUDE_CONFIG_DIR!, 'transcript-leases', `${sessionId}.lease.lock`)
  renameSync(lockPath, `${lockPath}.retired`)
  mkdirSync(lockPath, { mode: 0o700 })
  await expect(prepare()).rejects.toThrow('ownership was replaced')
  expect(readFileSync(path)).toEqual(damaged)
  expect(existsSync(recovery.transcriptRecoveryDirectory(path))).toBe(false)
})

test('healthy preflight and completed-review growth use bounded streaming reads', async () => {
  const fs = await import('node:fs')
  const block = Buffer.from(JSON.stringify({ type: 'tag', sessionId, tag: 'x'.repeat(128 * 1024) }) + '\n')
  const grow = () => {
    const fd = openSync(path, 'a')
    try { for (let i = 0; i < 128; i++) guard.writeTranscriptBytes(fd, block) } finally { closeSync(fd) }
  }
  grow()
  const realRead = fs.readSync
  let maximumRead = 0
  const observe = () => spyOn(fs, 'readSync').mockImplementation(((descriptor: number, buffer: NodeJS.ArrayBufferView,
    offset: number, length: number, position: number | null) => {
    maximumRead = Math.max(maximumRead, length)
    return realRead(descriptor, buffer, offset, length, position)
  }) as typeof fs.readSync)
  let observer = observe()
  try {
    expect(await storage.prepareOwnedTranscriptForResume(sessionId, path)).toBeNull()
    expect(maximumRead).toBeLessThanOrEqual(64 * 1024)
  } finally { observer.mockRestore() }
  appendFileSync(path, torn)
  await storage.prepareOwnedTranscriptForResume(sessionId, path)
  const loaded = await storage.loadTranscriptFile(path, { strict: true, keepAllLeaves: true })
  const active = storage.selectActiveConversation(loaded.messages, loaded.leafUuids, loaded.activeConversationTip)
  const input = createUserMessage({ content: 'review after streamed preflight' })
  await storage.recordTranscript([...active.messages, input])
  await storage.markActiveConversationTip(input.uuid as UUID)
  await storage.flushCurrentTranscriptDurably(input.uuid)
  maximumRead = 0
  observer = observe()
  try {
    recovery.acceptTailRecoveryReview(path, sessionId, input.uuid)
    grow()
    expect(recovery.readTailRecoveryState(path, sessionId)?.reviewRequired).toBe(false)
    expect(maximumRead).toBeLessThanOrEqual(64 * 1024)
  } finally { observer.mockRestore() }
}, 30_000)

test('resource exclusion refuses synchronous and cross-process metadata writers explicitly', async () => {
  await guard.withTranscriptAppendGuard(path, async () => {
    expect(() => guard.appendFramedTranscriptSync(path, '{"type":"tag"}\n')).toThrow()
    const child = Bun.spawnSync([process.execPath, '-e', `import { appendFramedTranscriptSync } from ${JSON.stringify(join(import.meta.dir, 'transcriptAppendGuard.ts'))}; try { appendFramedTranscriptSync(${JSON.stringify(path)}, '{"type":"tag"}\\n'); process.exit(2) } catch { process.exit(0) }`])
    expect(child.exitCode).toBe(0)
    expect(readFileSync(path)).toEqual(intact)
  })
  guard.appendFramedTranscriptSync(path, '{"type":"tag","tag":"ordinary metadata still works"}\n')
  expect(readFileSync(path, 'utf8')).toContain('ordinary metadata still works')
})

test.each([[1, 'changed'], [2, 'changed'], [1, 'missing'], [2, 'missing']] as const)('known v%s commitment covering %s bytes blocks repair before backup', async (version, damage) => {
  const current = await storage.sealResumeCheckpoint([seed])
  const checkpoint = { ...current, version: version as 1 | 2 }
  const generation = randomUUID()
  const identity = { appSessionId: randomUUID(), engineSessionId: sessionId, operationId: randomUUID(), continuationId: randomUUID(),
    sourceGeneration: randomUUID(), admissionGeneration: generation, operationSha256: 'a'.repeat(64) }
  await updateWorkspaceHandoffExecution(identity, () => ({ ...identity, version: 1, revision: 1, origin: 'fresh', consumed: true,
    inputCommitted: true, cancellation: null, terminal: { outcome: 'failed', order: 1, checkpoint }, notice: null, reconciliation: null }))
  if (damage === 'changed') {
    writeFileSync(path, readFileSync(path, 'utf8').replace('intact user request', 'altered user input'))
    appendFileSync(path, torn)
  } else {
    const fd = openSync(path, 'r+')
    try { ftruncateSync(fd, checkpoint.prefixBytes - 5) } finally { closeSync(fd) }
  }
  const damaged = readFileSync(path)
  await expect(prepare()).rejects.toThrow(damage === 'changed' ? 'digest differs' : 'prefix')
  expect(readFileSync(path)).toEqual(damaged)
  expect(existsSync(recovery.transcriptRecoveryDirectory(path))).toBe(false)
})

test('explicit owned storage preflight repairs before the real loader and retains a persistent review hold', async () => {
  appendFileSync(path, torn)
  const result = await storage.prepareOwnedTranscriptForResume(sessionId, path)
  expect(result?.reviewRequired).toBe(true)
  const { loadConversationForResume } = await import('./conversationRecovery.js')
  const loaded = await loadConversationForResume(sessionId, path, { interruptedTurn: 'ignore' })
  expect(loaded?.tailRecovery?.reviewRequired).toBe(true)
  expect(loaded?.turnInterruptionState).toEqual({ kind: 'none' })
  expect(loaded?.messages.some(message => message.type === 'user' && message.isMeta && message.message.content === recovery.RECOVERY_CONTEXT)).toBe(true)
})

test('mutable loader preflights damage while read-only/fork loading refuses without source mutation', async () => {
  const { loadConversationForResume } = await import('./conversationRecovery.js')
  appendFileSync(path, torn)
  const damaged = readFileSync(path)
  await expect(loadConversationForResume(sessionId, path, { interruptedTurn: 'ignore' })).rejects.toThrow('owned mutable resume')
  expect(readFileSync(path)).toEqual(damaged)
  expect(existsSync(recovery.transcriptRecoveryDirectory(path))).toBe(false)
  const loaded = await loadConversationForResume(sessionId, path, { interruptedTurn: 'ignore', mutable: true })
  expect(loaded?.tailRecovery?.reviewRequired).toBe(true)
  expect(readFileSync(join(recovery.transcriptRecoveryDirectory(path), "tail.bin"))).toEqual(torn)
})

test('retained validation and pathname replacement failures never truncate unvalidated history', async () => {
  appendFileSync(path, torn)
  const damaged = readFileSync(path)
  await expect(recovery.prepareOwnedTranscriptTail(path, sessionId, {
    verifyCheckpoint: async () => {},
    validateRetained: async () => { throw new Error('missing retained predecessor') },
  })).rejects.toThrow('missing retained predecessor')
  expect(readFileSync(path)).toEqual(damaged)
  await expect(recovery.prepareOwnedTranscriptTail(path, sessionId, {
    verifyCheckpoint: async () => {},
    validateRetained: async () => {
      renameSync(path, `${path}.original`)
      writeFileSync(path, intact, { mode: 0o600 })
      return seed.uuid
    },
  })).rejects.toThrow('identity changed')
  expect(readFileSync(`${path}.original`)).toEqual(damaged)
  expect(readFileSync(path)).toEqual(intact)
  expect(readFileSync(join(recovery.transcriptRecoveryDirectory(path), "tail.bin"))).toEqual(torn)
})

test('unreadable or over-budget local evidence blocks recovery without touching the transcript', async () => {
  appendFileSync(path, torn)
  const damaged = readFileSync(path)
  const directory = join(process.env.CLAUDE_CONFIG_DIR!, 'workspace-handoff-executions', sessionId)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeFileSync(join(directory, `${randomUUID()}.json`), '{broken', { mode: 0o600 })
  await expect(prepare()).rejects.toThrow()
  expect(existsSync(recovery.transcriptRecoveryDirectory(path))).toBe(false)
  for (let i = 0; i < 128; i++) writeFileSync(join(directory, `${randomUUID()}.json`), '{}', { mode: 0o600 })
  await expect(prepare()).rejects.toThrow('Too much local checkpoint evidence')
  expect(readFileSync(path)).toEqual(damaged)
})

test('async append failure retains bytes and is never retried as a whole batch', async () => {
  let writes = 0
  const writer = spyOn(guard, 'appendFramedTranscriptWithinGuard').mockImplementation(() => {
    writes++
    appendFileSync(path, '{\"type\":')
    throw new Error('synthetic partial append failure')
  })
  try {
    await storage.recordTranscript([seed, createUserMessage({ content: 'uncertain appended input' })])
    await expect(storage.flushSessionStorage()).rejects.toThrow('partial append failure')
  } finally { writer.mockRestore() }
  const bytes = readFileSync(path)
  await expect(storage.flushSessionStorage()).rejects.toThrow('partial append failure')
  expect(writes).toBe(1)
  expect(readFileSync(path)).toEqual(bytes)
})

test('external metadata refuses a damaged target without swallowing or replacing its bytes', async () => {
  appendFileSync(path, torn)
  const damaged = readFileSync(path)
  await expect(storage.saveTag(sessionId as `${string}-${string}-${string}-${string}-${string}`, 'must not append')).rejects.toThrow('unfinished record')
  expect(readFileSync(path)).toEqual(damaged)
})
