import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorkspaceJumpCoordinator, type WorkspaceJumpCoordinatorDeps } from './workspaceJumpCoordinator.js'
import { WorkspaceHandoffControl } from './workspaceHandoffControl.js'
import type { WorkspaceHandoffSnapshot, WorkspaceHandoffExecutionRecord } from '../shared/workspaceHandoff.js'
import type { PeerRegistryRow } from './peerRequestPlane.js'
import { readWorkspaceJump, writeWorkspaceJump, workspaceJumpOperationSha256, upgradeWorkspaceJumpState, workspaceJumpAllowsQueuedInput } from '../../src/utils/workspaceJumpState.js'
import { writeSessionRelocation } from '../../src/utils/sessionRelocationState.js'

const paths: string[] = []
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true })
})
function harness() {
  const base = mkdtempSync(join(tmpdir(), 'workspace-jump-'))
  paths.push(base)
  process.env.CLAUDE_CONFIG_DIR = base
  const directory = join(base, 'workspace-jumps')
  const appSessionId = randomUUID()
  const engineSessionId = randomUUID()
  const row: PeerRegistryRow = { appSessionId, engineSessionId, cwd: '/managed/chat',
    binding: { kind: 'managed', storageRootId: randomUUID(), storageId: randomUUID() },
    lastAttachedAt: 1, lastMessageSentAt: 1, shutdown: null }
  let generation = randomUUID()
  let trusted = true
  let idle = true
  let moved = 0
  let continuationCalls = 0
  let terminalCalls = 0
  let terminalDurable = true
  let continuationFails = false
  let finalLocation: 'source' | 'destination' | 'unknown' = 'destination'
  let holdMove: (() => Promise<void>) | undefined
  const held = new Map<string, string>()
  const deps: WorkspaceJumpCoordinatorDeps = {
    directory, row: id => id === appSessionId ? row : undefined,
    knownProjects: () => [{ path: '/projects/cat-code', lastUsedAt: 1 }],
    validateCwd: path => ({ ok: true, realpath: path }),
    trustedProjectRoots: async roots => trusted ? roots : [],
    verifyReady: () => idle,
    control: async (_state, action) => {
      if (action.action === 'continue') { continuationCalls++; if (continuationFails) return { kind: 'timeout' } }
      if (action.action === 'settle') terminalCalls++
      return { kind: 'result', result: { requestId: randomUUID(), operationId, action: action.action, disposition: 'accepted' } }
    },
    host: {
      getSessionGeneration: () => generation,
      reserveWorkspaceJump: async (id, operationId) => { held.set(id, operationId); return { ok: true, value: undefined } },
      releaseWorkspaceJump: (id, operationId) => { if (held.get(id) === operationId) held.delete(id) },
      moveWorkspaceJump: async (_id, _operationId, _cwd, beforeMutation) => {
        if (holdMove) await holdMove()
        if (!beforeMutation()) return { result: { ok: false, error: { code: 'session_unreachable', message: 'cancelled' } }, location: 'source', relocation: null }
        moved++
        return { result: finalLocation === 'destination' ? { ok: true, value: {} as never } : { ok: false, error: { code: 'session_unreachable', message: 'lost result' } },
          location: finalLocation, relocation: null }
      },
    },
  }
  const coordinator = new WorkspaceJumpCoordinator(deps)
  const operationId = randomUUID()
  const ready = { verb: 'workspace.ready' as const, operationId, tipUuid: randomUUID(), toolUseId: 'call_move' }
  async function accept() {
    const list = await coordinator.handleRequest(appSessionId, { verb: 'workspaces.list' })
    if (!list.ok || !('workspaces' in list.value)) throw new Error('listing failed')
    const handle = list.value.workspaces[0]!.handle
    return coordinator.handleRequest(appSessionId, { verb: 'workspace.jump', operationId, destinationHandle: handle })
  }
  return { coordinator, deps, row, appSessionId, directory, operationId, ready, held, accept, generation: () => generation,
    moved: () => moved, continuations: () => continuationCalls, terminals: () => terminalCalls,
    setGeneration: () => { generation = randomUUID() }, setTrusted: (v: boolean) => { trusted = v },
    setIdle: (v: boolean) => { idle = v }, setTerminalDurable: (v: boolean) => { terminalDurable = v },
    failContinuation: () => { continuationFails = true }, setFinalLocation: (v: typeof finalLocation) => { finalLocation = v },
    holdMove: (v: () => Promise<void>) => { holdMove = v },
  }
}

