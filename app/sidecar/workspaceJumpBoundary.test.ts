import { expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppSessionController } from '../../src/app-runtime/AppSessionController.js'
import { readWorkspaceJump, writeWorkspaceJump, workspaceJumpOperationSha256, type WorkspaceJumpStateV2 } from '../../src/utils/workspaceJumpState.js'
import { FrameDecoder, encodeFrame } from '../shared/framing.js'
import { PROTOCOL_VERSION, type ServerFrame } from '../shared/protocol.js'
import type { ResumeCheckpointV1, WorkspaceHandoffSnapshot } from '../shared/workspaceHandoff.js'
import { MAX_FRAME_BYTES } from '../shared/limits.js'
import { SidecarServer } from './sidecarServer.js'
import { getCwd } from '../../src/utils/cwd.js'
import * as engineConfig from '../../src/utils/config.js'
import * as sessionStorage from '../../src/utils/sessionStorage.js'
import type { SDKResultMessage } from '../../src/entrypoints/agentSdkTypes.js'
import { SDKResultSuccessSchema } from '../../src/entrypoints/sdk/coreSchemas.js'
import { getCommandQueueSnapshot, resetCommandQueue } from '../../src/utils/messageQueueManager.js'

test('legacy admitted history and wrong generation controls cannot start continuation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catcode-legacy-boundary-'))
  const oldConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = root
  const sessionId = randomUUID(), engineSessionId = randomUUID(), operationId = randomUUID(), generation = randomUUID(), continuationId = randomUUID()
  let runs = 0
  const controller = new AppSessionController({ async *runTurn() { runs++ } })
  const received: ServerFrame[] = [], decoder = new FrameDecoder(MAX_FRAME_BYTES)
  const server = new SidecarServer({ sessionId, engineSessionId, generation, controller, log: () => {} })
  const connection = server.addConnection({ write(data) { for (const value of decoder.push(Buffer.from(data))) if (value.kind === 'frame') received.push(value.payload as ServerFrame) }, end() {} })
  const send = (requestId: string, fields: object) => server.handleData(connection, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId,
    message: { type: 'workspace.handoff', requestId, operationId, forGeneration: generation, ...fields } }))
  try {
    writeWorkspaceJump({ version: 1, appSessionId: sessionId, engineSessionId, operationId, sourceGeneration: 'legacy-generation',
      source: { cwd: '/chat', binding: { kind: 'managed', storageId: randomUUID(), storageRootId: randomUUID() } }, target: { cwd: getCwd(), binding: { kind: 'project' } },
      phase: 'settled', location: 'destination', consumed: true, cancelled: false, acceptedAt: 1, outcome: 'completed',
      requiresUserReconciliation: false, sourceOutcomePersisted: false, continuation: { id: continuationId, state: 'admitted' } })
    send('wrong-generation', { action: 'status', forGeneration: randomUUID() })
    send('forged-path', { action: 'status', cwd: '/forged' })
    send('invalid-revision', { action: 'release', authorizationRevision: 0 })
    send('verify', { action: 'verify', tipUuid: randomUUID(), toolUseId: 'source-boundary' })
    await Bun.sleep(20)
    expect(controller.getWorkspaceHandoffSnapshot()).toBeNull()
    send('legacy', { action: 'continue', continuationId })
    await Bun.sleep(20)
    expect(runs).toBe(0)
    expect(received.find(frame => frame.kind === 'workspace.handoff.result' && frame.requestId === 'wrong-generation')).toMatchObject({ disposition: 'refused', reason: 'wrong_generation' })
    expect(received.filter(frame => frame.kind === 'workspace.handoff.result' && ['forged-path','invalid-revision'].includes(frame.requestId))).toEqual([])
    expect(received.find(frame => frame.kind === 'workspace.handoff.result' && frame.requestId === 'legacy')).toMatchObject({ disposition: 'refused', status: { record: { kind: 'absent' }, gate: { mode: 'held' } } })
    expect(controller.getHandoffReservation()).toBe(operationId)
  } finally {
    server.close()
    if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = oldConfig
    rmSync(root, { recursive: true, force: true })
  }
})

