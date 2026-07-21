/**
 * Main-owned sessions-catalog worker runner + interval driver (catalog owner,
 * decision #4 shape (b) — `docs/migration/decisions/CATALOG-OWNERSHIP.md`). This
 * module contains no Electron imports and is unit-testable. It is the catalog
 * sibling of the PL-B `runTranscriptBackfill` runner: it spawns exactly ONE
 * serialized engine-graph worker, reads bounded NDJSON, validates the single
 * result record fail-closed, re-scans for secret-keyed material, and hands the
 * accepted global catalog snapshot to main (which forwards it to the renderer as
 * a read-only outbound host event).
 *
 * The driver is single-flight + self-rescheduling: it never spawns a second
 * worker while one is in flight, and the next run is scheduled only AFTER the
 * current one settles, so a run that overruns its interval can never stack (the
 * CATALOG-OWNERSHIP §4 "run can overrun its interval" con). A failed run keeps
 * the last good catalog: it simply does not call `onCatalog`, so main emits no
 * host event and the renderer's retained snapshot survives.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import { scanForSecrets } from '../shared/secretGuard.js'
import type { SessionsCatalogSnapshot } from '../shared/protocol.js'
import {
  MAX_SESSIONS_CATALOG_WORKER_RECORD_BYTES,
  parseSessionsCatalogWorkerResult,
} from '../shared/sessionsCatalogWorker.js'

/**
 * Default cadence — preserve today's freshness contract (the per-sidecar refresh
 * ran every 30 s, `sidecarServer.ts` `SESSIONS_CATALOG_REFRESH_INTERVAL_MS`).
 * This is the cadence knob CATALOG-OWNERSHIP §4 names: lengthen it if the
 * per-run boot cost proves heavy — freshness is refresh-tolerant.
 */
export const SESSIONS_CATALOG_REFRESH_INTERVAL_MS = 30_000
export const SESSIONS_CATALOG_WORKER_TIMEOUT_MS = 5 * 60 * 1000
const MAX_CATALOG_STDERR_BYTES = 64 * 1024

export type SessionsCatalogRunOptions = {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs?: number
  spawnWorker?: typeof spawn
  /** Called at most ONCE, only for an accepted + secret-clean catalog record. */
  onCatalog: (catalog: SessionsCatalogSnapshot) => void
  log?: (line: string) => void
}

export type SessionsCatalogRunOutcome = 'delivered' | 'failure' | 'empty'

/**
 * Spawn one worker, deliver the single catalog record. Resolves with the
 * outcome; rejects only on a protocol/transport violation (bad NDJSON, oversize
 * record, timeout, abort, non-zero exit, a callback that threw), never on a
 * clean worker-reported `failure` (that resolves `'failure'` so the driver just
 * keeps the last good catalog).
 */
export async function runSessionsCatalogWorker(
  options: SessionsCatalogRunOptions,
): Promise<SessionsCatalogRunOutcome> {
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

  let outcome: SessionsCatalogRunOutcome = 'empty'
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
  }, options.timeoutMs ?? SESSIONS_CATALOG_WORKER_TIMEOUT_MS)
  const onAbort = () => {
    aborted = true
    terminate()
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })

  child.stderr.on('data', chunk => {
    if (stderr.byteLength >= MAX_CATALOG_STDERR_BYTES) return
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    stderr = Buffer.concat([
      stderr,
      next.subarray(0, MAX_CATALOG_STDERR_BYTES - stderr.byteLength),
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
      if (line.byteLength > MAX_SESSIONS_CATALOG_WORKER_RECORD_BYTES) {
        protocolError = 'catalog worker record exceeds size limit'
        terminate()
        return
      }
      if (recordSeen) {
        // The worker emits EXACTLY one result record; a second is a protocol
        // violation (fail closed, never silently accept extra output).
        protocolError = 'catalog worker emitted more than one record'
        terminate()
        return
      }
      let raw: unknown
      try {
        raw = JSON.parse(line.toString('utf8'))
      } catch {
        protocolError = 'catalog worker record is not valid JSON'
        terminate()
        return
      }
      const result = parseSessionsCatalogWorkerResult(raw)
      if (!result || !scanForSecrets(result).ok) {
        protocolError = 'catalog worker record failed validation'
        terminate()
        return
      }
      recordSeen = true
      if (result.type === 'failure') {
        outcome = 'failure'
        continue
      }
      try {
        options.onCatalog(result.catalog)
        outcome = 'delivered'
      } catch (error) {
        callbackError = error
        terminate()
        return
      }
    }
    if (pending.byteLength > MAX_SESSIONS_CATALOG_WORKER_RECORD_BYTES) {
      protocolError = 'catalog worker record exceeds size limit'
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
    // The catalog worker is a global enumeration — no manifest. Close stdin so a
    // worker that reads it (defense in depth) sees EOF immediately.
    child.stdin.end()
    ;({ code, signal } = await closed)
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', onAbort)
    child.stdin.removeListener('error', onStdinError)
  }

  const diagnostics = stderr.toString('utf8').trim()
  if (diagnostics) options.log?.(diagnostics)
  if (aborted) throw new Error('catalog worker aborted')
  if (timedOut) throw new Error('catalog worker timed out')
  if (callbackError !== null) {
    throw new Error('catalog worker result callback failed', { cause: callbackError })
  }
  if (stdinError !== null) {
    throw new Error('catalog worker stdin failed', { cause: stdinError })
  }
  if (protocolError !== null) throw new Error(protocolError)
  if (code !== 0) {
    throw new Error(
      `catalog worker failed (code=${String(code)} signal=${String(signal)})`,
    )
  }
  if (pending.byteLength !== 0 || !recordSeen) {
    throw new Error('catalog worker ended without a valid result record')
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

export type SessionsCatalogDriver = {
  /** Run once now (respecting single-flight), then keep refreshing on the timer. */
  start(): void
  /** Stop the timer and prevent any further scheduled runs. */
  stop(): void
}

/**
 * Single-flight, self-rescheduling driver. `run()` performs ONE catalog run
 * (spawn + deliver). The driver guarantees at most one run in flight and
 * schedules the next only after the current settles, so a slow corpus can never
 * cause overlapping spawns. A rejected `run()` is logged and swallowed — the
 * timer keeps ticking and the renderer keeps its last good catalog.
 */
export function createSessionsCatalogDriver(deps: {
  run: () => Promise<unknown>
  intervalMs?: number
  log?: (line: string) => void
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}): SessionsCatalogDriver {
  const intervalMs = deps.intervalMs ?? SESSIONS_CATALOG_REFRESH_INTERVAL_MS
  const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
  const clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle))

  let inFlight = false
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const schedule = () => {
    if (stopped) return
    timer = setTimer(() => {
      timer = null
      void tick()
    }, intervalMs)
    timer.unref?.()
  }

  const tick = async () => {
    // Single-flight: never a second worker while one is in flight. A tick that
    // arrives mid-run is dropped; the running tick reschedules on completion.
    if (inFlight || stopped) return
    inFlight = true
    try {
      await deps.run()
    } catch (error) {
      deps.log?.(
        `[catalog-runner] refresh failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    } finally {
      inFlight = false
      schedule()
    }
  }

  return {
    start() {
      if (stopped) return
      // Trigger one run immediately (cold-launch: the sidebar must not be empty),
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
