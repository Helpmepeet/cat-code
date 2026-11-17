import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { feature } from 'bun:bundle'
import { randomUUID, type UUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from 'zod/v4'
import type { AssistantMessage, Message } from '../../src/types/message.js'
import type { AppState } from '../../src/state/AppStateStore.js'
import type { QueryEngineConfig } from '../../src/QueryEngine.js'
import type { WorkspaceJumpStateV2 } from '../../src/utils/workspaceJumpState.js'
import type { WorkspaceControlAction } from '../main/workspaceHandoffControl.js'
import type { ServerFrame } from '../shared/protocol.js'
import type { UndeliveredPrompt } from './sessionResume.js'

// This suite owns cross-boundary convergence. Provider output is scripted, but
// input, tools, transcript/checkpoint IO, execution records and control parsing
// are the production owners. No account or network state is available.
const root = mkdtempSync(join(tmpdir(), 'handoff-integration-'))
const previousEnv = { config: process.env.CLAUDE_CONFIG_DIR, key: process.env.ANTHROPIC_API_KEY,
  simple: process.env.CLAUDE_CODE_SIMPLE, persistence: process.env.TEST_ENABLE_SESSION_PERSISTENCE }
const previousFetch = globalThis.fetch
const macros = globalThis as unknown as { MACRO?: { VERSION: string } }
const previousMacro = macros.MACRO
macros.MACRO = { VERSION: 'isolated-handoff-integration' }
process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
process.env.ANTHROPIC_API_KEY = 'isolated-scripted-provider'
process.env.CLAUDE_CODE_SIMPLE = '1'
process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
globalThis.fetch = (async () => { throw new Error('Network blocked by isolated handoff fixture') }) as unknown as typeof fetch

await import('../../src/QueryEngine.js')
const bootstrap = await import('../../src/bootstrap/state.js')
const storage = await import('../../src/utils/sessionStorage.js')
const lease = await import('../../src/utils/transcriptLease.js')
const claude = await import('../../src/services/api/claude.js')
const config = await import('../../src/utils/config.js')
const growthbook = await import('../../src/services/analytics/growthbook.js')
const fsPromises = await import('node:fs/promises')
const shell = await import('../../src/utils/Shell.js')
const { asSessionId } = await import('../../src/types/ids.js')
const { buildTool } = await import('../../src/Tool.js')
const { createUserMessage } = await import('../../src/utils/messages.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.js')
const { createRuntimeBackedAppSession } = await import('../../src/app-runtime/createRuntimeBackedAppSession.js')
const { loadConversationForResume } = await import('../../src/utils/conversationRecovery.js')
const { writeWorkspaceJump, readWorkspaceJump, workspaceJumpOperationSha256 } = await import('../../src/utils/workspaceJumpState.js')
const { WorkspaceJumpCoordinator } = await import('../main/workspaceJumpCoordinator.js')
const { WorkspaceHandoffControl } = await import('../main/workspaceHandoffControl.js')
const { SessionCloseCoordinator } = await import('../main/sessionCloseCoordinator.js')
const { SidecarServer } = await import('./sidecarServer.js')
const { FrameDecoder, encodeFrame } = await import('../shared/framing.js')
const { PROTOCOL_VERSION } = await import('../shared/protocol.js')
const { resetCommandQueue, enqueue, getCommandQueueSnapshot, flushQueueOperationsDurably } = await import('../../src/utils/messageQueueManager.js')
const { selectUndeliveredPrompts } = await import('./sessionResume.js')

const originalBootstrap = { id: bootstrap.getSessionId(), project: bootstrap.getSessionProjectDir(),
  provider: bootstrap.getSessionProvider(), cwd: bootstrap.getCwdState() }
const spies: Array<{ mockRestore(): void }> = []
const disposers: Array<() => void> = []
beforeEach(async () => {
  await lease.releaseActiveTranscriptLease()
  storage.resetProjectForTesting()
  const path = join(root, randomUUID())
  mkdirSync(path)
  const cwd = realpathSync(path)
  bootstrap.switchSession(asSessionId(randomUUID()), cwd)
  bootstrap.setSessionProvider('openai')
  shell.setCwd(cwd)
  spies.push(spyOn(growthbook, 'checkStatsigFeatureGate_CACHED_MAY_BE_STALE').mockReturnValue(false))
  spies.push(spyOn(config, 'isPathTrusted').mockReturnValue(true))
})
afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose()
  for (const spy of spies.splice(0)) spy.mockRestore()
  resetCommandQueue()
  await storage.flushSessionStorage().catch(() => {})
  await lease.releaseActiveTranscriptLease()
  storage.resetProjectForTesting()
  bootstrap.switchSession(asSessionId(originalBootstrap.id), originalBootstrap.project)
  bootstrap.setSessionProvider(originalBootstrap.provider)
  shell.setCwd(originalBootstrap.cwd)
})
afterAll(() => {
  for (const [name, value] of [['CLAUDE_CONFIG_DIR', previousEnv.config], ['ANTHROPIC_API_KEY', previousEnv.key],
    ['CLAUDE_CODE_SIMPLE', previousEnv.simple], ['TEST_ENABLE_SESSION_PERSISTENCE', previousEnv.persistence]] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  globalThis.fetch = previousFetch
  if (previousMacro === undefined) delete macros.MACRO
  else macros.MACRO = previousMacro
  rmSync(root, { recursive: true, force: true })
})

function assistant(content: AssistantMessage['message']['content']): AssistantMessage {
  return { type: 'assistant', uuid: randomUUID(), timestamp: new Date().toISOString(), message: {
    id: randomUUID(), role: 'assistant', model: 'gpt-5.6-terra', content,
    usage: { input_tokens: 11, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    stop_reason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null,
  } } as AssistantMessage
}
function engineConfig(messages: Message[], tools: ReturnType<typeof buildTool>[], canUseTool?: QueryEngineConfig['canUseTool']): QueryEngineConfig {
  let state: AppState = getDefaultAppState()
  return { cwd: bootstrap.getSessionProjectDir()!, initialMessages: messages, tools, commands: [], mcpClients: [], agents: [],
    canUseTool: canUseTool ?? (async (_tool, input) => ({ behavior: 'allow', updatedInput: input })),
    getAppState: () => state, setAppState: update => { state = update(state) },
    readFileCache: createFileStateCacheWithSizeLimit(20), customSystemPrompt: 'isolated handoff acceptance',
    userSpecifiedModel: 'gpt-5.6-terra', thinkingConfig: { type: 'disabled' } }
}

test('intact interrupted desktop history holds automatic work and supplies deferred resume context to genuine input', async () => {
  const seed = createUserMessage({ content: 'interrupted request without a damaged final record' })
  await storage.recordTranscript([seed])
  await storage.flushCurrentTranscriptDurably(seed.uuid)
  const sessionStart = await import('../../src/utils/sessionStart.js')
  const { createAttachmentMessage } = await import('../../src/utils/attachments.js')
  let hookCalls = 0, providerCalls = 0
  spies.push(spyOn(sessionStart, 'processSessionStartHooks').mockImplementation(async () => {
    hookCalls++
    return [createAttachmentMessage({ type: 'hook_additional_context', content: ['required restored policy'],
      hookName: 'SessionStart', toolUseID: 'SessionStart', hookEvent: 'SessionStart' })] as never
  }))
  const loaded = await loadConversationForResume(bootstrap.getSessionId(), storage.getTranscriptPath(), { mutable: true, interruptedTurn: 'ignore' })
  expect(loaded?.recoveryReviewRequired).toBe(true)
  expect(hookCalls).toBe(0)
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* ({ messages }) {
    providerCalls++
    expect(hookCalls).toBe(1)
    expect(JSON.stringify(messages)).toContain('required restored policy')
    yield assistant([{ type: 'text', text: 'reviewed intact interruption' }])
  }))
  const controller = createRuntimeBackedAppSession({ queryEngineConfig: {
    ...engineConfig(loaded!.messages, []), initialRecoveryReviewRequired: loaded!.recoveryReviewRequired,
  } })
  await controller.waitForInitialization()
  expect(controller.canStartAutomaticTurn()).toBe(false)
  await expect(controller.submit('automatic continuation', { isMeta: true })).rejects.toThrow('genuine user message')
  expect(providerCalls).toBe(0)
  await controller.submit('I reviewed the preserved work; continue with this new input')
  expect(providerCalls).toBe(1)
  expect(controller.canStartAutomaticTurn()).toBe(true)
})

