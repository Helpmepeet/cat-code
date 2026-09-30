import { expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppSessionController } from '../../src/app-runtime/AppSessionController.js'
import { writeWorkspaceJump } from '../../src/utils/workspaceJumpState.js'
import { FrameDecoder, encodeFrame } from '../shared/framing.js'
import { PROTOCOL_VERSION, type ServerFrame } from '../shared/protocol.js'
import { MAX_FRAME_BYTES } from '../shared/limits.js'
import { SidecarServer } from './sidecarServer.js'
import { getCwd } from '../../src/utils/cwd.js'
import * as engineConfig from '../../src/utils/config.js'
import type { SDKResultMessage } from '../../src/entrypoints/agentSdkTypes.js'
import { SDKResultSuccessSchema } from '../../src/entrypoints/sdk/coreSchemas.js'

test('closed handoff control settles the reserved engine, then only genuine admission reconciles it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catcode-handoff-boundary-'))
  const oldConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = root
  const sessionId = randomUUID(), engineSessionId = randomUUID(), operationId = randomUUID()
  let terminalWrites = 0
  const prompts: unknown[] = []
  const controller = new AppSessionController({
    async *runTurn({ prompt, options }) { prompts.push(prompt); options?.onInputPersisted?.() },
    async persistHandoffOutcome() { terminalWrites++; return [] },
  })
  const received: ServerFrame[] = []
  const decoder = new FrameDecoder(MAX_FRAME_BYTES)
  const server = new SidecarServer({ sessionId, engineSessionId, controller, log: () => {} })
  const connection = server.addConnection({ write(data) { for (const value of decoder.push(Buffer.from(data))) if (value.kind === 'frame') received.push(value.payload as ServerFrame) }, end() {} })
  const send = (message: unknown) => server.handleData(connection, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId, message }))
  try {
    writeWorkspaceJump({ version: 1, appSessionId: sessionId, engineSessionId, operationId, sourceGeneration: 'generation',
      source: { cwd: '/chat', binding: { kind: 'managed', storageId: randomUUID(), storageRootId: randomUUID() } }, target: { cwd: '/project', binding: { kind: 'project' } },
      phase: 'settled', location: 'source', consumed: false, cancelled: false, acceptedAt: 1, outcome: 'failed',
      requiresUserReconciliation: true, sourceOutcomePersisted: false, continuation: { id: randomUUID(), state: 'not_admitted' } })
    controller.restoreHandoffReservation(operationId)
    send({ type: 'app.submit', requestId: 'too-early', prompt: 'new request' })
    expect(prompts).toEqual([])
    send({ type: 'workspace.handoff', requestId: 'malformed', operationId, action: 'settle_failed', cwd: '/forged' })
    await Bun.sleep(0)
    expect(terminalWrites).toBe(0)
    send({ type: 'workspace.handoff', requestId: 'valid', operationId, action: 'settle_failed' })
    await Bun.sleep(0)
    expect(terminalWrites).toBe(1)
    expect(received.filter(frame => frame.kind === 'workspace.handoff.result')).toEqual([
      { kind: 'workspace.handoff.result', protocolVersion: PROTOCOL_VERSION, sessionId, requestId: 'valid', operationId, ok: true },
    ])
    expect(controller.getHandoffReservation()).toBeNull()
    expect(controller.canStartAutomaticTurn()).toBe(false)
    send({ type: 'app.submit', requestId: 'automatic', prompt: 'automatic work', options: { isMeta: true } })
    expect(prompts).toEqual([])
    send({ type: 'app.submit', requestId: 'genuine', prompt: 'inspect where we are' })
    await Bun.sleep(0)
    expect(prompts).toEqual(['inspect where we are'])
    expect(controller.requiresHandoffReconciliation()).toBe(false)
    expect(received.some(frame => frame.kind === 'workspace.user-admitted' && frame.operationId === operationId)).toBe(true)
  } finally {
    server.close()
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

for (const subtype of ['success', 'interrupted'] as const) test(`destination continuation acknowledges only actual success (${subtype})`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'catcode-continuation-result-'))
  const oldConfig = process.env.CLAUDE_CONFIG_DIR
  const trust = spyOn(engineConfig, 'isPathTrusted').mockReturnValue(true)
  process.env.CLAUDE_CONFIG_DIR = root
  const sessionId = randomUUID(), engineSessionId = randomUUID(), operationId = randomUUID()
  const result = { type: 'result', subtype, is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1,
    stop_reason: subtype === 'success' ? 'end_turn' : 'interrupted', session_id: engineSessionId, total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    modelUsage: {}, permission_denials: [], uuid: randomUUID(), ...(subtype === 'success' ? { result: 'Done.' } : {}),
  } satisfies SDKResultMessage
  expect(SDKResultSuccessSchema().safeParse(result).success).toBe(true)
  const controller = new AppSessionController({ async *runTurn() { yield result } })
  const received: ServerFrame[] = [], decoder = new FrameDecoder(MAX_FRAME_BYTES)
  const server = new SidecarServer({ sessionId, engineSessionId, controller, log: () => {} })
  const connection = server.addConnection({ write(data) { for (const value of decoder.push(Buffer.from(data))) if (value.kind === 'frame') received.push(value.payload as ServerFrame) }, end() {} })
  try {
    writeWorkspaceJump({ version: 1, appSessionId: sessionId, engineSessionId, operationId, sourceGeneration: 'source',
      source: { cwd: '/chat', binding: { kind: 'managed', storageId: randomUUID(), storageRootId: randomUUID() } },
      target: { cwd: getCwd(), binding: { kind: 'project' } }, acceptedAt: 1, phase: 'settled', location: 'destination',
      consumed: true, cancelled: false, outcome: 'completed', sourceOutcomePersisted: false, requiresUserReconciliation: false,
      continuation: { id: randomUUID(), state: 'admitted' } })
    controller.restoreHandoffReservation(operationId)
    server.handleData(connection, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId,
      message: { type: 'workspace.handoff', requestId: 'continue', operationId, action: 'continue' } }))
    await Bun.sleep(0)
    expect(received.find(frame => frame.kind === 'workspace.handoff.result')).toMatchObject({ operationId, ok: subtype === 'success' })
    expect(received.some(frame => frame.kind === 'event' && frame.event.type === 'message' && frame.event.message.type === 'result' && frame.event.message.subtype === subtype)).toBe(true)
    expect(controller.getHandoffReservation()).toBe(operationId)
    expect(controller.canStartAutomaticTurn()).toBe(false)
  } finally {
    server.close(); trust.mockRestore()
    if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = oldConfig
    rmSync(root, { recursive: true, force: true })
  }
})