test('acceptance cannot move; durable readiness, response delivery, and one-use survive reopening', async () => {
  const h = harness()
  expect((await h.accept()).ok).toBe(true)
  expect(h.moved()).toBe(0)
  h.setIdle(false)
  expect((await h.coordinator.handleRequest(h.appSessionId, h.ready)).ok).toBe(false)
  h.setIdle(true)
  expect((await h.coordinator.handleRequest(h.appSessionId, h.ready)).ok).toBe(true)
  expect(h.moved()).toBe(0)
  h.coordinator.afterResponse(h.appSessionId, h.ready, true)
  await h.coordinator.waitForSettlement(h.appSessionId)
  expect(h.moved()).toBe(1)
  expect(h.continuations()).toBe(1)
  expect(h.held.size).toBe(1)
  expect(h.coordinator.snapshot(h.appSessionId)?.continuation.dispatch).toBe('unknown')
  const reopened = new WorkspaceJumpCoordinator(h.deps)
  const list = await reopened.handleRequest(h.appSessionId, { verb: 'workspaces.list' })
  expect(list).toEqual({ ok: true, value: { eligible: false, workspaces: [] } })
  expect(readWorkspaceJump(h.appSessionId, h.directory)?.consumed).toBe(true)
})

test('stale process readiness and revoked trust do not start a move', async () => {
  const h = harness()
  await h.accept()
  h.setTrusted(false)
  expect((await h.coordinator.handleRequest(h.appSessionId, h.ready)).ok).toBe(false)
  h.setTrusted(true)
  h.setGeneration()
  expect((await h.coordinator.handleRequest(h.appSessionId, h.ready)).ok).toBe(false)
  expect(h.moved()).toBe(0)
})

test('recent listing deduplicates canonical workspaces before the bound and saved-trust filter', async () => {
  const h = harness()
  h.deps.knownProjects = () => [
    ...Array.from({ length: 150 }, (_, i) => ({ path: `/aliases/cat-${i}`, lastUsedAt: i })),
    { path: '/projects/recent', lastUsedAt: 500 },
    { path: '/projects/untrusted', lastUsedAt: 600 },
    ...Array.from({ length: 130 }, (_, i) => ({ path: `/projects/old-${String(i).padStart(3, '0')}`, lastUsedAt: 1 })),
  ]
  h.deps.validateCwd = path => ({ ok: true, realpath: path.startsWith('/aliases/') ? '/projects/cat-code' : path })
  h.deps.trustedProjectRoots = async roots => roots.filter(path => path !== '/projects/untrusted')
  const result = await h.coordinator.handleRequest(h.appSessionId, { verb: 'workspaces.list' })
  if (!result.ok || !('workspaces' in result.value)) throw new Error('listing failed')
  expect(result.value.workspaces.map(row => row.path)).toEqual([
    '/projects/recent', '/projects/cat-code',
    ...Array.from({ length: 125 }, (_, i) => `/projects/old-${String(i).padStart(3, '0')}`),
  ])
})