test.each(['success', 'failure'] as const)('ordinary desktop input acceptance follows the real fsync boundary: %s', async outcome => {
  const seed = createUserMessage({ content: 'saved work before idle submit' })
  await storage.recordTranscript([seed])
  await storage.flushCurrentTranscriptDurably(seed.uuid)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const realFlush = storage.flushCurrentTranscriptDurably
  spies.push(spyOn(storage, 'flushCurrentTranscriptDurably').mockImplementation(async uuid => {
    if (uuid && uuid !== seed.uuid) {
      entered.resolve()
      await release.promise
      if (outcome === 'failure') throw new Error('isolated ordinary input sync failure')
    }
    await realFlush(uuid)
  }))
  let providerCalls = 0
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
    providerCalls++
    yield assistant([{ type: 'text', text: 'accepted ordinary input' }])
  }))
  const controller = createRuntimeBackedAppSession({ queryEngineConfig: engineConfig([seed], []) })
  const sessionId = randomUUID(), requestId = randomUUID(), submitId = randomUUID()
  const frames: ServerFrame[] = [], decoder = new FrameDecoder(32 * 1024 * 1024)
  const server = new SidecarServer({ sessionId, engineSessionId: bootstrap.getSessionId(), controller, log: () => {} })
  disposers.push(() => server.close())
  const connection = server.addConnection({
    write(data) { for (const frame of decoder.push(Buffer.from(data))) if (frame.kind === 'frame') frames.push(frame.payload as ServerFrame) },
    end() {},
  })
  server.handleData(connection, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId,
    message: { type: 'app.submit', requestId, prompt: 'new genuine input', options: { submitId } } }))
  try {
    await entered.promise
    expect(frames.some(frame => frame.kind === 'submit.result' && frame.submitId === submitId)).toBe(false)
    expect(providerCalls).toBe(0)
    release.resolve()
    if (outcome === 'success') {
      await until(() => frames.some(frame => frame.kind === 'submit.result' && frame.submitId === submitId), 'durable idle acceptance')
      expect(frames.find(frame => frame.kind === 'submit.result' && frame.submitId === submitId)).toMatchObject({ accepted: true, queued: false })
    } else {
      await until(() => frames.some(frame => frame.kind === 'error' && frame.requestId === requestId), 'honest unconfirmed idle acceptance')
      expect(frames.some(frame => frame.kind === 'submit.result' && frame.submitId === submitId)).toBe(false)
      expect(frames.find(frame => frame.kind === 'error' && frame.requestId === requestId)).toMatchObject({
        message: expect.stringContaining('acceptance could not be confirmed'),
      })
    }
    await controller.waitUntilIdle()
    expect(providerCalls).toBe(outcome === 'success' ? 1 : 0)
  } finally { release.resolve(); await controller.waitUntilIdle() }
})

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5)
  expect(predicate(), label).toBe(true)
}
async function harness(options: { dropRelease?: 'command' | 'reply'; tools?: ReturnType<typeof buildTool>[]; canUseTool?: QueryEngineConfig['canUseTool']; recoveredPrompts?: UndeliveredPrompt[]; recoveredUnavailableCount?: number } = {}) {
  const appSessionId = randomUUID(), engineSessionId = bootstrap.getSessionId(), operationId = randomUUID()
  const generation = randomUUID()
  const seed = createUserMessage({ content: 'Complete the preserved request in this workspace.' })
  await storage.recordTranscript([seed])
  await storage.markActiveConversationTip(seed.uuid as UUID)
  await storage.flushCurrentTranscriptDurably()
  for (const input of options.recoveredPrompts ?? []) {
    await storage.recordQueueOperation({ type: 'queue-operation', operation: 'enqueue', mode: 'prompt',
      sessionId: engineSessionId, uuid: input.uuid as UUID, content: input.content, timestamp: input.timestamp })
  }
  await storage.flushCurrentTranscriptDurably()
  const state: WorkspaceJumpStateV2 = { version: 2, revision: 1, origin: 'fresh', appSessionId, engineSessionId,
    operationId, sourceGeneration: randomUUID(), source: { cwd: join(root, 'managed'), binding: {
      kind: 'managed', storageId: randomUUID(), storageRootId: randomUUID() } },
    target: { cwd: bootstrap.getSessionProjectDir()!, binding: { kind: 'project' } },
    acceptedAt: 1, phase: 'settled', boundary: { tipUuid: seed.uuid, toolUseId: 'source-jump' }, location: 'destination', consumed: true,
    continuation: { id: randomUUID(), admissionGeneration: generation, dispatch: 'none', outcome: 'pending', receiptRevision: null, checkpointSha256: null },
    cancellation: null, review: { required: false, noticeUuid: null, reconciledInputUuid: null },
    release: { target: 'held', authorizedRevision: null, confirmed: null } }
  writeWorkspaceJump(state)
  const queryConfig = engineConfig([seed], options.tools ?? [], options.canUseTool)
  const controller = createRuntimeBackedAppSession({ queryEngineConfig: queryConfig,
    initializeController: async instance => {
      instance.restoreHandoffReservation(operationId)
      await instance.configureWorkspaceHandoff({ identity: { appSessionId, engineSessionId, operationId,
        continuationId: state.continuation.id, sourceGeneration: state.sourceGeneration,
        admissionGeneration: generation, operationSha256: workspaceJumpOperationSha256(state) },
        observerGeneration: generation, origin: 'fresh', recover: false })
    } })
  await controller.waitForInitialization()
  let held = true, drop = options.dropRelease, releaseCommands = 0, paused = false, dropRecoveryCleanup = false
  const batch: ServerFrame[] = []
  const received: ServerFrame[] = [], decoder = new FrameDecoder(32 * 1024 * 1024)
  let control!: InstanceType<typeof WorkspaceHandoffControl>
  let connection!: ReturnType<InstanceType<typeof SidecarServer>['addConnection']>
  const { createSidecarTasksDomain } = await import('./tasksDomain.js')
  const tasks = createSidecarTasksDomain({ getState: queryConfig.getAppState, setState: queryConfig.setAppState, subscribe: () => () => {} }, controller)
  const server = new SidecarServer({ sessionId: appSessionId, engineSessionId, generation, controller, tasks, log: () => {},
    recoveredPrompts: options.recoveredPrompts, recoveredUnavailableCount: options.recoveredUnavailableCount,
    loadRecoveredPrompts: async () => selectUndeliveredPrompts(await storage.getSessionQueueOperations(engineSessionId)).prompts })
  const coordinator = new WorkspaceJumpCoordinator({ row: id => id === appSessionId ? {
    appSessionId, engineSessionId, cwd: state.target.cwd, binding: state.target.binding,
    lastAttachedAt: 1, lastMessageSentAt: 1, shutdown: null } : undefined,
    knownProjects: () => [], validateCwd: cwd => ({ ok: true, realpath: cwd }), trustedProjectRoots: async paths => paths,
    waitForControlSlot: (id, operation, gen) => control.waitForSlot(id, operation, gen),
    verifyReady: () => false, control: (current, action) => control.request(appSessionId, current.operationId, action),
    host: { getSessionGeneration: () => generation,
      reserveWorkspaceJump: async () => ({ ok: true, value: undefined }),
      releaseWorkspaceJump: () => { held = false }, moveWorkspaceJump: async () => { throw new Error('Already at destination') } } })
  control = new WorkspaceHandoffControl({ generation: () => generation,
    acceptsStatus: (id, status) => id === appSessionId && status.engineSessionId === engineSessionId,
    observe: (id, snapshot) => { coordinator.observe(id, snapshot) }, recover: id => coordinator.queryStatus(id),
    send: (_id, message) => {
      if (message.action === 'cancel_recovery' && dropRecoveryCleanup) return false
      if (message.action === 'release') {
        releaseCommands++
        if (drop === 'command') { drop = undefined; return true }
      }
      server.handleData(connection, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId: appSessionId, message }))
      return true
    } })
  const deliver = (frame: ServerFrame) => {
    received.push(frame)
    if (drop === 'reply' && frame.kind === 'workspace.handoff.result' && frame.action === 'release') { drop = undefined; return }
    if (paused) { batch.push(frame); return }
    control.receiveFrame(appSessionId, frame)
  }
  const transport = { write(data: Uint8Array) { for (const value of decoder.push(Buffer.from(data))) {
    if (value.kind === 'frame') deliver(value.payload as ServerFrame)
  } }, end() {} }
  connection = server.addConnection(transport)
  // Main records uncertain dispatch only after the destination is attached,
  // immediately before its first continuation command.
  state.continuation.dispatch = 'unknown'
  writeWorkspaceJump(state)
  disposers.push(() => { control.dispose(); server.close() })
  return { appSessionId, engineSessionId, operationId, generation, state, seed, controller, server, tasks, received, coordinator, control,
    dropRecoveryCleanup: (drop: boolean) => { dropRecoveryCleanup = drop },
    held: () => held, releaseCommands: () => releaseCommands,
    pauseControl: () => { paused = true },
    flushControlBatch: () => { paused = false; for (const frame of batch.splice(0)) control.receiveFrame(appSessionId, frame) },
    command: (action: WorkspaceControlAction) => control.request(appSessionId, operationId, action),
    send: (message: unknown) => server.handleData(connection, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId: appSessionId, message })),
    reloadRenderer: () => { server.removeConnection(connection); connection = server.addConnection(transport) },
    submit: (text: string) => server.handleData(connection, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId: appSessionId,
      message: { type: 'app.submit', requestId: randomUUID(), prompt: text } })) }
}

function latestRecoveredSnapshot(h: Awaited<ReturnType<typeof harness>>) {
  const frame = h.received.findLast(frame => frame.kind === 'queued-prompts.snapshot')
  if (frame?.kind !== 'queued-prompts.snapshot') throw new Error('No recovered input snapshot')
  return frame
}

test('recovered input attach/reload never queues or executes it, and force cannot skip review', async () => {
  let calls = 0
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () { calls++; throw new Error('Unexpected model execution') }))
  const recovered = { uuid: randomUUID(), content: 'legacy delivery is unknown', timestamp: new Date().toISOString() }
  const h = await harness({ recoveredPrompts: [recovered], recoveredUnavailableCount: 2 })
  expect(latestRecoveredSnapshot(h).prompts).toEqual([])
  expect(latestRecoveredSnapshot(h).recoveredPrompts).toEqual([{ id: recovered.uuid, text: recovered.content }])
  expect(getCommandQueueSnapshot()).toEqual([])
  h.reloadRenderer()
  expect(latestRecoveredSnapshot(h).recoveredPrompts).toHaveLength(1)
  expect(h.received.some(frame => frame.kind === 'error' && frame.message.includes('2 saved input records'))).toBe(true)
  const requestId = randomUUID()
  h.send({ type: 'prompt.force', requestId, promptId: recovered.uuid })
  expect(h.received.some(frame => frame.kind === 'prompt-force.result' && frame.requestId === requestId && !frame.ok)).toBe(true)
  expect(getCommandQueueSnapshot()).toEqual([])
  expect(calls).toBe(0)
})

