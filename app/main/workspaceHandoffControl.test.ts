import { afterEach, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { WorkspaceHandoffControl } from './workspaceHandoffControl.js'
import type { WorkspaceHandoffSnapshot } from '../shared/workspaceHandoff.js'

const controls: WorkspaceHandoffControl[] = []
afterEach(() => { for (const control of controls.splice(0)) control.dispose() })
function harness() {
  const id = randomUUID(), operationId = randomUUID(), generation = randomUUID(), engineSessionId = randomUUID()
  const sent: Parameters<ConstructorParameters<typeof WorkspaceHandoffControl>[0]['send']>[1][] = []
  const observations: WorkspaceHandoffSnapshot[] = [], recoveries: string[] = []
  const control = new WorkspaceHandoffControl({ generation: () => generation, acceptsStatus: (sessionId, status) => sessionId === id && status.engineSessionId === engineSessionId, send: (_id, message) => { sent.push(message); return true }, observe: (_id, status) => observations.push(status), recover: (_id, operation) => recoveries.push(operation) })
  controls.push(control)
  const status: WorkspaceHandoffSnapshot = { appSessionId: id, engineSessionId, operationId, continuationId: randomUUID(), sourceGeneration: randomUUID(), admissionGeneration: generation, operationSha256: 'a'.repeat(64), observerGeneration: generation, statusSeq: 1, execution: 'running', record: { kind: 'absent' }, gate: { mode: 'held', reservationOperationId: operationId, requiresUserReconciliation: false } }
  return { control, id, operationId, generation, sent, observations, recoveries, status }
}

test('continuation acknowledgement expires in 20 seconds; authenticated late evidence survives request expiry', async () => {
  const callbacks: (() => void)[] = [], delays: number[] = []
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay: number) => { callbacks.push(callback); delays.push(delay); return 0 as unknown as ReturnType<typeof setTimeout> }) as typeof setTimeout)
  try {
    const h = harness()
    const delivery = h.control.request(h.id, h.operationId, { action: 'continue', continuationId: h.status.continuationId })
    expect(delays).toEqual([20_000])
    callbacks[0]!()
    expect(await delivery).toEqual({ kind: 'timeout' })
    expect(h.recoveries).toEqual([h.operationId])
    h.control.receiveFrame(h.id, { kind: 'workspace.handoff.result', protocolVersion: 4, sessionId: h.id, requestId: h.sent[0]!.requestId, operationId: h.operationId, action: 'continue', disposition: 'accepted', status: h.status })
    expect(h.observations).toEqual([h.status])
  } finally { timer.mockRestore() }
})

test('one outstanding command preserves cancellation priority; disconnect is delivery uncertainty', async () => {
  const h = harness()
  const pending = h.control.request(h.id, h.operationId, { action: 'continue', continuationId: h.status.continuationId })
  expect(await h.control.request(h.id, h.operationId, { action: 'status' })).toEqual({ kind: 'unavailable' })
  const cancellation = h.control.request(h.id, h.operationId, { action: 'cancel', cancelId: randomUUID() })
  expect(h.sent.map(message => message.action)).toEqual(['continue', 'cancel'])
  expect(h.sent.every(message => message.forGeneration === h.generation)).toBe(true)
  h.control.disconnect(h.id)
  expect(await pending).toEqual({ kind: 'disconnected' })
  expect(await cancellation).toEqual({ kind: 'disconnected' })
})

test('slot wait does not send or block cancellation and wakes after command acknowledgement', async () => {
  const h = harness()
  const pending = h.control.request(h.id, h.operationId, { action: 'status' })
  let available = false
  const waiting = h.control.waitForSlot(h.id, h.operationId, h.generation).then(value => { available = value })
  const cancellation = h.control.request(h.id, h.operationId, { action: 'cancel', cancelId: randomUUID() })
  await Promise.resolve()
  expect(available).toBe(false)
  expect(h.sent.map(message => message.action)).toEqual(['status', 'cancel'])
  h.control.receive(h.id, { requestId: h.sent[0]!.requestId, operationId: h.operationId,
    action: 'status', disposition: 'accepted' })
  await Promise.all([pending, waiting])
  expect(available).toBe(true)
  h.control.disconnect(h.id)
  await cancellation
})

