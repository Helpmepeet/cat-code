import { feature } from 'bun:bundle'
import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'desktop-worker-outcome-'))
const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
const previousPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
const realClassifier = await import('../../src/utils/permissions/yoloClassifier.js')
let scriptedReview: (() => Promise<unknown>) | undefined
mock.module('../../src/utils/permissions/yoloClassifier.js', () => ({
  ...realClassifier,
  classifyYoloAction: async () => {
    if (!scriptedReview) throw new Error('Unexpected classifier request in restore fixture')
    return scriptedReview()
  },
}))
const { resetStateForTests, switchSession, setCwdState, setOriginalCwd } = await import('../../src/bootstrap/state.js')
const { asSessionId, asAgentId } = await import('../../src/types/ids.js')
const { createUserMessage, createAssistantMessage, createAssistantAPIErrorMessage } = await import('../../src/utils/messages.js')
const { recordTranscript, appendSubagentSpawned, appendSubagentTerminal, getTranscriptPath, flushSessionStorage, resetProjectForTesting } = await import('../../src/utils/sessionStorage.js')
const { releaseActiveTranscriptLease } = await import('../../src/utils/transcriptLease.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { registerAsyncAgent, completeAgentTask, enqueueAgentNotification, queuePendingMessageIfRunning } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.js')
const { AbortError } = await import('../../src/utils/errors.js')
const { registerActiveSubagent, unregisterActiveSubagent, flushStallDetectedEntries } = await import('../../src/utils/cleanupRegistry.js')
const { _clearOutputsForTest, _resetTaskOutputDirForTest } = await import('../../src/utils/task/diskOutput.js')
const { resetCommandQueue } = await import('../../src/utils/messageQueueManager.js')
const { AgentTool } = await import('../../src/tools/AgentTool/AgentTool.js')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.js')
const { runAsyncAgentLifecycle } = await import('../../src/tools/AgentTool/agentToolUtils.js')
const { resumeEngineSession } = await import('./sessionResume.js')
const { compactResumeFixture } = await import('../../src/utils/conversationRecovery.fixture.js')
const { loadDisplayTranscriptFromJsonlPath } = await import('../../src/utils/sessionStorage.js')
const { mergeDisplayHistoryWithSeed, projectResumedHistory } = await import('./historyProjection.js')

afterAll(async () => {
  mock.restore()
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
  await recordTranscript([...compactResumeFixture(), assistant, ack])
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
  const display = await loadDisplayTranscriptFromJsonlPath(transcriptPath, { maxMessages: 100, maxBytes: 1024 * 1024 })
  const seed = projectResumedHistory(restored.messages)
  const merged = mergeDisplayHistoryWithSeed(display.messages, seed)
  expect(merged.truncated).toBe(false)
  expect(JSON.stringify(merged.history)).toContain('completed response')
  expect(merged.history.slice(-seed.length)).toEqual(seed)
  // Normal parent persistence is the durable acceptance boundary, not scheduling.
  await recordTranscript(restored.messages)
  await flushSessionStorage()
  await releaseActiveTranscriptLease()
  resetProjectForTesting()
  const again = await resumeEngineSession(sessionId, root, { activeAgents: [], allAgents: [] } as never)
  expect(again.messages.filter(message => message.type === 'user' && message.origin?.kind === 'task-notification')).toHaveLength(1)
})

