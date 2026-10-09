import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
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
const { SidecarServer } = await import('./sidecarServer.js')
const { FrameDecoder, encodeFrame } = await import('../shared/framing.js')
const { PROTOCOL_VERSION } = await import('../shared/protocol.js')
const { resetCommandQueue } = await import('../../src/utils/messageQueueManager.js')

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
async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5)
  expect(predicate(), label).toBe(true)
}
async function harness(options: { dropRelease?: 'command' | 'reply'; tools?: ReturnType<typeof buildTool>[]; canUseTool?: QueryEngineConfig['canUseTool'] } = {}) {
  const appSessionId = randomUUID(), engineSessionId = bootstrap.getSessionId(), operationId = randomUUID()
  const generation = randomUUID()
  const seed = createUserMessage({ content: 'Complete the preserved request in this workspace.' })
  await storage.recordTranscript([seed])
  await storage.markActiveConversationTip(seed.uuid as UUID)
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
  const controller = createRuntimeBackedAppSession({ queryEngineConfig: engineConfig([seed], options.tools ?? [], options.canUseTool),
    initializeController: async instance => {
      instance.restoreHandoffReservation(operationId)
      await instance.configureWorkspaceHandoff({ identity: { appSessionId, engineSessionId, operationId,
        continuationId: state.continuation.id, sourceGeneration: state.sourceGeneration,
        admissionGeneration: generation, operationSha256: workspaceJumpOperationSha256(state) },
        observerGeneration: generation, origin: 'fresh', recover: false })
    } })
  await controller.waitForInitialization()
  let held = true, drop = options.dropRelease, releaseCommands = 0, paused = false
  const batch: ServerFrame[] = []
  const received: ServerFrame[] = [], decoder = new FrameDecoder(32 * 1024 * 1024)
  let control!: InstanceType<typeof WorkspaceHandoffControl>
  let connection!: ReturnType<InstanceType<typeof SidecarServer>['addConnection']>
  const server = new SidecarServer({ sessionId: appSessionId, engineSessionId, generation, controller, log: () => {} })
  const coordinator = new WorkspaceJumpCoordinator({ row: id => id === appSessionId ? {
    appSessionId, engineSessionId, cwd: state.target.cwd, binding: state.target.binding,
    lastAttachedAt: 1, lastMessageSentAt: 1, shutdown: null } : undefined,
    knownProjects: () => [], validateCwd: cwd => ({ ok: true, realpath: cwd }), trustedProjectRoots: async paths => paths,
    verifyReady: () => false, control: (current, action) => control.request(appSessionId, current.operationId, action),
    host: { getSessionGeneration: () => generation,
      reserveWorkspaceJump: async () => ({ ok: true, value: undefined }),
      releaseWorkspaceJump: () => { held = false }, moveWorkspaceJump: async () => { throw new Error('Already at destination') } } })
  control = new WorkspaceHandoffControl({ generation: () => generation,
    acceptsStatus: (id, status) => id === appSessionId && status.engineSessionId === engineSessionId,
    observe: (id, snapshot) => { coordinator.observe(id, snapshot) }, recover: id => coordinator.queryStatus(id),
    send: (_id, message) => {
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
  connection = server.addConnection({ write(data) { for (const value of decoder.push(Buffer.from(data))) {
    if (value.kind === 'frame') deliver(value.payload as ServerFrame)
  } }, end() {} })
  // Main records uncertain dispatch only after the destination is attached,
  // immediately before its first continuation command.
  state.continuation.dispatch = 'unknown'
  writeWorkspaceJump(state)
  disposers.push(() => { control.dispose(); server.close() })
  return { appSessionId, engineSessionId, operationId, generation, state, seed, controller, server, received, coordinator, control,
    held: () => held, releaseCommands: () => releaseCommands,
    pauseControl: () => { paused = true },
    flushControlBatch: () => { paused = false; for (const frame of batch.splice(0)) control.receiveFrame(appSessionId, frame) },
    command: (action: WorkspaceControlAction) => control.request(appSessionId, operationId, action),
    submit: (text: string) => server.handleData(connection, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId: appSessionId,
      message: { type: 'app.submit', requestId: randomUUID(), prompt: text } })) }
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
  const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay: number) => {
    const id = realTimer(callback, delay)
    if (delay >= 1_000) timers.set(id, { callback, delay })
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

test('a real completion checkpoint failure cannot become main-ledger success', async () => {
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
        if (calls === 1 && !failed) { failed = true; throw new Error('Isolated checkpoint sync failure') }
        await sync()
      }
    }
    return file
  }))
  expect((await h.command({ action: 'continue', continuationId: h.state.continuation.id })).kind).toBe('result')
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