test('copying recovered text/media retains the saved input until separate durable removal', async () => {
  const content = [{ type: 'text' as const, text: 'review original media' },
    { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AAAA' } }]
  const recovered = { uuid: randomUUID(), content, timestamp: new Date().toISOString() }
  const h = await harness({ recoveredPrompts: [recovered] })
  expect(JSON.stringify(h.received)).not.toContain('AAAA')
  const requestId = randomUUID()
  h.send({ type: 'prompt.recall', requestId, recoveredPromptId: recovered.uuid })
  await until(() => h.received.some(frame => frame.kind === 'prompt-recall.result' && frame.requestId === requestId), 'explicit review receives original content')
  const answer = h.received.find(frame => frame.kind === 'prompt-recall.result' && frame.requestId === requestId)
  if (answer?.kind !== 'prompt-recall.result') throw new Error('Missing review result')
  expect(answer.recalled).toEqual([{ id: recovered.uuid, prompt: content }])
  expect(latestRecoveredSnapshot(h).recoveredPromptCount).toBe(1)
  expect(selectUndeliveredPrompts(await storage.getSessionQueueOperations(h.engineSessionId)).prompts
    .map(prompt => prompt.uuid)).toContain(recovered.uuid)
  const discardId = randomUUID()
  h.send({ type: 'prompt.recall', requestId: discardId, recoveredPromptId: recovered.uuid, discard: true })
  await until(() => h.received.some(frame => frame.kind === 'prompt-recall.result' && frame.requestId === discardId), 'explicit removal is durable')
  expect(h.received.find(frame => frame.kind === 'prompt-recall.result' && frame.requestId === discardId)).toMatchObject({ recalled: [] })
  const saved = await storage.loadTranscriptFile(storage.getTranscriptPathForSession(h.engineSessionId), { strict: true })
  expect(saved.queueOperations.some(operation => operation.uuid === recovered.uuid && operation.operation === 'enqueue')).toBe(true)
  expect(saved.queueOperations.some(operation => operation.uuid === recovered.uuid && operation.queueVersion === 2 && operation.operation === 'remove')).toBe(true)
  const restored = selectUndeliveredPrompts(await storage.getSessionQueueOperations(h.engineSessionId))
  expect(restored.prompts.map(prompt => prompt.uuid)).not.toContain(recovered.uuid)
  h.server.close()
  const restarted = await harness({ recoveredPrompts: restored.prompts })
  restarted.reloadRenderer()
  expect(getCommandQueueSnapshot()).toEqual([])
  expect(restarted.received.some(frame => frame.kind === 'queued-prompts.snapshot' && frame.recoveredPrompts?.some(item => item.id === recovered.uuid))).toBe(false)
})

test('recovered review failure retains its only review reference and rejects malformed selectors', async () => {
  const recovered = { uuid: randomUUID(), content: 'keep this for review', timestamp: new Date().toISOString() }
  const h = await harness({ recoveredPrompts: [recovered] })
  const original = storage.recordQueueOperation
  const failure = spyOn(storage, 'recordQueueOperation').mockImplementation(async operation => {
    if (operation.uuid === recovered.uuid && operation.operation === 'remove') throw new Error('Injected cancellation failure')
    await original(operation)
  })
  const requestId = randomUUID()
  try {
    h.send({ type: 'prompt.recall', requestId, recoveredPromptId: recovered.uuid, discard: true })
    await until(() => h.received.some(frame => frame.kind === 'error' && frame.requestId === requestId), 'durability failure is explicit')
    h.reloadRenderer()
    expect(latestRecoveredSnapshot(h).recoveredPrompts?.map(item => item.id)).toContain(recovered.uuid)
  } finally { failure.mockRestore() }
  h.send({ type: 'prompt.recall', requestId: 'bad-id', recoveredPromptId: '../not-a-uuid' })
  expect(h.received.some(frame => frame.kind === 'error' && frame.requestId === 'bad-id')).toBe(true)
  h.send({ type: 'prompt.recall', requestId: 'extra-field', recoveredPromptId: recovered.uuid, injected: true })
  expect(h.received.some(frame => frame.kind === 'error' && frame.requestId === 'extra-field')).toBe(true)
  h.send({ type: 'prompt.recall', requestId: 'missing-discard-id', discard: true })
  expect(h.received.some(frame => frame.kind === 'error' && frame.requestId === 'missing-discard-id')).toBe(true)
  expect(getCommandQueueSnapshot()).toEqual([])
})

test('large recovered sets retain copied input and refill only after explicit removal', async () => {
  const inputs = Array.from({ length: 40 }, (_, index) => ({
    uuid: randomUUID(), content: `saved input ${index}`, timestamp: new Date().toISOString(),
  }))
  const h = await harness({ recoveredPrompts: inputs })
  expect(latestRecoveredSnapshot(h).recoveredPrompts).toHaveLength(32)
  expect(latestRecoveredSnapshot(h).recoveredPromptCount).toBe(40)
  const first = inputs[0]!
  h.send({ type: 'prompt.recall', requestId: randomUUID(), recoveredPromptId: first.uuid })
  expect(latestRecoveredSnapshot(h).recoveredPromptCount).toBe(40)
  h.send({ type: 'prompt.recall', requestId: randomUUID(), recoveredPromptId: first.uuid, discard: true })
  await until(() => latestRecoveredSnapshot(h).recoveredPromptCount === 39, 'next bounded batch becomes available')
  expect(latestRecoveredSnapshot(h).recoveredPrompts).toHaveLength(32)
  expect(latestRecoveredSnapshot(h).recoveredPrompts?.some(item => item.id === inputs[32]!.uuid)).toBe(true)
  expect(getCommandQueueSnapshot()).toEqual([])
})

async function heldContinuationWithQueuedManual(recoveredPrompts?: UndeliveredPrompt[]) {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  disposers.push(() => release())
  let calls = 0
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
    calls++
    await held
    yield assistant([{ type: 'text', text: 'Preserved active work.' }])
  }))
  const h = await harness({ recoveredPrompts })
  expect((await h.command({ action: 'continue', continuationId: h.state.continuation.id })).kind).toBe('result')
  await until(() => calls === 1 && h.coordinator.snapshot(h.appSessionId)?.continuation.dispatch === 'consumed',
    'continuation consumed its durable input and entered the scripted provider')
  h.submit('manual waiting at close')
  const queued = getCommandQueueSnapshot().find(command => command.value === 'manual waiting at close')
  expect(queued?.uuid).toBeDefined()
  await storage.flushCurrentTranscriptDurably()
  const cancelId = randomUUID()
  const state = h.coordinator.snapshot(h.appSessionId)!
  writeWorkspaceJump({ ...state, cancellation: { cancelId, requestedBy: 'close', application: 'unknown' } })
  return { ...h, queued: queued!, cancelId, release, calls: () => calls }
}

test('active queued input and recovered review remain separate and share the snapshot count budget', async () => {
  const recovered = Array.from({ length: 32 }, (_, index) => ({
    uuid: randomUUID(), content: `review-only ${index}`, timestamp: new Date().toISOString(),
  }))
  const h = await heldContinuationWithQueuedManual(recovered)
  try {
    const snapshot = latestRecoveredSnapshot(h)
    expect(snapshot.prompts).toHaveLength(1)
    expect(snapshot.recoveredPrompts).toHaveLength(31)
    expect(snapshot.recoveredPromptCount).toBe(32)
    const requestId = randomUUID()
    h.send({ type: 'prompt.recall', requestId })
    const result = h.received.find(frame => frame.kind === 'prompt-recall.result' && frame.requestId === requestId)
    if (result?.kind !== 'prompt-recall.result') throw new Error('Missing active queue recall')
    expect(result.recalled.map(input => input.id)).toEqual([h.queued.uuid!])
    expect(latestRecoveredSnapshot(h).recoveredPromptCount).toBe(32)
    expect(latestRecoveredSnapshot(h).recoveredPrompts).toHaveLength(32)
  } finally { h.release() }
  await until(() => !h.controller.isTurnActive(), 'active continuation settles independently')
})

test('retained recovered media shares the active queue body budget instead of adding a second store', async () => {
  const image = { type: 'image' as const, source: {
    type: 'base64' as const, media_type: 'image/png' as const, data: 'AAAA'.repeat(1024 * 1024),
  } }
  const inputs = Array.from({ length: 3 }, () => ({
    uuid: randomUUID(), content: [image, image], timestamp: new Date().toISOString(),
  }))
  const h = await heldContinuationWithQueuedManual(inputs)
  try {
    expect(latestRecoveredSnapshot(h).recoveredPrompts).toHaveLength(2)
    expect(latestRecoveredSnapshot(h).recoveredPromptCount).toBe(3)
    writeWorkspaceJump({ ...h.coordinator.snapshot(h.appSessionId)!, cancellation: null })
    const requestId = randomUUID()
    h.send({ type: 'app.submit', requestId, prompt: [image, image], options: { submitId: randomUUID() } })
    expect(h.received.find(frame => frame.kind === 'error' && frame.requestId === requestId)).toMatchObject({
      code: 'bad_request', message: expect.stringContaining('Waiting messages contain too much data'),
    })
    expect(getCommandQueueSnapshot()).toHaveLength(1)
    writeWorkspaceJump({ ...h.coordinator.snapshot(h.appSessionId)!, cancellation: {
      cancelId: h.cancelId, requestedBy: 'close', application: 'unknown',
    } })
    await h.command({ action: 'cancel', cancelId: h.cancelId })
  } finally { h.release() }
  await until(() => !h.controller.isTurnActive(), 'media budget fixture stops')
})

test('accepted transcript identity is excluded from recovered review selection', async () => {
  const h = await harness()
  await storage.recordQueueOperation({ type: 'queue-operation', operation: 'enqueue', mode: 'prompt',
    sessionId: h.engineSessionId, uuid: h.seed.uuid as UUID, content: 'already accepted input', timestamp: new Date().toISOString() })
  await storage.flushCurrentTranscriptDurably()
  expect(selectUndeliveredPrompts(await storage.getSessionQueueOperations(h.engineSessionId)).prompts).toEqual([])
  expect(getCommandQueueSnapshot()).toEqual([])
})

