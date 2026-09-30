/** Real routing -> relocation -> readiness -> submit, with private state and
 * network disabled in every engine process. Run this file in isolation. */
import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Host } from './host.js'
import { ManagedStorage } from './managedStorage.js'
import { SessionRegistry, defaultTranscriptPath } from './registry.js'
import { SidecarSupervisor } from '../supervisor/supervisor.js'
import { SIDECAR_RUNTIME_ARGS } from '../main/mainDecisions.js'
import { runSessionRelocationWorker } from '../main/sessionRelocationRunner.js'
import { ProjectRoutingController, type ProjectRoutingControllerOptions } from '../main/projectRoutingController.js'
import { FileProjectRoutingStore } from '../main/projectRoutingStore.js'
import { runProjectRoutingWorker } from '../main/projectRoutingRunner.js'

async function until(read: () => boolean) {
  const deadline = Date.now() + 60_000
  while (!read()) {
    if (Date.now() > deadline) throw new Error('Process boundary timed out')
    await Bun.sleep(25)
  }
}

for (const { established, refusal, recovery } of [
  { established: false, refusal: false }, { established: true, refusal: false },
  { established: false, refusal: true },
  { established: false, refusal: false, recovery: 'beforeMove' },
  { established: false, refusal: false, recovery: 'afterMove' },
]) test(`routing ${recovery ? `recovers ${recovery}` : refusal ? 'retains input after trust refusal' : 'delivers after a move'} in a ${established ? 'established inactive' : 'fresh'} Chat`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'catcode-routing-'))
  const oldConfig = process.env.CLAUDE_CONFIG_DIR
  const config = join(root, 'config')
  mkdirSync(config)
  const project = join(root, 'project')
  mkdirSync(project)
  const cwd = realpathSync(project)
  process.env.CLAUDE_CONFIG_DIR = config
  writeFileSync(join(config, '.config.json'), JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true } } }))
  const blocker = join(root, 'block-network.ts')
  writeFileSync(blocker, 'globalThis.fetch = (async () => new Response("Network disabled", {status:503})) as typeof fetch\n')
  const env = { CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'sk-ant-local-probe', NODE_ENV: 'development' }
  const registry = new SessionRegistry({ storageDir: join(root, 'registry'), log: () => {} })
  const supervisor = new SidecarSupervisor({ sidecarCommand: 'bun', sidecarArgs: [`--preload=${blocker}`, ...SIDECAR_RUNTIME_ARGS, resolve('app/sidecar/index.ts')], sidecarEnv: env })
  try {
    await registry.launch()
    const host = new Host({ supervisor, registry,
      managedStorage: new ManagedStorage({ appDataBase: join(root, 'app'), ownershipDir: join(config, 'chat-workspaces') }),
      validateCwd: path => { try { return { ok: true, realpath: realpathSync(path) } } catch { return { ok: false } } },
      relocate: request => runSessionRelocationWorker({ command: 'bun', args: [`--preload=${blocker}`, 'run', resolve('app/sidecar/sessionRelocationWorker.ts')], cwd: request.source.cwd, request: { type: 'session-relocation', version: 1, ...request }, env }),
      log: () => {},
    })
    const created = await host.createManagedChat()
    if (!created.ok) throw new Error(created.error.message)
    const id = created.value.appSessionId
    await until(() => supervisor.listSessions().some(row => row.sessionId === id && row.status === 'ready'))
    const original = registry.findSession(id)!
    const engineId = original.engineSessionId!
    if (established) {
      await host.closeSession(id)
      const child = Bun.spawn(['bun', `--preload=${blocker}`, 'run', resolve('app/sidecar/mintTranscript.fixture.ts'), engineId, 'earlier-user-message'], { cwd: original.cwd, env: { ...process.env, ...env, TEST_ENABLE_SESSION_PERSISTENCE: '1' }, stdout: 'pipe', stderr: 'pipe' })
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()])
      if (code !== 0) throw new Error(stderr)
      await registry.markParked(id)
    }
    let accepted = false
    const store = new FileProjectRoutingStore(join(root, 'route.json'))
    let recovering = false
    const options: ProjectRoutingControllerOptions = {
      store,
      prepareForward: session => {
        if (recovery === 'afterMove' && !recovering) throw new Error('Interrupted before delivery')
        return host.prepareRoutedSubmit(session)
      },
      eligible: session => registry.findSession(session)?.binding.kind === 'managed',
      currentCwd: session => registry.findSession(session)?.cwd ?? null,
      classify: async (_session, text, previousUserMessages, suppressedRoots) => {
        const decision = await runProjectRoutingWorker({ command: 'bun', args: [`--preload=${blocker}`, 'run', resolve('app/sidecar/projectRoutingWorker.ts')], cwd: original.cwd, env, request: { type: 'project-route', version: 1, text, previousUserMessages, suppressedRoots, knownProjectRoots: [cwd], model: null } })
        if (refusal) writeFileSync(join(config, '.config.json'), JSON.stringify({ projects: {} }))
        return recovery === 'beforeMove' && !recovering && decision.kind === 'auto' ? { ...decision, kind: 'ask' } : decision
      },
      move: async (session, target) => host.moveSession(session, target),
      forward: (session, message) => {
        supervisor.send(session, message)
        return null
      },
      answerRefused: () => { throw new Error('Submit refused') }, publish: () => {}, log: () => {},
    }
    let controller = new ProjectRoutingController(options)
    supervisor.subscribe(event => {
      if (event.type === 'frame' && event.frame.kind === 'submit.result') {
        accepted = event.frame.accepted
        controller.onSubmitResult(event.sessionId, event.frame.submitId, event.frame.accepted)
      }
    })
    const submitId = randomUUID()
    const prompt = `Fix the issue in ${cwd}`
    await controller.submit(id, { type: 'app.submit', requestId: randomUUID(), prompt, options: { submitId } }, prompt)
    if (recovery) {
      expect(accepted).toBe(false)
      expect(store.load()[0]?.outcome).toBe('unsent')
      recovering = true
      controller = new ProjectRoutingController(options)
      expect(controller.snapshots()[0]?.phase).toBe('unsent')
      await controller.resolve({ appSessionId: id, submitId, choice: 'resend' })
    }
    const destination = refusal ? original.cwd : cwd
    if (refusal) {
      expect(controller.snapshots()[0]?.phase).toBe('failed')
      expect(store.load()[0]?.outcome).toBe('unsent')
      expect(accepted).toBe(false)
      await controller.resolve({ appSessionId: id, submitId, choice: 'stay' })
    }
    expect(registry.findSession(id)).toMatchObject({ cwd: destination, appSessionId: id, engineSessionId: engineId })
    expect(supervisor.listSessions().find(row => row.sessionId === id)?.status).toBe('ready')
    await until(() => accepted)
    await until(() => existsSync(defaultTranscriptPath(destination, engineId)) && readFileSync(defaultTranscriptPath(destination, engineId), 'utf8').includes(prompt))
    expect(controller.hasPending(id)).toBe(false)
    expect(store.load().at(-1)?.outcome).toBe('accepted')
    if (established) expect(readFileSync(defaultTranscriptPath(destination, engineId), 'utf8')).toContain('earlier-user-message')
  } finally {
    supervisor.shutdown()
    if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = oldConfig
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)

