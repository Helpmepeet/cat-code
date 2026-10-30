import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getSessionId } from '../bootstrap/state.js'
import { asAgentId } from '../types/ids.js'
import { activateTranscriptLease, releaseActiveTranscriptLease, TranscriptInUseError, withUnownedTranscriptLease } from './transcriptLease.js'

const mode = process.argv[2]!
const scenario = process.argv[3]!
const sessionId = '11111111-1111-4111-8111-111111111111'
let ingressCalls = 0
let failReader = false
let empty = false
const ingress = await import('../services/api/sessionIngress.js')
mock.module('../services/api/sessionIngress.js', () => ({
  ...ingress,
  getSessionLogs: async () => {
    ingressCalls++
    if (scenario === 'released-main') await releaseActiveTranscriptLease()
    if (failReader) throw new Error('synthetic reader failure')
    return empty ? [] : [{ type: 'probe', marker: 'remote' }]
  },
  appendSessionLog: async () => { throw new Error('Unexpected ingress append') },
}))
const storage = await import('./sessionStorage.js')
const path = storage.getTranscriptPathForSession(sessionId)
await mkdir(dirname(path), { recursive: true })
await writeFile(path, 'original-main\n')
// Hydration switches to the target identity before deriving agent paths.
const agentPath = join(dirname(path), sessionId, 'subagents', 'agent-probe.jsonl')
await mkdir(dirname(agentPath), { recursive: true })
await writeFile(agentPath, 'original-agent\n')
let readerCalls = 0
storage.setInternalEventReader(async () => {
  readerCalls++
  if (scenario === 'released-main') await releaseActiveTranscriptLease()
  if (scenario === 'epoch') throw new Error('CCRClient: Epoch mismatch (409)')
  if (failReader) throw new Error('synthetic reader failure')
  return empty ? [] : [{ payload: { type: 'probe', marker: 'remote' } }]
}, async () => {
  if (scenario === 'released-agent') {
    await releaseActiveTranscriptLease()
    return [{ agent_id: 'probe', payload: { type: 'probe', marker: 'agent-remote' } }]
  }
  // Prove the foreground write did not release ownership before agent hydration.
  const contender = Bun.spawn([process.execPath, '-e', `const l = await import(${JSON.stringify(join(import.meta.dir, 'transcriptLease.ts'))}); try { await l.activateTranscriptLease(${JSON.stringify(sessionId)}); await l.releaseActiveTranscriptLease(); process.exit(2) } catch(e) { process.exit(e.name === 'TranscriptInUseError' ? 0 : 3) }`], {
    env: process.env, stdout: 'pipe', stderr: 'pipe',
  })
  assert.equal(await contender.exited, 0, await new Response(contender.stderr).text())
  return empty ? [] : [{ agent_id: 'probe', payload: { type: 'probe', marker: 'agent-remote' } }]
})
const hydrate = () => mode === 'v1'
  ? storage.hydrateRemoteSession(sessionId, 'https://invalid.test/ingress')
  : storage.hydrateFromCCRv2InternalEvents(sessionId)

let holder: ReturnType<typeof Bun.spawn> | undefined
try {
  if (scenario === 'busy') {
    holder = Bun.spawn([process.execPath, '-e', `const l = await import(${JSON.stringify(join(import.meta.dir, 'transcriptLease.ts'))}); await l.activateTranscriptLease(${JSON.stringify(sessionId)}); console.log('READY'); for await (const chunk of Bun.stdin.stream()) { break }; await l.releaseActiveTranscriptLease()`], {
      env: process.env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    })
    const ready = await (holder.stdout as ReadableStream<Uint8Array>).getReader().read()
    assert.match(new TextDecoder().decode(ready.value), /READY/)
    const previousSession = getSessionId()
    await assert.rejects(hydrate, TranscriptInUseError)
    assert.equal(getSessionId(), previousSession)
    assert.equal(ingressCalls + readerCalls, 0)
    assert.equal(await readFile(path, 'utf8'), 'original-main\n')
    assert.equal(await readFile(agentPath, 'utf8'), 'original-agent\n')
  } else {
    const borrowed = scenario.startsWith('borrowed-') || scenario.startsWith('released-')
    if (borrowed) await activateTranscriptLease(sessionId)
    failReader = scenario === 'reader-failure' || scenario === 'borrowed-failure'
    empty = scenario === 'empty'
    if (scenario === 'write-failure') {
      const { unlink } = await import('fs/promises')
      await unlink(path)
      await mkdir(path)
    }
    if (scenario.startsWith('released-')) {
      await assert.rejects(hydrate, /hydration lease released/)
      assert.equal(await readFile(agentPath, 'utf8'), 'original-agent\n')
      assert.equal(await readFile(path, 'utf8'), scenario === 'released-main'
        ? 'original-main\n' : '{"type":"probe","marker":"remote"}\n')
    } else if (scenario === 'epoch') {
      await assert.rejects(hydrate, /CCRClient: Epoch mismatch \(409\)/)
    } else {
      assert.equal(await hydrate(), !failReader && scenario !== 'write-failure' && !empty)
    }
    if (scenario === 'success' || scenario === 'borrowed-success' || empty) {
      assert.equal(await readFile(path, 'utf8'), empty ? '' : '{"type":"probe","marker":"remote"}\n')
      if (mode === 'v2' && !empty) {
        assert.equal(storage.getAgentTranscriptPath(asAgentId('probe')), agentPath)
        assert.equal(await readFile(agentPath, 'utf8'), '{"type":"probe","marker":"agent-remote"}\n')
      }
    }
    if (failReader || scenario === 'epoch') {
      assert.equal(await readFile(path, 'utf8'), 'original-main\n')
      assert.equal(await readFile(agentPath, 'utf8'), 'original-agent\n')
    }
    if (borrowed && !scenario.startsWith('released-')) {
      assert.deepEqual(await withUnownedTranscriptLease(sessionId, async () => null), { acquired: false })
      await releaseActiveTranscriptLease()
    }
    // Temporary ownership must be gone on every return/throw path.
    assert.deepEqual(await withUnownedTranscriptLease(sessionId, async () => null), { acquired: true, value: null })
    await activateTranscriptLease(sessionId)
    await releaseActiveTranscriptLease()
  }
  console.log('PASS')
} finally {
  if (holder) {
    const stdin = holder.stdin
    if (stdin && typeof stdin !== 'number') {
      stdin.write('release')
      stdin.end()
    }
    assert.equal(await holder.exited, 0)
  }
  await releaseActiveTranscriptLease()
}