test('initial handles survive later listings, while expired roots and process generations retire authority', async () => {
  const h = harness()
  async function list() {
    const result = await h.coordinator.handleRequest(h.appSessionId, { verb: 'workspaces.list' })
    if (!result.ok || !('workspaces' in result.value)) throw new Error('listing failed')
    return result.value.workspaces
  }
  const initial = (await list())[0]!
  h.deps.knownProjects = () => [{ path: '/projects/newer', lastUsedAt: 10 }, { path: initial.path, lastUsedAt: 1 }]
  expect((await list()).find(row => row.path === initial.path)?.handle).toBe(initial.handle)
  h.deps.knownProjects = () => [{ path: '/projects/newer', lastUsedAt: 10 }]
  await list()
  h.deps.knownProjects = () => [{ path: initial.path, lastUsedAt: 20 }]
  expect((await list())[0]?.handle).not.toBe(initial.handle)
  expect((await h.coordinator.handleRequest(h.appSessionId, { verb: 'workspace.jump', operationId: randomUUID(), destinationHandle: initial.handle })).ok).toBe(false)
  const current = (await list())[0]!
  h.setGeneration()
  expect((await list())[0]?.handle).not.toBe(current.handle)
  expect((await h.coordinator.handleRequest(h.appSessionId, { verb: 'workspace.jump', operationId: randomUUID(), destinationHandle: current.handle })).ok).toBe(false)
  expect(h.held.size).toBe(0)
})

test.each(['trust', 'canonical identity', 'caller', 'process generation'] as const)('listed handle rechecks %s before acceptance', async reason => {
  const h = harness()
  const listed = await h.coordinator.handleRequest(h.appSessionId, { verb: 'workspaces.list' })
  if (!listed.ok || !('workspaces' in listed.value)) throw new Error('listing failed')
  let requester = h.appSessionId
  if (reason === 'trust') h.setTrusted(false)
  if (reason === 'canonical identity') h.deps.validateCwd = path => ({ ok: true, realpath: path + '-replaced' })
  if (reason === 'process generation') h.setGeneration()
  if (reason === 'caller') {
    requester = randomUUID()
    h.deps.row = id => id === requester ? { ...h.row, appSessionId: requester, engineSessionId: randomUUID() } : h.row
  }
  expect((await h.coordinator.handleRequest(requester, { verb: 'workspace.jump', operationId: randomUUID(), destinationHandle: listed.value.workspaces[0]!.handle })).ok).toBe(false)
  expect(h.held.size).toBe(0)
  expect(h.coordinator.snapshot(h.appSessionId)).toBeNull()
})

test('published acceptance keeps its host reservation when state notification fails', async () => {
  const h = harness()
  h.deps.onStateChanged = () => { throw new Error('notification failed after publication') }
  expect((await h.accept()).ok).toBe(false)
  expect(h.coordinator.snapshot(h.appSessionId)?.phase).toBe('accepted')
  expect(h.held.get(h.appSessionId)).toBe(h.operationId)
  h.deps.onStateChanged = undefined
  expect(await h.coordinator.handleRequest(h.appSessionId, { verb: 'workspace.cancel', operationId: h.operationId }))
    .toEqual({ ok: true, value: { operationId: h.operationId, status: 'cancelled' } })
  await h.coordinator.waitForSettlement(h.appSessionId)
  expect(h.coordinator.snapshot(h.appSessionId)?.review.required).toBe(true)
  expect(h.held.size).toBe(1)
  expect(h.moved()).toBe(0)
})

test('unreadable acceptance after publication retains the host reservation and refuses cancellation proof', async () => {
  const h = harness()
  h.deps.onStateChanged = () => {
    writeFileSync(join(h.directory, `${h.appSessionId}.json`), '{broken')
    throw new Error('publication became unreadable')
  }
  expect((await h.accept()).ok).toBe(false)
  expect(h.held.get(h.appSessionId)).toBe(h.operationId)
  expect(h.coordinator.retains(h.appSessionId)).toBe(true)
  expect((await h.coordinator.handleRequest(h.appSessionId, { verb: 'workspace.cancel', operationId: h.operationId })).ok).toBe(false)
  expect(h.moved()).toBe(0)
})

test('cancellation during asynchronous readiness verification cannot authorize a late move', async () => {
  const h = harness()
  let releaseVerify!: () => void
  let enteredVerify!: () => void
  const entered = new Promise<void>(resolve => { enteredVerify = resolve })
  h.deps.verifyReady = async () => { enteredVerify(); await new Promise<void>(resolve => { releaseVerify = resolve }); return true }
  await h.accept()
  const lateReady = h.coordinator.handleRequest(h.appSessionId, h.ready)
  await entered
  await h.coordinator.cancel(h.appSessionId)
  releaseVerify()
  expect((await lateReady).ok).toBe(false)
  await h.coordinator.waitForSettlement(h.appSessionId)
  expect(h.moved()).toBe(0)
})

