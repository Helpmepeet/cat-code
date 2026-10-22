import { open } from 'node:fs/promises'
import { createShellFixture } from './shellFixtures'
import type { PtyAttemptOptions, PtyAttemptResult } from './pty'
import { stoppedBeforeSpawn } from './pty'

let outputClosed = false
process.stdout.on('error', error => {
  if ((error as NodeJS.ErrnoException).code === 'EPIPE') outputClosed = true
  else throw error
})
const send = (value: unknown) => {
  if (!outputClosed) process.stdout.write(JSON.stringify(value) + '\n')
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const bounded = (value: number | undefined, fallback: number, max: number) => {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value < 1 || value > max) throw new Error('Invalid experiment budget')
  return value
}
async function main() {
  const reader = Bun.stdin.stream().getReader()
  let input = ''
  const decoder = new TextDecoder()
  while (!input.includes('\n')) {
    const next = await reader.read()
    if (next.done) throw new Error('Missing attempt')
    input += decoder.decode(next.value, { stream: true })
    if (input.length > 2 * 1024 * 1024) throw new Error('Oversize attempt')
  }
  const options: PtyAttemptOptions = JSON.parse(input.slice(0, input.indexOf('\n')))
  if (options.shell && options.shell !== 'bash' && options.shell !== 'zsh') throw new Error('Unsupported shell')
  const startupMs = bounded(options.startupTimeoutMs, 2000, 10000)
  const runMs = bounded(options.runTimeoutMs, 2000, 30000)
  const promptMs = bounded(options.promptTimeoutMs, 100, 1000)
  const maxBytes = bounded(options.maxOutputBytes, 256 * 1024, 1024 * 1024)
  let stopped = false
  void (async () => { while (!(await reader.read()).done) {} stopped = true })()
  const fixture = await createShellFixture({ ...options, shell: options.shell ?? 'zsh' })
  let child: ReturnType<typeof Bun.spawn> | undefined
  let teardown: 'group_signalled' | 'group_missing' = 'group_missing'
  let killed = false
  const kill = () => {
    if (!child || killed) return
    killed = true
    try { process.kill(-child.pid, 'SIGKILL'); teardown = 'group_signalled' }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
  process.on('exit', kill)
  let output = Buffer.alloc(0)
  let overflow = false
  let ready = false
  let exitCode: number | null = null
  let status: PtyAttemptResult['status'] = 'integration_error'
  let promptCapture: PtyAttemptResult['lifecycle']['promptCapture'] = 'unavailable'
  let sandbox: Awaited<ReturnType<typeof import('./sandboxFixture').wrapFixtureWithSandbox>> | undefined
  try {
    if (options.sandbox) {
      const { wrapFixtureWithSandbox } = await import('./sandboxFixture')
      sandbox = await wrapFixtureWithSandbox(fixture, options.cwd)
    }
    if (stopped) {
      send({ type: 'result', result: stoppedBeforeSpawn(options) })
      return
    }
    child = Bun.spawn(sandbox?.argv ?? fixture.argv, {
      cwd: options.cwd, env: fixture.env,
      terminal: { cols: 100, rows: 30, data(_terminal, bytes) {
        const accepted = Buffer.from(bytes).subarray(0, Math.max(0, maxBytes - output.length))
        output = Buffer.concat([output, accepted])
        if (accepted.length) send({ type: 'output', data: accepted.toString('base64') })
        if (accepted.length < bytes.length) overflow = true
      } },
    })
    const start = performance.now()
    let readyAt = 0
    let doneAt = 0
    let exited = false
    void child.exited.then(() => { exited = true })
    while (true) {
      if (stopped) { status = 'stopped'; break }
      if (overflow) { status = 'output_limit'; break }
      if (!ready && await Bun.file(fixture.ready).exists()) { ready = true; readyAt = performance.now() }
      if (exitCode === null && await Bun.file(fixture.result).exists()) {
        const file = await open(fixture.result, 'r')
        let value: string
        try {
          const bytes = Buffer.alloc(16)
          const read = await file.read(bytes, 0, bytes.length, 0)
          value = bytes.subarray(0, read.bytesRead).toString('utf8')
        } finally { await file.close() }
        if (/^\d{1,3}$/.test(value) && Number(value) <= 255) {
          exitCode = Number(value); doneAt = performance.now(); promptCapture = 'bounded_window'
        }
      }
      if (exitCode !== null && (exited || performance.now() - doneAt >= promptMs)) { status = 'completed'; break }
      if (exited) break
      if ((!ready && performance.now() - start >= startupMs) || (ready && exitCode === null && performance.now() - readyAt >= runMs)) {
        status = 'timed_out'; break
      }
      await delay(5)
    }
    kill()
    await child.exited
    await delay(20)
    child.terminal?.close()
    const rawOutput = output.toString('utf8')
    const result: PtyAttemptResult = {
      runId: options.runId ?? crypto.randomUUID(), command: options.command, cwd: options.cwd,
      output: rawOutput, rawOutput, exitCode, status,
      shellExitCode: child.exitCode, shellSignal: child.signalCode,
      sandboxWrapped: sandbox !== undefined,
      lifecycle: { ready, foregroundStatusReceived: exitCode !== null, promptCapture, teardown,
        containment: sandbox ? 'sandbox_envelope_not_job_ownership' : 'job_control_disabled_not_a_sandbox' },
    }
    send({ type: 'result', result })
  } finally {
    kill()
    if (child) { await child.exited; child.terminal?.close() }
    process.off('exit', kill)
    await sandbox?.cleanup()
    await fixture.cleanup()
    void reader.cancel()
  }
}

if (import.meta.main) {
  main().then(() => process.exit(0), error => {
    send({ type: 'error', error: String(error) })
    process.exit(1)
  })
}
