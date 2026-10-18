import { expect, test } from 'bun:test'
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { createNativeCaptureRun, nativeCaptureBootstrap, nativeCapturePreservationMessage, preserveNativeCapture, waitForNativeCaptureExit } from './nativeCaptureLifetime.js'

test('a cancelled late launch exits before acknowledgement or state access', () => {
  const base = mkdtempSync(join(tmpdir(), 'native-cancel-test-'))
  try {
    const run = createNativeCaptureRun(base)
    run.published = true
    nativeCapturePreservationMessage(run, { configHome: '/isolated-state' })
    let code: number | undefined
    expect(() => runInNewContext(nativeCaptureBootstrap(run), {
      require: (name: string) => name === 'node:fs' ? fs : { app: { exit: (value: number) => { code = value; throw new Error('cancelled before app startup') } } },
    })).toThrow('cancelled before app startup')
    expect(code).toBe(1)
    expect(existsSync(join(run.outDir, 'started.json'))).toBe(false)
    expect(existsSync(join(run.outDir, 'electron.log'))).toBe(false)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('matching quit records do not authorize cleanup while their PID is still alive', async () => {
  const base = mkdtempSync(join(tmpdir(), 'native-exit-test-'))
  try {
    const run = createNativeCaptureRun(base)
    run.published = true
    const identity = { runId: run.runId, pid: process.pid }
    writeFileSync(join(run.outDir, 'started.json'), JSON.stringify(identity))
    writeFileSync(join(run.outDir, 'exited.json'), JSON.stringify({ ...identity, code: 0 }))
    await expect(waitForNativeCaptureExit(run, 30)).rejects.toThrow('timed out')
    expect(run.confirmedStopped).toBe(false)
    expect(preserveNativeCapture(run)).toBe(true)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('a bootstrap is single-use and a duplicate cannot replace its PID or truncate its log', () => {
  const base = mkdtempSync(join(tmpdir(), 'native-claim-test-'))
  try {
    const run = createNativeCaptureRun(base)
    const sandbox = () => ({
      require: (name: string) => name === 'node:fs' ? fs : { app: {
        on: () => {},
        exit: () => { throw new Error('duplicate launch rejected') },
      } },
      process: { pid: process.pid, execPath: process.execPath, stdout: { write: () => true }, stderr: { write: () => true } },
      __filename: join(run.outDir, 'native-bootstrap.cjs'),
    })
    runInNewContext(nativeCaptureBootstrap(run), sandbox())
    const acknowledgement = fs.readFileSync(join(run.outDir, 'started.json'), 'utf8')
    writeFileSync(join(run.outDir, 'electron.log'), 'first process log')
    expect(() => runInNewContext(nativeCaptureBootstrap(run), sandbox())).toThrow('duplicate launch rejected')
    expect(fs.readFileSync(join(run.outDir, 'started.json'), 'utf8')).toBe(acknowledgement)
    expect(fs.readFileSync(join(run.outDir, 'electron.log'), 'utf8')).toBe('first process log')
  } finally { rmSync(base, { recursive: true, force: true }) }
})
