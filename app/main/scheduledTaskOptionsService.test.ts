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
  expect((await service.read({ refresh: true })).projects).toEqual([])
  existing = true
  expect((await service.read({ refresh: true })).projects[0]!.workspaceId).toBe(id)
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

test('successful catalogs cache for five minutes, refresh bypasses and failures retain last good with bounded retries', async () => {
  let now = 1_000
  let calls = 0
  let fail = false
  const service = new ScheduledTaskOptionsService(async () => {
    calls++
    if (fail) throw new Error('offline')
    return catalog
  }, () => ({ ok: false }), () => now)
  const first = await service.read()
  expect(first.updatedAt).toBe(now)
  now += 299_999
  expect(await service.read()).toBe(first)
  expect(calls).toBe(1)
  now++
  expect((await service.read()).updatedAt).toBe(now)
  expect(calls).toBe(2)
  expect((await service.read({ refresh: true })).updatedAt).toBe(now)
  expect(calls).toBe(3)
  fail = true
  const failed = await service.read({ refresh: true })
  expect(failed.error).toBeDefined()
  expect(failed.updatedAt).toBe(now)
  expect(failed.defaultEffortOptions).toEqual(['high'])
  for (let i = 0; i < 20; i++) {
    expect(await service.read()).toBe(failed)
  }
  expect(calls).toBe(4)
  now += 30_000
  fail = false
  const recovered = await service.read()
  expect(recovered.error).toBeUndefined()
  expect(recovered.updatedAt).toBe(now)
  expect(calls).toBe(5)
})

test('first read failures have no timestamp and share an automatic retry cooldown', async () => {
  let now = 0
  let calls = 0
  const service = new ScheduledTaskOptionsService(async () => {
    calls++
    throw new Error('offline')
  }, () => ({ ok: false }), () => now)
  expect((await service.read()).updatedAt).toBeUndefined()
  await service.read()
  expect(calls).toBe(1)
  now = 30_000
  await service.read()
  expect(calls).toBe(2)
})

test('catalog mutation invalidation expires cache and in-flight reads cannot renew its freshness', async () => {
  let calls = 0
  let release!: (value: ScheduledTaskOptionsResult) => void
  const service = new ScheduledTaskOptionsService(() => {
    calls++
    return new Promise(resolve => { release = resolve })
  }, () => ({ ok: false }), () => 1_000)
  const first = service.read()
  service.invalidate()
  release(catalog)
  const obsolete = await first
  expect(obsolete.error).toBeDefined()
  expect(obsolete.updatedAt).toBeUndefined()
  const next = service.read()
  expect(calls).toBe(2)
  release(catalog)
  await next
  await service.read()
  expect(calls).toBe(2)
  service.invalidate()
  const refreshed = service.read()
  expect(calls).toBe(3)
  release(catalog)
  await refreshed
})

test('explicit refresh retries immediately after a failed read without changing the automatic cooldown', async () => {
  let calls = 0
  let fail = true
  const service = new ScheduledTaskOptionsService(async () => {
    calls++
    if (fail) throw new Error('offline')
    return catalog
  }, () => ({ ok: false }), () => 1_000)
  expect((await service.read()).error).toBeDefined()
  fail = false
  expect((await service.read()).error).toBeDefined()
  expect(calls).toBe(1)
  const refreshed = await service.read({ refresh: true })
  expect(refreshed.error).toBeUndefined()
  expect(refreshed.updatedAt).toBe(1_000)
  expect(calls).toBe(2)
})

test('a read invalidated in flight retains the prior catalog with a warning, not a fresh timestamp', async () => {
  let now = 1_000
  let release!: (value: ScheduledTaskOptionsResult) => void
  let deferred = false
  const service = new ScheduledTaskOptionsService(() => deferred
    ? new Promise(resolve => { release = resolve })
    : Promise.resolve(catalog), () => ({ ok: false }), () => now)
  const first = await service.read()
  now = 2_000
  deferred = true
  const pending = service.read({ refresh: true })
  service.invalidate()
  release({ ...catalog, defaultEffortOptions: ['low'] })
  const stale = await pending
  expect(stale.updatedAt).toBe(first.updatedAt)
  expect(stale.defaultEffortOptions).toEqual(['high'])
  expect(stale.error).toBeDefined()
  const next = service.read()
  release({ ...catalog, defaultEffortOptions: ['low'] })
  const current = await next
  expect(current.updatedAt).toBe(now)
  expect(current.defaultEffortOptions).toEqual(['low'])
  expect(current.error).toBeUndefined()
})
