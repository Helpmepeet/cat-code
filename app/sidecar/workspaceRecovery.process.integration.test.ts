import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

test.each(['checkpoint', 'recovery_notice'] as const)('real process replacement holds consumed continuation until verified review without replay: %s', async failureStage => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-recovery-process-'))
  const previousConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  const { SidecarSupervisor } = await import('../supervisor/supervisor.js')
  const { SessionRegistry } = await import('../host/registry.js')
  const { Host } = await import('../host/host.js')
  const { WorkspaceJumpCoordinator } = await import('../main/workspaceJumpCoordinator.js')
  const { WorkspaceHandoffControl } = await import('../main/workspaceHandoffControl.js')
  const { writeWorkspaceJump } = await import('../../src/utils/workspaceJumpState.js')
  const { writeSessionRelocation } = await import('../../src/utils/sessionRelocationState.js')
  mkdirSync(join(root, 'project'))
  const cwd = realpathSync(join(root, 'project'))
  const sessionId = randomUUID(), engineSessionId = randomUUID(), operationId = randomUUID()
  const supervisor = new SidecarSupervisor({ sidecarCommand: process.execPath,
    sidecarArgs: [join(import.meta.dir, 'workspaceRecovery.process.fixture.ts'), root, failureStage],
    socketDir: join(root, 'sockets'), startupTimeoutMs: 15_000, killGraceMs: 1000, log: () => {} })
  const registry = new SessionRegistry({ storageDir: join(root, 'registry'), log: () => {},
    transcriptPathFor: () => readFileSync(join(root, 'transcript-path.txt'), 'utf8') })
  let coordinator: InstanceType<typeof WorkspaceJumpCoordinator>
  let control: InstanceType<typeof WorkspaceHandoffControl>
  const host = new Host({ supervisor, registry, validateCwd: path => existsSync(path) ? { ok: true, realpath: realpathSync(path) } : { ok: false }, log: () => {},
    prepareWorkspaceRecovery: (id, op, gen, recovery) => coordinator.prepareRecovery(id, op, gen, recovery),
    cancelWorkspaceRecovery: async (id, op, gen, recovery) => { await coordinator.cancelRecovery(id, op, gen, recovery) },
    prepareSessionRecovery: id => { coordinator.recover(id) },
  })
  coordinator = new WorkspaceJumpCoordinator({ host, row: id => registry.findSession(id), knownProjects: () => [], validateCwd: path => ({ ok: true, realpath: path }),
    trustedProjectRoots: async paths => paths, verifyReady: () => false,
    onStateChanged: (state, status) => host.publishWorkspaceJumpDisplay(state, status),
    waitForControlSlot: (id, op, gen) => control.waitForSlot(id, op, gen), control: (state, action) => control.request(state.appSessionId, state.operationId, action) })
  control = new WorkspaceHandoffControl({ generation: id => host.getSessionGeneration(id), send: (id, message) => { supervisor.send(id, message); return true },
    acceptsStatus: (_id, status) => status.engineSessionId === engineSessionId, observe: (id, status) => { coordinator.observe(id, status) }, recover: id => coordinator.queryStatus(id) })
  const errors: string[] = []
  let streamedFrames = 0, descriptorUpdates = 0
  host.subscribe(event => { if (event.type === 'session-status') descriptorUpdates++ })
  supervisor.subscribe(event => { if (event.type === 'frame') {
    if (event.frame.kind === 'event' && event.frame.event.type === 'message' && event.frame.event.message.type === 'stream_event') streamedFrames++
    control.receiveFrame(event.sessionId, event.frame)
  } })
  const until = async (predicate: () => boolean, label: string) => {
    const end = Date.now() + 15_000
    while (!predicate() && Date.now() < end) await Bun.sleep(10)
    expect(predicate(), label + errors.join('\n')).toBe(true)
  }
  try {
    await registry.upsertOnSpawn({ appSessionId: sessionId, cwd, engineSessionId, binding: { kind: 'project' } })
    await registry.markInputAccepted(sessionId)
    supervisor.spawnSession(sessionId, { cwd, binding: { kind: 'project' }, freshEngineSessionId: engineSessionId })
    const generation = host.getSessionGeneration(sessionId)!
    const source = { cwd: join(root, 'old'), binding: { kind: 'managed' as const, storageId: randomUUID(), storageRootId: randomUUID() } }
    const target = { cwd: realpathSync(cwd), binding: { kind: 'project' as const } }
    writeWorkspaceJump({ version: 2, revision: 1, origin: 'fresh', appSessionId: sessionId, engineSessionId, operationId,
      sourceGeneration: randomUUID(), source, target, acceptedAt: 1, phase: 'settled', location: 'destination', consumed: true,
      boundary: { tipUuid: randomUUID(), toolUseId: 'synthetic-source' },
      continuation: { id: randomUUID(), admissionGeneration: generation, dispatch: 'unknown', outcome: 'pending', receiptRevision: null, checkpointSha256: null },
      cancellation: null, review: { required: false, noticeUuid: null, reconciledInputUuid: null }, release: { target: 'held', authorizedRevision: null, confirmed: null } })
    writeSessionRelocation({ version: 1, engineSessionId, appSessionId: sessionId, phase: 'complete', original: source, source, target, controls: { mode: 'default' }, backup: join(root, 'backup'), movedAt: 2 })
    await until(() => supervisor.listSessions().some(row => row.sessionId === sessionId && row.status === 'ready'), 'original sidecar ready')
    const streamStarted = performance.now()
    const statusesBeforeStream = descriptorUpdates
    await until(() => coordinator.liveObservation(sessionId)?.settled === true && coordinator.liveObservation(sessionId)?.failure !== null, 'original failure settled')
    console.info('handoff streaming fixture', JSON.stringify({ streamedFrames, descriptorUpdates: descriptorUpdates - statusesBeforeStream, elapsedMs: performance.now() - streamStarted }))
    expect(streamedFrames).toBeGreaterThanOrEqual(1000)
    expect(descriptorUpdates - statusesBeforeStream).toBeLessThan(30)
    const originalPid = supervisor.getSessionProcessId(sessionId)
    expect(readFileSync(join(root, 'provider-calls.txt'), 'utf8').trim().split('\n')).toEqual([generation])
    const result = await host.recoverWorkspaceHandoff(sessionId, operationId, generation)
    expect(result).toMatchObject({ ok: true })
    await until(() => coordinator.snapshot(sessionId)?.release.confirmed?.mode === 'review', 'replacement review admission')
    expect(supervisor.getSessionProcessId(sessionId)).not.toBe(originalPid)
    expect(host.getSessionGeneration(sessionId)).not.toBe(generation)
    expect(coordinator.liveObservation(sessionId)?.gate.mode).toBe('review')
    expect(readFileSync(join(root, 'provider-calls.txt'), 'utf8').trim().split('\n')).toEqual([generation])
    expect(host.isWorkspaceJumpReserved(sessionId)).toBe(false)
    supervisor.send(sessionId, { type: 'app.submit', requestId: randomUUID(), prompt: 'Review saved work before continuing' })
    await until(() => coordinator.snapshot(sessionId)?.release.confirmed?.mode === 'open', 'genuine input reconciled')
    await until(() => readFileSync(join(root, 'provider-calls.txt'), 'utf8').trim().split('\n').length === 2, 'follow-up reaches provider')
  } finally {
    control.dispose(); coordinator.dispose(); expect((await supervisor.shutdown()).confirmed).toBe(true)
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousConfig
    rmSync(root, { recursive: true, force: true })
  }
}, 45_000)