test('Stop during destination trust observation refuses late acceptance without needing an operation receipt', async () => {
  const h = harness()
  let releaseTrust!: () => void
  let enteredTrust!: () => void
  const entered = new Promise<void>(resolve => { enteredTrust = resolve })
  let reads = 0
  h.deps.trustedProjectRoots = async roots => {
    if (++reads === 2) { enteredTrust(); await new Promise<void>(resolve => { releaseTrust = resolve }) }
    return roots
  }
  const acceptance = h.accept()
  await entered
  expect(await h.coordinator.handleRequest(h.appSessionId, { verb: 'workspace.cancel', operationId: h.operationId }))
    .toEqual({ ok: true, value: { operationId: h.operationId, status: 'not_accepted' } })
  // Another cancellation cannot replace the first operation's fence while its
  // trust observation is still in flight.
  expect((await h.coordinator.handleRequest(h.appSessionId, { verb: 'workspace.cancel', operationId: randomUUID() })).ok).toBe(true)
  releaseTrust()
  expect((await acceptance).ok).toBe(false)
  expect(h.coordinator.snapshot(h.appSessionId)).toBe(null)
  expect(h.held.size).toBe(0)
})

test('cancellation proves no acceptance and fences an operation that has not yet reached main', async () => {
  const h = harness()
  const listed = await h.coordinator.handleRequest(h.appSessionId, { verb: 'workspaces.list' })
  if (!listed.ok || !('workspaces' in listed.value)) throw new Error('listing failed')
  const destinationHandle = listed.value.workspaces[0]!.handle
  expect(await h.coordinator.handleRequest(h.appSessionId, { verb: 'workspace.cancel', operationId: h.operationId }))
    .toEqual({ ok: true, value: { operationId: h.operationId, status: 'not_accepted' } })
  expect((await h.coordinator.handleRequest(h.appSessionId, { verb: 'workspace.jump', operationId: h.operationId, destinationHandle })).ok).toBe(false)
  expect(h.coordinator.snapshot(h.appSessionId)).toBe(null)
  expect(h.held.size).toBe(0)
  // Main restart cannot authorize the old handle, even without its old tombstone.
  const restarted = new WorkspaceJumpCoordinator(h.deps)
  expect((await restarted.handleRequest(h.appSessionId, { verb: 'workspace.jump', operationId: h.operationId, destinationHandle })).ok).toBe(false)
})

test('accepted or unreadable operation can never be reported as not accepted', async () => {
  const h = harness()
  await h.accept()
  expect(await h.coordinator.handleRequest(h.appSessionId, { verb: 'workspace.cancel', operationId: h.operationId }))
    .toEqual({ ok: true, value: { operationId: h.operationId, status: 'cancelled' } })
  await h.coordinator.waitForSettlement(h.appSessionId)
  writeFileSync(join(h.directory, `${h.appSessionId}.json`), '{broken')
  expect((await h.coordinator.handleRequest(h.appSessionId, { verb: 'workspace.cancel', operationId: h.operationId })).ok).toBe(false)
})

test('unreadable operation is retained before registry launch and refuses capability admission', async () => {
  const h = harness()
  mkdirSync(h.directory)
  writeFileSync(join(h.directory, `${h.appSessionId}.json`), '{broken')
  expect(h.coordinator.loadRetention().appSessionIds.has(h.appSessionId)).toBe(true)
  expect((await h.coordinator.handleRequest(h.appSessionId, { verb: 'workspaces.list' })).ok).toBe(false)
  expect(h.coordinator.retains(h.appSessionId)).toBe(true)
})