// Scripted proof is sufficient only for queue and transport behavior here.
// Real W/R publication is exercised by workspaceHandoff.integration.test.ts.
const scriptedCheckpoint = (): ResumeCheckpointV1 => ({ version: 1, prefixBytes: 1,
  prefixSha256: 'a'.repeat(64), activeTipUuid: randomUUID(), projectionSha256: 'b'.repeat(64), messageCount: 2 })
function freshState(sessionId: string, engineSessionId: string, operationId: string, generation: string): WorkspaceJumpStateV2 {
  return { version: 2, revision: 1, origin: 'fresh', appSessionId: sessionId, engineSessionId, operationId, sourceGeneration: randomUUID(),
    source: { cwd: '/chat', binding: { kind: 'managed', storageId: randomUUID(), storageRootId: randomUUID() } },
    target: { cwd: getCwd(), binding: { kind: 'project' } }, acceptedAt: 1, phase: 'settled', location: 'destination', consumed: true,
    continuation: { id: randomUUID(), admissionGeneration: generation, dispatch: 'consumed', outcome: 'pending', receiptRevision: null, checkpointSha256: null },
    cancellation: null, review: { required: false, noticeUuid: null, reconciledInputUuid: null }, release: { target: 'held', authorizedRevision: null, confirmed: null } }
}

test('repeated attachments share the state cap and retain the newest cumulative transport snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catcode-handoff-state-cap-'))
  const oldConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = root
  const sessionId = randomUUID(), engineSessionId = randomUUID(), operationId = randomUUID(), generation = randomUUID()
  const state = freshState(sessionId, engineSessionId, operationId, generation)
  const identity = { appSessionId: sessionId, engineSessionId, operationId, continuationId: state.continuation.id,
    sourceGeneration: state.sourceGeneration, admissionGeneration: generation, operationSha256: workspaceJumpOperationSha256(state) }
  // Scripted snapshots isolate transport throttling; this test publishes no W/R proof.
  let snapshot: WorkspaceHandoffSnapshot = { ...identity, observerGeneration: generation, statusSeq: 1,
    execution: 'idle', record: { kind: 'absent' }, gate: { mode: 'held', reservationOperationId: operationId, requiresUserReconciliation: false } }
  let sequence = 1
  const controller = new AppSessionController({ async *runTurn() {} })
  const snapshotSpy = spyOn(controller, 'getWorkspaceHandoffSnapshot').mockImplementation(() => ({ ...snapshot, statusSeq: ++sequence }))
  const allFrames: ServerFrame[] = []
  const server = new SidecarServer({ sessionId, engineSessionId, generation, controller, log: () => {} })
  const clockSpy = spyOn(Date, 'now').mockReturnValue(1_000_000)
  const realTimer = globalThis.setTimeout
  let flush: (() => void) | undefined
  const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay: number) => {
    const timer = realTimer(callback, delay)
    if (delay === 10_000) { clearTimeout(timer); flush = callback }
    return timer
  }) as typeof setTimeout)
  const attach = () => {
    const frames: ServerFrame[] = [], decoder = new FrameDecoder(MAX_FRAME_BYTES)
    const connection = server.addConnection({ write(data) {
      for (const item of decoder.push(Buffer.from(data))) if (item.kind === 'frame') {
        frames.push(item.payload as ServerFrame); allFrames.push(item.payload as ServerFrame)
      }
    }, end() {} })
    return { connection, frames }
  }
  try {
    writeWorkspaceJump(state)
    for (let i = 0; i < 32; i++) attach()
    snapshot = { ...snapshot, execution: 'running', record: { kind: 'valid', record: { ...identity,
      version: 1, origin: 'fresh', revision: 2, consumed: true, inputCommitted: true,
      cancellation: null, terminal: null, notice: null, reconciliation: null } } }
    const delayed = attach()
    expect(allFrames.filter(frame => frame.kind === 'workspace.handoff.state')).toHaveLength(32)
    expect(delayed.frames.filter(frame => frame.kind === 'workspace.handoff.state')).toHaveLength(0)
    expect(flush).toBeDefined()
    server.handleData(delayed.connection, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId,
      message: { type: 'workspace.handoff', requestId: 'status', operationId, forGeneration: generation, action: 'status' } }))
    expect(delayed.frames.find(frame => frame.kind === 'workspace.handoff.result')).toMatchObject({ disposition: 'accepted',
      status: { record: { kind: 'valid', record: { consumed: true, inputCommitted: true, revision: 2 } } } })
    clockSpy.mockReturnValue(1_010_000)
    flush!()
    expect(delayed.frames.find(frame => frame.kind === 'workspace.handoff.state')).toMatchObject({
      status: { execution: 'running', record: { kind: 'valid', record: { consumed: true, inputCommitted: true, revision: 2 } } } })
  } finally {
    server.close(); timerSpy.mockRestore(); clockSpy.mockRestore(); snapshotSpy.mockRestore()
    if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = oldConfig
    rmSync(root, { recursive: true, force: true })
  }
})

