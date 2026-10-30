import { expect, test } from 'bun:test'
import type { HostResult } from '../shared/hostApi.js'
import { SessionCloseCoordinator, type SessionCloseDependencies } from './sessionCloseCoordinator.js'

const ok: HostResult<void> = { ok: true, value: undefined }
const refused: HostResult<void> = { ok: false, error: { code: 'session_unreachable', message: 'foreign owner' } }
function fixture(overrides: Partial<SessionCloseDependencies> = {}) {
  const calls: string[] = []
  const coordinator = new SessionCloseCoordinator({
    authorize: async () => { calls.push('authorize'); return ok },
    blocked: () => false,
    cancel: async () => { calls.push('cancel') },
    observe: () => { calls.push('observe') },
    close: async () => { calls.push('close'); return ok },
    timeoutMs: 25, retryMs: 1, ...overrides,
  })
  return { calls, coordinator }
}

test('authorizes before cancellation and never cancels a foreign owner', async () => {
  const h = fixture({ authorize: async () => refused })
  expect(await h.coordinator.close('id')).toEqual(refused)
  expect(h.calls).toEqual([])
})

test('waits for safe settlement and coalesces repeated requests', async () => {
  let reserved = true
  const h = fixture({ blocked: () => reserved, observe: () => { reserved = false } })
  const first = h.coordinator.close('id')
  expect(h.coordinator.close('id')).toBe(first)
  expect(await first).toEqual(ok)
  expect(h.calls).toEqual(['authorize', 'cancel', 'authorize', 'cancel', 'close'])
})

test('uncertain move times out without killing and permits explicit retry', async () => {
  let reserved = true
  const h = fixture({ blocked: () => reserved })
  const result = await h.coordinator.close('id')
  expect(result.ok).toBe(false)
  expect(h.calls).not.toContain('close')
  reserved = false
  expect(await h.coordinator.close('id')).toEqual(ok)
})

test.each(['cancel', 'close'] as const)('throwing %s reports failed stop and permits retry', async stage => {
  let fail = true
  const h = fixture({ [stage]: async () => {
    if (fail) throw new Error('controlled failure')
    return stage === 'close' ? ok : undefined
  } } as Partial<SessionCloseDependencies>)
  expect((await h.coordinator.close('id')).ok).toBe(false)
  fail = false
  expect((await h.coordinator.close('id')).ok).toBe(true)
})

test('stalled cancellation is bounded and cannot later kill after timeout', async () => {
  let release!: () => void
  const h = fixture({ cancel: () => new Promise<void>(resolve => { release = resolve }) })
  expect((await h.coordinator.close('id')).ok).toBe(false)
  release()
  await Promise.resolve()
  await Promise.resolve()
  expect(h.calls).not.toContain('close')
})

test('stalled host cleanup returns an honest bounded failure', async () => {
  const h = fixture({ close: () => new Promise<HostResult<void>>(() => {}) })
  const pending = h.coordinator.close('id')
  expect(h.coordinator.isPending('id')).toBe(true)
  expect((await pending).ok).toBe(false)
  expect(h.coordinator.isPending('id')).toBe(false)
})

test('changed ownership during settlement prevents further cancellation and stop', async () => {
  let authorizations = 0
  const h = fixture({ authorize: async () => ++authorizations === 1 ? ok : refused, blocked: () => true })
  expect(await h.coordinator.close('id')).toEqual(refused)
  expect(h.calls).toEqual(['cancel'])
})
