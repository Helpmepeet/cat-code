import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScheduledTasks, nextTaskOccurrence, type ScheduledTasksPorts } from './scheduledTasks.js'
import type { ScheduledTaskInput } from '../shared/scheduledTasks.js'
import { PROTOCOL_VERSION } from '../shared/protocol.js'
import type { ServerFrame } from '../shared/protocol.js'

const dirs: string[] = []
const managers: ScheduledTasks[] = []
afterEach(() => { for (const manager of managers.splice(0)) manager.stop(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const input: ScheduledTaskInput = { name: 'Daily maintenance', prompt: 'Inspect the project', schedule: { kind: 'daily', time: '03:00', timeZone: 'Asia/Bangkok', day: 0 }, enabled: true, model: '', effort: 'default', permissionMode: 'auto' }
function setup(ports: Partial<ScheduledTasksPorts> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'catcode-schedule-')); dirs.push(dir)
  const file = join(dir, 'tasks.json')
  const launched: string[] = []; const submitted: string[] = []
  const manager = new ScheduledTasks(file, { launch: async (_task, id) => { launched.push(id) }, submit: (_id, prompt) => { submitted.push(prompt); return true }, ...ports })
  managers.push(manager)
  return { manager, file, launched, submitted }
}
function event(sessionId: string, body: unknown): Extract<ServerFrame, { kind: 'event' }> { return { kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId, event: body } as unknown as Extract<ServerFrame, { kind: 'event' }> }
async function flush() { await Promise.resolve(); await Promise.resolve() }

test('saved Bangkok wall-clock schedules survive reopening; overdue work dispatches once and overlap is refused', async () => {
  const h = setup()
  const task = h.manager.save(input, '/project', Date.parse('2026-10-12T18:00:00Z'))
  expect(task.nextRunAt).toBe(Date.parse('2026-10-12T20:00:00Z'))
  const reopened = new ScheduledTasks(h.file, { launch: async (_task, id) => { h.launched.push(id) }, submit: () => true }); managers.push(reopened)
  reopened.tick(Date.parse('2026-10-15T21:00:00Z'))
  reopened.tick(Date.parse('2026-10-15T21:01:00Z'))
  await flush()
  expect(h.launched).toHaveLength(1)
  expect(reopened.snapshot().tasks[0]?.nextRunAt).toBe(Date.parse('2026-10-16T20:00:00Z'))
  expect(() => reopened.run(task.id)).toThrow('unfinished run')
  expect(reopened.snapshot().runs[0]?.scheduledAt).toBe(Date.parse('2026-10-12T20:00:00Z'))
})

test('a run claim and chat identity reach disk before launch; launch is awaited and ready repeats cannot double-submit', async () => {
  let allowReady!: () => void
  const ready = new Promise<void>(resolve => { allowReady = resolve })
  let claimed = false
  const h = setup({ launch: async (_task, id) => {
    const disk = JSON.parse(readFileSync(h.file, 'utf8'))
    claimed = disk.runs[0].appSessionId === id && disk.runs[0].status === 'starting'
    await ready
  } })
  const task = h.manager.save(input, '/project')
  h.manager.run(task.id)
  const run = h.manager.snapshot().runs[0]!
  const frame = { kind: 'ready', sessionId: run.appSessionId, protocolVersion: PROTOCOL_VERSION } as unknown as ServerFrame
  h.manager.receive(run.appSessionId, frame)
  expect(claimed).toBe(true)
  expect(h.submitted).toEqual([])
  allowReady(); await flush()
  h.manager.receive(run.appSessionId, frame)
  expect(h.submitted).toEqual([input.prompt])
})

test('permission waits remain unfinished, replay cannot settle a run, and live result survives task deletion', async () => {
  const h = setup(); const task = h.manager.save(input, '/project'); h.manager.run(task.id); await flush()
  const run = h.manager.snapshot().runs[0]!
  h.manager.receive(run.appSessionId, event(run.appSessionId, { type: 'permission.requested' }))
  expect(h.manager.snapshot().runs[0]?.status).toBe('waiting')
  const result = event(run.appSessionId, { type: 'message', message: { type: 'result', subtype: 'success', is_error: false, result: 'No changes needed' } })
  h.manager.receive(run.appSessionId, { ...result, replay: true })
  expect(h.manager.snapshot().runs[0]?.status).toBe('waiting')
  h.manager.change('delete', task.id)
  h.manager.receive(run.appSessionId, result)
  expect(h.manager.snapshot().runs[0]?.status).toBe('waiting')
  expect(() => h.manager.run(task.id)).toThrow()
  h.manager.receive(run.appSessionId, event(run.appSessionId, { type: 'turn.status', activeTurn: false }))
  const disk = JSON.parse(readFileSync(h.file, 'utf8'))
  expect(disk.tasks).toEqual([])
  expect(disk.runs[0].status).toBe('completed')
  expect(disk.runs[0].summary).toBe('No changes needed')
})

test('crash recovery records interruption without resubmitting the saved run; pause survives restart', async () => {
  const h = setup(); const task = h.manager.save(input, '/project'); h.manager.run(task.id); await flush(); h.manager.change('pause', task.id)
  const launches: string[] = []
  const reopened = new ScheduledTasks(h.file, { launch: async (_task, id) => { launches.push(id) }, submit: () => true }); managers.push(reopened)
  reopened.tick(Date.now() + 30 * 86400_000)
  expect(reopened.snapshot().runs[0]?.status).toBe('interrupted')
  expect(reopened.snapshot().tasks[0]?.enabled).toBe(false)
  expect(launches).toEqual([])
})

test('failed durable claims launch nothing; corrupt storage is preserved', () => {
  const h = setup(); const task = h.manager.save(input, '/project')
  rmSync(h.file); mkdirSync(h.file)
  expect(() => h.manager.run(task.id)).toThrow('could not be saved')
  h.manager.tick(Date.now() + 86400_000)
  expect(h.launched).toEqual([])
  expect(h.manager.snapshot().error).toContain('Scheduling has stopped')
  rmSync(h.file, { recursive: true }); writeFileSync(h.file, '{broken')
  expect(() => new ScheduledTasks(h.file, { launch: async () => {}, submit: () => true })).toThrow()
  expect(readFileSync(h.file, 'utf8')).toBe('{broken')
})

test('failed launch and refused submit are terminal, without automatic redelivery', async () => {
  const h = setup({ launch: async () => { throw new Error('Folder disappeared') } }); const task = h.manager.save(input, '/project')
  h.manager.run(task.id); await flush()
  expect(h.manager.snapshot().runs[0]?.status).toBe('failed')
  expect(h.submitted).toEqual([])
  const accepted = setup(); const second = accepted.manager.save(input, '/project'); accepted.manager.run(second.id); await flush()
  const run = accepted.manager.snapshot().runs[0]!
  accepted.manager.receive(run.appSessionId, { kind: 'submit.result', protocolVersion: PROTOCOL_VERSION, sessionId: run.appSessionId, submitId: run.id, accepted: false, code: 'unauthorized' })
  expect(accepted.manager.snapshot().runs[0]?.status).toBe('failed')
  expect(accepted.submitted).toHaveLength(1)
})

test('weekly and weekday rules use the saved zone; DST gaps skip and repeated local minutes fire once', () => {
  expect(nextTaskOccurrence({ kind: 'weekdays', time: '09:00', timeZone: 'Asia/Bangkok', day: 0 }, Date.parse('2026-10-16T03:00:00Z'))).toBe(Date.parse('2026-10-19T02:00:00Z'))
  expect(nextTaskOccurrence({ kind: 'weekly', time: '03:00', timeZone: 'Asia/Bangkok', day: 0 }, Date.parse('2026-10-13T00:00:00Z'))).toBe(Date.parse('2026-10-17T20:00:00Z'))
  expect(nextTaskOccurrence({ kind: 'daily', time: '02:30', timeZone: 'America/New_York', day: 0 }, Date.parse('2026-03-08T06:59:00Z'))).toBe(Date.parse('2026-03-09T06:30:00Z'))
  expect(nextTaskOccurrence({ kind: 'daily', time: '01:30', timeZone: 'America/New_York', day: 0 }, Date.parse('2026-11-01T05:40:15Z'))).toBe(Date.parse('2026-11-02T06:30:00Z'))
})
