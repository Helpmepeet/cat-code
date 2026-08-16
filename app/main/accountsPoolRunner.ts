/**
 * Main-owned accounts-pool worker runner + interval driver (accounts owner —
 * `docs/migration/decisions/ACCOUNTS-OWNERSHIP.md`). This module contains no
 * Electron imports and is unit-testable. It is the accounts sibling of
 * `sessionsCatalogRunner`: it spawns exactly ONE serialized engine-graph worker,
 * reads bounded NDJSON, validates the single result record fail-closed, re-scans
 * for secret-keyed material, and hands the accepted redacted pool snapshot to
 * main (which forwards it to the renderer as a read-only outbound host event).
 *
 * It is deliberately self-contained rather than importing the catalog runner's
 * driver: the two are siblings in the same way `runTranscriptBackfill` and the
 * catalog runner are siblings, and coupling the accounts poll to the catalog
 * module would make one surface's refactor silently break the other.
 *
 * The driver is single-flight + fixed-cadence, with the same reasoning the
 * catalog driver documents: it never spawns a second worker while one is in
 * flight, but anchors the next run to when the current one STARTED, so the
 * refresh period stays exactly `intervalMs` instead of growing with run
 * duration. A failed run keeps the last good pool: it simply does not call
 * `onPool`, so main emits no host event and the renderer's retained snapshot
 * survives.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import { scanForSecrets } from '../shared/secretGuard.js'
import type { AccountsSnapshot, UsageStatsByRange } from '../shared/protocol.js'
import {
  MAX_ACCOUNTS_POOL_WORKER_RECORD_BYTES,
  parseAccountsPoolWorkerResult,
} from '../shared/accountsPoolWorker.js'

/**
 * Default cadence. Longer than the catalog's 30 s because usage headroom is
 * coarse (percent buckets on a 5-hour window), and because the worker's one
 * network read (`fetchPoolUsage`) is NOT effectively cached here: its
 * module-level cache (`codexUsage.ts:93`, 1-minute TTL) lives inside the
 * disposable worker process this driver spawns fresh every run, so the cache
 * never survives between runs and every run performs a live authenticated
 * fetch regardless of interval. Polling faster does not "spend a boot to
 * re-read a cached value" — it directly multiplies real network calls against
 * the account's usage endpoint.
 */
export const ACCOUNTS_POOL_REFRESH_INTERVAL_MS = 60_000
export const ACCOUNTS_POOL_WORKER_TIMEOUT_MS = 2 * 60 * 1000

/**
 * Usage analytics ride only every Nth pool run (5 min at the 60 s cadence
 * above), requested with the `--usage-stats` argv flag.
 *
 * Their cost is nothing like the pool's. The pool read is a vault/config read
 * plus one usage GET; the stats read is a full stat-and-parse pass over every
 * transcript in the projects directory, ~0.9 s for both ranges on a corpus of
 * ~130 sessions and growing with history. Paying that every minute is ~22
 * minutes of disk work a day for numbers that are 7-day and 30-day totals: they
 * cannot meaningfully move inside a minute, and the whole scan happens whether
 * or not the Accounts page is even open.
 *
 * A shorter interval for the pool is the right trade (usage headroom IS live and
 * the page shows it per-account); the same interval for the analytics is not.
 * Runs that skip it deliver the pool exactly as before and simply carry no
 * `usageStats`, which the renderer already treats as "keep the last good value".
 * The FIRST run always includes them, so a cold launch is never gated on this.
 */
export const USAGE_STATS_EVERY_N_RUNS = 5

/**
 * Does run `runIndex` (0-based) carry the analytics? Run 0 must, or a cold
 * launch would leave the Accounts page pending for the first five minutes,
 * which is the state this whole feed exists to remove.
 */
export function runCarriesUsageStats(runIndex: number): boolean {
  return runIndex % USAGE_STATS_EVERY_N_RUNS === 0
}
const MAX_ACCOUNTS_STDERR_BYTES = 64 * 1024

export type AccountsPoolRunOptions = {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs?: number
  spawnWorker?: typeof spawn
  /** Called at most ONCE, only for an accepted + secret-clean pool record. */
  onPool: (pool: AccountsSnapshot) => void
  /**
   * Called at most ONCE, and only when the accepted record actually carried
   * `usageStats` — the field is optional so a failed stats read still delivers
   * the pool. Fired AFTER `onPool` so the two never land out of order.
   */
  onUsageStats?: (stats: UsageStatsByRange) => void
  /** Metadata-only process lifecycle hook; it never receives worker output. */
  onWorkerLifecycle?: (event: WorkerProcessLifecycle) => void
  log?: (line: string) => void
}

export type WorkerProcessLifecycle = Readonly<{
  phase: 'started' | 'exited'
  pid: number
  code?: number | null
  signal?: NodeJS.Signals | null
}>

export type AccountsPoolRunOutcome = 'delivered' | 'failure' | 'empty'

/**
 * Spawn one worker, deliver the single pool record. Resolves with the outcome;
 * rejects only on a protocol/transport violation (bad NDJSON, oversize record,
 * timeout, abort, non-zero exit, a callback that threw), never on a clean
 * worker-reported `failure` (that resolves `'failure'` so the driver just keeps
 * the last good pool).
 */
