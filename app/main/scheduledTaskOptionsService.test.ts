import { expect, test } from 'bun:test'
import { ScheduledTaskOptionsService } from './scheduledTaskOptionsService.js'
import type { ScheduledTaskOptionsResult } from '../shared/scheduledTaskOptions.js'
const catalog: ScheduledTaskOptionsResult = { type: 'scheduled-options-result', version: 1,
  models: [], defaultEffortOptions: ['high'], projectPaths: ['/project', '/alias', '/missing'] }

test('saved project options deduplicate canonical directories and retain handles without any chats', async () => {
  let existing = true
  const service = new ScheduledTaskOptionsService(async () => catalog, path =>
    path !== '/missing' && existing ? { ok: true, realpath: '/project' } : { ok: false })
  const first = await service.read()
  expect(first.projects).toHaveLength(1)
  const id = first.projects[0]!.workspaceId
  expect(id).not.toBe('/project')
  expect((await service.read()).projects[0]!.workspaceId).toBe(id)
  expect(service.resolve(id)).toBe('/project')
  expect(service.resolve(crypto.randomUUID())).toBeUndefined()
  existing = false
  expect(service.resolve(id)).toBeUndefined()
  expect((await service.read()).projects).toEqual([])
  existing = true
  expect((await service.read()).projects[0]!.workspaceId).toBe(id)
})

test('concurrent reads share a worker and read failures expose errors rather than defaults', async () => {
  let calls = 0
  let release!: (result: ScheduledTaskOptionsResult) => void
  const service = new ScheduledTaskOptionsService(() => {
    calls++
    return new Promise(resolve => { release = resolve })
  }, () => ({ ok: false }))
  const first = service.read()
  const second = service.read()
  expect(first).toBe(second)
  expect(calls).toBe(1)
  release(catalog)
  expect((await first).defaultEffortOptions).toEqual(['high'])
  const failed = new ScheduledTaskOptionsService(async () => { throw new Error('read failed') }, () => ({ ok: false }))
  expect(await failed.read()).toEqual({ models: [], projects: [], defaultEffortOptions: [], error: 'Scheduled task options could not be read. Try again.' })
})

test('project handles cannot be redirected by a changed canonical path', async () => {
  let canonical = '/project'
  const service = new ScheduledTaskOptionsService(async () => catalog, () => ({ ok: true, realpath: canonical }))
  const id = (await service.read()).projects[0]!.workspaceId
  canonical = '/replacement'
  expect(service.resolve(id)).toBeUndefined()
})
