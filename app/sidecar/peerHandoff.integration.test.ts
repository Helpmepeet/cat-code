import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { randomUUID, type UUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage, Message } from '../../src/types/message.js'
import type { AppState } from '../../src/state/AppStateStore.js'
import type { QueryEngineConfig } from '../../src/QueryEngine.js'
import type { WorkspaceJumpStateV2 } from '../../src/utils/workspaceJumpState.js'
import type { WorkspaceControlAction } from '../main/workspaceHandoffControl.js'
import type { ServerFrame, SidecarClientMessage } from '../shared/protocol.js'

// Persistent module mocks in other routine suites must not replace engine owners.
if (process.env.CATCODE_PEER_HANDOFF_TEST_CHILD !== '1') {
  test('peer handoff admission and consumption use real owners in an isolated runtime', () => {
    const env = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !key.startsWith('CATCODE_')))
    const result = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      cwd: new URL('../..', import.meta.url).pathname,
      env: { ...env, CATCODE_PEER_HANDOFF_TEST_CHILD: '1' },
      stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
    })
    expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
  }, 35_000)
} else {
  const { default: z } = await import('zod/v4')
  // Frames use an in-memory asynchronous transport and provider output is scripted.
  // Admission, queue consumption, acknowledgements and durable handoff lifecycle
  // use production owners. No Electron, account state or network is available.
  const root = mkdtempSync(join(tmpdir(), 'peer-handoff-integration-'))
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
  const envUtils = await import('../../src/utils/envUtils.js')
  const growthbook = await import('../../src/services/analytics/growthbook.js')
  const shell = await import('../../src/utils/Shell.js')
  const { asSessionId } = await import('../../src/types/ids.js')
  const { buildTool } = await import('../../src/Tool.js')
  const { createUserMessage } = await import('../../src/utils/messages.js')
  const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
  const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.js')
  const { createRuntimeBackedAppSession } = await import('../../src/app-runtime/createRuntimeBackedAppSession.js')
  const { writeWorkspaceJump, readWorkspaceJump, workspaceJumpOperationSha256 } = await import('../../src/utils/workspaceJumpState.js')
  const { WorkspaceJumpCoordinator } = await import('../main/workspaceJumpCoordinator.js')
  const { WorkspaceHandoffControl } = await import('../main/workspaceHandoffControl.js')
  const { SidecarServer } = await import('./sidecarServer.js')
  const { FrameDecoder, encodeFrame } = await import('../shared/framing.js')
  const { PROTOCOL_VERSION } = await import('../shared/protocol.js')
  const { resetCommandQueue, getCommandQueueSnapshot } = await import('../../src/utils/messageQueueManager.js')

  const { createPeerRequestPlane } = await import('../main/peerRequestPlane.js')
  const { canForwardWorkspaceInput } = await import('../main/mainDecisions.js')

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
    // SIMPLE isolates optional services, but desktop input must await persistence.
    spies.push(spyOn(envUtils, 'isBareMode').mockReturnValue(false))
  })
  afterEach(async () => {
    for (const dispose of disposers.splice(0)) dispose()
    for (const spy of spies.splice(0)) spy.mockRestore()
    resetCommandQueue()
    await storage.flushSessionStorage()
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
    const consumption: Array<{ reservation: string | null; active: boolean }> = []
    const received: ServerFrame[] = [], decoder = new FrameDecoder(32 * 1024 * 1024)
    let control!: InstanceType<typeof WorkspaceHandoffControl>
    let connection!: ReturnType<InstanceType<typeof SidecarServer>['addConnection']>
    const server = new SidecarServer({ sessionId: appSessionId, engineSessionId, generation, controller, log: () => {} })
    let plane!: ReturnType<typeof createPeerRequestPlane>
    let openCount = 0
    const coordinator = new WorkspaceJumpCoordinator({ row: id => id === appSessionId ? {
      appSessionId, engineSessionId, cwd: state.target.cwd, binding: state.target.binding,
      lastAttachedAt: 1, lastMessageSentAt: 1, shutdown: null } : undefined,
      onPeerInputOpen: id => { openCount++; plane.onPeerInputOpen(id) },
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
      if (frame.kind === 'host.request') {
        if (frame.verb === 'peer.ack') consumption.push({
          reservation: controller.getHandoffReservation(), active: controller.isTurnActive(),
        })
        void plane.handleRequest(appSessionId, frame)
      }
      if (drop === 'reply' && frame.kind === 'workspace.handoff.result' && frame.action === 'release') { drop = undefined; return }
      if (paused) { batch.push(frame); return }
      control.receiveFrame(appSessionId, frame)
    }
    connection = server.addConnection({ write(data) { for (const value of decoder.push(Buffer.from(data))) {
      if (value.kind === 'frame') deliver(value.payload as ServerFrame)
    } }, end() {} })
    const senderId = randomUUID()
    const attempts: SidecarClientMessage[] = [], delayed: SidecarClientMessage[] = []
    let delayPeer = false
    const send = (message: SidecarClientMessage) => server.handleData(connection,
      encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId: appSessionId, message }))
    plane = createPeerRequestPlane({
      rows: () => [
        { appSessionId, engineSessionId, name: 'Bear', cwd: state.target.cwd, binding: state.target.binding, lastAttachedAt: 1, lastMessageSentAt: 1, shutdown: null },
        { appSessionId: senderId, engineSessionId: senderId, name: 'Alex', cwd: state.target.cwd, binding: state.target.binding, lastAttachedAt: 1, lastMessageSentAt: 1, shutdown: null },
      ],
      workspaceRequests: coordinator,
      isLive: () => true, isReady: () => true, canResume: () => true,
      setPeerNotice: async () => null,
      createSessionInWorkspace: async () => { throw new Error('Unexpected peer creation') },
      restoreSession: async () => { throw new Error('Unexpected peer restart') },
      logRouted: () => {},
      forward: (id, message) => {
        if (id !== appSessionId) return null
        if (!canForwardWorkspaceInput(id, message, coordinator)) return 'unavailable'
        if (message.type === 'peer.deliver') {
          attempts.push(message)
          if (delayPeer) { delayed.push(message); return null }
        }
        // Match the socket boundary: a retry cannot reenter the release handler.
        setImmediate(() => send(message))
        return null
      },
    })
    // Main records uncertain dispatch only after the destination is attached,
    // immediately before its first continuation command.
    state.continuation.dispatch = 'unknown'
    writeWorkspaceJump(state)
    disposers.push(() => { control.dispose(); server.close() })
    return { appSessionId, engineSessionId, operationId, generation, state, seed, controller, server, received, coordinator, control,
      plane, senderId, attempts, consumption, openCount: () => openCount,
      delayPeer: () => { delayPeer = true },
      flushPeers: () => { delayPeer = false; for (const message of delayed.splice(0)) send(message) },
      peer: (text: string) => plane.handleRequest(senderId, { protocolVersion: PROTOCOL_VERSION,
        sessionId: senderId, kind: 'host.request', requestId: randomUUID(), verb: 'peer.deliver', args: { to: 'Bear', text } }),
      held: () => held, releaseCommands: () => releaseCommands,
      pauseControl: () => { paused = true },
      flushControlBatch: () => { paused = false; for (const frame of batch.splice(0)) control.receiveFrame(appSessionId, frame) },
      command: (action: WorkspaceControlAction) => control.request(appSessionId, operationId, action),
      submit: (text: string) => server.handleData(connection, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId: appSessionId,
        message: { type: 'app.submit', requestId: randomUUID(), prompt: text } })) }
  }

  function blockedProvider() {
    let unblock!: () => void, entered = false, calls = 0
    const blocked = new Promise<void>(resolve => { unblock = resolve })
    const tool = buildTool({ name: 'PeerCheckpoint', inputSchema: z.object({}),
      description: async () => 'Wait at checkpoint', prompt: async () => 'Wait at checkpoint',
      maxResultSizeChars: 1000, renderToolUseMessage: () => null,
      async call() { entered = true; await blocked; return { data: 'Checkpoint passed.' } },
      mapToolResultToToolResultBlockParam: (data, id) => ({ type: 'tool_result', tool_use_id: id, content: data }) })
    spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
      calls++
      yield assistant(calls === 1
        ? [{ type: 'tool_use', id: 'peer-checkpoint', name: 'PeerCheckpoint', input: {} }]
        : [{ type: 'text', text: 'Finished the request.' }])
    }))
    disposers.push(() => unblock())
    return { tool, unblock: () => unblock(), entered: () => entered, calls: () => calls }
  }

  test('a peer reaches the running destination through main and is acknowledged only when the engine consumes it', async () => {
    const provider = blockedProvider()
    const h = await harness({ tools: [provider.tool] })
    await h.command({ action: 'continue', continuationId: h.state.continuation.id })
    await until(provider.entered, 'destination tool running')
    await h.peer('Inspect the destination result.')
    await h.peer('Inspect the destination result.')
    await until(() => getCommandQueueSnapshot().length === 1, 'peer frame admitted')
    const queue = getCommandQueueSnapshot()
    expect(queue).toHaveLength(1)
    expect(queue[0]).toMatchObject({ mode: 'task-notification', priority: 'next',
      origin: { kind: 'peer', name: 'Alex', appSessionId: h.senderId } })
    expect(queue[0]!.value).toContain('Inspect the destination result.')
    expect(queue[0]!.value).not.toBe('Inspect the destination result.')
    expect(h.plane.pendingFor(h.appSessionId)).toHaveLength(1)
    expect(h.received.filter(frame => frame.kind === 'host.request' && frame.verb === 'peer.ack')).toHaveLength(0)
    expect(h.controller.getHandoffReservation()).toBe(h.operationId)
    expect(h.releaseCommands()).toBe(0)
    expect(provider.calls()).toBe(1)
    provider.unblock()
    await until(() => h.plane.pendingFor(h.appSessionId).length === 0, 'engine consumption acknowledges pending peer')
    await until(() => !h.held(), 'original continuation completes')
    expect(h.received.filter(frame => frame.kind === 'host.request' && frame.verb === 'peer.ack')).toHaveLength(1)
    expect(provider.calls()).toBe(2)
    expect(h.consumption).toEqual([{ reservation: h.operationId, active: true }])
    expect(getCommandQueueSnapshot()).toHaveLength(0)
  })

  test('a frame approved while running but refused terminal-held is retried with its original identity on authenticated open', async () => {
    const provider = blockedProvider()
    const h = await harness({ tools: [provider.tool] })
    await h.command({ action: 'continue', continuationId: h.state.continuation.id })
    await until(provider.entered, 'destination running')
    h.delayPeer()
    await h.peer('Reply after the handoff.')
    expect(h.attempts).toHaveLength(1)
    const pending = [...h.plane.pendingFor(h.appSessionId)]
    expect(pending).toHaveLength(1)
    h.pauseControl()
    provider.unblock()
    await until(() => h.controller.getWorkspaceHandoffSnapshot()?.execution === 'terminal', 'durable terminal held before main observes it')
    h.flushPeers()
    expect(getCommandQueueSnapshot()).toHaveLength(0)
    expect(h.plane.pendingFor(h.appSessionId)).toEqual(pending)
    expect(h.received.filter(frame => frame.kind === 'host.request' && frame.verb === 'peer.ack')).toHaveLength(0)
    expect(h.controller.getHandoffReservation()).toBe(h.operationId)
    h.flushControlBatch()
    // The sidecar bounds unsolicited state publications; correlated status is
    // the production recovery path after the delayed observation batch.
    await h.command({ action: 'status' })
    await until(() => h.openCount() === 1, 'authenticated open')
    await until(() => h.plane.pendingFor(h.appSessionId).length === 0, 'open callback redelivers and engine consumes')
    await until(() => !h.controller.isTurnActive(), 'post-release peer turn completes')
    expect(h.openCount()).toBe(1)
    expect(h.attempts).toHaveLength(2)
    expect(h.attempts[1]).toEqual(h.attempts[0])
    expect(h.received.filter(frame => frame.kind === 'host.request' && frame.verb === 'peer.ack')).toHaveLength(1)
    expect(provider.calls()).toBe(3)
  })

  test('cancelled review admits no peer and genuine reconciliation reopens delivery', async () => {
    let calls = 0
    spies.push(spyOn(claude, 'queryModelWithStreaming').mockImplementation(async function* () {
      calls++
      yield assistant([{ type: 'text', text: 'Reviewed the preserved progress.' }])
    }))
    const h = await harness()
    expect(await h.coordinator.cancel(h.appSessionId, h.operationId)).toBe(true)
    await h.coordinator.waitForSettlement(h.appSessionId)
    await h.command({ action: 'settle', outcome: 'cancelled' })
    await until(() => h.controller.requiresHandoffReconciliation(), 'durable review gate')
    await h.peer('Do not bypass review.')
    h.plane.onPeerInputOpen(h.appSessionId)
    expect(h.attempts).toHaveLength(0)
    expect(getCommandQueueSnapshot()).toHaveLength(0)
    expect(h.openCount()).toBe(0)
    expect(calls).toBe(0)
    expect(h.received.filter(frame => frame.kind === 'host.request' && frame.verb === 'peer.ack')).toHaveLength(0)
    h.submit('Review the progress and proceed.')
    await until(() => h.openCount() === 1 && !h.controller.isTurnActive(), 'genuine persisted input reopens gate')
    await h.peer('Now inspect the reviewed result.')
    await until(() => h.attempts.length === 1 && h.plane.pendingFor(h.appSessionId).length === 0, 'peer consumed after reconciliation')
    await until(() => !h.controller.isTurnActive(), 'peer turn completes')
    expect(calls).toBe(2)
    expect(h.received.filter(frame => frame.kind === 'host.request' && frame.verb === 'peer.ack')).toHaveLength(1)
  })
}