test('strict receiving rejects extra keys, wrong generation and refusal without a reason before observation or correlation', async () => {
  const h = harness()
  const pending = h.control.request(h.id, h.operationId, { action: 'status' })
  const result = { kind: 'workspace.handoff.result', protocolVersion: 4, sessionId: h.id, requestId: h.sent[0]!.requestId, operationId: h.operationId, action: 'status', disposition: 'accepted', status: h.status }
  h.control.receiveFrame(h.id, { ...result, extra: true })
  h.control.receiveFrame(h.id, { ...result, status: { ...h.status, observerGeneration: randomUUID() } })
  h.control.receiveFrame(h.id, { ...result, disposition: 'refused' })
  expect(h.observations).toEqual([])
  h.control.receiveFrame(h.id, result)
  expect((await pending).kind).toBe('result')
  expect(h.observations).toEqual([h.status])
})

test('rate-window exhaustion retains latest idle evidence after the occupied slot frees', async () => {
  const callbacks: (() => void)[] = []
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
    callbacks.push(callback); return 0 as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout)
  try {
    const h = harness()
    const pending = h.control.request(h.id, h.operationId, { action: 'status' })
    for (let index = 1; index <= 32; index++) h.control.receiveState(h.id, { ...h.status, statusSeq: index })
    const idle = { ...h.status, statusSeq: 33, execution: 'idle' as const }
    h.control.receiveState(h.id, idle)
    expect(h.observations).toHaveLength(32)
    h.control.receive(h.id, { requestId: h.sent[0]!.requestId, operationId: h.operationId,
      action: 'status', disposition: 'accepted' })
    expect((await pending).kind).toBe('result')
    callbacks[1]!()
    expect(h.observations.at(-1)).toEqual(idle)
    expect(h.recoveries).toEqual([h.operationId])
    const cancellation = h.control.request(h.id, h.operationId, { action: 'cancel', cancelId: randomUUID() })
    const continuation = h.control.request(h.id, h.operationId, { action: 'continue', continuationId: idle.continuationId })
    expect(h.sent.map(message => message.action)).toEqual(['status', 'cancel', 'continue'])
    h.control.disconnect(h.id)
    await Promise.all([cancellation, continuation])
  } finally { timer.mockRestore() }
})

test('rate-limited null admission cannot hide current admission evidence whose sequence restarted', async () => {
  const callbacks: (() => void)[] = []
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
    callbacks.push(callback); return 0 as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout)
  try {
    const h = harness()
    const authorization = h.control.request(h.id, h.operationId, { action: 'status' })
    h.control.disconnect(h.id); await authorization
    for (let sequence = 1; sequence <= 33; sequence++) {
      h.control.receiveState(h.id, { ...h.status, admissionGeneration: null, statusSeq: sequence })
    }
    const admitted = { ...h.status, statusSeq: 1, execution: 'idle' as const }
    h.control.receiveState(h.id, admitted)
    h.control.receiveState(h.id, { ...h.status, admissionGeneration: null, statusSeq: 100 })
    callbacks[1]!()
    expect(h.observations.at(-1)).toEqual(admitted)
    expect(h.recoveries).toEqual([h.operationId])
  } finally { timer.mockRestore() }
})

test('stale operation and foreign membership cannot replace the current operation snapshot at rate overflow', async () => {
  const callbacks: (() => void)[] = []
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => { callbacks.push(callback); return 0 as unknown as ReturnType<typeof setTimeout> }) as typeof setTimeout)
  try {
    const h = harness()
    const authorization = h.control.request(h.id, h.operationId, { action: 'status' })
    h.control.disconnect(h.id); await authorization
    for (let index = 1; index <= 32; index++) h.control.receiveState(h.id, { ...h.status, statusSeq: index })
    const current = { ...h.status, statusSeq: 33 }
    h.control.receiveState(h.id, current)
    const foreignOperation = randomUUID()
    h.control.receiveState(h.id, { ...h.status, operationId: foreignOperation, statusSeq: 100, gate: { ...h.status.gate, reservationOperationId: foreignOperation } })
    h.control.receiveState(h.id, { ...h.status, engineSessionId: randomUUID(), statusSeq: 101 })
    h.control.receiveState(h.id, { ...h.status, appSessionId: randomUUID(), statusSeq: 102 })
    callbacks[1]!()
    expect(h.observations.at(-1)).toEqual(current)
    expect(h.observations).toHaveLength(33)
    expect(h.recoveries).toEqual([h.operationId])
  } finally { timer.mockRestore() }
})
