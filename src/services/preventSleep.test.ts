import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'events'
import { spawn, type ChildProcess } from 'child_process'
import { createPreventSleepOwner } from '../../app/shared/sleepAssertion.js'

function harness() {
  let now = 0
  let throws = false
  const timers = new Map<object, { at: number; callback: () => void }>()
  const children: FakeChild[] = []
  class FakeChild extends EventEmitter {
    pid: number | undefined = 123
    kills = 0
    killResult = true
    killError = false
    unref() {}
    kill() {
      this.kills++
      if (this.killError) this.emit('error', new Error('EPERM'))
      return this.killResult
    }
  }
  const owner = createPreventSleepOwner({
    enabled: true,
    spawn() {
      if (throws) throw new Error('spawn unavailable')
      const child = new FakeChild()
      children.push(child)
      return child as unknown as ChildProcess
    },
    setTimeout(callback, ms) {
      const timer = { unref() {} }
      timers.set(timer, { at: now + ms, callback })
      return timer as ReturnType<typeof setTimeout>
    },
    clearTimeout(timer) { timers.delete(timer) },
    log() {},
  })
  function advance(ms: number) {
    const end = now + ms
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next || next[1].at > end) break
      now = next[1].at
      timers.delete(next[0])
      next[1].callback()
    }
    now = end
  }
  return { owner, children, advance, timers, setThrows(value: boolean) { throws = value } }
}

describe('idle sleep process lifecycle', () => {
  test('synchronous kill errors do not recursively retire the same child', () => {
    const h = harness()
    h.owner.start(); h.children[0]!.emit('spawn')
    h.children[0]!.killError = true
    h.children[0]!.killResult = false
    h.owner.forceStop()
    expect(h.children[0]!.kills).toBe(1)
    expect(h.owner.snapshot()).toMatchObject({ retiring: 1, failures: 2, retryPending: false })
    h.children[0]!.emit('exit')
    expect(h.owner.snapshot().tracked).toBe(0)
  })

  test('refcount churn cannot bypass a pending exponential spawn retry', () => {
    const h = harness()
    h.setThrows(true)
    h.owner.start()
    for (let i = 0; i < 100; i++) { h.owner.start(); h.owner.stop() }
    expect(h.owner.snapshot().failures).toBe(1)
    h.advance(499)
    expect(h.owner.snapshot().failures).toBe(1)
    h.advance(1)
    expect(h.owner.snapshot().failures).toBe(2)
    for (let i = 0; i < 100; i++) { h.owner.start(); h.owner.stop() }
    h.setThrows(false)
    h.advance(999)
    expect(h.children).toHaveLength(0)
    h.advance(1)
    expect(h.children).toHaveLength(1)
    h.children[0]!.emit('spawn')
    expect(h.owner.snapshot()).toMatchObject({ active: 1, references: 1, recoveries: 0 })
    h.advance(10_000)
    expect(h.owner.snapshot().recoveries).toBe(1)
  })

  test('refcounts and suppression retain demand without duplicate children', () => {
    const h = harness()
    h.owner.setSuppressed(true)
    h.owner.start(); h.owner.start()
    expect(h.children).toHaveLength(0)
    h.owner.setSuppressed(false)
    h.children[0]!.emit('spawn')
    h.owner.stop()
    expect(h.children[0]!.kills).toBe(0)
    h.owner.stop()
    expect(h.children[0]!.kills).toBe(1)
    expect(h.timers.size).toBe(0)
    expect(h.owner.snapshot().retiring).toBe(1)
    h.children[0]!.emit('exit', null, 'SIGKILL')
    expect(h.owner.snapshot().tracked).toBe(0)
  })

  test('renews only after successor spawn, retaining failed terminations with a two-child cap', () => {
    const h = harness()
    h.owner.start(); h.children[0]!.emit('spawn')
    h.advance(240_000)
    expect(h.children).toHaveLength(2)
    expect(h.children[0]!.kills).toBe(0)
    h.children[0]!.killResult = false
    h.children[1]!.emit('spawn')
    expect(h.children[0]!.kills).toBe(1)
    h.advance(1_000_000)
    expect(h.children).toHaveLength(2)
    expect(h.owner.snapshot().tracked).toBe(2)
    h.children[0]!.emit('exit')
    h.advance(30_000)
    expect(h.children).toHaveLength(3)
  })

  test('unexpected exit and asynchronous spawn failure recover promptly', () => {
    const h = harness()
    h.owner.start(); h.children[0]!.emit('spawn')
    h.children[0]!.emit('exit', 1)
    h.advance(500)
    expect(h.children).toHaveLength(2)
    h.children[1]!.pid = undefined
    h.children[1]!.emit('error', new Error('ENOENT'))
    h.advance(1000)
    h.children[2]!.emit('spawn')
    expect(h.owner.snapshot()).toMatchObject({ active: 1, tracked: 1, failures: 2, recoveries: 0 })
    h.advance(10_000)
    expect(h.owner.snapshot().recoveries).toBe(1)
    expect(Object.isFrozen(h.owner.snapshot())).toBe(true)
  })

  test('synchronous failures back off, stop cancels retries, and starting children are bounded', () => {
    const h = harness()
    h.setThrows(true); h.owner.start()
    h.advance(100_000)
    expect(h.owner.snapshot().failures).toBeLessThan(12)
    h.setThrows(false)
    h.advance(30_000)
    expect(h.children).toHaveLength(1)
    h.advance(10_000)
    expect(h.children[0]!.kills).toBeGreaterThan(0)
    h.owner.forceStop()
    h.advance(1_000_000)
    expect(h.children).toHaveLength(1)
    expect(h.timers.size).toBe(0)
  })

  test('repeated short-lived processes back off instead of resetting on every successful spawn', () => {
    const h = harness()
    h.owner.start()
    for (const delay of [500, 1000, 2000, 4000, 8000, 16000, 30000]) {
      const before = h.children.length
      const child = h.children.at(-1)!
      child.emit('spawn')
      child.emit('exit', 1)
      h.advance(delay - 1)
      expect(h.children).toHaveLength(before)
      h.advance(1)
      expect(h.children).toHaveLength(before + 1)
    }
    h.owner.forceStop()
    expect(h.timers.size).toBe(0)
  })

  test('late spawn after stop cannot reactivate the owner', () => {
    const h = harness()
    h.owner.start(); h.owner.forceStop()
    h.children[0]!.emit('spawn')
    expect(h.owner.snapshot()).toMatchObject({ desired: false, active: 0, retiring: 1 })
    expect(h.timers.size).toBe(0)
  })
})

// Uses a short timeout to verify the production flags coexist without leaving a child behind.
test.skipIf(process.platform !== 'darwin')('real caffeinate accepts idle, timeout and parent monitoring together', async () => {
  const child = spawn('/usr/bin/caffeinate', ['-i', '-t', '1', '-w', String(process.pid)], { stdio: 'ignore' })
  const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    const watchdog = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('caffeinate timeout did not expire')) }, 5000)
    watchdog.unref()
    child.once('error', error => { clearTimeout(watchdog); reject(error) })
    child.once('exit', (code, signal) => { clearTimeout(watchdog); resolve({ code, signal }) })
  })
  expect(result).toEqual({ code: 0, signal: null })
})