test('busy queue success waits for its recorder producer and fsync before the acknowledgement crash cut', async () => {
  const h = await heldContinuationWithQueuedManual()
  writeWorkspaceJump({ ...h.coordinator.snapshot(h.appSessionId)!, cancellation: null })
  const text = 'queued admission durability cut'
  let permit!: () => void, producerEntered = false
  const held = new Promise<void>(resolve => { permit = resolve })
  const original = storage.recordQueueOperation
  const recorder = spyOn(storage, 'recordQueueOperation').mockImplementation(async operation => {
    if (operation.operation === 'enqueue' && operation.content === text) {
      producerEntered = true
      await held
    }
    await original(operation)
  })
  spies.push(recorder)
  const requestId = randomUUID(), submitId = randomUUID()
  try {
    h.send({ type: 'app.submit', requestId, prompt: text, options: { submitId } })
    await until(() => producerEntered, 'enqueue producer starts')
    expect(h.received.some(frame => frame.kind === 'submit.result' && frame.submitId === submitId)).toBe(false)
    const before = await storage.loadTranscriptFile(storage.getTranscriptPathForSession(h.engineSessionId), { strict: true })
    expect(before.queueOperations.some(operation => operation.content === text)).toBe(false)
    expect(h.calls()).toBe(1)
    permit()
    await until(() => h.received.some(frame => frame.kind === 'submit.result' && frame.submitId === submitId), 'durable enqueue receives its admission acknowledgement')
    expect(h.received.find(frame => frame.kind === 'submit.result' && frame.submitId === submitId)).toMatchObject({
      accepted: true, queued: true,
    })
    const saved = await storage.loadTranscriptFile(storage.getTranscriptPathForSession(h.engineSessionId), { strict: true })
    expect(saved.queueOperations.some(operation => operation.operation === 'enqueue' && operation.content === text)).toBe(true)
    writeWorkspaceJump({ ...h.coordinator.snapshot(h.appSessionId)!, cancellation: {
      cancelId: h.cancelId, requestedBy: 'close', application: 'unknown',
    } })
    await h.command({ action: 'cancel', cancelId: h.cancelId })
  } finally { permit(); recorder.mockRestore(); h.release() }
  await until(() => !h.controller.isTurnActive(), 'acknowledgement fixture stops')
})

test('an enqueue recorder failure after real consumption is uncertain, never a definitely-unaccepted answer', async () => {
  let calls = 0, releaseFirst!: () => void, releaseSecond!: () => void, failEnqueue!: (error: Error) => void
  const first = new Promise<void>(resolve => { releaseFirst = resolve })
  const second = new Promise<void>(resolve => { releaseSecond = resolve })
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
    calls++
    if (calls === 1) {
      await first
      yield assistant([{ type: 'tool_use', id: 'queue-ack-tool', name: 'QueueAckFixture', input: {} }])
    } else {
      await second
      yield assistant([{ type: 'text', text: 'Queued input was consumed.' }])
    }
  }))
  const tool = buildTool({ name: 'QueueAckFixture', inputSchema: z.object({}),
    description: async () => 'Run isolated queue fixture', prompt: async () => 'Run isolated queue fixture',
    maxResultSizeChars: 1000, renderToolUseMessage: () => null,
    async call() { return { data: 'Isolated tool completed.' } },
    mapToolResultToToolResultBlockParam: (data, id) => ({ type: 'tool_result', tool_use_id: id, content: data }) })
  const h = await harness({ tools: [tool] })
  await h.command({ action: 'continue', continuationId: h.state.continuation.id })
  await until(() => calls === 1 && h.coordinator.snapshot(h.appSessionId)?.continuation.dispatch === 'consumed', 'continuation enters first provider')
  const text = 'consumed before enqueue failure'
  const heldEnqueue = new Promise<void>((_resolve, reject) => { failEnqueue = reject })
  const original = storage.recordQueueOperation
  const recorder = spyOn(storage, 'recordQueueOperation').mockImplementation(async operation => {
    if (operation.operation === 'enqueue' && operation.content === text) await heldEnqueue
    await original(operation)
  })
  spies.push(recorder)
  const requestId = randomUUID(), submitId = randomUUID()
  try {
    h.send({ type: 'app.submit', requestId, prompt: text, options: { submitId } })
    const queuedId = getCommandQueueSnapshot().find(command => command.value === text)?.uuid
    expect(queuedId).toBeDefined()
    releaseFirst()
    await until(() => calls === 2, 'real engine durably consumes queued input before its next provider request')
    expect((await storage.getSessionQueueOperations(h.engineSessionId)).messageUuids.has(queuedId!)).toBe(true)
    expect(h.received.some(frame => frame.kind === 'submit.result' && frame.submitId === submitId)).toBe(false)
    failEnqueue(new Error('Injected enqueue recorder failure after consumption'))
    await until(() => h.received.some(frame => frame.kind === 'error' && frame.requestId === requestId), 'uncertain I/O outcome is reported')
    expect(h.received.find(frame => frame.kind === 'error' && frame.requestId === requestId)).toMatchObject({
      retryable: false, message: expect.stringContaining('may have been delivered'),
    })
    expect(h.received.some(frame => frame.kind === 'submit.result' && frame.submitId === submitId)).toBe(false)
    expect((await storage.getSessionQueueOperations(h.engineSessionId)).messageUuids.has(queuedId!)).toBe(true)
  } finally {
    failEnqueue(new Error('Fixture cleanup'))
    recorder.mockRestore()
    h.controller.abort('Fixture complete')
    releaseFirst(); releaseSecond()
  }
  await until(() => !h.controller.isTurnActive(), 'uncertain admission fixture stops')
})

test('verified close cancellation fences admission before async work and preserves task, peer, uncertain and consumed evidence', async () => {
  const h = await heldContinuationWithQueuedManual()
  const task = { value: 'task result', mode: 'task-notification' as const, uuid: randomUUID() }
  const peer = { value: 'peer input', mode: 'task-notification' as const, uuid: randomUUID(), origin: { kind: 'peer' as const, name: 'Alex', appSessionId: randomUUID() } }
  const uncertain = { value: 'untracked input for review', mode: 'prompt' as const, uuid: randomUUID() }
  const answer = { value: 'accepted question answer', mode: 'prompt' as const, uuid: randomUUID(),
    origin: { kind: 'question-reply' as const, batchId: randomUUID(), questions: [{ toolUseId: 'asked', questionIndex: 0 }] } }
  enqueue(task); enqueue(peer); enqueue(uncertain); enqueue(answer)
  const stopping = h.command({ action: 'cancel', cancelId: h.cancelId })
  // handleData has reached its first asynchronous durability boundary, not its
  // cancellation acknowledgement. A racing submit must already be fenced.
  h.submit('late close input')
  expect(h.received.some(frame => frame.kind === 'error' && frame.message === 'This chat is stopping.')).toBe(true)
  expect(getCommandQueueSnapshot().some(command => command.uuid === h.queued.uuid)).toBe(false)
  expect(getCommandQueueSnapshot().some(command => command.uuid === answer.uuid)).toBe(false)
  try {
    const result = await stopping
    expect(result.kind).toBe('result')
    if (result.kind === 'result') expect(result.result.disposition).toBe('accepted')
    const loaded = await storage.loadTranscriptFile(storage.getTranscriptPathForSession(h.engineSessionId), { strict: true })
    expect(loaded.queueOperations.some(op => op.uuid === h.queued.uuid && op.operation === 'remove')).toBe(true)
    expect(loaded.queueOperations.some(op => op.uuid === answer.uuid && op.operation === 'remove')).toBe(true)
    expect(loaded.queueOperations.some(op => [task.uuid, peer.uuid, uncertain.uuid].includes(op.uuid!) && op.operation !== 'enqueue')).toBe(false)
    expect(loaded.messages.has(h.seed.uuid as UUID)).toBe(true)
    expect(loaded.messages.has(h.state.continuation.id as UUID)).toBe(true)
    expect(loaded.queueOperations.some(op => op.uuid === h.state.continuation.id && op.operation === 'remove')).toBe(false)
  } finally { h.release() }
  await until(() => !h.controller.isTurnActive(), 'aborted consumed turn settles')
  await h.command({ action: 'status' })
  h.submit('late drain input')
  await Bun.sleep(0)
  expect(getCommandQueueSnapshot().map(command => command.uuid)).toEqual([task.uuid, peer.uuid, uncertain.uuid])
  expect(h.calls()).toBe(1)
})

test.skipIf(feature('NONBLOCKING_ASK_USER_QUESTION') ? false : true)('an accepted answer crossing close fsync is cancelled durably and never replayed', async () => {
  const { AskUserQuestionTool } = await import('../../src/tools/AskUserQuestionTool/AskUserQuestionTool.js')
  const { PendingQuestionRuntime } = await import('../../src/utils/pendingQuestionRuntime.js')
  const question = { question: 'Which storage?', options: [
    { label: 'Local', description: 'Disk' }, { label: 'Remote', description: 'Server' },
  ], multiSelect: false }
  let calls = 0
  const provider = Promise.withResolvers<void>()
  const writeEntered = Promise.withResolvers<void>()
  const writeReleased = Promise.withResolvers<void>()
  disposers.push(() => { provider.resolve(); writeReleased.resolve() })
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
    calls++
    if (calls === 1) yield assistant([{ type: 'tool_use', id: 'question-before-close', name: 'AskUserQuestion', input: { questions: [question] } }])
    else { await provider.promise; yield assistant([{ type: 'text', text: 'Independent work stopped.' }]) }
  }))
  const h = await harness({ tools: [AskUserQuestionTool], canUseTool: async (tool, input, context) => {
    const decision = await tool.checkPermissions(input, context)
    if (decision.behavior !== 'allow') throw new Error('Nonblocking question unexpectedly requested permission')
    return decision
  } })
  await h.command({ action: 'continue', continuationId: h.state.continuation.id })
  await until(() => calls === 2 && h.controller.getQuestionSnapshot().pending.length === 1, 'real question tool published before independent work')
  const record = storage.recordQuestionLifecycle
  spies.push(spyOn(storage, 'recordQuestionLifecycle').mockImplementation(async entry => {
    if (entry.operation === 'resolved') { writeEntered.resolve(); await writeReleased.promise }
    await record(entry)
  }))
  const requestId = randomUUID()
  try {
    h.send({ type: 'askUserQuestion.reply', requestId, replies: [{
      toolUseId: 'question-before-close', questionIndex: 0, answer: { optionIndices: [1] },
    }] })
    await writeEntered.promise
    const cancelId = randomUUID()
    writeWorkspaceJump({ ...h.coordinator.snapshot(h.appSessionId)!, cancellation: { cancelId, requestedBy: 'close', application: 'unknown' } })
    const stopped = await h.command({ action: 'cancel', cancelId })
    expect(stopped.kind).toBe('result')
    writeReleased.resolve()
    await until(() => h.received.some(frame => frame.kind === 'question.result' && frame.requestId === requestId), 'answer write settles behind the close fence')
    expect(h.received.find(frame => frame.kind === 'question.result' && frame.requestId === requestId)).toMatchObject({ accepted: true })
    expect(getCommandQueueSnapshot().some(command => command.origin?.kind === 'question-reply')).toBe(false)
  } finally { provider.resolve(); writeReleased.resolve() }
  await until(() => !h.controller.isTurnActive(), 'independent work settles')
  const saved = await storage.loadTranscriptFile(storage.getTranscriptPathForSession(h.engineSessionId), { strict: true })
  const resolution = saved.questionLifecycles.find(entry => entry.operation === 'resolved')
  if (resolution?.operation !== 'resolved' || !resolution.delivery) throw new Error('Missing durable answer outbox')
  expect(saved.queueOperations.some(operation => operation.uuid === resolution.delivery!.uuid && operation.operation === 'remove')).toBe(true)
  const restarted = new PendingQuestionRuntime(() => [])
  await restarted.initialize()
  restarted.deliver()
  expect(restarted.registry.getSnapshot().resolved[0]?.answer).toBe('Remote')
  expect(getCommandQueueSnapshot().some(command => command.origin?.kind === 'question-reply')).toBe(false)
  expect(calls).toBe(2)
})

