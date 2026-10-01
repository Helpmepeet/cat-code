import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorkspaceJumpCoordinator, type WorkspaceJumpCoordinatorDeps } from './workspaceJumpCoordinator.js'
import type { PeerRegistryRow } from './peerRequestPlane.js'
import { readWorkspaceJump, writeWorkspaceJump } from '../../src/utils/workspaceJumpState.js'
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
    persistTerminalOutcome: async () => { terminalCalls++; return terminalDurable },
    continueDestination: async () => { continuationCalls++; if (continuationFails) throw new Error('lost completion') },
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
  return { coordinator, deps, row, appSessionId, directory, operationId, ready, held, accept,
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
  expect(h.held.size).toBe(0)
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
  expect(h.coordinator.snapshot(h.appSessionId)?.sourceOutcomePersisted).toBe(true)
  expect(h.held.size).toBe(0)
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

test('cancellation acknowledges while source terminal persistence still awaits tool-idle', async () => {
  const h = harness()
  let releaseIdle!: () => void
  const idle = new Promise<void>(resolve => { releaseIdle = resolve })
  h.deps.persistTerminalOutcome = async () => { await idle; return true }
  await h.accept()
  const cancelled = await h.coordinator.handleRequest(h.appSessionId, { verb: 'workspace.cancel', operationId: h.operationId })
  expect(cancelled).toEqual({ ok: true, value: { operationId: h.operationId, status: 'cancelled' } })
  expect(h.held.size).toBe(1)
  expect(h.coordinator.snapshot(h.appSessionId)?.sourceOutcomePersisted).toBe(false)
  releaseIdle()
  await h.coordinator.waitForSettlement(h.appSessionId)
  expect(h.held.size).toBe(0)
  expect(h.coordinator.snapshot(h.appSessionId)?.sourceOutcomePersisted).toBe(true)
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

test('Stop while parking prevents mutation and awaits durable source outcome before releasing', async () => {
  const h = harness()
  let release!: () => void
  h.holdMove(() => new Promise<void>(resolve => { release = resolve }))
  await h.accept()
  await h.coordinator.handleRequest(h.appSessionId, h.ready)
  h.coordinator.afterResponse(h.appSessionId, h.ready, true)
  h.setTerminalDurable(false)
  await h.coordinator.cancel(h.appSessionId)
  release()
  await h.coordinator.waitForSettlement(h.appSessionId)
  expect(h.moved()).toBe(0)
  expect(h.continuations()).toBe(0)
  expect(h.held.size).toBe(1)
  expect(h.coordinator.retains(h.appSessionId)).toBe(true)
  expect(await h.coordinator.reconcileUser(h.appSessionId)).toBe(false)
  h.setTerminalDurable(true)
  expect(await h.coordinator.reconcileUser(h.appSessionId)).toBe(true)
  expect(h.held.size).toBe(0)
  expect(readWorkspaceJump(h.appSessionId, h.directory)?.consumed).toBe(false)
})

test('Stop retries an unacknowledged failed outcome without changing its kind or replaying work', async () => {
  const h = harness()
  h.setFinalLocation('source')
  const outcomes: Array<string | undefined> = []
  let releasePersistence!: () => void
  h.deps.persistTerminalOutcome = async state => {
    outcomes.push(state.outcome)
    if (outcomes.length === 1) return false
    await new Promise<void>(resolve => { releasePersistence = resolve })
    return true
  }
  await h.accept()
  await h.coordinator.handleRequest(h.appSessionId, h.ready)
  h.coordinator.afterResponse(h.appSessionId, h.ready, true)
  await h.coordinator.waitForSettlement(h.appSessionId)
  expect(outcomes).toEqual(['failed'])
  expect(h.held.size).toBe(1)
  expect(h.coordinator.snapshot(h.appSessionId)?.sourceOutcomePersisted).toBe(false)

  const cancel = { verb: 'workspace.cancel' as const, operationId: h.operationId }
  expect(await h.coordinator.handleRequest(h.appSessionId, cancel))
    .toEqual({ ok: true, value: { operationId: h.operationId, status: 'cancelled' } })
  expect(outcomes).toEqual(['failed', 'failed'])
  expect(await h.coordinator.reconcileUser(h.appSessionId, h.operationId)).toBe(false)
  // Another Stop and a recovery boundary coalesce with the in-flight note.
  expect((await h.coordinator.handleRequest(h.appSessionId, cancel)).ok).toBe(true)
  expect(await h.coordinator.settleRecovery(h.appSessionId, h.operationId)).toBe(false)
  expect(outcomes).toEqual(['failed', 'failed'])
  releasePersistence()
  await h.coordinator.waitForSettlement(h.appSessionId)
  const settled = h.coordinator.snapshot(h.appSessionId)!
  expect(settled.outcome).toBe('failed')
  expect(settled.sourceOutcomePersisted).toBe(true)
  expect(settled.requiresUserReconciliation).toBe(true)
  expect(h.held.size).toBe(0)
  expect(h.moved()).toBe(1)
  expect(h.continuations()).toBe(0)
  expect(await h.coordinator.reconcileUser(h.appSessionId, h.operationId)).toBe(true)
  expect(h.coordinator.retains(h.appSessionId)).toBe(false)
})

test('lost continuation settlement is retained and never automatically replayed after restart', async () => {
  const h = harness()
  h.failContinuation()
  await h.accept()
  await h.coordinator.handleRequest(h.appSessionId, h.ready)
  h.coordinator.afterResponse(h.appSessionId, h.ready, true)
  await h.coordinator.waitForSettlement(h.appSessionId)
  expect(h.continuations()).toBe(1)
  expect(readWorkspaceJump(h.appSessionId, h.directory)?.continuation.state).toBe('uncertain')
  const restored = new WorkspaceJumpCoordinator(h.deps)
  expect(restored.loadRetention().appSessionIds.has(h.appSessionId)).toBe(true)
  restored.recover(h.appSessionId)
  expect(h.continuations()).toBe(1)
  expect((await restored.handleRequest(h.appSessionId, h.ready)).ok).toBe(false)
})

test('Stop during admitted destination continuation writes cancelled outcome before releasing', async () => {
  const h = harness()
  let releaseContinuation!: () => void
  let enteredContinuation!: () => void
  const entered = new Promise<void>(resolve => { enteredContinuation = resolve })
  h.deps.continueDestination = async () => {
    enteredContinuation()
    await new Promise<void>(resolve => { releaseContinuation = resolve })
  }
  await h.accept()
  await h.coordinator.handleRequest(h.appSessionId, h.ready)
  h.coordinator.afterResponse(h.appSessionId, h.ready, true)
  await entered
  await h.coordinator.cancel(h.appSessionId)
  expect(h.held.size).toBe(1)
  releaseContinuation()
  await h.coordinator.waitForSettlement(h.appSessionId)
  expect(h.terminals()).toBe(1)
  const state = h.coordinator.snapshot(h.appSessionId)!
  expect(state.outcome).toBe('cancelled')
  expect(state.consumed).toBe(true)
  expect(state.sourceOutcomePersisted).toBe(true)
  expect(state.continuation.state).toBe('settled')
  expect(state.requiresUserReconciliation).toBe(true)
  expect(h.held.size).toBe(0)
})

test('durable destination consumes jump despite reopen failure; unknown location refuses reconciliation', async () => {
  const h = harness()
  await h.accept()
  await h.coordinator.handleRequest(h.appSessionId, h.ready)
  // A host failure after relocation still names its authoritative durable location.
  h.deps.host.moveWorkspaceJump = async (_id, _operationId, _cwd, start) => {
    start()
    return { result: { ok: false, error: { code: 'spawn_failed', message: 'could not reopen' } }, location: 'destination', relocation: null }
  }
  h.coordinator.afterResponse(h.appSessionId, h.ready, true)
  await h.coordinator.waitForSettlement(h.appSessionId)
  const state = readWorkspaceJump(h.appSessionId, h.directory)!
  expect(state.consumed).toBe(true)
  expect(h.continuations()).toBe(0)
  writeWorkspaceJump({ ...state, location: 'unknown' }, h.directory)
  expect(await h.coordinator.reconcileUser(h.appSessionId)).toBe(false)
})

test('unreadable operation is retained before registry launch and refuses capability admission', async () => {
  const h = harness()
  mkdirSync(h.directory)
  writeFileSync(join(h.directory, `${h.appSessionId}.json`), '{broken')
  expect(h.coordinator.loadRetention().appSessionIds.has(h.appSessionId)).toBe(true)
  expect((await h.coordinator.handleRequest(h.appSessionId, { verb: 'workspaces.list' })).ok).toBe(false)
  expect(h.coordinator.retains(h.appSessionId)).toBe(true)
})

test('restored source retries only the fixed terminal note and keeps user reconciliation until genuine receipt', async () => {
  const h = harness()
  await h.accept()
  const restored = new WorkspaceJumpCoordinator(h.deps)
  restored.recover(h.appSessionId)
  expect(await restored.settleRecovery(h.appSessionId, h.operationId)).toBe(true)
  expect(h.terminals()).toBe(1)
  expect(h.continuations()).toBe(0)
  expect(restored.snapshot(h.appSessionId)?.requiresUserReconciliation).toBe(true)
  expect(await restored.settleRecovery(h.appSessionId, h.operationId)).toBe(true)
  expect(h.terminals()).toBe(1)
  expect(await restored.reconcileUser(h.appSessionId, randomUUID())).toBe(false)
  expect(await restored.reconcileUser(h.appSessionId, h.operationId)).toBe(true)
  expect(restored.retains(h.appSessionId)).toBe(false)
  // A late transport replay of the accepted operation is never a new request.
  expect((await h.accept()).ok).toBe(false)
})

test('verified compensation allows a later genuine request but a later manual relocation cannot reset eligibility', async () => {
  const h = harness()
  await h.accept()
  await h.coordinator.handleRequest(h.appSessionId, h.ready)
  let compensationRecord!: Parameters<typeof writeSessionRelocation>[0]
  h.deps.host.moveWorkspaceJump = async (_id, _operation, _cwd, start) => {
    start()
    const state = h.coordinator.snapshot(h.appSessionId)!
    compensationRecord = { version: 1, engineSessionId: state.engineSessionId, appSessionId: h.appSessionId,
      original: state.source, source: state.target, target: state.source, phase: 'complete',
      controls: { mode: 'default' }, backup: join(process.env.CLAUDE_CONFIG_DIR!, 'backup'), movedAt: Date.now() }
    writeSessionRelocation(compensationRecord)
    return { result: { ok: false, error: { code: 'session_unreachable', message: 'verified compensation' } },
      location: 'source', relocation: compensationRecord }
  }
  h.coordinator.afterResponse(h.appSessionId, h.ready, true)
  await h.coordinator.waitForSettlement(h.appSessionId)
  expect((await h.coordinator.handleRequest(h.appSessionId, { verb: 'workspaces.list' })).ok).toBe(true)
  expect(await h.coordinator.reconcileUser(h.appSessionId, h.operationId)).toBe(true)
  const listed = await h.coordinator.handleRequest(h.appSessionId, { verb: 'workspaces.list' })
  expect(listed.ok && 'eligible' in listed.value && listed.value.eligible).toBe(true)
  expect(h.coordinator.snapshot(h.appSessionId)?.consumed).toBe(false)
  writeSessionRelocation({ ...compensationRecord, backup: `${compensationRecord.backup}-manual`, movedAt: compensationRecord.movedAt + 1 })
  expect(await h.coordinator.handleRequest(h.appSessionId, { verb: 'workspaces.list' })).toEqual({ ok: true, value: { eligible: false, workspaces: [] } })
})