function snapshot(h: ReturnType<typeof harness>, sequence: number, record?: Partial<WorkspaceHandoffExecutionRecord>, gate: WorkspaceHandoffSnapshot['gate'] = { mode: 'held', reservationOperationId: h.operationId, requiresUserReconciliation: false }): WorkspaceHandoffSnapshot {
  const state = h.coordinator.snapshot(h.appSessionId)!
  const identity = { appSessionId: h.appSessionId, engineSessionId: state.engineSessionId, operationId: state.operationId, continuationId: state.continuation.id, sourceGeneration: state.sourceGeneration, admissionGeneration: state.continuation.admissionGeneration, operationSha256: workspaceJumpOperationSha256(state) }
  return { ...identity, observerGeneration: h.generation(), statusSeq: sequence, execution: record?.terminal ? 'terminal' : 'idle', gate,
    record: record ? { kind: 'valid', record: { ...identity, version: 1, origin: 'fresh', revision: sequence, consumed: true, inputCommitted: true, cancellation: null, terminal: null, notice: null, reconciliation: null, ...record } } : { kind: 'absent' } }
}
const checkpoint = () => ({ version: 1 as const, prefixBytes: 10, prefixSha256: 'a'.repeat(64), projectionSha256: 'b'.repeat(64), activeTipUuid: randomUUID(), messageCount: 1 })
async function arrive(h: ReturnType<typeof harness>) { await h.accept(); await h.coordinator.handleRequest(h.appSessionId, h.ready); h.coordinator.afterResponse(h.appSessionId, h.ready, true); await h.coordinator.waitForSettlement(h.appSessionId) }

test('settlement and newer cumulative reconciliation merge while an acknowledgement is pending; stale settlement cannot re-arm review', async () => {
  const h = harness(); await arrive(h)
  let finish!: () => void
  h.deps.control = async (_state, action) => { if (action.action === 'status') await new Promise<void>(resolve => { finish = resolve }); return { kind: 'timeout' } }
  h.coordinator.queryStatus(h.appSessionId)
  await Promise.resolve()
  const notice = { displayUuid: randomUUID(), contextUuid: randomUUID(), outcome: 'uncertain' as const, checkpoint: checkpoint() }
  const first = snapshot(h, 1, { notice })
  expect(h.coordinator.observe(h.appSessionId, first)).toBe(true)
  const next = snapshot(h, 2, { notice, reconciliation: { noticeUuid: notice.displayUuid, inputUuid: randomUUID(), contextUuid: randomUUID(), checkpoint: checkpoint() } }, { mode: 'open', reservationOperationId: null, requiresUserReconciliation: false })
  expect(h.coordinator.observe(h.appSessionId, next)).toBe(true)
  expect(h.coordinator.snapshot(h.appSessionId)?.review.required).toBe(false)
  expect(h.coordinator.observe(h.appSessionId, first)).toBe(false)
  expect(h.coordinator.snapshot(h.appSessionId)?.review.required).toBe(false)
  finish()
})

test('release not applied retains hold; lost release reply converges by gate evidence without repeating continuation', async () => {
  const h = harness(); await arrive(h)
  const terminal = { outcome: 'success' as const, order: 1, checkpoint: checkpoint() }
  expect(h.coordinator.observe(h.appSessionId, snapshot(h, 1, { terminal }))).toBe(true)
  await h.coordinator.waitForSettlement(h.appSessionId)
  expect(h.coordinator.snapshot(h.appSessionId)?.continuation.outcome).toBe('success')
  expect(h.held.size).toBe(1)
  expect(h.coordinator.retains(h.appSessionId)).toBe(true)
  h.coordinator.observe(h.appSessionId, snapshot(h, 2, { terminal }, { mode: 'open', reservationOperationId: null, requiresUserReconciliation: false }))
  expect(h.held.size).toBe(0)
  expect(h.coordinator.retains(h.appSessionId)).toBe(false)
  expect(h.continuations()).toBe(1)
  const settled = h.coordinator.snapshot(h.appSessionId)!
  h.setGeneration()
  expect(h.coordinator.retains(h.appSessionId)).toBe(false)
  expect(h.coordinator.isReserved(h.appSessionId)).toBe(false)
  expect(h.coordinator.recover(h.appSessionId)).toEqual(settled)
})

