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

const dirs: string[] = []
const supervisors: SidecarSupervisor[] = []
const managers: ScheduledTasks[] = []
afterEach(() => { for (const manager of managers.splice(0)) manager.stop(); for (const supervisor of supervisors.splice(0)) supervisor.shutdown(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
async function waitFor(predicate: () => boolean) { const deadline = Date.now() + 20_000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Scheduled process did not settle'); await Bun.sleep(10) } }

for (const trusted of [true, false]) test(`scheduled dispatch uses the host, socket, and real permission boundary (${trusted ? 'trusted' : 'untrusted'})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccsched-')); dirs.push(dir)
  const project = join(dir, 'project'); mkdirSync(project)
  const sockets = join(dir, 's'); mkdirSync(sockets)
  const fixture = join(dirname(fileURLToPath(import.meta.url)), '../sidecar/scheduledTask.fixture.ts')
  const supervisor = new SidecarSupervisor({ sidecarCommand: process.execPath, sidecarArgs: ['run', fixture], sidecarCwd: project, socketDir: sockets,
    sidecarEnv: { CLAUDE_CONFIG_DIR: join(dir, 'config'), SCHEDULED_FIXTURE_TRUSTED: trusted ? '1' : '0' }, log: () => {} }); supervisors.push(supervisor)
  const registry = new SessionRegistry({ storageDir: join(dir, 'registry'), log: () => {}, transcriptPathFor: (_cwd, id) => join(dir, `${id}.jsonl`) })
  const host = new Host({ supervisor, registry, validateCwd: cwd => cwd === project ? { ok: true, realpath: realpathSync(cwd) } : { ok: false }, log: () => {} })
  const file = join(dir, 'scheduled.json')
  const manager = new ScheduledTasks(file, { launch: (task, id) => launchScheduledSession(host, supervisor, task, id), submit: (id, prompt, submitId) => {
    const options = { submitId, isMeta: false }
    supervisor.send(id, { type: 'app.submit', requestId: submitId, prompt, options })
    return true
  } }); managers.push(manager)
  let permissionId: string | null = null
  supervisor.subscribe(event => {
    const frame = supervisorEventToServerFrame(event)
    if (!frame) return
    manager.receive(event.sessionId, frame)
    if (frame.kind === 'event' && frame.event.type === 'permission.requested') permissionId = frame.event.request.requestId
  })
  const input: ScheduledTaskInput = { name: 'Native scheduled task', prompt: 'A unique scheduled prompt', enabled: true, schedule: { kind: 'interval', minutes: 1 }, model: 'gpt-6-luna', effort: 'max', permissionMode: 'auto' }
  const task = manager.save(input, project)
  manager.run(task.id)
  await waitFor(() => trusted ? manager.snapshot().runs[0]?.status === 'waiting' : manager.snapshot().runs[0]?.status === 'failed')
  const run = manager.snapshot().runs[0]!
  expect(host.listSessions().find(row => row.appSessionId === run.appSessionId)?.cwd).toBe(project)
  if (trusted) {
    expect(permissionId as string | null).toBe('scheduled-permission')
    expect(() => manager.run(task.id)).toThrow('unfinished run')
    supervisor.send(run.appSessionId, { type: 'permission.response', requestId: permissionId!, response: { behavior: 'allow', updatedInput: { command: 'pwd' } } })
    await waitFor(() => manager.snapshot().runs[0]?.status === 'completed')
    expect(manager.snapshot().runs[0]?.summary).toBe(input.prompt)
    expect(JSON.parse(readFileSync(file, 'utf8')).runs[0].status).toBe('completed')
  } else {
    expect(permissionId).toBeNull()
    expect(manager.snapshot().runs[0]?.summary).toContain('refused')
  }
}, 30_000)