test('parking stays fenced while the warning persistence owner is pending', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catcode-warning-park-'))
  const oldConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = root
  const sessionId = randomUUID(), engineSessionId = randomUUID(), operationId = randomUUID(), generation = randomUUID()
  const { activateTranscriptLease, releaseActiveTranscriptLease } = await import('../../src/utils/transcriptLease.js')
  await activateTranscriptLease(engineSessionId)
  let unblock!: () => void, entered!: () => void, parked = false
  const saving = new Promise<void>(resolve => { entered = resolve })
  const controller = new AppSessionController({
    async *runTurn() {}, sealResumeCheckpoint: async () => scriptedCheckpoint(),
    async persistHandoffOutcome() {
      entered()
      await new Promise<void>(resolve => { unblock = resolve })
      return [{ type: 'system', uuid: randomUUID() }, { type: 'system', uuid: randomUUID() }] as never
    },
  })
  const frames: ServerFrame[] = [], decoder = new FrameDecoder(MAX_FRAME_BYTES)
  const server = new SidecarServer({ sessionId, engineSessionId, generation, controller, onPark: () => { parked = true }, log: () => {} })
  const connection = server.addConnection({ write(data) { for (const item of decoder.push(Buffer.from(data))) if (item.kind === 'frame') frames.push(item.payload as ServerFrame) }, end() {} })
  try {
    writeWorkspaceJump(freshState(sessionId, engineSessionId, operationId, generation))
    server.handleData(connection, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId,
      message: { type: 'workspace.handoff', requestId: 'settle', operationId, forGeneration: generation, action: 'settle', outcome: 'uncertain' } }))
    await saving
    server.handleData(connection, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId, message: { type: 'app.park', requestId: 'park' } }))
    expect(parked).toBe(false)
    expect(controller.getHandoffReservation()).toBe(operationId)
    unblock()
    for (let i = 0; i < 100 && !frames.some(frame => frame.kind === 'workspace.handoff.result' && frame.requestId === 'settle'); i++) await Bun.sleep(5)
    expect(frames.find(frame => frame.kind === 'workspace.handoff.result' && frame.requestId === 'settle')).toMatchObject({ disposition: 'accepted', status: { gate: { mode: 'review' } } })
  } finally {
    unblock?.(); server.close(); await releaseActiveTranscriptLease()
    if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = oldConfig
    rmSync(root, { recursive: true, force: true })
  }
})
test('park checks authoritative controller activity even for turns not started by the sidecar', async () => {
  let release!: () => void
  let started!: () => void
  const active = new Promise<void>(resolve => { started = resolve })
  const controller = new AppSessionController({ async *runTurn() { started(); await new Promise<void>(resolve => { release = resolve }) } })
  let parked = false
  const server = new SidecarServer({ sessionId: 'session', engineSessionId: 'engine-session', controller, onPark: () => { parked = true }, log: () => {} })
  const connection = server.addConnection({ write() {}, end() {} })
  const turn = controller.submit('goal-driven request', { isMeta: true })
  await active
  server.handleData(connection, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId: 'session', message: { type: 'app.park', requestId: 'park' } }))
  expect(parked).toBe(false)
  release(); await turn
  server.close()
})