test('late cancellation intent remains distinct from durable successful closure', async () => {
  const h = harness(); await arrive(h)
  await h.coordinator.cancel(h.appSessionId, undefined, 'close')
  const cancelId = h.coordinator.snapshot(h.appSessionId)!.cancellation!.cancelId
  h.coordinator.observe(h.appSessionId, snapshot(h, 1, { cancellation: { cancelId, application: 'too_late', order: 2 }, terminal: { outcome: 'success', order: 1, checkpoint: checkpoint() } }))
  const state = h.coordinator.snapshot(h.appSessionId)!
  expect(state.continuation.outcome).toBe('success')
  expect(state.cancellation).toEqual({ cancelId, requestedBy: 'close', application: 'too_late' })
  await h.coordinator.waitForSettlement(h.appSessionId)
})

test('process replacement observes old admission evidence and never redispatches its attempt', async () => {
  const h = harness(); await arrive(h)
  h.setGeneration(); h.coordinator.recover(h.appSessionId)
  h.coordinator.observe(h.appSessionId, { ...snapshot(h, 1), execution: 'idle' })
  await h.coordinator.waitForSettlement(h.appSessionId)
  expect(h.continuations()).toBe(1)
  expect(h.coordinator.retains(h.appSessionId)).toBe(true)
})

test('unresolved V1 completed admission stays unknown; settled V1 stays legacy without invented success', async () => {
  const h = harness(); await h.accept()
  const current = h.coordinator.snapshot(h.appSessionId)!
  const {revision:_r,origin:_o,cancellation:_c,review:_w,release:_s,continuation:_a,...identity}=current
  const legacy = { ...identity, version: 1 as const, phase: 'settled' as const, location: 'destination' as const, consumed:true, cancelled:false, requiresUserReconciliation:false, sourceOutcomePersisted:false, outcome:'completed' as const, continuation:{id: current.continuation.id,state:'admitted' as const} }
  writeWorkspaceJump(legacy,h.directory)
  const recovered = h.coordinator.recover(h.appSessionId)!
  expect(recovered.continuation.outcome).toBe('unknown')
  expect(recovered.legacy?.continuation.state).toBe('admitted')
  expect(h.continuations()).toBe(0)
  expect(upgradeWorkspaceJumpState({...legacy,continuation:{...legacy.continuation,state:'settled'}}).continuation.outcome).toBe('legacy_settled')
})

test('confirmed review release permits ordinary close while retaining review and refusing automatic queue eligibility', async () => {
  const h = harness(); await arrive(h)
  const notice = { displayUuid: randomUUID(), contextUuid: randomUUID(), outcome: 'uncertain' as const, checkpoint: checkpoint() }
  h.coordinator.observe(h.appSessionId, snapshot(h, 1, { notice }, { mode: 'review', reservationOperationId: null, requiresUserReconciliation: true }))
  expect(h.coordinator.isReserved(h.appSessionId)).toBe(false)
  expect(h.coordinator.retains(h.appSessionId)).toBe(true)
  expect(h.coordinator.requiresReview(h.appSessionId)).toBe(true)
  expect(workspaceJumpAllowsQueuedInput(h.coordinator.snapshot(h.appSessionId)!, h.coordinator.liveObservation(h.appSessionId))).toBe(false)
  expect(h.held.size).toBe(0)
  await h.coordinator.waitForSettlement(h.appSessionId)
})