const classifierEnabled = feature('TRANSCRIPT_CLASSIFIER') ? true : false
for (const boundary of ['cleanup', 'failure-cleanup', 'api-error-cleanup', 'killed-cleanup', 'review-pending', 'review-blocked', 'completion-shutdown', 'failure-shutdown', 'api-error-shutdown', 'killed-shutdown'] as const) {
  const reviewing = boundary.startsWith('review-')
  const shutdown = boundary.endsWith('-shutdown')
  const status = boundary.startsWith('killed-') ? 'killed'
    : boundary.startsWith('failure-') || boundary.startsWith('api-error-') ? 'failed' : 'completed'
  test.skipIf(reviewing && !classifierEnabled)(
    `desktop recovers ${status} output before notification persistence: ${boundary}`, async () => {
      const sessionId = crypto.randomUUID()
      await releaseActiveTranscriptLease()
      await _clearOutputsForTest()
      _resetTaskOutputDirForTest()
      resetCommandQueue()
      resetProjectForTesting()
      resetStateForTests()
      setOriginalCwd(root)
      setCwdState(root)
      switchSession(asSessionId(sessionId))
      await recordTranscript([createUserMessage({ content: 'fixture parent' })])
      await flushSessionStorage()
      const path = getTranscriptPath()
      const toolUseId = `run-${boundary}`
      appendSubagentSpawned(path, {
        sessionId, agentId: asAgentId('worker'), agentType: 'implementor',
        description: 'Fixture', transcriptPath: join(root, 'worker.jsonl'),
        toolUseId, spawnedAt: new Date().toISOString(), isAsync: true,
      })
      let state = getDefaultAppState()
      if (reviewing) state = { ...state, toolPermissionContext: { ...state.toolPermissionContext, mode: 'auto' } }
      const setAppState = (update: (prev: typeof state) => typeof state) => {
        const wasRunning = state.tasks.worker?.status === 'running'
        state = update(state)
        if (shutdown && wasRunning && state.tasks.worker?.status === status) {
          // A parent exit can run the real stall sweep at the first await after
          // the terminal transition, before worker bookkeeping finishes.
          queueMicrotask(() => flushStallDetectedEntries(path))
        }
      }
      const registration = registerAsyncAgent({
        agentId: 'worker', prompt: 'fixture', description: 'Fixture', toolUseId,
        selectedAgent: { agentType: 'implementor', source: 'built-in', baseDir: 'built-in', whenToUse: 'fixture', getSystemPrompt: () => 'fixture' }, setAppState,
      })
      const instruction = 'Check the unhandled instruction fixture.ts'
      if (status !== 'completed') {
        expect(queuePendingMessageIfRunning('worker', instruction, setAppState)).toBe(true)
      }
      let release!: () => void
      let reached!: () => void
      const paused = new Promise<void>(resolve => { reached = resolve })
      const gate = new Promise<void>(resolve => { release = resolve })
      registerActiveSubagent('worker', {
        startedAt: Date.now(), toolUseId, transcriptPath: join(root, 'worker.jsonl'),
        agentType: 'implementor', description: 'Fixture', sessionId,
      })
      let reviews = 0
      scriptedReview = async () => {
        reviews++
        if (boundary === 'review-pending') { reached(); await gate }
        return { shouldBlock: boundary === 'review-blocked', unavailable: false, reason: 'fixture safety finding', model: 'fixture' }
      }
      const lifecycle = runAsyncAgentLifecycle({
        taskId: 'worker', runId: registration.runId, abortController: registration.abortController!,
        makeStream: async function* () {
          const action = createAssistantMessage({ content: 'fixture action' })
          action.message.content = [{ type: 'tool_use', id: 'fixture-action', name: FileReadTool.name, input: { file_path: 'fixture.ts' } }]
          yield action
          yield createAssistantMessage({ content: 'worker outcome fixture.ts' })
          if (boundary.startsWith('failure-')) throw new Error('fixture stream failed')
          if (boundary.startsWith('killed-')) throw new AbortError('fixture stopped')
          if (boundary.startsWith('api-error-')) {
            yield createAssistantAPIErrorMessage({ content: 'fixture API failed' })
          }
        },
        metadata: { prompt: 'fixture', agentType: 'implementor', resolvedAgentModel: 'claude-sonnet-4-6', isBuiltInAgent: true, isAsync: true, startTime: Date.now() },
        description: 'Fixture', agentIdForCleanup: 'worker', enableSummarization: false,
        toolUseContext: { toolUseId, options: { tools: [FileReadTool], mainLoopProvider: 'anthropic' }, getAppState: () => state, setAppState } as never,
        rootSetAppState: setAppState, parentTranscriptPath: path, parentSessionId: sessionId,
        getWorktreeResult: async () => {
          if (boundary !== 'review-pending') { reached(); await gate }
          return {}
        },
      })
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([paused, new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('completion boundary not reached')), 2000)
        })])
        clearTimeout(timeout)
        const persisted = await readFile(path, 'utf8')
        expect(persisted).not.toContain('queue-operation')
        expect(state.tasks.worker?.status).toBe(status)
        expect(reviews).toBe(reviewing ? 1 : 0)
        // Restore from the durable prefix at this exact crash boundary. The
        // paused lifecycle cannot append a later outcome while restore reads.
        await releaseActiveTranscriptLease()
        resetProjectForTesting()
        const restored = await resumeEngineSession(sessionId, root, { activeAgents: [], allAgents: [] } as never)
        const outcomes = restored.messages.filter(message => message.type === 'user' && message.origin?.kind === 'task-notification')
        expect(outcomes).toHaveLength(1)
        expect(JSON.stringify(outcomes)).toContain('worker outcome fixture.ts')
        if (status !== 'completed') expect(JSON.stringify(outcomes)).toContain(instruction)
        if (status === 'failed') expect(JSON.stringify(outcomes)).toContain(boundary.startsWith('failure-') ? 'fixture stream failed' : 'fixture API failed')
        expect(outcomes[0]).toMatchObject({ origin: { kind: 'task-notification', taskId: 'worker', toolUseId } })
        if (boundary === 'review-pending') expect(JSON.stringify(outcomes)).toContain('safety classifier was unavailable')
        if (boundary === 'review-blocked') expect(JSON.stringify(outcomes)).toContain('SECURITY WARNING')
        if (!reviewing) expect(JSON.stringify(outcomes)).not.toContain('safety classifier was unavailable')
        expect(reviews).toBe(reviewing ? 1 : 0)
        await recordTranscript(restored.messages)
        await flushSessionStorage()
        await releaseActiveTranscriptLease()
        resetProjectForTesting()
        const again = await resumeEngineSession(sessionId, root, { activeAgents: [], allAgents: [] } as never)
        expect(again.messages.filter(message => message.type === 'user' && message.origin?.kind === 'task-notification')).toHaveLength(1)
      } finally {
        clearTimeout(timeout)
        release()
        await lifecycle
        unregisterActiveSubagent('worker')
        scriptedReview = undefined
        resetCommandQueue()
        await flushSessionStorage()
      }
    }, 10_000,
  )
}
