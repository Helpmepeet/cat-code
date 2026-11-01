import { expect, test } from 'bun:test'
import { StreamIdleError, streamIdleTimeoutMs, withStreamIdleDeadline } from './streamIdle.js'

const hung = (): AsyncIterable<number> => ({
  [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}), return: () => new Promise(() => {}) }),
})

test('bounds an uncooperative reader and releases resources', async () => {
  let cleaned = 0
  const reader = withStreamIdleDeadline(hung(), new AbortController().signal, 10, () => { cleaned++ }, () => new Error('cancelled'))
  await expect(reader.next()).rejects.toBeInstanceOf(StreamIdleError)
  expect(cleaned).toBe(1)
})

test('user cancellation is distinct and cleans once', async () => {
  const controller = new AbortController()
  let cleaned = 0
  const reader = withStreamIdleDeadline(hung(), controller.signal, 1000, () => { cleaned++ }, () => new Error('cancelled'))
  const pending = reader.next()
  controller.abort()
  await expect(pending).rejects.toThrow('cancelled')
  expect(cleaned).toBe(1)
})

test('local consumption waits do not count as network idle', async () => {
  async function* chunks() { yield 1; yield 2 }
  const reader = withStreamIdleDeadline(chunks(), new AbortController().signal, 10, () => {}, () => new Error('cancelled'))
  expect((await reader.next()).value).toBe(1)
  await Bun.sleep(25)
  expect((await reader.next()).value).toBe(2)
  expect((await reader.next()).done).toBe(true)
})

test('idle setting is bounded and defaults safely', () => {
  for (const value of ['', '0', '-1', 'no', 'Infinity', '2147483648']) expect(streamIdleTimeoutMs(value)).toBe(90_000)
  expect(streamIdleTimeoutMs('20')).toBe(20)
})

test('each valid chunk renews the pending-read deadline', async () => {
  async function* chunks() {
    for (let i = 0; i < 4; i++) { await Bun.sleep(5); yield i }
  }
  const values = []
  for await (const value of withStreamIdleDeadline(chunks(), new AbortController().signal, 30, () => {}, () => new Error('cancelled'))) values.push(value)
  expect(values).toEqual([0, 1, 2, 3])
})

test('cancellation after timeout cannot settle or clean twice', async () => {
  let cleaned = 0
  const controller = new AbortController()
  const reader = withStreamIdleDeadline(hung(), controller.signal, 5, () => { cleaned++ }, () => new Error('cancelled'))
  await expect(reader.next()).rejects.toBeInstanceOf(StreamIdleError)
  controller.abort()
  expect((await reader.next()).done).toBe(true)
  expect(cleaned).toBe(1)
})