test('status reply schedules a release retry after freeing its command slot without replaying continuation', async () => {
  const h = harness(); await arrive(h)
  const terminal = { outcome: 'success' as const, order: 1, checkpoint: checkpoint() }
  let releases = 0, sequence = 1
  const control = new WorkspaceHandoffControl({
    generation: h.generation,
    acceptsStatus: (id, status) => id === h.appSessionId && status.engineSessionId === h.row.engineSessionId,
    observe: (id, status) => { h.coordinator.observe(id, status) },
    recover: id => h.coordinator.queryStatus(id),
    send: (id, message) => {
      if (message.action === 'release' && ++releases === 1) return true
      const gate = message.action === 'release' ? { mode: 'open' as const, reservationOperationId: null, requiresUserReconciliation: false } : { mode: 'held' as const, reservationOperationId: h.operationId, requiresUserReconciliation: false }
      control.receiveFrame(id, { kind: 'workspace.handoff.result', protocolVersion: 3, sessionId: id, requestId: message.requestId, operationId: h.operationId, action: message.action, disposition: 'accepted', status: snapshot(h, ++sequence, { terminal }, gate) })
      return true
    },
  })
  h.deps.control = (state, action) => control.request(state.appSessionId, state.operationId, action)
  try {
    h.coordinator.observe(h.appSessionId, snapshot(h, 1, { terminal }))
    await Promise.resolve(); await Promise.resolve()
    expect(releases).toBe(1)
    expect(h.held.size).toBe(1)
    control.disconnect(h.appSessionId)
    await h.coordinator.waitForSettlement(h.appSessionId)
    h.coordinator.queryStatus(h.appSessionId)
    await h.coordinator.waitForSettlement(h.appSessionId)
    expect(releases).toBe(2)
    expect(h.held.size).toBe(0)
    expect(h.continuations()).toBe(1)
  } finally { control.dispose() }
})

test('verified source compensation permits a later request but a later manual relocation cannot reset authority', async () => {
  const h = harness()
  await h.accept(); await h.coordinator.handleRequest(h.appSessionId, h.ready)
  let compensation!: Parameters<typeof writeSessionRelocation>[0]
  h.deps.host.moveWorkspaceJump = async (_id, _operation, _cwd, start) => {
    start()
    const state = h.coordinator.snapshot(h.appSessionId)!
    compensation = { version: 1, engineSessionId: state.engineSessionId, appSessionId: h.appSessionId,
      original: state.source, source: state.target, target: state.source, phase: 'complete',
      controls: { mode: 'default' }, backup: join(process.env.CLAUDE_CONFIG_DIR!, 'backup'), movedAt: Date.now() }
    writeSessionRelocation(compensation)
    return { result: { ok: false, error: { code: 'session_unreachable', message: 'verified compensation' } }, location: 'source', relocation: compensation }
  }
  h.coordinator.afterResponse(h.appSessionId, h.ready, true)
  await h.coordinator.waitForSettlement(h.appSessionId)
  const notice = { displayUuid: randomUUID(), contextUuid: randomUUID(), outcome: 'failed' as const, checkpoint: checkpoint() }
  const evidence = { consumed: false, inputCommitted: false, terminal: { outcome: 'not_started' as const, order: 1, checkpoint: checkpoint() }, notice }
  h.coordinator.observe(h.appSessionId, snapshot(h, 1, evidence, { mode: 'review', reservationOperationId: null, requiresUserReconciliation: true }))
  const reconciliation = { noticeUuid: notice.displayUuid, inputUuid: randomUUID(), contextUuid: randomUUID(), checkpoint: checkpoint() }
  h.coordinator.observe(h.appSessionId, snapshot(h, 2, { ...evidence, reconciliation }, { mode: 'open', reservationOperationId: null, requiresUserReconciliation: false }))
  await h.coordinator.waitForSettlement(h.appSessionId)
  const listed = await h.coordinator.handleRequest(h.appSessionId, { verb: 'workspaces.list' })
  expect(listed.ok && 'eligible' in listed.value && listed.value.eligible).toBe(true)
  expect(h.coordinator.snapshot(h.appSessionId)?.consumed).toBe(false)
  writeSessionRelocation({ ...compensation, backup: `${compensation.backup}-manual`, movedAt: compensation.movedAt + 1 })
  expect(await h.coordinator.handleRequest(h.appSessionId, { verb: 'workspaces.list' })).toEqual({ ok: true, value: { eligible: false, workspaces: [] } })
})