test('a pre-ready journal keeps its original Chat addressable across registry relaunch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catcode-route-before-ready-'))
  const previousConfig = process.env.CLAUDE_CONFIG_DIR
  const config = join(root, 'config')
  mkdirSync(config)
  process.env.CLAUDE_CONFIG_DIR = config
  const blocker = join(root, 'block-network.ts')
  writeFileSync(blocker, 'globalThis.fetch = (async () => new Response("Network disabled", {status:503})) as typeof fetch\n')
  const supervisor = new SidecarSupervisor({ sidecarCommand: 'bun', sidecarArgs: [`--preload=${blocker}`, ...SIDECAR_RUNTIME_ARGS, resolve('app/sidecar/index.ts')], sidecarEnv: { CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'sk-ant-local-probe', NODE_ENV: 'development' } })
  try {
    const storage = new ManagedStorage({ appDataBase: join(root, 'app'), ownershipDir: join(config, 'chat-workspaces') })
    const folder = storage.create()
    if (!folder.ok) throw new Error('Chat allocation failed')
    const id = randomUUID()
    const submitId = randomUUID()
    const original = new SessionRegistry({ storageDir: join(root, 'registry'), log: () => {} })
    await original.launch()
    await original.upsertOnSpawn({ appSessionId: id, cwd: folder.cwd, binding: folder.binding, forked: false })
    await original.markClean(id)
    const journal = new FileProjectRoutingStore(join(root, 'route.json'))
    const held = new ProjectRoutingController({ store: journal, eligible: () => true, currentCwd: () => folder.cwd,
      classify: async () => ({ kind: 'ask', cwd: '/project', name: 'project', explicit: false }),
      move: async () => { throw new Error('Unexpected move') }, forward: () => { throw new Error('Unexpected send') },
      publish: () => {}, answerRefused: () => {}, log: () => {},
    })
    await held.submit(id, { type: 'app.submit', requestId: randomUUID(), prompt: 'Earlier unsent input', options: { submitId } }, 'Earlier unsent input')
    const pendingIds = new Set(journal.load().filter(row => row.outcome !== 'accepted').map(row => row.sessionId))
    const registry = new SessionRegistry({ storageDir: join(root, 'registry'), retainSession: session => pendingIds.has(session), log: () => {} })
    await registry.launch()
    const host = new Host({ supervisor, registry, managedStorage: storage, hasPendingSubmit: session => pendingIds.has(session), validateCwd: () => ({ ok: false }), log: () => {} })
    expect(host.listSessions().find(row => row.appSessionId === id)?.restorable).toBe(true)
    let accepted = false
    const recovered = new ProjectRoutingController({ store: journal, eligible: () => true, currentCwd: session => registry.findSession(session)?.cwd ?? null,
      classify: async () => ({ kind: 'stay' }), move: async () => { throw new Error('Unexpected move') },
      prepareForward: session => host.prepareRoutedSubmit(session), forward: (session, message) => { supervisor.send(session, message); return null },
      publish: () => {}, answerRefused: () => { throw new Error('Unexpected refusal') }, log: () => {},
    })
    supervisor.subscribe(event => {
      if (event.type === 'frame' && event.frame.kind === 'submit.result') {
        accepted = event.frame.accepted
        recovered.onSubmitResult(event.sessionId, event.frame.submitId, event.frame.accepted)
      }
    })
    await recovered.resolve({ appSessionId: id, submitId, choice: 'resend' })
    await until(() => accepted)
    expect(registry.findSession(id)).toMatchObject({ appSessionId: id, cwd: folder.cwd, binding: folder.binding })
    expect(registry.findSession(id)?.engineSessionId).toBeTruthy()
    expect(journal.load()[0]?.outcome).toBe('accepted')
  } finally {
    supervisor.shutdown()
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfig
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)
