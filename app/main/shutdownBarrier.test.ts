import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canReopenRuntime, createShutdownBarrier, settleShutdownTasks, shutdownFullyClean, type ShutdownResult } from './shutdownBarrier.js'
import { createOwnedWorkerShutdownTracker } from './ownedWorkerShutdown.js'
import { runNdjsonWorker } from './ndjsonWorker.js'
import { runWorkspaceTrustWorker } from './workspaceTrustRunner.js'
import { runSessionRelocationWorker } from './sessionRelocationRunner.js'

test('shutdown barrier closes admission once and waits for helpers before success', async () => {
  let starts = 0
  let finish!: () => void
  const helper = new Promise<void>(resolve => { finish = resolve })
  const barrier = createShutdownBarrier(() => {
    starts++
    return helper.then(() => ({ confirmed: true, unresolvedSessionIds: [] }))
  }, 1000)
  const pending = barrier()
  expect(starts).toBe(1)
  expect(barrier()).toBe(pending)
  let settled = false
  void pending.then(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  finish()
  expect(await pending).toEqual({ confirmed: true, unresolvedSessionIds: [] })
})

test('deadline or helper failure cannot report clean completion', async () => {
  expect(await createShutdownBarrier(() => new Promise(() => {}), 5)()).toEqual({ confirmed: false, unresolvedSessionIds: [] })
  expect(await createShutdownBarrier(async () => { throw new Error('helper failed') })()).toEqual({ confirmed: false, unresolvedSessionIds: [] })
})

test('synchronous teardown re-entry observes the already-published barrier', async () => {
  let starts = 0
  let nested: ReturnType<ReturnType<typeof createShutdownBarrier>> | undefined
  const barrier = createShutdownBarrier(async () => {
    starts++
    nested = barrier()
    return { confirmed: true, unresolvedSessionIds: [] }
  })
  const result = barrier()
  expect(nested).toBe(result)
  expect((await result).confirmed).toBe(true)
  expect(starts).toBe(1)
})

test('helper rejection still waits for captured runtime exits before settling', async () => {
  let finish!: (result: ShutdownResult) => void
  const runtime = new Promise<ShutdownResult>(resolve => { finish = resolve })
  let settled = false
  const pending = settleShutdownTasks(runtime, Promise.reject(new Error('helper failed')), Promise.resolve(true))
  void pending.then(() => { settled = true })
  await Promise.resolve()
  await Promise.resolve()
  expect(settled).toBe(false)
  finish({ confirmed: true, unresolvedSessionIds: [] })
  expect((await pending).confirmed).toBe(false)
})

test('confirmed exits do not hide failed durable clean marks or helper restoration', async () => {
  const result = await settleShutdownTasks(
    Promise.resolve({ confirmed: true, unresolvedSessionIds: [], persistenceConfirmed: false }),
    Promise.resolve({ processConfirmed: true, restorationConfirmed: false }),
    Promise.resolve(true),
  )
  expect(result.confirmed).toBe(true)
  expect(result.persistenceConfirmed).toBe(false)
  expect(result.restorationConfirmed).toBe(false)
  expect(shutdownFullyClean(result)).toBe(false)
  expect(shutdownFullyClean({ confirmed: true, unresolvedSessionIds: [], persistenceConfirmed: false })).toBe(false)
})

test('confirmed exits permit recovery UI after failed cleanup without reporting fully clean shutdown', () => {
  for (const cleanup of [{ persistenceConfirmed: false }, { restorationConfirmed: false }]) {
    const result = { confirmed: true, unresolvedSessionIds: [], ...cleanup }
    expect(canReopenRuntime(result)).toBe(true)
    expect(shutdownFullyClean(result)).toBe(false)
    expect(canReopenRuntime({ ...result, confirmed: false })).toBe(false)
  }
})

test('worker tracker retains uncertain identity until a late matching exit', async () => {
  const tracker = createOwnedWorkerShutdownTracker()
  tracker.observe('old-generation', { phase: 'started', pid: 100 })
  tracker.observe('new-generation', { phase: 'started', pid: 100 })
  tracker.observe('old-generation', { phase: 'termination-unconfirmed', pid: 100 })
  expect(await tracker.waitForExit(5)).toBe(false)
  tracker.observe('old-generation', { phase: 'exited', pid: 100 })
  expect(tracker.pendingPids()).toEqual([100])
  tracker.observe('new-generation', { phase: 'exited', pid: 100 })
  expect(await tracker.waitForExit(5)).toBe(true)
})

test('worker shutdown barrier waits for actual owned child exit', async () => {
  const tracker = createOwnedWorkerShutdownTracker()
  const controller = new AbortController()
  let armed!: () => void
  const ready = new Promise<void>(resolve => { armed = resolve })
  const run = runNdjsonWorker({
    command: process.execPath,
    args: ['-e', `process.on('SIGTERM',()=>{});console.log('armed');setInterval(()=>{},1000)`],
    cwd: tmpdir(), signal: controller.signal, timeoutMs: 2000, escalateKillAfterMs: 10,
    maxRecordBytes: 1024, onRecord: () => { armed(); return 'continue' }, onOversizeRecord() {},
    onWorkerLifecycle: event => tracker.observe('owned-fixture', event),
  })
  await ready
  const barrier = createShutdownBarrier(() => {
    controller.abort()
    return tracker.waitForExit(1000).then(confirmed => ({ confirmed, unresolvedSessionIds: [] }))
  })
  expect((await barrier()).confirmed).toBe(true)
  expect((await run).termination).toBe('confirmed')
  expect(tracker.pendingPids()).toEqual([])
})

test('trust and relocation runners publish captured lifecycle and cancel owned fixtures', async () => {
  for (const role of ['trust', 'relocation'] as const) {
    const tracker = createOwnedWorkerShutdownTracker()
    const abort = new AbortController()
    let started = false
    const options = {
      command: process.execPath,
      args: ['-e', `process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`],
      cwd: tmpdir(), signal: abort.signal,
      onWorkerLifecycle: (event: import('./ndjsonWorker.js').WorkerProcessLifecycle) => {
        tracker.observe(role, event)
        if (event.phase === 'started') { started = true; setTimeout(() => abort.abort(), 30) }
      },
    }
    const pending = role === 'trust'
      ? runWorkspaceTrustWorker({ ...options, request: { type: 'workspace.inspect', version: 1 } })
      : runSessionRelocationWorker({ ...options, request: {
        type: 'session-relocation', version: 1,
        appSessionId: '00000000-0000-4000-8000-000000000001',
        engineSessionId: '00000000-0000-4000-8000-000000000002',
        source: { cwd: '/fixture-source', binding: { kind: 'project' } },
        target: { cwd: '/fixture-target', binding: { kind: 'project' } },
        controls: { mode: 'default', model: null, fastMode: false },
      } })
    await expect(pending).rejects.toThrow()
    expect(started).toBe(true)
    expect(await tracker.waitForExit(100)).toBe(true)
    expect(tracker.pendingPids()).toEqual([])
  }
})

for (const route of ['signal', 'quit'] as const) {
  test(`isolated ${route} parent exits only after the runtime shutdown barrier`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'shutdown-barrier-'))
    const marker = join(root, 'armed')
    const completed = join(root, 'completed')
    const supervisorPath = new URL('../supervisor/supervisor.ts', import.meta.url).pathname
    const barrierPath = new URL('./shutdownBarrier.ts', import.meta.url).pathname
    const child = `process.on('SIGTERM',()=>{});require('node:net').createServer(()=>{}).listen(process.env.CATCODE_SIDECAR_SOCKET,()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid)));`
    const script = `import {SidecarSupervisor} from ${JSON.stringify(supervisorPath)};
      import {createShutdownBarrier} from ${JSON.stringify(barrierPath)};
      import {existsSync,writeFileSync} from 'node:fs';
      const s=new SidecarSupervisor({sidecarCommand:process.execPath,sidecarArgs:['-e',${JSON.stringify(child)}],socketDir:${JSON.stringify(join(root, 'sockets'))},killGraceMs:20});
      const barrier=createShutdownBarrier(()=>s.shutdown(),1500);
      const finish=async()=>{const p=barrier();if(p!==barrier())throw Error('duplicate teardown');const result=await p;if(!result.confirmed)throw Error('unconfirmed');writeFileSync(${JSON.stringify(completed)},'confirmed');process.exit(0)};
      process.on('SIGTERM',()=>{void finish()});
      s.spawnSession('owned');
      while(!existsSync(${JSON.stringify(marker)}))await Bun.sleep(5);
      ${route === 'quit' ? 'await finish();' : 'setInterval(()=>{},1000);'}`
    const parent = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
    let pid: number | undefined
    const alive = (id: number) => { try { process.kill(id, 0); return true } catch { return false } }
    try {
      const deadline = Date.now() + 3000
      while (!existsSync(marker)) { if (Date.now() > deadline) throw new Error('fixture did not start'); await Bun.sleep(5) }
      pid = Number(readFileSync(marker, 'utf8'))
      if (route === 'signal') parent.kill('SIGTERM')
      expect(await parent.exited).toBe(0)
      expect(existsSync(completed)).toBe(true)
      expect(alive(pid)).toBe(false)
    } finally {
      if (parent.exitCode === null) parent.kill('SIGKILL')
      if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
      rmSync(root, { recursive: true, force: true })
    }
  })
}