test('a never-accepted jump settles only after source idle and cannot be parked before its durable note', async () => {
  const operationId = randomUUID()
  let started!: () => void, release!: () => void
  const active = new Promise<void>(resolve => { started = resolve })
  let terminalWrites = 0, parked = false
  const controller = new AppSessionController({
    async *runTurn() { started(); await new Promise<void>(resolve => { release = resolve }) },
    async persistHandoffOutcome() { terminalWrites++; return [] },
  })
  const server = new SidecarServer({ sessionId: 'no-accepted-ledger', engineSessionId: 'engine-session', controller, onPark: () => { parked = true }, log: () => {} })
  const connection = server.addConnection({ write() {}, end() {} })
  try {
    const turn = controller.submit('work on this project')
    await active
    controller.reserveHandoff(operationId)
    server.cancelUnacceptedWorkspaceHandoff(operationId)
    await Bun.sleep(0)
    expect(terminalWrites).toBe(0)
    server.handleData(connection, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId: 'no-accepted-ledger', message: { type: 'app.park', requestId: 'park' } }))
    expect(parked).toBe(false)
    release(); await turn
    await Bun.sleep(0)
    expect(terminalWrites).toBe(1)
    expect(controller.getHandoffReservation()).toBeNull()
    expect(controller.requiresHandoffReconciliation()).toBe(true)
    expect(controller.canStartAutomaticTurn()).toBe(false)
  } finally { server.close() }
})

