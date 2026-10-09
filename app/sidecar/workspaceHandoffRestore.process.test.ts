import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readWorkspaceJump, writeWorkspaceJump, type WorkspaceJumpStateV2 } from '../../src/utils/workspaceJumpState.js'
import { type ServerFrame } from '../shared/protocol.js'
import { SidecarSupervisor } from '../supervisor/supervisor.js'
import { writeSessionRelocation } from '../../src/utils/sessionRelocationState.js'
import { SIDECAR_RUNTIME_ARGS } from '../main/mainDecisions.js'
import { WorkspaceHandoffControl } from '../main/workspaceHandoffControl.js'
import { WorkspaceJumpCoordinator } from '../main/workspaceJumpCoordinator.js'

for (const historical of [false, true]) test(historical
  ? 'normal replacement startup preserves converged open history after rewind without repeating continuation'
  : 'real execution survives process replacement and confirms main-authorized release without replay', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'handoff-restore-')))
  const config = join(root, 'config'), cwd = join(root, 'project'), socket = join('/tmp', `hr-${randomUUID().slice(0, 8)}.sock`)
  mkdirSync(config); mkdirSync(cwd)
  const oldConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = config
  const appSessionId = randomUUID(), engineSessionId = randomUUID(), admissionGeneration = randomUUID()
  const state: WorkspaceJumpStateV2 = { version: 2, revision: 1, origin: 'fresh',
    appSessionId, engineSessionId, operationId: randomUUID(), sourceGeneration: randomUUID(),
    source: { cwd: join(root, 'source'), binding: { kind: 'managed', storageId: randomUUID(), storageRootId: randomUUID() } }, target: { cwd, binding: { kind: 'project' } },
    acceptedAt: 1, phase: 'settled', location: 'destination', consumed: true,
    continuation: { id: randomUUID(), admissionGeneration, dispatch: 'unknown', outcome: 'pending', receiptRevision: null, checkpointSha256: null },
    cancellation: null, review: { required: false, noticeUuid: null, reconciledInputUuid: null },
    release: { target: 'held', authorizedRevision: null, confirmed: null } }
  writeWorkspaceJump(state)
  writeFileSync(join(config, '.config.json'), JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true } } }))
  const blocker = join(root, 'block-network.ts')
  writeFileSync(blocker, 'globalThis.fetch = async () => { throw new Error("Network disabled") }\n')
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'sk-ant-local-probe', NODE_ENV: 'development', TEST_ENABLE_SESSION_PERSISTENCE: '1' }
  const children: Array<ReturnType<typeof Bun.spawn>> = []
  let supervisor: SidecarSupervisor | undefined
  let control: WorkspaceHandoffControl | undefined
  try {
    const minter = Bun.spawn(['bun', `--preload=${blocker}`, `--preload=${resolve('src/QueryEngine.ts')}`, ...SIDECAR_RUNTIME_ARGS, resolve('app/sidecar/mintHandoffReceipt.fixture.ts'), appSessionId, ...(historical ? ['--new-conversation'] : [])], { cwd, env: { ...env, CLAUDE_CODE_SIMPLE: '1' }, stdout: 'pipe', stderr: 'pipe' })
    children.push(minter)
    const [mintCode, mintError, mintOutput] = await Promise.all([minter.exited, new Response(minter.stderr).text(), new Response(minter.stdout).text()])
    expect(mintCode, mintError).toBe(0)
    const receipt = JSON.parse(mintOutput.trim()) as { checkpointSha256: string; receiptRevision: number; providerCalls: number }
    expect(receipt.providerCalls).toBe(1)
    if (historical) {
      writeWorkspaceJump({ ...state, continuation: { ...state.continuation, dispatch: 'consumed', outcome: 'success', receiptRevision: receipt.receiptRevision, checkpointSha256: receipt.checkpointSha256 },
        release: { target: 'open', authorizedRevision: 2, confirmed: { generation: admissionGeneration, mode: 'open' } } })
      writeSessionRelocation({ version: 1, appSessionId, engineSessionId, original: state.source, source: state.source, target: state.target, phase: 'complete',
        controls: { mode: 'default' }, backup: join(root, 'backup'), movedAt: 2 })
    }
    const frames: ServerFrame[] = []
    supervisor = new SidecarSupervisor({ sidecarCommand: 'bun', sidecarArgs: [`--preload=${blocker}`, ...SIDECAR_RUNTIME_ARGS, resolve('app/sidecar/index.ts')], sidecarEnv: env, socketDir: root })
    supervisor.subscribe(event => { if (event.type === 'frame') {
      frames.push(event.frame)
      const { deliveryTrace: _deliveryTrace, ...controlFrame } = event.frame
      control?.receiveFrame(appSessionId, controlFrame)
    } })
    supervisor.spawnSession(appSessionId, { cwd, resumeEngineSessionId: engineSessionId })
    const generation = supervisor.getSessionGeneration(appSessionId)!
    expect(generation).not.toBe(admissionGeneration)
    for (let i = 0; i < 500 && !frames.some(frame => frame.kind === 'ready'); i++) await Bun.sleep(20)
    expect(frames.some(frame => frame.kind === 'ready')).toBe(true)
    supervisor.send(appSessionId, { type: 'workspace.handoff', requestId: 'status', operationId: state.operationId, forGeneration: generation, action: 'status' })
    for (let i = 0; i < 100 && !frames.some(frame => frame.kind === 'workspace.handoff.result' && frame.requestId === 'status'); i++) await Bun.sleep(20)
    expect(frames.find(frame => frame.kind === 'workspace.handoff.result' && frame.requestId === 'status')).toMatchObject({ disposition: 'accepted',
      status: { observerGeneration: generation, admissionGeneration, execution: 'terminal', record: { kind: 'valid', record: { consumed: true, terminal: { outcome: 'success' } } }, gate: { mode: historical ? 'open' : 'held' } } })
    if (!historical) {
      let held = true
      const coordinator = new WorkspaceJumpCoordinator({ row: id => id === appSessionId ? {
        appSessionId, engineSessionId, cwd, binding: state.target.binding, lastAttachedAt: 1, lastMessageSentAt: 1, shutdown: null } : undefined,
        knownProjects: () => [], validateCwd: path => ({ ok: true, realpath: path }), trustedProjectRoots: async paths => paths,
        verifyReady: () => false, control: (current, action) => control!.request(appSessionId, current.operationId, action),
        host: { getSessionGeneration: id => supervisor!.getSessionGeneration(id),
          reserveWorkspaceJump: async () => ({ ok: true, value: undefined }), releaseWorkspaceJump: () => { held = false },
          moveWorkspaceJump: async () => { throw new Error('Fixture is already at destination') } } })
      control = new WorkspaceHandoffControl({ generation: id => supervisor!.getSessionGeneration(id),
        acceptsStatus: (id, status) => id === appSessionId && status.engineSessionId === engineSessionId,
        observe: (id, snapshot) => { coordinator.observe(id, snapshot) }, recover: id => coordinator.queryStatus(id),
        send: (id, message) => { supervisor!.send(id, message); return true } })
      expect(coordinator.isReserved(appSessionId)).toBe(true)
      coordinator.queryStatus(appSessionId, true)
      for (let i = 0; i < 200 && readWorkspaceJump(appSessionId)?.version === 2 &&
          (readWorkspaceJump(appSessionId) as WorkspaceJumpStateV2).release.confirmed?.generation !== generation; i++) await Bun.sleep(20)
      expect(readWorkspaceJump(appSessionId)).toMatchObject({ continuation: { dispatch: 'consumed', outcome: 'success',
        receiptRevision: receipt.receiptRevision, checkpointSha256: receipt.checkpointSha256 },
        release: { target: 'open', confirmed: { generation, mode: 'open' } } })
      expect(frames.find(frame => frame.kind === 'workspace.handoff.result' && frame.action === 'release')).toMatchObject({ disposition: 'accepted', status: { gate: { mode: 'open', reservationOperationId: null } } })
      expect(held).toBe(false)
      expect(coordinator.isReserved(appSessionId)).toBe(false)
    }
    if (control) {
      const repeated = await control.request(appSessionId, state.operationId, { action: 'continue', continuationId: state.continuation.id })
      expect(repeated).toMatchObject({ kind: 'result', result: { disposition: 'refused' } })
    } else {
      supervisor.send(appSessionId, { type: 'workspace.handoff', requestId: 'repeat', operationId: state.operationId, forGeneration: generation, action: 'continue', continuationId: state.continuation.id })
      for (let i = 0; i < 100 && !frames.some(frame => frame.kind === 'workspace.handoff.result' && frame.requestId === 'repeat'); i++) await Bun.sleep(20)
      expect(frames.find(frame => frame.kind === 'workspace.handoff.result' && frame.requestId === 'repeat')).toMatchObject({ disposition: 'refused' })
    }
    expect(frames.some(frame => frame.kind === 'event' && frame.event.type === 'turn.status' && frame.event.activeTurn)).toBe(false)
    supervisor.shutdown()
  } finally {
    control?.dispose()
    supervisor?.shutdown()
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
    await Promise.all(children.map(child => child.exited))
    if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = oldConfig
    rmSync(root, { recursive: true, force: true }); rmSync(socket, { force: true })
  }
}, 30_000)
