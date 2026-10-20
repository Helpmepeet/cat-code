import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Host } from '../host/host.js'
import { SessionRegistry } from '../host/registry.js'
import { ScheduledTasks } from '../host/scheduledTasks.js'
import { SidecarSupervisor } from '../supervisor/supervisor.js'
import { launchScheduledSession } from './scheduledTaskRunner.js'
import { supervisorEventToServerFrame } from './mainDecisions.js'
import type { ScheduledTaskInput } from '../shared/scheduledTasks.js'
import { PROTOCOL_VERSION } from '../shared/protocol.js'

const dirs: string[] = []
const supervisors: SidecarSupervisor[] = []
const managers: ScheduledTasks[] = []
afterEach(() => { for (const manager of managers.splice(0)) manager.stop(); for (const supervisor of supervisors.splice(0)) supervisor.shutdown(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
async function waitFor(predicate: () => boolean) { const deadline = Date.now() + 20_000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Scheduled process did not settle'); await Bun.sleep(10) } }

function setup(trusted: boolean, options: { now?: () => number; registryFailure?: boolean; socketLossRoute?: 'host' | 'lifecycle' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ccsched-')); dirs.push(dir)
  const project = join(dir, 'project'); mkdirSync(project)
  const sockets = join(dir, 's'); mkdirSync(sockets)
  const fixture = join(dirname(fileURLToPath(import.meta.url)), '../sidecar/scheduledTask.fixture.ts')
  const socketLossFixture = `
    const { writeFileSync } = require('node:fs')
    const { join } = require('node:path')
    const sessionId = process.env.CATCODE_SIDECAR_SESSION_ID
    function send(socket, frame) {
      const body = Buffer.from(JSON.stringify(frame))
      const prefix = Buffer.alloc(4)
      prefix.writeUInt32BE(body.length)
      socket.write(Buffer.concat([prefix, body]))
    }
    let executing = false
    let ticks = 0
    let pending = Buffer.alloc(0)
    Bun.listen({
      unix: process.env.CATCODE_SIDECAR_SOCKET,
      socket: {
        open(socket) {
          send(socket, { kind: 'ready', protocolVersion: ${PROTOCOL_VERSION}, sessionId,
            engineSessionId: 'synthetic-' + sessionId,
            payload: { type: 'app.ready', protocolVersion: 1, inputEnabled: true } })
        },
        data(socket, chunk) {
          pending = Buffer.concat([pending, chunk])
          while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE(0)) {
            const length = pending.readUInt32BE(0)
            const command = JSON.parse(pending.subarray(4, 4 + length).toString())
            pending = pending.subarray(4 + length)
            if (command.message?.type !== 'app.submit' || executing) continue
            executing = true
            setInterval(() => writeFileSync(join(process.cwd(), sessionId + '.heartbeat'), String(++ticks)), 10)
            socket.end()
          }
        }
      }
    })
    setInterval(() => {}, 1000)
  `
  const supervisor = new SidecarSupervisor({ sidecarCommand: process.execPath, sidecarArgs: options.socketLossRoute ? ['-e', socketLossFixture] : ['run', fixture], sidecarCwd: project, socketDir: sockets,
    sidecarEnv: { CLAUDE_CONFIG_DIR: join(dir, 'config'), SCHEDULED_FIXTURE_TRUSTED: trusted ? '1' : '0' }, log: () => {} }); supervisors.push(supervisor)
  const registry = new SessionRegistry({ storageDir: join(dir, 'registry'), log: () => {}, transcriptPathFor: (_cwd, id) => join(dir, `${id}.jsonl`),
    ...(options.registryFailure ? { acquireLock: async () => { throw new Error('Fixture storage unavailable') } } : {}) })
  const host = new Host({ supervisor, registry, validateCwd: cwd => cwd === project ? { ok: true, realpath: realpathSync(cwd) } : { ok: false }, log: () => {}, ...(options.now ? { now: options.now } : {}) })
  const file = join(dir, 'scheduled.json')
  const submitted: string[] = []
  const manager = new ScheduledTasks(file, { launch: (task, id) => launchScheduledSession(host, supervisor, task, id, registry), submit: (id, prompt, submitId) => {
    submitted.push(id)
    const options = { submitId, isMeta: false }
    supervisor.send(id, { type: 'app.submit', requestId: submitId, prompt, options })
    return true
  } }); managers.push(manager)
  host.subscribe(event => { if (options.socketLossRoute !== 'lifecycle') manager.receiveHostEvent(event) })
  const permissionIds: string[] = []
  const resolvedIds: string[] = []
  supervisor.subscribe(event => {
    const frame = supervisorEventToServerFrame(event)
    if (!frame) return
    if (options.socketLossRoute === 'host' && frame.kind === 'lifecycle' && frame.status === 'disconnected') return
    manager.receive(event.sessionId, frame)
    if (frame.kind === 'event' && frame.event.type === 'permission.requested') permissionIds.push(frame.event.request.requestId)
    if (frame.kind === 'event' && frame.event.type === 'permission.resolved') resolvedIds.push(frame.event.request.requestId)
  })
  return { dir, project, file, supervisor, registry, host, manager, submitted, permissionIds, resolvedIds }
}
const input: ScheduledTaskInput = { name: 'Native scheduled task', prompt: 'A unique scheduled prompt', enabled: true, schedule: { kind: 'interval', minutes: 1 }, model: 'gpt-6-luna', effort: 'max', permissionMode: 'auto' }
for (const route of ['host', 'lifecycle'] as const) test(`a real socket disconnect retains overlap protection through the ${route} path until process exit`, async () => {
  const h = setup(true, { socketLossRoute: route })
  const task = h.manager.save(input, h.project)
  h.manager.run(task.id)
  await waitFor(() => h.host.listSessions().some(row => row.status === 'disconnected'))
  const run = h.manager.snapshot().runs[0]!
  const pid = h.supervisor.getSessionProcessId(run.appSessionId)!
  const heartbeat = join(h.project, `${run.appSessionId}.heartbeat`)
  await waitFor(() => { try { return Number(readFileSync(heartbeat, 'utf8')) > 0 } catch { return false } })
  const before = Number(readFileSync(heartbeat, 'utf8'))
  await waitFor(() => Number(readFileSync(heartbeat, 'utf8')) > before)
  expect(() => process.kill(pid, 0)).not.toThrow()
  expect(run.endedAt).toBeNull()
  expect(run.status).toBe('submitted')
  h.manager.tick(task.nextRunAt)
  expect(() => h.manager.run(task.id)).toThrow('unfinished run')
  expect(h.host.listSessions()).toHaveLength(1)
  expect(h.submitted).toEqual([run.appSessionId])
  expect(JSON.parse(readFileSync(h.file, 'utf8')).runs[0].endedAt).toBeNull()

  // Signal only this fixture PID; the production supervisor must observe its exit.
  process.kill(pid, 'SIGTERM')
  await waitFor(() => h.supervisor.listSessions().some(row => row.sessionId === run.appSessionId && row.status === 'exited'))
  await waitFor(() => h.manager.snapshot().runs[0]?.status === 'interrupted')
  expect(h.manager.snapshot().runs[0]?.endedAt).not.toBeNull()
  if (route === 'host') h.manager.tick(task.nextRunAt)
  else h.manager.run(task.id)
  await waitFor(() => h.submitted.length === 2)
  expect(h.manager.snapshot().runs).toHaveLength(2)
}, 30_000)

for (const trusted of [true, false]) test(`scheduled dispatch uses the host, socket, and real permission boundary (${trusted ? 'trusted' : 'untrusted'})`, async () => {
  const { manager, project, host, permissionIds, resolvedIds, supervisor, file } = setup(trusted)
  const task = manager.save(input, project)
  manager.run(task.id)
  await waitFor(() => trusted ? manager.snapshot().runs[0]?.status === 'waiting' : manager.snapshot().runs[0]?.status === 'failed')
  const run = manager.snapshot().runs[0]!
  expect(host.listSessions().find(row => row.appSessionId === run.appSessionId)?.cwd).toBe(realpathSync(project))
  if (trusted) {
    await waitFor(() => permissionIds.length === 2)
    expect(permissionIds).toEqual(['scheduled-permission', 'scheduled-permission-two'])
    expect(JSON.parse(readFileSync(join(project, `.scheduled-controls-${run.appSessionId}.json`), 'utf8'))).toEqual({ model: input.model, effort: input.effort, permissionMode: input.permissionMode })
    expect(() => manager.run(task.id)).toThrow('unfinished run')
    supervisor.send(run.appSessionId, { type: 'permission.response', requestId: permissionIds[0]!, response: { behavior: 'allow', updatedInput: { command: 'pwd' } } })
    await waitFor(() => resolvedIds.length === 1)
    expect(manager.snapshot().runs[0]?.status).toBe('waiting')
    expect(manager.snapshot().runs[0]?.summary).toContain('pending request')
    supervisor.send(run.appSessionId, { type: 'permission.response', requestId: permissionIds[1]!, response: { behavior: 'allow', updatedInput: { command: 'pwd' } } })
    await waitFor(() => manager.snapshot().runs[0]?.status === 'completed')
    expect(manager.snapshot().runs[0]?.summary).toBe(input.prompt)
    expect(JSON.parse(readFileSync(file, 'utf8')).runs[0].status).toBe('completed')
  } else {
    expect(permissionIds).toEqual([])
    expect(manager.snapshot().runs[0]?.summary).toContain('refused')
  }
}, 30_000)

test('a due burst keeps the same claim through definite admission refusal and eventually admits every task', async () => {
  let now = Date.now()
  const h = setup(true, { now: () => now })
  for (let i = 0; i < 9; i++) h.manager.save({ ...input, name: `Burst ${i}`, model: '', effort: 'default', permissionMode: 'default' }, h.project, now - 60_000)
  h.manager.tick(now)
  await waitFor(() => h.manager.snapshot().runs.filter(run => run.status === 'waiting' || run.status === 'failed').length >= 8)
  const queued = h.manager.snapshot().runs.find(run => run.taskName === 'Burst 8')!
  expect(queued.status).toBe('starting')
  expect(h.host.listSessions()).toHaveLength(8)
  h.manager.change('delete', queued.taskId)
  now += 15_000; h.manager.tick(now)
  await waitFor(() => h.manager.snapshot().runs.every(run => run.status === 'waiting'))
  expect(h.manager.snapshot().runs.find(run => run.id === queued.id)?.appSessionId).toBe(queued.appSessionId)
  expect(new Set(h.submitted).size).toBe(9)
  expect(h.submitted).toHaveLength(9)
  expect(JSON.parse(readFileSync(join(h.project, `.scheduled-controls-${queued.appSessionId}.json`), 'utf8'))).toEqual({ model: '', effort: '', permissionMode: 'default' })
}, 30_000)

test('closing an owned waiting chat settles its run and permits the next claim', async () => {
  const h = setup(true); const task = h.manager.save(input, h.project); h.manager.run(task.id)
  await waitFor(() => h.manager.snapshot().runs[0]?.status === 'waiting')
  const run = h.manager.snapshot().runs[0]!
  expect((await h.host.closeSession(run.appSessionId)).ok).toBe(true)
  expect(h.manager.snapshot().runs[0]?.status).toBe('interrupted')
  expect(JSON.parse(readFileSync(h.file, 'utf8')).runs[0].status).toBe('interrupted')
  expect(h.supervisor.listSessions()).toHaveLength(0)
  expect(() => h.manager.run(task.id)).not.toThrow()
  await waitFor(() => h.manager.snapshot().runs[0]?.status === 'waiting')
}, 30_000)

test('registry publication failure cannot submit scheduled work', async () => {
  const h = setup(true, { registryFailure: true }); const task = h.manager.save(input, h.project); h.manager.run(task.id)
  await waitFor(() => ['waiting', 'failed'].includes(h.manager.snapshot().runs[0]?.status ?? ''))
  expect(h.registry.lastWriteFailed).toBe(true)
  expect(h.manager.snapshot().runs[0]?.status).toBe('failed')
  expect(h.submitted).toEqual([])
}, 30_000)