test.each(['cancellation', 'durability'] as const)('failed close %s keeps manual admission fenced and never claims unconfirmed durability', async failure => {
  const h = await heldContinuationWithQueuedManual()
  const originalRecord = storage.recordQueueOperation
  const failing = failure === 'cancellation'
    ? spyOn(h.controller, 'cancelWorkspaceHandoff').mockRejectedValue(new Error('controlled cancellation failure'))
    : spyOn(storage, 'recordQueueOperation').mockImplementation(async operation => {
        if (operation.operation === 'remove') throw new Error('controlled durable retraction failure')
        await originalRecord(operation)
      })
  try {
    const result = await h.command({ action: 'cancel', cancelId: h.cancelId })
    expect(result.kind).toBe('result')
    if (result.kind === 'result') {
      expect(result.result.disposition).toBe('refused')
      if (failure === 'durability') expect(result.result.reason).toBe('durability_unconfirmed')
    }
    h.submit('must not drain after failed cancellation')
    expect(h.received.some(frame => frame.kind === 'error' && frame.message === 'This chat is stopping.')).toBe(true)
    expect(getCommandQueueSnapshot().some(command => command.uuid === h.queued.uuid)).toBe(false)
  } finally { failing.mockRestore() }
  try {
    const retry = await h.command({ action: 'cancel', cancelId: h.cancelId })
    expect(retry.kind).toBe('result')
    if (retry.kind === 'result') expect(retry.result.disposition).toBe(failure === 'durability' ? 'refused' : 'accepted')
    const loaded = await storage.loadTranscriptFile(storage.getTranscriptPathForSession(h.engineSessionId), { strict: true })
    expect(loaded.queueOperations.some(op => op.uuid === h.queued.uuid && op.operation === 'remove')).toBe(failure !== 'durability')
    expect(loaded.messages.has(h.state.continuation.id as UUID)).toBe(true)
  } finally { h.release() }
  await until(() => !h.controller.isTurnActive(), 'failed-cancel active turn settles')
  expect(h.calls()).toBe(1)
})

test('a wrong close cancel identity cannot retract queued input or abort the active turn', async () => {
  const h = await heldContinuationWithQueuedManual()
  try {
    const rejected = await h.command({ action: 'cancel', cancelId: randomUUID() })
    expect(rejected.kind).toBe('result')
    if (rejected.kind === 'result') expect(rejected.result.disposition).toBe('refused')
    expect(getCommandQueueSnapshot().some(command => command.uuid === h.queued.uuid)).toBe(true)
    expect(h.controller.isTurnActive()).toBe(true)
    const accepted = await h.command({ action: 'cancel', cancelId: h.cancelId })
    expect(accepted.kind).toBe('result')
    if (accepted.kind === 'result') expect(accepted.result.disposition).toBe('accepted')
  } finally { h.release() }
  await until(() => !h.controller.isTurnActive(), 'verified cancellation settles active turn')
})

test('close preserves an already consumed manual turn while cancelling only its queued successor', async () => {
  let calls = 0, release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  disposers.push(() => release())
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
    calls++
    if (calls > 1) await blocked
    yield assistant([{ type: 'text', text: 'Scripted accepted input.' }])
  }))
  const h = await harness()
  await h.command({ action: 'continue', continuationId: h.state.continuation.id })
  await until(() => !h.held(), 'continuation releases the input gate')
  h.submit('consumed manual input')
  await until(() => calls === 2, 'manual input is durably consumed by the real controller')
  h.submit('unconsumed successor')
  const queued = getCommandQueueSnapshot().find(command => command.value === 'unconsumed successor')
  expect(queued?.uuid).toBeDefined()
  const before = await storage.loadTranscriptFile(storage.getTranscriptPathForSession(h.engineSessionId), { strict: true })
  const consumed = [...before.messages.values()].find(message =>
    message.type === 'user' && message.message.content === 'consumed manual input')
  expect(consumed?.uuid).toBeDefined()
  const cancelId = randomUUID()
  writeWorkspaceJump({ ...h.coordinator.snapshot(h.appSessionId)!, cancellation: { cancelId, requestedBy: 'close', application: 'unknown' } })
  try {
    const outcome = await h.command({ action: 'cancel', cancelId })
    expect(outcome.kind).toBe('result')
    if (outcome.kind === 'result') expect(outcome.result.disposition).toBe('accepted')
    const after = await storage.loadTranscriptFile(storage.getTranscriptPathForSession(h.engineSessionId), { strict: true })
    expect(after.messages.has(consumed!.uuid as UUID)).toBe(true)
    expect(after.queueOperations.some(operation => operation.uuid === consumed!.uuid && operation.operation === 'remove')).toBe(false)
    expect(after.queueOperations.some(operation => operation.uuid === queued!.uuid && operation.operation === 'remove')).toBe(true)
    h.submit('late successor')
  } finally { release() }
  await until(() => !h.controller.isTurnActive(), 'consumed manual turn stops without losing its history')
  expect(calls).toBe(2)
})

test.each(['uncertain', 'question-reply'] as const)('a late failed reserve handles %s input without draining it again', async kind => {
  let providerCalls = 0
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
    providerCalls++
    yield assistant([{ type: 'text', text: 'Preserved request completed.' }])
  }))
  const h = await harness()
  await h.command({ action: 'continue', continuationId: h.state.continuation.id })
  await until(() => !h.held(), 'continuation gate opens')
  let rejectReserve!: (error: Error) => void
  const reserved = new Promise<void>((_resolve, reject) => { rejectReserve = reject })
  const submit = spyOn(h.controller, 'submit').mockImplementation(() => reserved)
  spies.push(submit)
  const uncertain = { value: 'uncertain reserved input', mode: 'prompt' as const, uuid: randomUUID(),
    ...(kind === 'question-reply' ? { origin: { kind: 'question-reply' as const, batchId: randomUUID(),
      questions: [{ toolUseId: 'asked', questionIndex: 0 }] } } : {}) }
  enqueue(uncertain)
  await until(() => submit.mock.calls.length === 1, 'server reserves unknown input but controller has not accepted it')
  const cancelId = randomUUID()
  writeWorkspaceJump({ ...h.coordinator.snapshot(h.appSessionId)!, cancellation: { cancelId, requestedBy: 'close', application: 'unknown' } })
  const stopped = await h.command({ action: 'cancel', cancelId })
  expect(stopped.kind).toBe('result')
  if (stopped.kind === 'result') expect(stopped.result.disposition).toBe('accepted')
  rejectReserve(new Error('controlled refusal before durable acceptance'))
  if (kind === 'uncertain') {
    await until(() => getCommandQueueSnapshot().some(command => command.uuid === uncertain.uuid), 'late refusal retains the uncertain input')
  } else {
    await until(() => !h.controller.isTurnActive(), 'late answer reserve settles after close')
    await Bun.sleep(0)
    expect(getCommandQueueSnapshot().some(command => command.uuid === uncertain.uuid)).toBe(false)
  }
  await flushQueueOperationsDurably()
  const loaded = await storage.loadTranscriptFile(storage.getTranscriptPathForSession(h.engineSessionId), { strict: true })
  expect(loaded.queueOperations.some(operation => operation.uuid === uncertain.uuid && operation.operation === 'reserve')).toBe(true)
  expect(loaded.queueOperations.some(operation => operation.uuid === uncertain.uuid && operation.operation === 'remove')).toBe(kind === 'question-reply')
  expect(submit.mock.calls).toHaveLength(1)
  expect(providerCalls).toBe(1)
})

for (const ending of ['success', 'completion rejection', 'admission rejection'] as const) {
  test(`continuation publishes idle after ${ending}`, async () => {
    spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
      yield assistant([{ type: 'text', text: 'Completed preserved request.' }])
    }))
    const h = await harness()
    if (ending !== 'success') {
      const start = h.controller.startHandoffContinuation.bind(h.controller)
      spies.push(spyOn(h.controller, 'startHandoffContinuation').mockImplementation(async () => {
        const started = await start()
        if (ending === 'admission rejection') {
          await started.completion
          throw new Error('isolated admission failure after controller exit')
        }
        return { ...started, completion: started.completion.then(() => {
          throw new Error('isolated completion failure')
        }) }
      }))
    }
    await h.command({ action: 'continue', continuationId: h.state.continuation.id })
    await until(() => h.controller.getWorkspaceHandoffSnapshot()?.execution === 'terminal', 'controller completion')
    // Controller exit precedes the sidecar finalizer, so let both promise chains settle.
    await Bun.sleep(0)
    expect(h.received.filter(frame => frame.kind === 'activity').map(frame => frame.presence))
      .toEqual(['idle', 'running', 'idle'])
  })
}

