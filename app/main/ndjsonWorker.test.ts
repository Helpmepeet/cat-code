import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { spawn } from 'node:child_process'
import { runNdjsonWorker, type NdjsonWorkerOptions } from './ndjsonWorker.js'
import { createSingleFlightDriver } from './singleFlightDriver.js'

function fake(killThrows = false) {
  const child = Object.assign(new EventEmitter(), {
    pid: 987654, exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill(signal: string) { signals.push(signal); if (killThrows) throw new Error('kill denied'); return true },
  })
  const signals: string[] = []
  return { child, signals, spawnWorker: (() => child) as unknown as typeof spawn }
}
function options(extra: Partial<NdjsonWorkerOptions> = {}): NdjsonWorkerOptions {
  return { command: process.execPath, args: [], cwd: process.cwd(), timeoutMs: 10,
    escalateKillAfterMs: 10, finalCloseWaitMs: 10, maxRecordBytes: 100,
    onRecord: () => 'continue', onOversizeRecord: () => {}, ...extra }
}
test('no-close settles with identity, signal order, cleanup and writer fence until confirmed exit', async () => {
  const fixture = fake()
  let disconnected = 0
  const input = options({ ...fixture, mutationKey: 'test-writer', connectInput: () => () => { disconnected++ } })
  const outcome = await runNdjsonWorker(input)
  expect(outcome.termination).toBe('unconfirmed')
  expect(outcome.pid).toBe(fixture.child.pid)
  expect(fixture.signals).toEqual(['SIGTERM', 'SIGKILL'])
  expect(disconnected).toBe(1)
  // Only the confirmation observer remains, not the settled close waiter.
  expect(fixture.child.listenerCount('close')).toBe(1)
  await expect(runNdjsonWorker(input)).rejects.toThrow('replacement is blocked')
  fixture.child.emit('exit', null, 'SIGKILL')
  expect(fixture.child.listenerCount('close')).toBe(0)
  const next = fake()
  const task = runNdjsonWorker(options({ ...next, mutationKey: 'test-writer' }))
  next.child.emit('close', 0, null)
  expect((await task).termination).toBe('confirmed')
})
test('kill errors still settle; abort and invalid records use bounded teardown', async () => {
  const fixture = fake(true)
  const controller = new AbortController()
  const task = runNdjsonWorker(options({ ...fixture, signal: controller.signal }))
  controller.abort()
  const outcome = await task
  expect(outcome.aborted).toBe(true)
  expect(outcome.killError).toBeInstanceOf(Error)
  expect(outcome.termination).toBe('unconfirmed')
  const invalid = fake()
  const invalidTask = runNdjsonWorker(options({ ...invalid, timeoutMs: 1000, onRecord: () => 'stop' }))
  invalid.child.stdout.write('invalid\n')
  expect((await invalidTask).timedOut).toBe(false)
  expect(invalid.signals).toEqual(['SIGTERM', 'SIGKILL'])
})
test('owned real TERM-ignoring process is killed and reaped on timeout and abort', async () => {
  for (const abort of [false, true]) {
    const controller = new AbortController()
    const outcome = await runNdjsonWorker(options({
      args: ['-e', 'process.on("SIGTERM",()=>{}); console.log("ready"); setInterval(()=>{},1000)'],
      timeoutMs: 250, signal: controller.signal,
      onRecord: () => { if (abort) controller.abort(); return 'continue' },
    }))
    expect(outcome.termination).toBe('confirmed')
    expect(outcome.signal).toBe('SIGKILL')
    expect(abort ? outcome.aborted : outcome.timedOut).toBe(true)
  }
})
test('cooperative owned process closes on TERM', async () => {
  const outcome = await runNdjsonWorker(options({ args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 100, finalCloseWaitMs: 100 }))
  expect(outcome.termination).toBe('confirmed')
  expect(outcome.signal).toBe('SIGTERM')
})
test('default escalation bounds a stuck request and releases the caller single-flight slot', async () => {
  let runs = 0
  let finished!: () => void
  const done = new Promise<void>(resolve => { finished = resolve })
  const driver = createSingleFlightDriver({
    intervalMs: 60_000, logLabel: 'fixture',
    run: async () => {
      runs++
      if (runs === 2) { driver.stop(); finished(); return }
      const fixture = fake()
      const outcome = await runNdjsonWorker(options({ ...fixture, escalateKillAfterMs: undefined }))
      expect(outcome.timedOut).toBe(true)
      expect(outcome.termination).toBe('unconfirmed')
      expect(fixture.signals).toEqual(['SIGTERM', 'SIGKILL'])
    },
  })
  driver.start()
  driver.refreshNow()
  await done
  expect(runs).toBe(2)
})