for (const subtype of ['success', 'interrupted'] as const) test(`restored destination attachment and continuation preserve the jump until host settlement (${subtype})`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'catcode-continuation-result-'))
  const oldConfig = process.env.CLAUDE_CONFIG_DIR
  const trust = spyOn(engineConfig, 'isPathTrusted').mockReturnValue(true)
  process.env.CLAUDE_CONFIG_DIR = root
  const sessionId = randomUUID(), engineSessionId = randomUUID(), operationId = randomUUID(), generation = randomUUID()
  const { activateTranscriptLease, releaseActiveTranscriptLease } = await import('../../src/utils/transcriptLease.js')
  await activateTranscriptLease(engineSessionId)
  const result = { type: 'result', subtype, is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1,
    stop_reason: subtype === 'success' ? 'end_turn' : 'interrupted', session_id: engineSessionId, total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    modelUsage: {}, permission_denials: [], uuid: randomUUID(), ...(subtype === 'success' ? { result: 'Done.' } : {}),
  } satisfies SDKResultMessage
  expect(SDKResultSuccessSchema().safeParse(result).success).toBe(true)
  let started!: () => void, release!: () => void
  const active = new Promise<void>(resolve => { started = resolve })
  const prompts: unknown[] = []
  let workspaceTrusted = true
  const controller = new AppSessionController({ async *runTurn({ prompt, options }) {
    prompts.push(prompt)
    await options?.onHandoffInputCommitted?.(scriptedCheckpoint())
    await options?.onInputPersisted?.()
    if (prompts.length === 1) {
      started()
      await new Promise<void>(resolve => { release = resolve })
    }
    options?.onExecutionClosed?.(subtype === 'success' ? 'success' : 'interrupted')
    yield result
  }, sealResumeCheckpoint: async () => scriptedCheckpoint(), verifyResumeCheckpoint: async () => {},
    async persistHandoffOutcome() { return [{ type: 'system', uuid: randomUUID() }, { type: 'system', uuid: randomUUID() }] as never } })
  const received: ServerFrame[] = [], decoder = new FrameDecoder(MAX_FRAME_BYTES)
  const server = new SidecarServer({
    sessionId,
    engineSessionId,
    generation,
    controller,
    log: () => {},
    ...(subtype === 'interrupted'
      ? {
          workspaceTrust: {
            getSnapshot: () => ({ trusted: workspaceTrusted }),
            acceptTrust: () => ({ ok: true }),
          } as never,
        }
      : {}),
  })
  const attach = () => server.addConnection({ write(data) { for (const value of decoder.push(Buffer.from(data))) if (value.kind === 'frame') received.push(value.payload as ServerFrame) }, end() {} })
  try {
    writeWorkspaceJump(freshState(sessionId, engineSessionId, operationId, generation))
    controller.restoreHandoffReservation(operationId)
    // Replacement startup restores the reservation before the host attaches.
    const connection = attach()
    await Bun.sleep(0)
    expect(received.filter(frame => frame.kind === 'host.request')).toEqual([])
    server.handleData(connection, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId,
      message: { type: 'app.submit', requestId: 'before', prompt: 'before continuation', options: { submitId: 'before' } } }))
    expect(received.find(frame => frame.kind === 'submit.result' && frame.submitId === 'before')).toMatchObject({ accepted: false })
    server.handleData(connection, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId,
      message: { type: 'workspace.handoff', requestId: 'continue', operationId, forGeneration: generation, action: 'continue', continuationId: (readWorkspaceJump(sessionId)! as WorkspaceJumpStateV2).continuation.id } }))
    await active
    if (subtype === 'success') {
      const admitted = readWorkspaceJump(sessionId)! as WorkspaceJumpStateV2
      writeWorkspaceJump({ ...admitted, cancellation: { cancelId: randomUUID(), requestedBy: 'stop', application: 'unknown' }, review: { ...admitted.review, required: true } })
      server.handleData(connection, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId,
        message: { type: 'app.submit', requestId: 'cancelled', prompt: 'after cancellation', options: { submitId: 'cancelled' } } }))
      expect(received.find(frame => frame.kind === 'submit.result' && frame.submitId === 'cancelled')).toMatchObject({ accepted: false })
      expect(getCommandQueueSnapshot()).toHaveLength(0)
      writeWorkspaceJump(admitted)
      server.handleData(connection, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId,
        message: { type: 'app.submit', requestId: 'during', prompt: 'also check the logs', options: { submitId: 'during' } } }))
      expect(received.find(frame => frame.kind === 'submit.result' && frame.submitId === 'during')).toMatchObject({ accepted: true })
      expect(getCommandQueueSnapshot()).toMatchObject([{ value: 'also check the logs', priority: 'next' }])
      const queuedPrompt = received
        .filter((frame): frame is Extract<ServerFrame, { kind: 'queued-prompts.snapshot' }> =>
          frame.kind === 'queued-prompts.snapshot',
        )
        .at(-1)?.prompts[0]
      expect(queuedPrompt?.id).toBeString()
      server.handleData(connection, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId,
        message: { type: 'prompt.force', requestId: 'force-during-continuation', promptId: queuedPrompt!.id } }))
      expect(received.find(frame => frame.kind === 'prompt-force.result')).toMatchObject({
        requestId: 'force-during-continuation',
        ok: true,
        message: 'The message will send after the workspace change finishes.',
      })
      expect(controller.getAbortState().status).toBe('idle')
      server.handleData(connection, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId,
        message: { type: 'app.submit', requestId: 'meta', prompt: 'automatic work', options: { submitId: 'meta', isMeta: true } } }))
      expect(received.find(frame => frame.kind === 'submit.result' && frame.submitId === 'meta')).toMatchObject({ accepted: false })
    } else {
      server.handleData(connection, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId,
        message: { type: 'app.submit', requestId: 'during-failed', prompt: 'withdraw this request', options: { submitId: 'during-failed' } } }))
      expect(received.find(frame => frame.kind === 'submit.result' && frame.submitId === 'during-failed')).toMatchObject({ accepted: true })
      const recalledPrompt = received
        .filter((frame): frame is Extract<ServerFrame, { kind: 'queued-prompts.snapshot' }> =>
          frame.kind === 'queued-prompts.snapshot',
        )
        .at(-1)?.prompts[0]
      server.handleData(connection, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId,
        message: { type: 'prompt.force', requestId: 'force-recalled-prompt', promptId: recalledPrompt!.id } }))
      expect(received.find(frame => frame.kind === 'prompt-force.result')).toMatchObject({
        requestId: 'force-recalled-prompt',
        ok: true,
        message: 'The message will send after the workspace change finishes.',
      })
      server.handleData(connection, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId,
        message: { type: 'prompt.recall', requestId: 'recall-forced-prompt' } }))
      expect(received.find(frame => frame.kind === 'prompt-recall.result' && frame.requestId === 'recall-forced-prompt')).toMatchObject({
        ok: true,
        recalled: [{ id: recalledPrompt!.id }],
      })
      server.handleData(connection, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId,
        message: { type: 'app.submit', requestId: 'during-failed', prompt: 'keep this request', options: { submitId: 'during-failed' } } }))
      expect(received.filter(frame => frame.kind === 'submit.result' && frame.submitId === 'during-failed')).toMatchObject([
        { accepted: true },
        { accepted: true },
      ])
      const queuedPrompt = received
        .filter((frame): frame is Extract<ServerFrame, { kind: 'queued-prompts.snapshot' }> =>
          frame.kind === 'queued-prompts.snapshot',
        )
        .at(-1)?.prompts[0]
      expect(queuedPrompt?.text).toBe('keep this request')
      server.handleData(connection, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId,
        message: { type: 'prompt.force', requestId: 'force-kept-prompt', promptId: queuedPrompt!.id } }))
      expect(received.find(frame => frame.kind === 'prompt-force.result' && frame.requestId === 'force-kept-prompt')).toMatchObject({
        ok: true,
        message: 'The message will send after the workspace change finishes.',
      })
    }
    release()
    for (let attempt = 0; attempt < 100 && controller.getWorkspaceHandoffSnapshot()?.execution !== 'terminal'; attempt++) await Bun.sleep(5)
    await Bun.sleep(0)
    expect(received.find(frame => frame.kind === 'workspace.handoff.result')).toMatchObject({ operationId, disposition: 'accepted' })
    expect(received.some(frame => frame.kind === 'event' && frame.event.type === 'message' && frame.event.message.type === 'result' && frame.event.message.subtype === subtype)).toBe(true)
    expect(controller.getHandoffReservation()).toBe(operationId)
    expect(controller.canStartAutomaticTurn()).toBe(false)
    expect(prompts).toHaveLength(1)
    if (subtype === 'interrupted') {
      expect(getCommandQueueSnapshot()).toMatchObject([
        { value: 'keep this request', priority: 'next' },
      ])
      const state = readWorkspaceJump(sessionId)! as WorkspaceJumpStateV2
      writeWorkspaceJump({
        ...state,
        phase: 'settled',
        review: { ...state.review, required: true },
        continuation: { ...state.continuation, outcome: 'interrupted' },
      })
      workspaceTrusted = false
      server.handleData(connection, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId,
        message: { type: 'workspace.handoff', requestId: 'reconcile', operationId, forGeneration: generation, action: 'settle', outcome: 'uncertain' } }))
      for (let i = 0; i < 50 && !received.some(frame => frame.kind === 'workspace.handoff.result' && frame.requestId === 'reconcile'); i += 1) {
        await Bun.sleep(5)
      }
      expect(received.find(frame => frame.kind === 'workspace.handoff.result' && frame.requestId === 'reconcile')).toMatchObject({ disposition: 'accepted' })
      expect(controller.getHandoffReservation()).toBeNull()
      expect(controller.requiresHandoffReconciliation()).toBe(true)
      expect(controller.isTurnActive()).toBe(false)
      expect(prompts).toHaveLength(1)
      expect(getCommandQueueSnapshot()).toMatchObject([
        { value: 'keep this request', priority: 'next' },
      ])
      const queuedPromptId = getCommandQueueSnapshot()[0]!.uuid!
      server.handleData(connection, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId,
        message: { type: 'prompt.force', requestId: 'force-while-untrusted', promptId: queuedPromptId } }))
      expect(received.find(frame => frame.kind === 'prompt-force.result' && frame.requestId === 'force-while-untrusted')).toMatchObject({
        ok: false,
        message: 'The message is still waiting to be sent.',
      })
      workspaceTrusted = true
      server.handleData(connection, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId,
        message: { type: 'prompt.force', requestId: 'force-after-trust', promptId: queuedPromptId } }))
      expect(received.find(frame => frame.kind === 'prompt-force.result' && frame.requestId === 'force-after-trust')).toMatchObject({
        ok: true,
        message: 'Sending the queued message now.',
      })
      for (let i = 0; i < 100 && (prompts.length < 2 || controller.requiresHandoffReconciliation()); i += 1) await Bun.sleep(5)
      expect(prompts).toHaveLength(2)
      expect(prompts[1]).toBe('keep this request')
      expect(getCommandQueueSnapshot()).toHaveLength(0)
      expect(controller.requiresHandoffReconciliation()).toBe(false)
      expect(received.some(frame => frame.kind === 'workspace.handoff.state' && frame.operationId === operationId && frame.status.record.kind === 'valid' && !!frame.status.record.record.reconciliation)).toBe(true)
    }
    server.handleData(connection, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId,
      message: { type: 'app.submit', requestId: 'after', prompt: 'before settlement', options: { submitId: 'after' } } }))
    expect(received.find(frame => frame.kind === 'submit.result' && frame.submitId === 'after')).toMatchObject({
      accepted: subtype === 'interrupted',
    })
    attach()
    await Bun.sleep(0)
    expect(received.filter(frame => frame.kind === 'host.request')).toEqual([])
    if (subtype === 'success') {
      const state = readWorkspaceJump(sessionId)! as WorkspaceJumpStateV2
      writeWorkspaceJump({ ...state, release: { target: 'open', authorizedRevision: 2, confirmed: null } })
      server.handleData(connection, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId,
        message: { type: 'workspace.handoff', requestId: 'release', operationId, forGeneration: generation, action: 'release', authorizationRevision: 2 } }))
      await Bun.sleep(0)
      expect(received.find(frame => frame.kind === 'workspace.handoff.result' && frame.requestId === 'release')).toMatchObject({ disposition: 'accepted' })
      expect(controller.getHandoffReservation()).toBeNull()
      expect(controller.canStartAutomaticTurn()).toBe(true)
      expect(prompts).toHaveLength(2)
      expect(prompts[1]).toBe('also check the logs')
      expect(getCommandQueueSnapshot()).toHaveLength(0)
    }
  } finally {
    release?.(); server.close(); resetCommandQueue(); trust.mockRestore()
    await releaseActiveTranscriptLease()
    if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = oldConfig
    rmSync(root, { recursive: true, force: true })
  }
})