for (const lost of ['command', 'reply'] as const) test(`real durable execution converges after lost release ${lost} without a second continuation`, async () => {
  let calls = 0
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
    calls++
    yield assistant([{ type: 'text', text: calls === 1 ? 'Completed preserved request.' : 'Accepted next ordinary prompt.' }])
  }))
  const h = await harness({ dropRelease: lost })
  const ack = await h.command({ action: 'continue', continuationId: h.state.continuation.id })
  expect(ack.kind).toBe('result')
  if (ack.kind === 'result') expect(ack.result).toMatchObject({ disposition: 'accepted' })
  await until(() => h.controller.getWorkspaceHandoffSnapshot()?.record.kind === 'valid' &&
    h.controller.getWorkspaceHandoffSnapshot()?.execution === 'terminal', 'actual checkpoint publication')
  const snapshot = h.controller.getWorkspaceHandoffSnapshot()!
  if (snapshot.record.kind !== 'valid' || !snapshot.record.record.terminal) throw new Error('Missing durable terminal')
  expect(snapshot.record.record.terminal.outcome).toBe('success')
  await storage.verifyResumeCheckpoint(snapshot.record.record.terminal.checkpoint)
  expect(calls).toBe(1)
  if (lost === 'command') {
    expect(h.controller.getHandoffReservation()).toBe(h.operationId)
    expect(h.held()).toBe(true)
    // A lost command leaves correlation pending, but status recovery remains
    // possible on disconnect/next attachment without deciding execution failed.
    h.control.disconnect(h.appSessionId)
    await Bun.sleep(0)
    await h.command({ action: 'status' })
    await until(() => !h.held(), 'retry applies release')
    expect(h.releaseCommands()).toBe(2)
  } else {
    await until(() => !h.held(), 'state confirms applied release despite missing reply')
    expect(h.releaseCommands()).toBe(1)
    expect(h.controller.getHandoffReservation()).toBeNull()
    h.control.disconnect(h.appSessionId)
    await Bun.sleep(0)
  }
  const duplicate = await h.command({ action: 'continue', continuationId: h.state.continuation.id })
  expect(duplicate.kind).toBe('result')
  if (duplicate.kind === 'result') expect(duplicate.result.disposition).toBe('already_applied')
  expect(calls).toBe(1)
  h.submit('Next ordinary prompt')
  await until(() => calls === 2 && !h.controller.isTurnActive(), 'next ordinary input admitted exactly once')
  const persisted = await storage.loadTranscriptFile(storage.getTranscriptPathForSession(h.engineSessionId))
  const active = storage.selectActiveConversation(persisted.messages, persisted.leafUuids, persisted.activeConversationTip)
  expect(active.messages.filter(message => message.uuid === h.state.continuation.id)).toHaveLength(1)
  expect(readWorkspaceJump(h.appSessionId)?.version).toBe(2)
})

test('a settlement reply and subsequent real genuine-input proof in one delivery batch converge without restoring review', async () => {
  let calls = 0
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
    calls++; yield assistant([{ type: 'text', text: 'Reviewed the preserved progress.' }])
  }))
  const h = await harness()
  expect(await h.coordinator.cancel(h.appSessionId, h.operationId)).toBe(true)
  await h.coordinator.waitForSettlement(h.appSessionId)
  h.pauseControl()
  const settling = h.command({ action: 'settle', outcome: 'cancelled' })
  await until(() => h.controller.requiresHandoffReconciliation(), 'real warning persisted and review gate released')
  h.submit('Review the progress and proceed.')
  await until(() => calls === 1 && !h.controller.isTurnActive(), 'genuine input passed real checkpoint and record barrier')
  const proof = h.controller.getWorkspaceHandoffSnapshot()!.record
  if (proof.kind !== 'valid' || !proof.record.reconciliation) throw new Error('Missing genuine input proof')
  await storage.verifyResumeCheckpoint(proof.record.reconciliation.checkpoint)
  h.flushControlBatch()
  expect((await settling).kind).toBe('result')
  await until(() => !h.held(), 'main and controller agree on open gate after batch')
  expect(h.coordinator.snapshot(h.appSessionId)?.review).toMatchObject({ required: false,
    noticeUuid: proof.record.reconciliation.noticeUuid, reconciledInputUuid: proof.record.reconciliation.inputUuid })
  expect(h.controller.requiresHandoffReconciliation()).toBe(false)
  expect(h.coordinator.snapshot(h.appSessionId)?.continuation.outcome).toBe('not_started')
  const active = await loadConversationForResume(h.engineSessionId, storage.getTranscriptPathForSession(h.engineSessionId), { interruptedTurn: 'ignore' })
  expect(active!.messages.some(message => message.uuid === proof.record.reconciliation!.contextUuid)).toBe(true)
})

test('acknowledged continuation remains running during a real permission wait beyond the former 30-minute deadline', async () => {
  let unblock!: () => void, entered = false, calls = 0
  const blocked = new Promise<void>(resolve => { unblock = resolve })
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
    calls++
    yield assistant(calls === 1 ? [{ type: 'tool_use', id: 'delayed-permission', name: 'FixturePermission', input: {} }]
      : [{ type: 'text', text: 'Long continuation completed.' }])
  }))
  let executed = 0
  const tool = buildTool({ name: 'FixturePermission', inputSchema: z.object({}),
    description: async () => 'Wait for permission', prompt: async () => 'Wait for permission',
    maxResultSizeChars: 1000, renderToolUseMessage: () => null,
    async call() { executed++; return { data: 'Permission allowed once.' } },
    mapToolResultToToolResultBlockParam: (data, id) => ({ type: 'tool_result', tool_use_id: id, content: data }) })
  const h = await harness({ tools: [tool], canUseTool: async (_tool, input) => {
    entered = true; await blocked
    return { behavior: 'allow', updatedInput: input }
  } })
  const timers = new Map<ReturnType<typeof setTimeout>, { callback: () => void; delay: number }>()
  const realTimer = globalThis.setTimeout, realClear = globalThis.clearTimeout
  // Forward extra arguments: sleep() passes its resolver through them, and any
  // long sleep that starts during this window would otherwise throw.
  const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, delay: number, ...args: unknown[]) => {
    const id = realTimer(callback, delay, ...args)
    if (delay >= 1_000) timers.set(id, { callback: () => callback(...args), delay })
    return id
  }) as typeof setTimeout)
  const clearSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(((id: ReturnType<typeof setTimeout>) => {
    timers.delete(id); realClear(id)
  }) as typeof clearTimeout)
  let clockSpy: ReturnType<typeof spyOn> | undefined
  try {
    const delivery = await h.command({ action: 'continue', continuationId: h.state.continuation.id })
    expect(delivery.kind).toBe('result')
    await until(() => entered, 'real permission wait started independently of acknowledgement')
    clockSpy = spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000)
    for (const [id, timer] of [...timers]) if (timer.delay <= 31 * 60_000) {
      realClear(id); timers.delete(id); timer.callback()
    }
    const status = await h.command({ action: 'status' })
    expect(status.kind).toBe('result')
    expect(h.controller.getWorkspaceHandoffSnapshot()?.execution).toBe('running')
    expect(h.coordinator.snapshot(h.appSessionId)?.continuation.outcome).toBe('pending')
    expect(h.held()).toBe(true)
    const record = h.controller.getWorkspaceHandoffSnapshot()!.record
    expect(record.kind).toBe('valid')
    if (record.kind === 'valid') { expect(record.record.notice).toBeNull(); expect(record.record.terminal).toBeNull() }
    expect(calls).toBe(1)
    expect(executed).toBe(0)
  } finally {
    clockSpy?.mockRestore(); timerSpy.mockRestore(); clearSpy.mockRestore(); unblock()
  }
  await until(() => !h.held(), 'same long execution publishes durable success')
  expect(h.coordinator.snapshot(h.appSessionId)?.continuation.outcome).toBe('success')
  expect(executed).toBe(1)
  expect(calls).toBe(2)
})

test.each(['transient', 'persistent'] as const)('a %s completion checkpoint failure retries proof without replaying work and permits acknowledged close', async failure => {
  let calls = 0, failed = false
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
    calls++; yield assistant([{ type: 'text', text: 'Execution closed before its failing durability barrier.' }])
  }))
  const h = await harness()
  const path = storage.getTranscriptPathForSession(h.engineSessionId)
  const realOpen = fsPromises.open
  spies.push(spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
    const file = await realOpen(...args)
    if (String(args[0]) === path) {
      const sync = file.sync.bind(file)
      file.sync = async () => {
        if (calls === 1 && (failure === 'persistent' || !failed)) { failed = true; throw new Error('Isolated checkpoint sync failure') }
        await sync()
      }
    }
    return file
  }))
  expect((await h.command({ action: 'continue', continuationId: h.state.continuation.id })).kind).toBe('result')
  if (failure === 'transient') {
    await until(() => !h.held(), 'retry publishes durable success and releases the hold')
    const record = h.controller.getWorkspaceHandoffSnapshot()!.record
    if (record.kind !== 'valid' || !record.record.terminal) throw new Error('Missing completed checkpoint')
    await storage.verifyResumeCheckpoint(record.record.terminal.checkpoint)
    expect(record.record.terminal.outcome).toBe('success')
    expect(failed).toBe(true)
    expect(calls).toBe(1)
    return
  }
  await until(() => h.controller.getWorkspaceHandoffSnapshot()?.execution === 'unconfirmed' && !h.controller.isTurnActive(), 'failed barrier remains unconfirmed')
  expect(failed).toBe(true)
  expect(calls).toBe(1)
  expect(h.coordinator.snapshot(h.appSessionId)?.continuation.outcome).toBe('unknown')
  const record = h.controller.getWorkspaceHandoffSnapshot()!.record
  if (record.kind !== 'valid') throw new Error('Missing conservative warning evidence')
  expect(record.record.terminal).toBeNull()
  expect(record.record.notice).toBeNull()
  expect(h.held()).toBe(true)
  expect(h.controller.canStartAutomaticTurn()).toBe(false)
  let stopped = false
  const close = new SessionCloseCoordinator({
    authorize: async () => ({ ok: true, value: undefined }),
    blocked: id => h.coordinator.isCloseBlocked(id),
    cancel: async id => { await h.coordinator.cancel(id, undefined, 'close') },
    observe: id => h.coordinator.queryStatus(id),
    close: async () => { stopped = true; expect(h.held()).toBe(false); return { ok: true, value: undefined } },
    timeoutMs: 100, retryMs: 1,
  })
  expect((await close.close(h.appSessionId)).ok).toBe(true)
  expect(stopped).toBe(true)
  expect(calls).toBe(1)
  expect(h.coordinator.snapshot(h.appSessionId)?.continuation.outcome).toBe('unknown')
  expect(h.coordinator.retains(h.appSessionId)).toBe(true)
  expect(h.controller.canStartAutomaticTurn()).toBe(false)
})

