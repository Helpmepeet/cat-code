import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OpenHistoryResolution } from '../main/openHistorySession.js'
import { PROTOCOL_VERSION, type SessionActionResultFrame } from '../shared/protocol.js'
import type { Message } from '../../src/types/message.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

type ForkEvidence = {
  appSessionId: string
  requestId: string
  result: SessionActionResultFrame
  requesterResultCount: number
  observerResultCount: number
  sourceUnchanged: boolean
  activeEngineSessionId: string
  sourceMessageUuids: string[]
  forkEntries: Array<{
    type: string
    uuid?: string
    sessionId: string
    parentUuid?: string | null
    isSidechain?: boolean
    forkedFrom?: { sessionId: string; messageUuid: string }
    customTitle?: string
    sourceSessionId?: string
  }>
  staleOpen: OpenHistoryResolution | null
  seededOpen: OpenHistoryResolution | null
  freshOpen: OpenHistoryResolution | null
}

async function isolatedState() {
  const root = mkdtempSync(join(tmpdir(), 'desktop-session-branch-'))
  roots.push(root)
  const cwd = join(root, 'workspace')
  const config = join(root, 'config')
  await Promise.all([mkdir(cwd), mkdir(config)])
  return { cwd: await realpath(cwd), config }
}

async function runFixture<T>(
  operation: 'fork' | 'empty' | 'resume',
  engineSessionId: string,
  state: Awaited<ReturnType<typeof isolatedState>>,
): Promise<T> {
  // Cold processes keep this test isolated from other suites' engine-module
  // mocks, bootstrap singletons, and persistence state.
  const child = Bun.spawn([
    process.execPath,
    new URL('./sessionBranch.fixture.ts', import.meta.url).pathname,
    operation,
    engineSessionId,
  ], {
    cwd: state.cwd,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: state.config,
      TEST_ENABLE_SESSION_PERSISTENCE: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
  })
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exit !== 0) throw new Error(`${operation} fixture exited ${exit}: ${stderr}\n${stdout}`)
  const line = stdout.split('\n').find(value => value.startsWith('SESSION_BRANCH_RESULT='))
  if (!line) throw new Error(`${operation} fixture returned no evidence: ${stdout}\n${stderr}`)
  return JSON.parse(line.slice('SESSION_BRANCH_RESULT='.length)) as T
}

test('session.branch persists the active HEAD, returns a correlated engine id, and cold-resumes the fork', async () => {
  const state = await isolatedState()
  const sourceEngineSessionId = randomUUID()
  const evidence = await runFixture<ForkEvidence>('fork', sourceEngineSessionId, state)
  const result = evidence.result
  expect(result).toMatchObject({
    kind: 'session-action.result',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: evidence.appSessionId,
    requestId: evidence.requestId,
    verb: 'branch',
    ok: true,
    branchTitle: 'Fork fixture prompt (Branch)',
  })
  expect(result.branchEngineSessionId).toMatch(/^[0-9a-f-]{36}$/)
  expect(result.branchEngineSessionId).not.toBe(sourceEngineSessionId)
  expect(result.branchEngineSessionId).not.toBe(evidence.appSessionId)
  const forkEngineSessionId = result.branchEngineSessionId
  if (!forkEngineSessionId) throw new Error('Successful branch returned no engine session id')
  expect(result.selectedPrompt).toBeUndefined()
  expect(evidence.requesterResultCount).toBe(1)
  expect(evidence.observerResultCount).toBe(0)
  expect(evidence.sourceUnchanged).toBe(true)
  expect(evidence.activeEngineSessionId).toBe(sourceEngineSessionId)

  const messages = evidence.forkEntries.filter(entry => ['user', 'assistant'].includes(entry.type))
  expect(messages.map(entry => entry.uuid)).toEqual(evidence.sourceMessageUuids)
  expect(messages.map(entry => entry.parentUuid)).toEqual([null, evidence.sourceMessageUuids[0]])
  for (const message of messages) {
    expect(message.sessionId).toBe(forkEngineSessionId)
    expect(message.isSidechain).toBe(false)
    expect(message.forkedFrom).toEqual({
      sessionId: sourceEngineSessionId,
      messageUuid: message.uuid!,
    })
  }
  expect(evidence.forkEntries).toContainEqual({
    type: 'custom-title',
    sessionId: forkEngineSessionId,
    customTitle: result.branchTitle,
  })
  expect(evidence.forkEntries).toContainEqual({
    type: 'forked-session',
    sessionId: forkEngineSessionId,
    sourceSessionId: sourceEngineSessionId,
  })
  // The main trusted seed is needed before the next catalog refresh. A fresh
  // engine catalog resolves the same id with its persisted cwd/title/provenance.
  expect(evidence.staleOpen?.kind).toBe('reject')
  expect(evidence.seededOpen).toEqual({
    kind: 'spawn',
    cwd: state.cwd,
    resumeEngineSessionId: forkEngineSessionId,
    title: result.branchTitle,
    forked: true,
    binding: { kind: 'project' },
  })
  expect(evidence.freshOpen).toEqual({
    kind: 'spawn',
    cwd: state.cwd,
    resumeEngineSessionId: forkEngineSessionId,
    title: result.branchTitle,
    forked: true,
    binding: { kind: 'project' },
  })

  const resumed = await runFixture<{
    engineSessionId: string
    messages: Message[]
    undeliveredPrompts: unknown[]
  }>('resume', forkEngineSessionId, state)
  expect(resumed.engineSessionId).toBe(forkEngineSessionId)
  expect(resumed.messages.map(message => message.uuid)).toEqual(evidence.sourceMessageUuids)
  expect(JSON.stringify(resumed.messages)).toContain('Fork fixture answer')
  expect(JSON.stringify(resumed.messages)).not.toContain('Discarded fixture')
  expect(resumed.undeliveredPrompts).toEqual([])
}, 120_000)

test('session.branch on an unsaved empty session returns a correlated failure without a fork id', async () => {
  const state = await isolatedState()
  const sourceEngineSessionId = randomUUID()
  const evidence = await runFixture<ForkEvidence>('empty', sourceEngineSessionId, state)
  expect(evidence.result).toMatchObject({
    kind: 'session-action.result',
    sessionId: evidence.appSessionId,
    requestId: evidence.requestId,
    verb: 'branch',
    ok: false,
    message: 'Could not branch: No messages to branch',
  })
  expect(evidence.result.branchEngineSessionId).toBeUndefined()
  expect(evidence.result.branchTitle).toBeUndefined()
  expect(evidence.requesterResultCount).toBe(1)
  expect(evidence.observerResultCount).toBe(0)
  expect(evidence.activeEngineSessionId).toBe(sourceEngineSessionId)
  expect(evidence.forkEntries).toEqual([])
}, 120_000)
