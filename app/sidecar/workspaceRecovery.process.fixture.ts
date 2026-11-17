// Isolated subprocess for the recovery transport regression. No real provider is reachable.
import { spyOn } from 'bun:test'
import { appendFileSync, chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const fixtureRoot = process.argv[2]!
const failureStage = process.argv[3] ?? 'checkpoint'
process.env.CLAUDE_CONFIG_DIR = join(fixtureRoot, 'config')
process.env.CLAUDE_CODE_SIMPLE = '1'
process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
process.env.ANTHROPIC_API_KEY = 'synthetic-recovery-fixture'
;(globalThis as any).MACRO = { VERSION: 'recovery-fixture' }
globalThis.fetch = (async () => { throw new Error('Network forbidden in recovery fixture') }) as unknown as typeof fetch
const { QueryEngine } = await import('../../src/QueryEngine.js')
const bootstrap = await import('../../src/bootstrap/state.js')
const { asSessionId } = await import('../../src/types/ids.js')
const storage = await import('../../src/utils/sessionStorage.js')
const lease = await import('../../src/utils/transcriptLease.js')
const { createUserMessage } = await import('../../src/utils/messages.js')
const { readWorkspaceJump, workspaceJumpOperationSha256 } = await import('../../src/utils/workspaceJumpState.js')
const { resumeEngineSession } = await import('./sessionResume.js')
const { createRuntimeBackedAppSession } = await import('../../src/app-runtime/createRuntimeBackedAppSession.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { createStore } = await import('../../src/state/store.js')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.js')
const { createSidecarTasksDomain } = await import('./tasksDomain.js')
const { SidecarServer } = await import('./sidecarServer.js')
const { createBackpressuredSocket } = await import('./backpressuredSocket.js')
const claude = await import('../../src/services/api/claude.js')
const config = await import('../../src/utils/config.js')
const growthbook = await import('../../src/services/analytics/growthbook.js')
const { ResumeIdentityError } = await import('../../src/utils/resumeCheckpoint.js')
const sessionId = process.env.CATCODE_SIDECAR_SESSION_ID!
const generation = process.env.CATCODE_SIDECAR_GENERATION!
const engineSessionId = process.env.CATCODE_SIDECAR_RESUME_SESSION_ID || process.env.CATCODE_SIDECAR_FRESH_SESSION_ID!
bootstrap.switchSession(asSessionId(engineSessionId), null)
bootstrap.setSessionProvider('openai')
spyOn(config, 'isPathTrusted').mockReturnValue(true)
spyOn(growthbook, 'checkStatsigFeatureGate_CACHED_MAY_BE_STALE').mockReturnValue(false)
let saved: ReturnType<typeof readWorkspaceJump> = null
for (let i = 0; i < 500; i++) {
  saved = readWorkspaceJump(sessionId)
  if (saved?.version === 2) break
  await Bun.sleep(10)
}
if (!saved || saved.version !== 2 || !saved.boundary) throw new Error('Synthetic operation missing')
const state = saved
const recovering = !!process.env.CATCODE_SIDECAR_RESUME_SESSION_ID
let messages: import('../../src/types/message.js').Message[]
let initialState = getDefaultAppState()
let recoveryReviewRequired = false
if (recovering) {
  const resumed = await resumeEngineSession(engineSessionId, process.cwd(), { activeAgents: [], allAgents: [] })
  messages = resumed.messages
  initialState = resumed.initialState
  recoveryReviewRequired = resumed.recoveryReviewRequired
} else {
  messages = [createUserMessage({ content: 'Synthetic preserved work', uuid: state.boundary!.tipUuid })]
  await storage.recordTranscript(messages)
  await storage.flushCurrentTranscriptDurably()
}
writeFileSync(join(fixtureRoot, 'transcript-path.txt'), storage.getTranscriptPath())
spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
  appendFileSync(join(fixtureRoot, 'provider-calls.txt'), generation + '\n')
  for (let delta = 0; delta < 1000; delta++) yield { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } } } as never
  yield { type: 'assistant', ...(failureStage === 'recovery_notice' && !recovering ? { isApiErrorMessage: true } : {}), uuid: randomUUID(), timestamp: new Date().toISOString(), message: {
    id: randomUUID(), role: 'assistant', model: 'gpt-5.6-terra', content: [{ type: 'text', text: 'x'.repeat(1000) }],
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, stop_reason: 'end_turn', stop_sequence: null,
  } } as import('../../src/types/message.js').AssistantMessage
})
if (!recovering) {
  const seal = storage.sealResumeCheckpoint
  spyOn(storage, 'sealResumeCheckpoint').mockImplementation(async rows => {
    if (failureStage === 'recovery_notice' && rows.some(row => row.type === 'system' && row.subtype === 'workspace_handoff_outcome')) throw new Error('Synthetic review notice failure')
    if (failureStage === 'checkpoint' && rows.some(row => row.type === 'assistant')) throw new ResumeIdentityError('duplicate_message_identity', rows.at(-1)?.uuid, 'attachment')
    return seal(rows)
  })
}
const appState = createStore(initialState)
const controller = createRuntimeBackedAppSession({ queryEngineConfig: {
  cwd: process.cwd(), initialMessages: messages, initialRecoveryReviewRequired: recoveryReviewRequired, tools: [], commands: [], mcpClients: [], agents: [],
  canUseTool: async (_tool, input) => ({ behavior: 'allow', updatedInput: input }), getAppState: appState.getState, setAppState: appState.setState,
  readFileCache: createFileStateCacheWithSizeLimit(10), customSystemPrompt: 'Synthetic recovery test', userSpecifiedModel: 'gpt-5.6-terra', thinkingConfig: { type: 'disabled' },
}, initializeController: async instance => {
  await instance.configureWorkspaceHandoff({ identity: { appSessionId: sessionId, engineSessionId, operationId: state.operationId,
    continuationId: state.continuation.id, sourceGeneration: state.sourceGeneration, admissionGeneration: state.continuation.admissionGeneration,
    operationSha256: workspaceJumpOperationSha256(state) }, observerGeneration: generation, origin: 'fresh', recover: recovering })
} })
await controller.waitForInitialization()
const server = new SidecarServer({ sessionId, engineSessionId, generation, controller,
  tasks: createSidecarTasksDomain(appState, controller), log: () => {} })
const connections = new WeakMap<object, { connection: ReturnType<typeof server.addConnection>; drain: () => void }>()
const listener = Bun.listen({ unix: process.env.CATCODE_SIDECAR_SOCKET!, socket: {
  open(socket) { const output = createBackpressuredSocket(socket); connections.set(socket, { connection: server.addConnection(output.wrapper), drain: output.drain }) },
  data(socket, data) { const state = connections.get(socket); if (state) server.handleData(state.connection, Buffer.from(data)) },
  drain(socket) { connections.get(socket)?.drain() },
  close(socket) { const state = connections.get(socket); if (state) server.removeConnection(state.connection); connections.delete(socket) },
} })
chmodSync(process.env.CATCODE_SIDECAR_SOCKET!, 0o600)
process.on('SIGTERM', () => { void (async () => {
  server.close(); listener.stop(true); controller.dispose()
  await storage.flushSessionStorage(); await lease.releaseActiveTranscriptLease(); process.exit(0)
})() })