export async function runAccountsPoolWorker(
  options: AccountsPoolRunOptions,
): Promise<AccountsPoolRunOutcome> {
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

  let outcome: AccountsPoolRunOutcome = 'empty'
  let recordSeen = false
  let pending = Buffer.alloc(0)
  let stderr = Buffer.alloc(0)
  let timedOut = false
  let aborted = false
  let protocolError: string | null = null
  let callbackError: unknown = null
  let stdinError: unknown = null

  const terminate = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
  const timeout = setTimeout(() => {
    timedOut = true
    terminate()
  }, options.timeoutMs ?? ACCOUNTS_POOL_WORKER_TIMEOUT_MS)
  const onAbort = () => {
    aborted = true
    terminate()
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })

  child.stderr.on('data', chunk => {
    if (stderr.byteLength >= MAX_ACCOUNTS_STDERR_BYTES) return
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    stderr = Buffer.concat([
      stderr,
      next.subarray(0, MAX_ACCOUNTS_STDERR_BYTES - stderr.byteLength),
    ])
  })

  child.stdout.on('data', chunk => {
    if (protocolError) return
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    pending = Buffer.concat([pending, next])
    while (true) {
      const newline = pending.indexOf(0x0a)
      if (newline < 0) break
      const line = pending.subarray(0, newline)
      pending = pending.subarray(newline + 1)
      if (line.byteLength === 0) continue
      if (line.byteLength > MAX_ACCOUNTS_POOL_WORKER_RECORD_BYTES) {
        protocolError = 'accounts worker record exceeds size limit'
        terminate()
        return
      }
      if (recordSeen) {
        // The worker emits EXACTLY one result record; a second is a protocol
        // violation (fail closed, never silently accept extra output).
        protocolError = 'accounts worker emitted more than one record'
        terminate()
        return
      }
      let raw: unknown
      try {
        raw = JSON.parse(line.toString('utf8'))
      } catch {
        protocolError = 'accounts worker record is not valid JSON'
        terminate()
        return
      }
      const result = parseAccountsPoolWorkerResult(raw)
      if (!result || !scanForSecrets(result).ok) {
        protocolError = 'accounts worker record failed validation'
        terminate()
        return
      }
      recordSeen = true
      if (result.type === 'failure') {
        outcome = 'failure'
        continue
      }
      try {
        options.onPool(result.pool)
        if (result.usageStats) options.onUsageStats?.(result.usageStats)
        outcome = 'delivered'
      } catch (error) {
        callbackError = error
        terminate()
        return
      }
    }
    if (pending.byteLength > MAX_ACCOUNTS_POOL_WORKER_RECORD_BYTES) {
      protocolError = 'accounts worker record exceeds size limit'
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
    // The accounts worker reads no manifest. Close stdin so a worker that reads
    // it (defense in depth) sees EOF immediately.
    child.stdin.end()
    ;({ code, signal } = await closed)
    options.onWorkerLifecycle?.({ phase: 'exited', pid: child.pid ?? 0, code, signal })
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', onAbort)
    child.stdin.removeListener('error', onStdinError)
  }

  const diagnostics = stderr.toString('utf8').trim()
  if (diagnostics) options.log?.(diagnostics)
  if (aborted) throw new Error('accounts worker aborted')
  if (timedOut) throw new Error('accounts worker timed out')
  if (callbackError !== null) {
    throw new Error('accounts worker result callback failed', { cause: callbackError })
  }
  if (stdinError !== null) {
    throw new Error('accounts worker stdin failed', { cause: stdinError })
  }
  if (protocolError !== null) throw new Error(protocolError)
  if (code !== 0) {
    throw new Error(
      `accounts worker failed (code=${String(code)} signal=${String(signal)})`,
    )
  }
  if (pending.byteLength !== 0 || !recordSeen) {
    throw new Error('accounts worker ended without a valid result record')
  }
  return outcome
}

function waitForClose(
  child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    // `close` (not `exit`) is the guarantee that stdio drained, so the final
    // record cannot race completion validation.
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
}

export type AccountsPoolDriver = {
  /** Run once now (respecting single-flight), then keep refreshing on the timer. */
  start(): void
  /** Stop the timer and prevent any further scheduled runs. */
  stop(): void
}

/**
 * Single-flight, fixed-cadence driver. `run()` performs ONE pool run (spawn +
 * deliver). At most one run is ever in flight — the next is only SCHEDULED once
 * the current settles — while the next run is anchored to the current run's
 * START, so the period stays `intervalMs` rather than `intervalMs + runDuration`.
 * A run that overruns the interval schedules the next immediately (delay 0),
 * still serialized behind the in-flight guard. A rejected `run()` is logged and
 * swallowed: the timer keeps ticking and the renderer keeps its last good pool.
 */
export function createAccountsPoolDriver(deps: {
  run: () => Promise<unknown>
  intervalMs?: number
  log?: (line: string) => void
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
  /** Injected only so tests can drive the cadence math on a virtual clock. */
  now?: () => number
}): AccountsPoolDriver {
  const intervalMs = deps.intervalMs ?? ACCOUNTS_POOL_REFRESH_INTERVAL_MS
  const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
  const clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle))
  const now = deps.now ?? (() => Date.now())

  let inFlight = false
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const schedule = (startedAt: number) => {
    if (stopped) return
    const delay = Math.max(0, intervalMs - (now() - startedAt))
    timer = setTimer(() => {
      timer = null
      void tick()
    }, delay)
    timer.unref?.()
  }

  const tick = async () => {
    // Single-flight: never a second worker while one is in flight. A tick that
    // arrives mid-run is dropped; the running tick reschedules on completion.
    if (inFlight || stopped) return
    inFlight = true
    const startedAt = now()
    try {
      await deps.run()
    } catch (error) {
      deps.log?.(
        `[accounts-runner] refresh failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    } finally {
      inFlight = false
      schedule(startedAt)
    }
  }

  return {
    start() {
      if (stopped) return
      // Trigger one run immediately (cold launch: the page must not sit empty),
      // then self-reschedule from its completion.
      void tick()
    },
    stop() {
      stopped = true
      if (timer !== null) {
        clearTimer(timer)
        timer = null
      }
    },
  }
}