test('real W/R seals complete actual parallel tool outputs through the transport and main ledger', async () => {
  const outputs = ['actual-left-' + 'L'.repeat(4096), 'actual-right-' + 'R'.repeat(4096)]
  let calls = 0
  const executed: string[] = []
  const tool = buildTool({ name: 'FixtureRead', inputSchema: z.object({ index: z.number().int().min(0).max(1) }),
    description: async () => 'Read isolated fixture', prompt: async () => 'Read isolated fixture',
    maxResultSizeChars: 20_000, renderToolUseMessage: () => null,
    async call(input) { executed.push(outputs[input.index]!); return { data: outputs[input.index]! } },
    mapToolResultToToolResultBlockParam: (data, id) => ({ type: 'tool_result', tool_use_id: id, content: data }) })
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
    calls++
    yield assistant(calls === 1 ? [
      { type: 'tool_use', id: 'read-left', name: 'FixtureRead', input: { index: 0 } },
      { type: 'tool_use', id: 'read-right', name: 'FixtureRead', input: { index: 1 } },
    ] : [{ type: 'text', text: 'Both actual results retained.' }])
  }))
  const h = await harness({ tools: [tool] })
  await h.command({ action: 'continue', continuationId: h.state.continuation.id })
  await until(() => !h.held(), 'durable success and release')
  expect(executed).toEqual(outputs)
  const record = h.controller.getWorkspaceHandoffSnapshot()!.record
  if (record.kind !== 'valid' || !record.record.terminal) throw new Error('No terminal checkpoint')
  await storage.verifyResumeCheckpoint(record.record.terminal.checkpoint)
  const restored = await loadConversationForResume(h.engineSessionId, storage.getTranscriptPathForSession(h.engineSessionId), { interruptedTurn: 'ignore' })
  expect(restored).not.toBeNull()
  const actual = restored!.messages.flatMap(message => message.type === 'user' && Array.isArray(message.message.content)
    ? message.message.content.filter(block => block.type === 'tool_result').map(block => block.content) : [])
  expect(actual).toEqual(outputs)
  expect(h.coordinator.snapshot(h.appSessionId)?.continuation.outcome).toBe('success')
})

test.each(['intact', 'damaged'] as const)('fresh execution admission supplies deferred policy but cannot bypass %s tail evidence', async kind => {
  const seed = createUserMessage({ content: 'preserved request at a parked source boundary' })
  await storage.recordTranscript([seed])
  await storage.markActiveConversationTip(seed.uuid as UUID)
  await storage.flushCurrentTranscriptDurably(seed.uuid)
  if (kind === 'damaged') {
    await fsPromises.appendFile(storage.getTranscriptPath(), '{"type":"assistant","message":')
    await storage.prepareOwnedTranscriptForResume(bootstrap.getSessionId())
  }
  const loaded = await loadConversationForResume(bootstrap.getSessionId(), storage.getTranscriptPath(), { mutable: true, interruptedTurn: 'ignore' })
  expect(loaded?.recoveryReviewRequired).toBe(true)
  const identity = { appSessionId: randomUUID(), engineSessionId: bootstrap.getSessionId(), operationId: randomUUID(),
    continuationId: randomUUID(), sourceGeneration: randomUUID(), admissionGeneration: randomUUID(), operationSha256: 'a'.repeat(64) }
  const sessionStart = await import('../../src/utils/sessionStart.js')
  const { createAttachmentMessage } = await import('../../src/utils/attachments.js')
  let hooks = 0, providers = 0, admissions = 0
  spies.push(spyOn(sessionStart, 'processSessionStartHooks').mockImplementation(async () => {
    hooks++
    return [createAttachmentMessage({ type: 'hook_additional_context', content: ['fresh admitted policy'],
      hookName: 'SessionStart', toolUseID: 'SessionStart', hookEvent: 'SessionStart' })] as never
  }))
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* ({ messages }) {
    providers++
    expect(hooks).toBe(1)
    expect(JSON.stringify(messages)).toContain('fresh admitted policy')
    yield assistant([{ type: 'text', text: 'continued authorized move' }])
  }))
  const controller = createRuntimeBackedAppSession({ queryEngineConfig: {
    ...engineConfig(loaded!.messages, []), initialRecoveryReviewRequired: true,
    verifyFreshHandoffAdmission: async actual => {
      expect(actual).toEqual(identity)
      const { readWorkspaceHandoffExecution } = await import('../../src/utils/workspaceHandoffExecutionState.js')
      const execution = await readWorkspaceHandoffExecution(identity)
      expect(execution.kind === 'valid' && execution.record.consumed && !execution.record.inputCommitted).toBe(true)
      admissions++
    },
  } })
  await controller.waitForInitialization()
  await expect(controller.submit('unclaimed automatic work', { isMeta: true })).rejects.toThrow('genuine user message')
  expect(admissions).toBe(0)
  await controller.configureWorkspaceHandoff({ identity, observerGeneration: identity.admissionGeneration,
    origin: 'fresh', recover: false })
  const started = await controller.startHandoffContinuation()
  if (kind === 'damaged') {
    await expect(started.completion).rejects.toThrow('Damaged history requires a genuine user message')
    expect(admissions).toBe(0)
    expect(hooks).toBe(0)
    expect(providers).toBe(0)
    expect(controller.canStartAutomaticTurn()).toBe(false)
  } else {
    await started.completion
    expect(admissions).toBe(1)
    expect(hooks).toBe(1)
    expect(providers).toBe(1)
    await expect(controller.startHandoffContinuation().then(result => result.completion)).resolves.toBeUndefined()
    expect(providers).toBe(1)
  }
})

test('structural proof failure stays held without repeated writes and recovery preparation fences ingress until cancellation', async () => {
  const { ResumeIdentityError } = await import('../../src/utils/resumeCheckpoint.js')
  let calls = 0, seals = 0
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
    calls++; yield assistant([{ type: 'text', text: 'saved result before proof failure' }])
  }))
  const h = await harness()
  const originalSeal = storage.sealResumeCheckpoint
  const seal = spyOn(storage, 'sealResumeCheckpoint').mockImplementation(async messages => {
    if (!messages.some(m => m.type === 'assistant')) return originalSeal(messages)
    seals++; throw new ResumeIdentityError('duplicate_message_identity', randomUUID(), 'attachment')
  })
  spies.push(seal)
  await h.command({ action: 'continue', continuationId: h.state.continuation.id })
  await until(() => h.controller.getWorkspaceHandoffSnapshot()?.settled === true &&
    h.received.at(-1)?.kind !== 'activity', 'failed proof settles')
  await Bun.sleep(0)
  expect(h.controller.getWorkspaceHandoffSnapshot()).toMatchObject({ execution: 'unconfirmed', settled: true,
    failure: { stage: 'checkpoint_seal', reason: 'duplicate_message_identity' }, gate: { mode: 'held' } })
  seal.mockRestore()
  const bytes = await fsPromises.readFile(storage.getTranscriptPath())
  for (let i = 0; i < 4; i++) await h.command({ action: 'status' })
  expect(seals).toBe(1)
  expect(await fsPromises.readFile(storage.getTranscriptPath())).toEqual(bytes)
  const id = randomUUID()
  expect(await h.coordinator.prepareRecovery(h.appSessionId, h.operationId, randomUUID(), id)).toMatchObject({ ok: false })
  expect(await h.coordinator.prepareRecovery(h.appSessionId, h.operationId, h.generation, id)).toMatchObject({ ok: true })
  const submitId = randomUUID()
  h.send({ type: 'app.submit', requestId: randomUUID(), prompt: 'keep this draft', options: { submitId } })
  expect(h.received.find(frame => frame.kind === 'submit.result' && frame.submitId === submitId)).toMatchObject({ accepted: false })
  expect(h.controller.getHandoffReservation()).toBe(h.operationId)
  expect(calls).toBe(1)
  await h.coordinator.cancelRecovery(h.appSessionId, h.operationId, h.generation, id)
  const status = await h.command({ action: 'status' })
  expect(status.kind === 'result' && status.result.status?.recoveryId).toBeNull()
  expect(h.held()).toBe(true)
  expect(calls).toBe(1)
})

test('watchdog unconfirmed cannot authorize replacement while the actual seal is still running', async () => {
  const blocked = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  const original = storage.sealResumeCheckpoint
  spies.push(spyOn(storage, 'sealResumeCheckpoint').mockImplementation(async messages => {
    if (messages.some(m => m.type === 'assistant')) { entered.resolve(); await blocked.promise }
    return original(messages)
  }))
  const realTimer = globalThis.setTimeout
  let watchdog: (() => void) | undefined
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms: number, ...args: unknown[]) => {
    if (ms === 30_000) watchdog = callback
    return realTimer(callback, ms, ...args)
  }) as typeof setTimeout)
  spies.push(timer)
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
    yield assistant([{ type: 'text', text: 'completed but sealing' }])
  }))
  const h = await harness()
  try {
    await h.command({ action: 'continue', continuationId: h.state.continuation.id })
    await entered.promise
    expect(watchdog).toBeDefined()
    watchdog!()
    expect(h.controller.getWorkspaceHandoffSnapshot()).toMatchObject({ execution: 'unconfirmed', settled: false })
    expect(await h.coordinator.prepareRecovery(h.appSessionId, h.operationId, h.generation, randomUUID())).toMatchObject({ ok: false })
    const attempt = await h.command({ action: 'prepare_recovery', recoveryId: randomUUID() })
    expect(attempt.kind === 'result' && attempt.result.disposition).toBe('refused')
  } finally { blocked.resolve() }
  await until(() => !h.held(), 'original seal finishes without replacement')
})

