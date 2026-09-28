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

describe('createCuaDriverRun', () => {
  let stops: number

  beforeEach(() => {
    stops = 0
    _forTest.setStopDaemon(async () => {
      stops++
    })
  })

  afterEach(() => {
    _forTest.setStopDaemon(null)
  })

  test('a run that never used cua-driver does not stop the daemon', async () => {
    await createCuaDriverRun().end()
    expect(stops).toBe(0)
  })

  test('a run that used cua-driver stops the daemon once when it ends', async () => {
    const run = createCuaDriverRun()
    expect(run.markUsed()).toBe(true)
    expect(run.markUsed()).toBe(true)
    await run.end()
    await run.end()
    expect(stops).toBe(1)
  })

  test('a call that reaches the guard after the run ended is refused', async () => {
    const run = createCuaDriverRun()
    await run.end()
    expect(run.markUsed()).toBe(false)
    expect(stops).toBe(0)
  })

  test('a run that stops using cua-driver stops the daemon when idle', async () => {
    const run = createCuaDriverRun(20)
    run.markUsed()
    await Bun.sleep(60)
    expect(stops).toBe(1)
    await run.end()
  })

  test('each cua-driver call pushes the idle stop back', async () => {
    const run = createCuaDriverRun(60)
    run.markUsed()
    await Bun.sleep(40)
    run.markUsed()
    await Bun.sleep(40)
    expect(stops).toBe(0)
    await run.end()
    expect(stops).toBe(1)
  })

  test('ending the run cancels the idle stop', async () => {
    const run = createCuaDriverRun(30)
    run.markUsed()
    await run.end()
    await Bun.sleep(60)
    expect(stops).toBe(1)
  })

  test('a failing stop does not fail the run end', async () => {
    _forTest.setStopDaemon(async () => {
      throw new Error('socket gone')
    })
    const run = createCuaDriverRun()
    run.markUsed()
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
