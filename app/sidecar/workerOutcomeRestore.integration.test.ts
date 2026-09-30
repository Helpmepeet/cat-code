import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'desktop-worker-outcome-'))
const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
const previousPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
const { resetStateForTests, switchSession, setCwdState, setOriginalCwd } = await import('../../src/bootstrap/state.js')
const { asSessionId, asAgentId } = await import('../../src/types/ids.js')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.js')
const { recordTranscript, appendSubagentSpawned, appendSubagentTerminal, getTranscriptPath, flushSessionStorage, resetProjectForTesting } = await import('../../src/utils/sessionStorage.js')
const { releaseActiveTranscriptLease } = await import('../../src/utils/transcriptLease.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { registerAsyncAgent, completeAgentTask, enqueueAgentNotification } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.js')
const { _clearOutputsForTest, _resetTaskOutputDirForTest } = await import('../../src/utils/task/diskOutput.js')
const { resetCommandQueue } = await import('../../src/utils/messageQueueManager.js')
const { AgentTool } = await import('../../src/tools/AgentTool/AgentTool.js')
const { resumeEngineSession } = await import('./sessionResume.js')

afterAll(async () => {
  await releaseActiveTranscriptLease()
  await _clearOutputsForTest()
  _resetTaskOutputDirForTest()
  resetCommandQueue()
  resetProjectForTesting()
  resetStateForTests()
  await rm(root, { recursive: true, force: true })
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  if (previousPersistence === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  else process.env.TEST_ENABLE_SESSION_PERSISTENCE = previousPersistence
})

test('desktop restore returns the undelivered worker outcome to the parent with provenance, then deduplicates durable acceptance', async () => {
  const sessionId = crypto.randomUUID()
  resetStateForTests()
  setOriginalCwd(root)
  setCwdState(root)
  switchSession(asSessionId(sessionId))
  resetProjectForTesting()
  const assistant = createAssistantMessage({ content: 'delegate' })
  assistant.message.content = [{ type: 'tool_use', id: 'launch-worker', name: 'Agent', input: { prompt: 'fixture', run_in_background: true } }]
  const ack = createUserMessage({ content: [AgentTool.mapToolResultToToolResultBlockParam({
    status: 'async_launched', isAsync: true, agentId: 'worker', description: 'Fixture', prompt: 'fixture', outputFile: '/tmp/unused', canCheckProgress: false,
  } as never, 'launch-worker')] })
  await recordTranscript([createUserMessage({ content: 'start fixture' }), assistant, ack])
  await flushSessionStorage()
  const transcriptPath = getTranscriptPath()
  appendSubagentSpawned(transcriptPath, {
    sessionId, agentId: asAgentId('worker'), agentType: 'implementor', description: 'Fixture',
    transcriptPath: join(root, 'worker.jsonl'), toolUseId: 'launch-worker', spawnedAt: new Date().toISOString(), isAsync: true,
  })
  let state = getDefaultAppState()
  const setAppState = (update: (prev: typeof state) => typeof state) => { state = update(state) }
  const registration = registerAsyncAgent({ agentId: 'worker', prompt: 'fixture', description: 'Fixture',
    selectedAgent: { agentType: 'implementor', source: 'built-in', baseDir: 'built-in', whenToUse: 'fixture', getSystemPrompt: () => 'fixture' },
    setAppState, toolUseId: 'launch-worker' })
  completeAgentTask({ agentId: 'worker', content: [{ type: 'text', text: 'fixed fixture.ts; checks passed' }],
    totalDurationMs: 1, totalToolUseCount: 0, totalTokens: 1 }, setAppState, registration.runId)
  appendSubagentTerminal(transcriptPath, { sessionId, agentId: asAgentId('worker'), toolUseId: 'launch-worker', status: 'completed', durationMs: 1, endedAt: new Date().toISOString() })
  enqueueAgentNotification({ taskId: 'worker', description: 'Fixture', status: 'completed', finalMessage: 'fixed fixture.ts; checks passed', toolUseId: 'launch-worker', setAppState, runId: registration.runId })
  // Wait for the ordinary notification queue log batch to reach disk.
  for (let i = 0; i < 100; i++) {
    await flushSessionStorage()
    if ((await readFile(transcriptPath, 'utf8')).includes('queue-operation')) break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  expect(await readFile(transcriptPath, 'utf8')).toContain('queue-operation')
  // Restart only synthetic engine state. No model request or running application.
  resetCommandQueue()
  await releaseActiveTranscriptLease()
  resetProjectForTesting()
  const restored = await resumeEngineSession(sessionId, root, { activeAgents: [], allAgents: [] } as never)
  const outcomes = restored.messages.filter(message => message.type === 'user' && message.origin?.kind === 'task-notification')
  expect(outcomes).toHaveLength(1)
  expect(outcomes[0]).toMatchObject({ origin: { kind: 'task-notification', toolUseId: 'launch-worker', taskId: 'worker' } })
  expect(JSON.stringify(outcomes)).toContain('fixed fixture.ts; checks passed')
  expect(JSON.stringify(restored.messages)).not.toContain('still running')
  // Normal parent persistence is the durable acceptance boundary, not scheduling.
  await recordTranscript(restored.messages)
  await flushSessionStorage()
  await releaseActiveTranscriptLease()
  resetProjectForTesting()
  const again = await resumeEngineSession(sessionId, root, { activeAgents: [], allAgents: [] } as never)
  expect(again.messages.filter(message => message.type === 'user' && message.origin?.kind === 'task-notification')).toHaveLength(1)
})
