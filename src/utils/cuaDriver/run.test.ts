import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { _forTest, createCuaDriverRun } from './run.js'

type Deferred = { promise: Promise<void>; resolve: () => void }
function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>(r => {
    resolve = r
  })
  return { promise, resolve }
}

describe('createCuaDriverRun', () => {
  let events: string[]

  beforeEach(() => {
    events = []
    _forTest.setStopDaemon(async () => {
      events.push('stop')
    })
  })

  afterEach(() => {
    _forTest.setStopDaemon(null)
  })

  async function useOnce(run: ReturnType<typeof createCuaDriverRun>) {
    expect(await run.beginCall()).toBe(true)
    run.endCall()
  }

  test('a run that never used cua-driver does not stop the daemon', async () => {
    await createCuaDriverRun().end()
    expect(events).toEqual([])
  })

  test('a run that used cua-driver stops the daemon once when it ends', async () => {
    const run = createCuaDriverRun()
    await useOnce(run)
    await useOnce(run)
    await run.end()
    await run.end()
    expect(events).toEqual(['stop'])
  })

  test('a call that reaches the guard after the run ended is refused', async () => {
    const run = createCuaDriverRun()
    await run.end()
    expect(await run.beginCall()).toBe(false)
    expect(events).toEqual([])
  })

  test('the end waits for a call still executing, then stops', async () => {
    const run = createCuaDriverRun()
    expect(await run.beginCall()).toBe(true)
    const ending = run.end().then(() => events.push('ended'))
    await Bun.sleep(20)
    expect(events).toEqual([])
    events.push('call settled')
    run.endCall()
    await ending
    expect(events).toEqual(['call settled', 'stop', 'ended'])
  })

  test('the end stops anyway when a call never settles', async () => {
    const run = createCuaDriverRun(60_000, 30)
    expect(await run.beginCall()).toBe(true)
    await run.end()
    expect(events).toEqual(['stop'])
  })

  test('a run that stops using cua-driver stops the daemon when idle', async () => {
    const run = createCuaDriverRun(20)
    await useOnce(run)
    await Bun.sleep(60)
    expect(events).toEqual(['stop'])
    await run.end()
    expect(events).toEqual(['stop'])
  })

  test('a long call is not stopped by the idle timer', async () => {
    const run = createCuaDriverRun(20)
    expect(await run.beginCall()).toBe(true)
    await Bun.sleep(60)
    expect(events).toEqual([])
    run.endCall()
    await run.end()
    expect(events).toEqual(['stop'])
  })

  test('a call arriving during an idle stop waits for it, and the end stops again', async () => {
    const idleStop = deferred()
    let stops = 0
    _forTest.setStopDaemon(async () => {
      stops++
      if (stops === 1) {
        events.push('idle stop started')
        await idleStop.promise
        events.push('idle stop done')
      } else {
        events.push('stop')
      }
    })
    const run = createCuaDriverRun(10)
    await useOnce(run)
    await Bun.sleep(40)
    expect(events).toEqual(['idle stop started'])

    const begun = run.beginCall().then(allowed => {
      events.push(`call began: ${allowed}`)
    })
    await Bun.sleep(20)
    expect(events).toEqual(['idle stop started'])
    idleStop.resolve()
    await begun
    run.endCall()
    await run.end()
    expect(events).toEqual([
      'idle stop started',
      'idle stop done',
      'call began: true',
      'stop',
    ])
  })

  test('the end settles an idle stop still in flight', async () => {
    const idleStop = deferred()
    _forTest.setStopDaemon(async () => {
      events.push('idle stop started')
      await idleStop.promise
      events.push('idle stop done')
    })
    const run = createCuaDriverRun(10)
    await useOnce(run)
    await Bun.sleep(40)
    const ending = run.end().then(() => events.push('ended'))
    await Bun.sleep(20)
    expect(events).toEqual(['idle stop started'])
    idleStop.resolve()
    await ending
    expect(events).toEqual(['idle stop started', 'idle stop done', 'ended'])
  })

  test('a failing stop does not fail the run end', async () => {
    _forTest.setStopDaemon(async () => {
      throw new Error('socket gone')
    })
    const run = createCuaDriverRun()
    await useOnce(run)
    await expect(run.end()).resolves.toBeUndefined()
  })
})

describe('stopCuaDriverDaemon', () => {
  const originalHome = process.env.HOME
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cua-stop-'))
    mkdirSync(join(home, '.local', 'bin'), { recursive: true })
    process.env.HOME = home
  })

  afterEach(() => {
    process.env.HOME = originalHome
    rmSync(home, { recursive: true, force: true })
  })

  function fakeBinary(body: string): void {
    const path = join(home, '.local', 'bin', 'cua-driver')
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
  }

  test('runs `cua-driver stop` from ~/.local/bin', async () => {
    const log = join(home, 'args.txt')
    fakeBinary(`echo "$@" > "${log}"`)
    await _forTest.stopCuaDriverDaemon()
    expect(readFileSync(log, 'utf8').trim()).toBe('stop')
  })

  test('gives up on a stop that does not return', async () => {
    // exec, so the hung process is the binary itself, like the real single
    // process; a forked child would hold the output pipe past the kill.
    fakeBinary('exec sleep 10')
    const started = Date.now()
    await _forTest.stopCuaDriverDaemon(200)
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
