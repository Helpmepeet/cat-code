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
  phase: 'started' | 'exited'
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
  signal?: AbortSignal
  timeoutMs: number
  spawnWorker?: typeof spawn
  /** A framed line longer than this is never parsed; `onOversizeRecord` fires. */
  maxRecordBytes: number
  /** Written once to stdin before it is closed. Absent closes stdin empty. */
  input?: string
  /**
   * Destructive one-shot writes cannot outlive Electron teardown. Abort sends
   * SIGKILL immediately because app.exit can destroy escalation timers.
   */
  forceKillOnAbort?: boolean
  /**
   * Escalate an unanswered SIGTERM to SIGKILL after this long. Absent means the
   * worker is only ever asked to stop, never forced.
   */
  escalateKillAfterMs?: number
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
export async function runNdjsonWorker(
  options: NdjsonWorkerOptions,
): Promise<NdjsonWorkerOutcome> {
  const spawnWorker = options.spawnWorker ?? spawn
  const child = spawnWorker(options.command, options.args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
      // Defense in depth with the worker's own pre-import assignment + --bare
      // argv: SessionStart hooks must stay suppressed even if one gate drifts.
      CLAUDE_CODE_SIMPLE: '1',
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

  const terminate = (force = false) => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(force ? 'SIGKILL' : 'SIGTERM')
    }
    if (force || options.escalateKillAfterMs === undefined) return
    if (forceKillTimer === null) {
      forceKillTimer = setTimeout(() => {
        if (!childClosed) child.kill('SIGKILL')
      }, options.escalateKillAfterMs)
      forceKillTimer.unref?.()
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

  child.stderr.on('data', chunk => {
    if (stderr.byteLength >= MAX_WORKER_STDERR_BYTES) return
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    stderr = Buffer.concat([
      stderr,
      next.subarray(0, MAX_WORKER_STDERR_BYTES - stderr.byteLength),
    ])
  })

  child.stdout.on('data', chunk => {
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
  })

  const onStdinError = (error: unknown) => {
    stdinError = error
    terminate()
  }
  child.stdin.on('error', onStdinError)
  const closed = waitForClose(child)
  let code: number | null
  let signal: NodeJS.Signals | null
  try {
    child.stdin.end(options.input)
    ;({ code, signal } = await closed)
    childClosed = true
    options.onWorkerLifecycle?.({ phase: 'exited', pid: child.pid ?? 0, code, signal })
  } finally {
    clearTimeout(timeout)
    if (forceKillTimer !== null) clearTimeout(forceKillTimer)
    options.signal?.removeEventListener('abort', onAbort)
    child.stdin.removeListener('error', onStdinError)
  }

  const diagnostics = stderr.toString('utf8').trim()
  if (diagnostics) options.log?.(diagnostics)
  return {
    code,
    signal,
    aborted,
    timedOut,
    stdinError,
    trailingBytes: pending.byteLength,
  }
}

function waitForClose(
  child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    // `exit` can precede delivery of the final stdout chunk. `close` is the
    // child-process guarantee that stdio has drained, so a caller's completion
    // validation cannot race the final record.
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
}