for (const effect of ['tool receipt', 'task', 'queue', 'missing archive', 'changed archive'] as const) {
  test(`recovery refuses ${effect} and keeps the handoff reservation`, async () => {
    const { ResumeIdentityError } = await import('../../src/utils/resumeCheckpoint.js')
    spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
      yield assistant([{ type: 'text', text: 'ARCHIVE_RECOVERY_RESULT' }])
    }))
    const h = await harness()
    const originalSeal = storage.sealResumeCheckpoint
    const seal = spyOn(storage, 'sealResumeCheckpoint').mockImplementation(async messages => {
      if (!messages.some(m => m.type === 'assistant')) return originalSeal(messages)
      throw new ResumeIdentityError('duplicate_message_identity')
    })
    spies.push(seal)
    await h.command({ action: 'continue', continuationId: h.state.continuation.id })
    await until(() => h.controller.getWorkspaceHandoffSnapshot()?.settled === true, 'failed attempt settles')
    await Bun.sleep(0)
    seal.mockRestore()
    const path = storage.getTranscriptPath()
    if (effect === 'tool receipt') spies.push(spyOn(h.controller, 'hasUnresolvedToolEffects').mockReturnValue(true))
    if (effect === 'task') spies.push(spyOn(h.tasks, 'hasLiveWork').mockReturnValue(true))
    if (effect === 'queue') enqueue({ value: 'queued human input', mode: 'prompt', uuid: randomUUID() })
    if (effect === 'missing archive') await fsPromises.rename(path, path + '.saved')
    if (effect === 'changed archive') {
      await storage.flushCurrentTranscriptDurably()
      const original = await fsPromises.readFile(path, 'utf8')
      expect(original).toContain('ARCHIVE_RECOVERY_RESULT')
      await fsPromises.writeFile(path, original.replaceAll('ARCHIVE_RECOVERY_RESULT', 'ALTERED_RECOVERY_RESULT'))
      expect(await fsPromises.readFile(path, 'utf8')).not.toContain('ARCHIVE_RECOVERY_RESULT')
    }
    const attempt = await h.command({ action: 'prepare_recovery', recoveryId: randomUUID() })
    expect(attempt.kind === 'result' && attempt.result.disposition).toBe('refused')
    if (attempt.kind === 'result') expect(attempt.result.reason).toBe(({ 'tool receipt': 'pending_receipts', task: 'live_tasks', queue: 'queued_input', 'missing archive': 'durability_unconfirmed', 'changed archive': 'durability_unconfirmed' } as const)[effect])
    const status = await h.command({ action: 'status' })
    expect(status.kind === 'result' && status.result.status?.recoveryId).toBeNull()
    expect(h.controller.getHandoffReservation()).toBe(h.operationId)
    expect(h.held()).toBe(true)
    if (effect === 'missing archive') await fsPromises.rename(path + '.saved', path)
  })
}

test.each(['cancelled', 'late tool receipt'] as const)('recovery preparation rechecks its owners after archive read: %s', async interruption => {
  const { ResumeIdentityError } = await import('../../src/utils/resumeCheckpoint.js')
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
    yield assistant([{ type: 'text', text: 'completed before abandoned preparation' }])
  }))
  const h = await harness()
  const originalSeal = storage.sealResumeCheckpoint
  const seal = spyOn(storage, 'sealResumeCheckpoint').mockImplementation(async rows => {
    if (rows.some(row => row.type === 'assistant')) throw new ResumeIdentityError('duplicate_message_identity')
    return originalSeal(rows)
  })
  spies.push(seal)
  await h.command({ action: 'continue', continuationId: h.state.continuation.id })
  await until(() => h.controller.getWorkspaceHandoffSnapshot()?.settled === true, 'completion settles')
  await Bun.sleep(0)
  seal.mockRestore()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const verify = h.controller.verifyWorkspaceRecoveryArchive.bind(h.controller)
  spies.push(spyOn(h.controller, 'verifyWorkspaceRecoveryArchive').mockImplementation(async () => {
    entered.resolve(); await release.promise; await verify()
  }))
  const recoveryId = randomUUID()
  const preparation = h.command({ action: 'prepare_recovery', recoveryId })
  try {
    await entered.promise
    if (interruption === 'cancelled') {
      const cancelled = await h.command({ action: 'cancel_recovery', recoveryId })
      expect(cancelled.kind === 'result' && cancelled.result.disposition).toBe('accepted')
    } else spies.push(spyOn(h.controller, 'hasUnresolvedToolEffects').mockReturnValue(true))
  } finally { release.resolve() }
  const late = await preparation
  expect(late.kind === 'result' && late.result.disposition).toBe('refused')
  if (interruption === 'late tool receipt' && late.kind === 'result') expect(late.result.reason).toBe('pending_receipts')
  const status = await h.command({ action: 'status' })
  expect(status.kind === 'result' && status.result.status?.recoveryId).toBeNull()
  expect(h.controller.getHandoffReservation()).toBe(h.operationId)
})

test('execution publication failure reports only its bounded stage and I/O code', async () => {
  const execution = await import('../../src/utils/workspaceHandoffExecutionState.js')
  const update = execution.updateWorkspaceHandoffExecution
  spies.push(spyOn(execution, 'updateWorkspaceHandoffExecution').mockImplementation((identity, change) => update(identity, previous => {
    const next = change(previous)
    if (next.terminal) throw Object.assign(new Error('PRIVATE content must not enter status'), { code: 'ENOSPC' })
    return next
  })))
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
    yield assistant([{ type: 'text', text: 'completed before publication failure' }])
  }))
  const h = await harness()
  await h.command({ action: 'continue', continuationId: h.state.continuation.id })
  await until(() => h.controller.getWorkspaceHandoffSnapshot()?.settled === true, 'publication failure settles')
  const status = h.controller.getWorkspaceHandoffSnapshot()!
  expect(status.failure).toEqual({ stage: 'execution_record', reason: 'unknown', ioCode: 'ENOSPC' })
  expect(JSON.stringify(status)).not.toContain('PRIVATE')
  expect(status.gate.mode).toBe('held')
})

test('explicit recovery reconciles an orphaned preparation after its cleanup command was lost', async () => {
  const { ResumeIdentityError } = await import('../../src/utils/resumeCheckpoint.js')
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
    yield assistant([{ type: 'text', text: 'completed before lost cleanup' }])
  }))
  const h = await harness()
  const originalSeal = storage.sealResumeCheckpoint
  const seal = spyOn(storage, 'sealResumeCheckpoint').mockImplementation(async rows => {
    if (rows.some(row => row.type === 'assistant')) throw new ResumeIdentityError('duplicate_message_identity')
    return originalSeal(rows)
  })
  spies.push(seal)
  await h.command({ action: 'continue', continuationId: h.state.continuation.id })
  await until(() => h.controller.getWorkspaceHandoffSnapshot()?.settled === true, 'failed completion settles')
  await Bun.sleep(0)
  seal.mockRestore()
  const firstId = randomUUID(), nextId = randomUUID()
  expect(await h.coordinator.prepareRecovery(h.appSessionId, h.operationId, h.generation, firstId)).toEqual({ ok: true })
  h.dropRecoveryCleanup(true)
  expect(await h.coordinator.cancelRecovery(h.appSessionId, h.operationId, h.generation, firstId)).toBe(false)
  h.dropRecoveryCleanup(false)
  expect(await h.coordinator.prepareRecovery(h.appSessionId, h.operationId, h.generation, nextId)).toEqual({ ok: true })
  const status = await h.command({ action: 'status' })
  expect(status.kind === 'result' && status.result.status?.recoveryId).toBe(nextId)
  expect(await h.coordinator.cancelRecovery(h.appSessionId, h.operationId, h.generation, nextId)).toBe(true)
  expect(h.held()).toBe(true)
})

test('a settled failed terminal with an unsealed review notice can prepare explicit recovery', async () => {
  spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
    const failed = assistant([{ type: 'text', text: 'synthetic execution failure' }])
    failed.isApiErrorMessage = true
    yield failed
  }))
  const h = await harness()
  const originalSeal = storage.sealResumeCheckpoint
  const seal = spyOn(storage, 'sealResumeCheckpoint').mockImplementation(async rows => {
    if (rows.some(row => row.type === 'system' && row.subtype === 'workspace_handoff_outcome')) throw new Error('synthetic notice seal failure')
    return originalSeal(rows)
  })
  spies.push(seal)
  await h.command({ action: 'continue', continuationId: h.state.continuation.id })
  await until(() => h.controller.getWorkspaceHandoffSnapshot()?.failure?.stage === 'recovery_notice' &&
    h.controller.getWorkspaceHandoffSnapshot()?.settled === true, 'failed review notice settles')
  await Bun.sleep(0)
  seal.mockRestore()
  expect(h.controller.getWorkspaceHandoffSnapshot()).toMatchObject({ execution: 'terminal', settled: true,
    record: { kind: 'valid', record: { terminal: { outcome: 'failed' }, notice: null } }, gate: { mode: 'held' } })
  const before = await fsPromises.readFile(storage.getTranscriptPath())
  for (let i = 0; i < 3; i++) await h.command({ action: 'status' })
  expect(await fsPromises.readFile(storage.getTranscriptPath())).toEqual(before)
  const recoveryId = randomUUID()
  expect(await h.coordinator.prepareRecovery(h.appSessionId, h.operationId, h.generation, recoveryId)).toEqual({ ok: true })
  await h.coordinator.cancelRecovery(h.appSessionId, h.operationId, h.generation, recoveryId)
})
