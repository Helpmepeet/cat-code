/** Process regression fixture: scripted provider, real QueryEngine/controller
 * claim, closure, independent W/R seal, and lease-owned execution publication. */
import { spyOn } from 'bun:test'
import { randomUUID, type UUID } from 'node:crypto'
import type { AssistantMessage } from '../../src/types/message.js'
import { init } from '../../src/entrypoints/init.js'
import { switchSession, setSessionProvider } from '../../src/bootstrap/state.js'
import { asSessionId } from '../../src/types/ids.js'
import { createAssistantMessage, createUserMessage } from '../../src/utils/messages.js'
import { recordTranscript, sealResumeCheckpoint, verifyResumeCheckpoint, flushCurrentTranscriptDurably, markActiveConversationTip, removeTranscriptMessage } from '../../src/utils/sessionStorage.js'
import { activateTranscriptLease, releaseActiveTranscriptLease } from '../../src/utils/transcriptLease.js'
import { readWorkspaceJump, upgradeWorkspaceJumpState, workspaceJumpOperationSha256 } from '../../src/utils/workspaceJumpState.js'
import { createRuntimeBackedAppSession } from '../../src/app-runtime/createRuntimeBackedAppSession.js'
import { getDefaultAppState } from '../../src/state/AppStateStore.js'
import { createFileStateCacheWithSizeLimit } from '../../src/utils/fileStateCache.js'
import * as claude from '../../src/services/api/claude.js'
import * as growthbook from '../../src/services/analytics/growthbook.js'

const saved = readWorkspaceJump(process.argv[2]!)
if (!saved) throw new Error('Missing fixture operation')
const state = upgradeWorkspaceJumpState(saved)
;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = { VERSION: 'isolated-handoff-process' }
await init()
await activateTranscriptLease(state.engineSessionId)
switchSession(asSessionId(state.engineSessionId))
setSessionProvider('openai')
let providerCalls = 0
const completedAssistantUuid = randomUUID()
const providerSpy = spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
  providerCalls++
  yield { type: 'assistant', uuid: completedAssistantUuid, timestamp: new Date().toISOString(), message: {
    id: randomUUID(), role: 'assistant', model: 'gpt-5.6-terra', content: [{ type: 'text', text: 'The saved task is complete.' }],
    usage: { input_tokens: 11, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    stop_reason: 'end_turn', stop_sequence: null,
  } } as AssistantMessage
})
const featureSpy = spyOn(growthbook, 'checkStatsigFeatureGate_CACHED_MAY_BE_STALE').mockReturnValue(false)
try {
  const seed = createUserMessage({ content: 'Complete the preserved request in this workspace.' })
  await recordTranscript([seed])
  await markActiveConversationTip(seed.uuid as UUID)
  await flushCurrentTranscriptDurably()
  const identity = { appSessionId: state.appSessionId, engineSessionId: state.engineSessionId,
    operationId: state.operationId, continuationId: state.continuation.id,
    sourceGeneration: state.sourceGeneration, admissionGeneration: state.continuation.admissionGeneration,
    operationSha256: workspaceJumpOperationSha256(state) }
  let appState = getDefaultAppState()
  const controller = createRuntimeBackedAppSession({ queryEngineConfig: {
    cwd: state.target.cwd, initialMessages: [seed], tools: [], commands: [], mcpClients: [], agents: [],
    canUseTool: async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
    getAppState: () => appState, setAppState: update => { appState = update(appState) },
    readFileCache: createFileStateCacheWithSizeLimit(20), customSystemPrompt: 'isolated handoff process fixture',
    userSpecifiedModel: 'gpt-5.6-terra', thinkingConfig: { type: 'disabled' },
  }, initializeController: instance => instance.configureWorkspaceHandoff({ identity,
    observerGeneration: state.continuation.admissionGeneration!, origin: 'fresh', recover: false }) })
  await controller.waitForInitialization()
  const claim = await controller.startHandoffContinuation()
  await claim.completion
  const result = controller.getWorkspaceHandoffSnapshot()
  if (providerCalls !== 1 || result?.record.kind !== 'valid' || !result.record.record.consumed ||
      !result.record.record.inputCommitted || result.record.record.terminal?.outcome !== 'success') {
    throw new Error('Real continuation did not publish one verified successful execution')
  }
  const checkpoint = result.record.record.terminal.checkpoint
  process.stdout.write(`${JSON.stringify({ checkpointSha256: checkpoint.prefixSha256, receiptRevision: result.record.record.revision, providerCalls })}\n`)
  if (process.argv.includes('--new-conversation')) {
    await markActiveConversationTip(null)
    await removeTranscriptMessage(completedAssistantUuid)
    const replacement = [createUserMessage({ content: 'Start a new task after rewind.' }), createAssistantMessage({ content: 'The new task is complete.' })]
    await recordTranscript(replacement)
    await sealResumeCheckpoint(replacement)
    let oldProofRejected = false
    try { await verifyResumeCheckpoint(checkpoint) } catch { oldProofRejected = true }
    if (!oldProofRejected) throw new Error('Historical fixture did not invalidate its old prefix')
  }
} catch (error) {
  process.stderr.write(`fixture error: ${String(error)}\n`)
  process.exitCode = 1
} finally {
  providerSpy.mockRestore(); featureSpy.mockRestore()
  await releaseActiveTranscriptLease()
}
process.exit(process.exitCode ?? 0)
