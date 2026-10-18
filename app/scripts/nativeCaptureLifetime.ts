import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type NativeCaptureRun = {
  runId: string
  outDir: string
  published: boolean
  confirmedStopped: boolean
  pid: number | null
}

export function createNativeCaptureRun(base: string): NativeCaptureRun {
  mkdirSync(base, { recursive: true })
  return { runId: randomUUID(), outDir: mkdtempSync(join(base, 'run-')), published: false, confirmedStopped: false, pid: null }
}

/** No signals are sent to externally acknowledged PIDs: PID reuse cannot prove ownership. */
export function preserveNativeCapture(run: NativeCaptureRun | null): boolean {
  return !!run?.published && !run.confirmedStopped
}

export function nativeCapturePreservationMessage(run: NativeCaptureRun, state: Record<string, unknown>): string {
  writeFileSync(join(run.outDir, 'cancelled.json'), JSON.stringify({ runId: run.runId }))
  const detail = { runId: run.runId, acknowledgedPid: run.pid, evidence: run.outDir, ...state }
  writeFileSync(join(run.outDir, 'cleanup-required.json'), JSON.stringify(detail, null, 2))
  return `Cleanup required; native process termination was not confirmed. State and dependencies preserved: ${JSON.stringify(detail)}. No signals were sent to the acknowledged PID.`
}

export function nativeCaptureBootstrap(run: NativeCaptureRun): string {
  return `
const fs = require('node:fs');
const {app} = require('electron');
const runId = ${JSON.stringify(run.runId)};
const runDir = ${JSON.stringify(run.outDir)};
if (fs.existsSync(runDir + '/cancelled.json')) { app.exit(1); process.exit(1); }
try { fs.closeSync(fs.openSync(runDir + '/launch.claim', 'wx')); }
catch (error) { if (error.code === 'EEXIST') { app.exit(1); process.exit(1); } throw error; }
const record = (name, extra = {}) => { const path = runDir + '/' + name; fs.writeFileSync(path + '.tmp', JSON.stringify({runId,pid:process.pid,...extra})); fs.renameSync(path + '.tmp', path); };
record('started.json', {bootstrap:__filename,execPath:process.execPath});
app.on('quit', (_event, code) => record('exited.json', {code}));
const log = runDir + '/electron.log';
fs.writeFileSync(log, '');
for (const stream of [process.stdout, process.stderr]) { const original=stream.write.bind(stream); stream.write=function(chunk,...args) { fs.appendFileSync(log,String(chunk)); return original(chunk,...args); }; }
`
}

function record(run: NativeCaptureRun, name: string): Record<string, unknown> | null {
  const path = join(run.outDir, name)
  if (!existsSync(path)) return null
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (!value || value.runId !== run.runId || !Number.isSafeInteger(value.pid) || value.pid < 1) {
    throw new Error(`Invalid native run identity in ${path}`)
  }
  return value
}

export async function waitForNativeCaptureExit(run: NativeCaptureRun, defaultTimeoutMs: number): Promise<number> {
  const timeoutMs = Number(process.env.CATCODE_NATIVE_TIMEOUT_MS ?? defaultTimeoutMs)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid CATCODE_NATIVE_TIMEOUT_MS')
  const deadline = Date.now() + timeoutMs
  while (true) {
    const started = record(run, 'started.json')
    if (started) {
      if (run.pid !== null && run.pid !== started.pid) throw new Error('Native acknowledgement PID changed')
      run.pid = started.pid as number
      const exited = record(run, 'exited.json')
      if (exited) {
        if (exited.pid !== run.pid || !Number.isInteger(exited.code)) throw new Error('Native exit acknowledgement does not match launch')
        try {
          process.kill(run.pid, 0)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
          run.confirmedStopped = true
          return exited.code as number
        }
      }
    }
    if (Date.now() >= deadline) throw new Error(`Native launch/completion timed out for run ${run.runId}; acknowledged PID ${run.pid ?? 'unknown'}`)
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))))
  }
}
