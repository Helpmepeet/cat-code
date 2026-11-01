/**
 * The shared body of main's three NDJSON child-worker runners (sessions
 * catalog, accounts pool, transcript backfill). Each of them had independently
 * transcribed the same mechanism: spawn with the hook-suppressing env, a
 * bounded stderr collector, newline framing with a record-size cap, the
 * terminate/timeout/abort trio, the stdin write, and the wait-for-`close`
 * teardown. This module contains no Electron imports and is unit-testable.
 *
 * It owns the MECHANISM and none of the policy. What a record means, what an
 * oversize or unparseable one means, and which terminal condition wins are all
 * decided by the caller: the three runners order their error ladders
 * differently and their messages are asserted verbatim by their own tests, so
 * the ladder stays where it can be read next to the rules it enforces.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/** Every runner capped its worker's stderr at the same 64 KiB. */
const MAX_WORKER_STDERR_BYTES = 64 * 1024

export type WorkerProcessLifecycle = Readonly<{
  phase: 'started' | 'exited' | 'termination-unconfirmed'
  pid: number
  code?: number | null
  signal?: NodeJS.Signals | null
}>

/**
 * What the caller wants done after a framed record. `'stop'` terminates the
 * worker and stops framing: every stop path in every runner is paired with a
 * kill, and draining more output from a child you have just killed is nobody's
 * intent.
 */
export type NdjsonRecordDisposition = 'continue' | 'stop'

export type NdjsonWorkerOptions = {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  /** Inventory reads need the full user/project command and agent catalogs. */
  simpleMode?: boolean
  signal?: AbortSignal
  timeoutMs: number
  spawnWorker?: typeof spawn
  /** A framed line longer than this is never parsed; `onOversizeRecord` fires. */
  maxRecordBytes: number
  /** Written once to stdin before it is closed. Absent closes stdin empty. */
  input?: string
  /** Interactive workers keep stdin open and return a cleanup for their sender. */
  connectInput?: (send: (input: string) => void) => () => void
  /**
   * Destructive one-shot writes cannot outlive Electron teardown. Abort sends
   * SIGKILL immediately because app.exit can destroy escalation timers.
   */
  forceKillOnAbort?: boolean
  /**
   * Escalate an unanswered SIGTERM to SIGKILL after this long (default 2s).
   */
  escalateKillAfterMs?: number
  finalCloseWaitMs?: number
  /** Stable resource identity for workers that may mutate persistent state. */
  mutationKey?: string
  /** One complete, non-empty NDJSON line, still unparsed. */
  onRecord: (line: Buffer) => NdjsonRecordDisposition
  /**
   * A framed line, or the unterminated tail, exceeded `maxRecordBytes`. The
   * worker is terminated and framing stops either way.
   */
  onOversizeRecord: () => void
  /** Metadata-only process lifecycle hook; it never receives worker output. */
  onWorkerLifecycle?: (event: WorkerProcessLifecycle) => void
  /** Receives the worker's trimmed stderr once, if it wrote any. */
  log?: (line: string) => void
}

export type NdjsonWorkerOutcome = {
  code: number | null
  signal: NodeJS.Signals | null
  aborted: boolean
  timedOut: boolean
  termination: 'confirmed' | 'unconfirmed'
  pid: number | undefined
  killError: unknown
  /** What `stdin` emitted, if anything. The caller decides what it means. */
  stdinError: unknown
  /** Bytes left in the frame buffer with no terminating newline. */
  trailingBytes: number
}

/**
 * Spawn one worker, frame its stdout, reap it, and report how it ended. Rejects
 * only on a spawn error (which `waitForClose` surfaces); every other terminal
 * condition is reported in the outcome for the caller's own ladder to judge.
 */
const pendingWriters = new Set<string>()

