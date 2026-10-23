import { afterEach, expect, mock, test } from 'bun:test'
import { constants } from 'fs'

let bytes = Buffer.alloc(0)
let pending: (() => void) | undefined
let delayRead = false
let reads = 0
let openFlags = 0
mock.module('fs/promises', () => ({
  open: async (_path: string, flags: number) => {
    openFlags = flags
    reads++
    if (delayRead)
      await new Promise<void>((resolve) => {
        pending = resolve
      })
    return {
      stat: async () => ({ size: bytes.length, isFile: () => true }),
      read: async (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => {
        const count = bytes.copy(buffer, offset, position, position + length)
        return { bytesRead: count }
      },
      [Symbol.asyncDispose]: async () => {},
    }
  },
  unlink: async () => {},
}))
mock.module('./diskOutput.js', () => ({
  getTaskOutputPath: (id: string) => `/isolated/${id}`,
  DiskTaskOutput: class {},
}))
mock.module('../fsOperations.js', () => ({
  tailFile: async () => {
    reads++
    return {
      content: bytes.toString(),
      bytesRead: bytes.length,
      bytesTotal: bytes.length,
    }
  },
  readFileRange: async () => null,
}))
mock.module('../debug.js', () => ({ logForDebugging: () => {} }))
mock.module('../shell/outputLimits.js', () => ({
  getMaxOutputLength: () => 4096,
}))
const { TaskOutput } = await import('./TaskOutput.js')
const outputs: InstanceType<typeof TaskOutput>[] = []
const timers: { callback: () => void; ms: number; active: boolean }[] = []
const nativeTimeout = globalThis.setTimeout
const nativeInterval = globalThis.setInterval
const nativeClearTimeout = globalThis.clearTimeout
const nativeClearInterval = globalThis.clearInterval
function installTimers() {
  const schedule = (callback: () => void, ms: number) => {
    const timer = { callback, ms, active: true, unref() {} }
    timers.push(timer)
    return timer
  }
  globalThis.setTimeout = schedule as any
  globalThis.setInterval = schedule as any
  globalThis.clearTimeout = ((timer: any) => {
    timer.active = false
  }) as any
  globalThis.clearInterval = globalThis.clearTimeout as any
}
async function settle() {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}
function create(id = 'task') {
  const callback = mock(() => {})
  const output = new TaskOutput(id, callback, true)
  outputs.push(output)
  return callback
}
function tick(ms: number) {
  for (const timer of [...timers]) {
    if (timer.active && timer.ms === ms) {
      if (ms === 100) timer.active = false
      timer.callback()
    }
  }
}
afterEach(async () => {
  for (const output of outputs) output.clear()
  pending?.()
  pending = undefined
  await settle()
  outputs.length = 0
  timers.length = 0
  reads = 0
  bytes = Buffer.alloc(0)
  delayRead = false
  globalThis.setTimeout = nativeTimeout
  globalThis.setInterval = nativeInterval
  globalThis.clearTimeout = nativeClearTimeout
  globalThis.clearInterval = nativeClearInterval
})

test('inline samples immediately, suppresses quiet/unchanged output, and isolates ordinary cadence', async () => {
  installTimers()
  const inline = create('inline')
  const ordinary = create('ordinary')
  TaskOutput.startPolling('ordinary')
  expect(reads).toBe(0)
  TaskOutput.startPolling('inline', { inline: true })
  expect(reads).toBe(1)
  expect(openFlags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW)
  expect(openFlags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK)
  await settle()
  expect(inline).not.toHaveBeenCalled()
  bytes = Buffer.from('hello\n')
  tick(100)
  await settle()
  expect(inline).toHaveBeenCalledTimes(1)
  expect(ordinary).not.toHaveBeenCalled()
  tick(100)
  await settle()
  expect(inline).toHaveBeenCalledTimes(1)
  bytes = Buffer.from('changed\n')
  tick(100)
  await settle()
  expect(inline).toHaveBeenCalledTimes(2)
  tick(1000)
  await settle()
  expect(ordinary).toHaveBeenCalledTimes(1)
  tick(1000)
  await settle()
  expect(ordinary).toHaveBeenCalledTimes(2)
  bytes = Buffer.alloc(0)
  tick(1000)
  await settle()
  expect(ordinary).toHaveBeenLastCalledWith(
    '',
    '',
    expect.any(Number),
    0,
    false,
  )
})

test('delayed reads stay single flight and stop/restart fence stale samples', async () => {
  installTimers()
  delayRead = true
  bytes = Buffer.from('output')
  const callback = create()
  TaskOutput.startPolling('task', { inline: true })
  tick(100)
  tick(1000)
  expect(reads).toBe(1)
  TaskOutput.stopPolling('task')
  TaskOutput.startPolling('task', { inline: true })
  expect(reads).toBe(1)
  delayRead = false
  pending!()
  pending = undefined
  await settle()
  expect(reads).toBe(2)
  expect(callback).toHaveBeenCalledTimes(1)
  delayRead = true
  tick(100)
  outputs[0]!.clear()
  pending!()
  pending = undefined
  await settle()
  expect(callback).toHaveBeenCalledTimes(1)
  expect(
    timers.filter((timer) => timer.active && timer.ms === 100),
  ).toHaveLength(0)
})

test('inline preview stays bounded and omits split UTF8 window edges', async () => {
  installTimers()
  const callback = create()
  bytes = Buffer.concat([
    Buffer.from('😀'),
    Buffer.alloc(4093, 97),
    Buffer.from([0xe2, 0x82]),
  ])
  TaskOutput.startPolling('task', { inline: true })
  await settle()
  const args = callback.mock.calls[0] as unknown as [
    string,
    string,
    number,
    number,
    boolean,
  ]
  expect(args[1]).toBe('a'.repeat(4093))
  expect(args[1]).not.toContain('�')
  expect(args[4]).toBe(true)
  bytes = Buffer.concat([bytes, Buffer.from([0xac])])
  tick(100)
  await settle()
  expect((callback.mock.calls[1] as unknown as string[])[1]).toEndWith('€')
})

test('unsubscribe alone discards an in-flight sample without rescheduling', async () => {
  installTimers()
  delayRead = true
  bytes = Buffer.from('late')
  const callback = create()
  TaskOutput.startPolling('task', { inline: true })
  TaskOutput.stopPolling('task')
  pending!()
  pending = undefined
  await settle()
  expect(callback).not.toHaveBeenCalled()
  expect(timers).toHaveLength(0)
})

test('clearing an older instance preserves its replacement subscription', async () => {
  installTimers()
  create()
  const previous = outputs[0]!
  const replacement = create()
  bytes = Buffer.from('replacement')
  TaskOutput.startPolling('task', { inline: true })
  previous.clear()
  await settle()
  expect(replacement).toHaveBeenCalledTimes(1)
  bytes = Buffer.from('next')
  tick(100)
  await settle()
  expect(replacement).toHaveBeenCalledTimes(2)
})