test('a locally reserved source turn without a durable handoff still requests cancellation', async () => {
  const persistence = spyOn(sessionStorage, 'canPersistHandoffTranscript').mockReturnValue(true)
  const operationId = randomUUID()
  let started!: () => void, release!: () => void
  const active = new Promise<void>(resolve => { started = resolve })
  const controller = new AppSessionController({ async *runTurn() { started(); await new Promise<void>(resolve => { release = resolve }) } })
  const received: ServerFrame[] = [], decoder = new FrameDecoder(MAX_FRAME_BYTES)
  const server = new SidecarServer({ sessionId: 'source-without-boundary', engineSessionId: 'engine-session', controller, log: () => {} })
  server.addConnection({ write(data) { for (const value of decoder.push(Buffer.from(data))) if (value.kind === 'frame') received.push(value.payload as ServerFrame) }, end() {} })
  try {
    const turn = controller.submit('work on this project')
    await active
    expect(server.reserveWorkspaceHandoff(operationId)).toBe(true)
    expect(received.filter(frame => frame.kind === 'host.request')).toEqual([])
    release(); await turn
    await Bun.sleep(0)
    expect(received.filter(frame => frame.kind === 'host.request')).toMatchObject([
      { verb: 'workspace.cancel', args: { operationId } },
    ])
    expect(controller.getHandoffReservation()).toBe(operationId)
    expect(controller.canStartAutomaticTurn()).toBe(false)
  } finally { server.close(); persistence.mockRestore() }
})