export async function runNdjsonWorker(
  options: NdjsonWorkerOptions,
): Promise<NdjsonWorkerOutcome> {
  const spawnWorker = options.spawnWorker ?? spawn
  if (options.mutationKey && pendingWriters.has(options.mutationKey)) {
    throw new Error('Previous worker termination is unconfirmed; replacement is blocked')
  }
  const child = spawnWorker(options.command, options.args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
      // Existing disposable workers stay in SIMPLE mode. The Settings
      // inventory opts out to read user/project skills and agents; its worker
      // never calls full init or starts a session.
      CLAUDE_CODE_SIMPLE: options.simpleMode === false ? '' : '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams
  options.onWorkerLifecycle?.({ phase: 'started', pid: child.pid ?? 0 })

  let pending = Buffer.alloc(0)
  let stderr = Buffer.alloc(0)
  let timedOut = false
  let aborted = false
  let stdinError: unknown = null
  let stopped = false
  let childClosed = false
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null
  let finalTimer: ReturnType<typeof setTimeout> | null = null
  let killError: unknown = null
  let finishUnconfirmed: () => void = () => {}
  let terminationRequested = false
  let killRequested = false
  let processExited = false
  let reportedUnconfirmed = false
  if (options.mutationKey) pendingWriters.add(options.mutationKey)
  const confirmedExit = (code = child.exitCode, signal = child.signalCode) => {
    // Exit may precede close and a replacement claim. Release only once.
    if (processExited) return
    processExited = true
    if (options.mutationKey) pendingWriters.delete(options.mutationKey)
    child.removeListener('exit', confirmedExit)
    child.removeListener('close', confirmedExit)
    if (reportedUnconfirmed) {
      reportedUnconfirmed = false
      options.onWorkerLifecycle?.({ phase: 'exited', pid: child.pid ?? 0, code, signal })
    }
  }
  child.once('exit', confirmedExit)
  child.once('close', confirmedExit)
  const sendSignal = (signal: NodeJS.Signals) => {
    try { child.kill(signal) } catch (error) { killError = error }
  }
  const forceKill = () => {
    if (!killRequested && !processExited) { killRequested = true; sendSignal('SIGKILL') }
    if (finalTimer === null) finalTimer = setTimeout(() => finishUnconfirmed(), options.finalCloseWaitMs ?? 2_000)
  }

  const terminate = (force = false) => {
    if (terminationRequested && !force) return
    terminationRequested = true
    if (!processExited && child.exitCode === null && child.signalCode === null) {
      if (force) forceKill()
      else sendSignal('SIGTERM')
    }
    if (force) { if (finalTimer === null) forceKill(); return }
    if (forceKillTimer === null) {
      forceKillTimer = setTimeout(() => {
        if (!childClosed) forceKill()
      }, options.escalateKillAfterMs ?? 2_000)
    }
  }
  const timeout = setTimeout(() => {
    timedOut = true
    terminate()
  }, options.timeoutMs)
  const onAbort = () => {
    aborted = true
    terminate(options.forceKillOnAbort === true)
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })

  const onStderr = (chunk: Buffer | string) => {
    if (stderr.byteLength >= MAX_WORKER_STDERR_BYTES) return
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    stderr = Buffer.concat([
      stderr,
      next.subarray(0, MAX_WORKER_STDERR_BYTES - stderr.byteLength),
    ])
  }
  child.stderr.on('data', onStderr)

  const onStdout = (chunk: Buffer | string) => {
    if (stopped) return
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    pending = Buffer.concat([pending, next])
    while (true) {
      const newline = pending.indexOf(0x0a)
      if (newline < 0) break
      const line = pending.subarray(0, newline)
      pending = pending.subarray(newline + 1)
      if (line.byteLength === 0) continue
      if (line.byteLength > options.maxRecordBytes) {
        stopped = true
        options.onOversizeRecord()
        terminate()
        return
      }
      if (options.onRecord(line) === 'stop') {
        stopped = true
        terminate()
        return
      }
    }
    // Only the unterminated tail is one in-flight record. Several complete
    // records may arrive in one OS chunk and are drained above before this cap.
    if (pending.byteLength > options.maxRecordBytes) {
      stopped = true
      options.onOversizeRecord()
      terminate()
    }
  }
  child.stdout.on('data', onStdout)

  const onStdinError = (error: unknown) => {
    stdinError = error
    terminate()
  }
  child.stdin.on('error', onStdinError)
  const closeWait = waitForClose(child, error => { killError = error })
  const closed = closeWait.promise
  const unconfirmed = new Promise<{ code: null; signal: null }>(resolve => {
    finishUnconfirmed = () => resolve({ code: null, signal: null })
  })
  let code: number | null
  let signal: NodeJS.Signals | null
  let disconnectInput: (() => void) | undefined
  try {
    if (options.connectInput) {
      disconnectInput = options.connectInput(input => { child.stdin.write(input) })
    } else {
      child.stdin.end(options.input)
    }
    if (options.signal?.aborted) onAbort()
    ;({ code, signal } = await Promise.race([closed.then(value => { childClosed = true; confirmedExit(); return value }), unconfirmed]))
    reportedUnconfirmed = !childClosed && !processExited
    options.onWorkerLifecycle?.({ phase: reportedUnconfirmed ? 'termination-unconfirmed' : 'exited', pid: child.pid ?? 0, code, signal })
  } finally {
    clearTimeout(timeout)
    if (forceKillTimer !== null) clearTimeout(forceKillTimer)
    if (finalTimer !== null) clearTimeout(finalTimer)
    options.signal?.removeEventListener('abort', onAbort)
    child.stdin.removeListener('error', onStdinError)
    closeWait.cleanup()
    child.stdout.removeListener('data', onStdout)
    child.stderr.removeListener('data', onStderr)
    if (!child.pid) confirmedExit()
    if (childClosed || !child.pid) {
      child.removeListener('exit', confirmedExit)
      child.removeListener('close', confirmedExit)
    }
    stopped = true
    if (!childClosed) {
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
    }
    disconnectInput?.()
  }

  const diagnostics = stderr.toString('utf8').trim()
  if (diagnostics) options.log?.(diagnostics)
  return {
    code,
    signal,
    aborted,
    timedOut,
    termination: childClosed || processExited ? 'confirmed' : 'unconfirmed',
    pid: child.pid,
    killError,
    stdinError,
    trailingBytes: pending.byteLength,
  }
}

function waitForClose(
  child: ChildProcessWithoutNullStreams,
  onRunningError: (error: Error) => void,
): { promise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; cleanup: () => void } {
  let onError: (error: Error) => void
  let onClose: (code: number | null, signal: NodeJS.Signals | null) => void
  const promise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    onError = error => { if (child.pid) onRunningError(error); else reject(error) }
    child.once('error', onError)
    // `exit` can precede delivery of the final stdout chunk. `close` is the
    // child-process guarantee that stdio has drained, so a caller's completion
    // validation cannot race the final record.
    onClose = (code, signal) => resolve({ code, signal })
    child.once('close', onClose)
  })
  return { promise, cleanup: () => {
    child.removeListener('error', onError!)
    child.removeListener('close', onClose!)
  } }
}
