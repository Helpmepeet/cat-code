import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
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
    run.markUsed()
    run.markUsed()
    await run.end()
    await run.end()
    expect(stops).toBe(1)
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
