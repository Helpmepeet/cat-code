import { expect, test } from 'bun:test'
import { waitForClaudeRefreshPreparation } from './claudeTokenRefresh.js'

test('cancelled waiter does not cancel or consume another waiter’s shared result', async () => {
  const operation = Promise.withResolvers<{ status: 'ready' }>()
  const controller = new AbortController()
  const first = waitForClaudeRefreshPreparation(operation.promise, { signal: controller.signal })
  const second = waitForClaudeRefreshPreparation(operation.promise)
  controller.abort()
  expect(await first).toEqual({ status: 'waiting', reason: 'cancelled' })
  operation.resolve({ status: 'ready' })
  expect(await second).toEqual({ status: 'ready' })
})

test('timeout ends only the waiter and later callers can observe completion', async () => {
  const operation = Promise.withResolvers<string>()
  expect(await waitForClaudeRefreshPreparation(operation.promise, { waitTimeoutMs: 1 }))
    .toEqual({ status: 'waiting', reason: 'timeout' })
  operation.resolve('saved')
  expect(await waitForClaudeRefreshPreparation(operation.promise)).toBe('saved')
})

test('already aborted waiter returns waiting even with an already completed operation', async () => {
  const signal = AbortSignal.abort()
  expect(await waitForClaudeRefreshPreparation(Promise.resolve('ready'), { signal }))
    .toEqual({ status: 'waiting', reason: 'cancelled' })
})

test('shared failure reaches active waiters and is observed after cancellation', async () => {
  const failure = new Error('persistence failed')
  await expect(waitForClaudeRefreshPreparation(Promise.reject(failure))).rejects.toBe(failure)
  const operation = Promise.withResolvers<string>()
  expect(await waitForClaudeRefreshPreparation(operation.promise, { signal: AbortSignal.abort() }))
    .toEqual({ status: 'waiting', reason: 'cancelled' })
  operation.reject(failure)
  await Promise.resolve()
})

test('invalid durations cannot silently become immediate or unbounded waits', () => {
  for (const waitTimeoutMs of [-1, Infinity, NaN, 2_147_483_648]) {
    expect(() => waitForClaudeRefreshPreparation(Promise.resolve(), { waitTimeoutMs })).toThrow(RangeError)
  }
})
