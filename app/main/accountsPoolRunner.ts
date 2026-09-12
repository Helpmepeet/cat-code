/**
 * Main-owned accounts-pool worker runner (accounts owner —
 * `docs/migration/decisions/ACCOUNTS-OWNERSHIP.md`). This module contains no
 * Electron imports and is unit-testable. It is the accounts sibling of
 * `sessionsCatalogRunner`: it spawns exactly ONE serialized engine-graph worker,
 * reads bounded NDJSON, validates the single result record fail-closed, re-scans
 * for secret-keyed material, and hands the accepted redacted result to main.
 * Ordinary runs deliver a pool snapshot; the explicit one-shot delete mode writes
 * one validated request to stdin and delivers its outcome plus the fresh pool.
 *
 * The spawn/framing/teardown mechanism lives in `ndjsonWorker.ts` and the
 * refresh cadence in `singleFlightDriver.ts`; what stays here is the pool's own
 * record policy. A failed run keeps the last good pool: it simply does not call
 * `onPool`, so main emits no host event and the renderer's retained snapshot
 * survives.
 */

import type { spawn } from 'node:child_process'

import { scanForSecrets } from '../shared/secretGuard.js'
import type { AccountsSnapshot, UsageStatsByRange } from '../shared/protocol.js'
import {
  MAX_ACCOUNTS_POOL_WORKER_RECORD_BYTES,
  parseAccountsPoolWorkerResult,
  type AccountsPoolWorkerDeleteRequest,
  type AccountsPoolWorkerDeleteResult,
  type AccountsPoolWorkerResult,
} from '../shared/accountsPoolWorker.js'
import { runNdjsonWorker, type WorkerProcessLifecycle } from './ndjsonWorker.js'

/**
 * Usage headroom changes in coarse percent buckets on a 5-hour window, so a
 * minute is sufficient for ordinary observation. Each run still boots a
 * disposable engine worker. Its unforced `fetchPoolUsage` read can reuse the
 * engine-owned private 60-second observation shared across processes; misses
 * perform authenticated usage GETs. Sharing observations saves requests when
 * workers and sessions overlap, but does not remove worker startup cost.
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
 *
 * "Every 5 minutes" is therefore approximate, not a clock. The counter advances
 * per RUN, and `refreshNow()` runs are runs, so an out-of-band refresh both
 * shifts the phase and can be the run that pays the scan. Harmless in both
 * directions (the numbers are 7-day and 30-day totals), and worth knowing before
 * reading the interval off this constant.
 */
export const USAGE_STATS_EVERY_N_RUNS = 5

export type AccountsPoolPublicationGate = {
  beginRead(): number
  invalidate(): void
  canPublish(generation: number): boolean
}

export function createAccountsPoolPublicationGate(): AccountsPoolPublicationGate {
  let generation = 0
  return {
    beginRead: () => generation,
    invalidate: () => {
      generation += 1
    },
    canPublish: candidate => candidate === generation,
  }
}

/**
 * Does run `runIndex` (0-based) carry the analytics? Run 0 must, or a cold
 * launch would leave the Accounts page pending for the first five minutes,
 * which is the state this whole feed exists to remove.
 */
export function runCarriesUsageStats(runIndex: number): boolean {
  return runIndex % USAGE_STATS_EVERY_N_RUNS === 0
}

/**
 * An unanswered SIGTERM becomes a SIGKILL after this long. Unique to this
 * runner: a destructive account-delete worker must not outlive Electron
 * teardown.
 */
const ACCOUNTS_FORCE_KILL_AFTER_MS = 2_000

export type AccountsPoolRunOptions = {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs?: number
  spawnWorker?: typeof spawn
  /**
   * Present only for the one-shot, session-independent account-delete mode.
   * The exact closed request is written once to stdin before it is closed.
   */
  input?: AccountsPoolWorkerDeleteRequest
  /**
   * Destructive one-shot writes cannot outlive Electron teardown. Abort sends
   * SIGKILL immediately because app.exit can destroy escalation timers.
   */
  forceKillOnAbort?: boolean
  /** Called at most ONCE, only for an accepted + secret-clean pool record. */
  onPool?: (pool: AccountsSnapshot) => void
  /** Called at most once for an accepted account-delete result. */
  onAccountDelete?: (result: AccountsPoolWorkerDeleteResult) => void
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
  let outcome: AccountsPoolRunOutcome = 'empty'
  let recordSeen = false
  let protocolError: string | null = null
  const accepted: { value: AccountsPoolWorkerResult | null } = {
    value: null,
  }

  const { code, signal, aborted, timedOut, stdinError, trailingBytes } =
    await runNdjsonWorker({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? ACCOUNTS_POOL_WORKER_TIMEOUT_MS,
      spawnWorker: options.spawnWorker,
      maxRecordBytes: MAX_ACCOUNTS_POOL_WORKER_RECORD_BYTES,
      input: options.input ? `${JSON.stringify(options.input)}\n` : undefined,
      forceKillOnAbort: options.forceKillOnAbort,
      escalateKillAfterMs: ACCOUNTS_FORCE_KILL_AFTER_MS,
      onWorkerLifecycle: options.onWorkerLifecycle,
      log: options.log,
      onOversizeRecord: () => {
        protocolError = 'accounts worker record exceeds size limit'
      },
      onRecord: line => {
        if (recordSeen) {
          // The worker emits EXACTLY one result record; a second is a protocol
          // violation (fail closed, never silently accept extra output).
          protocolError = 'accounts worker emitted more than one record'
          return 'stop'
        }
        let raw: unknown
        try {
          raw = JSON.parse(line.toString('utf8'))
        } catch {
          protocolError = 'accounts worker record is not valid JSON'
          return 'stop'
        }
        const result = parseAccountsPoolWorkerResult(raw)
        if (!result || !scanForSecrets(result).ok) {
          protocolError = 'accounts worker record failed validation'
          return 'stop'
        }
        recordSeen = true
        if (result.type === 'failure') {
          accepted.value = result
          outcome = 'failure'
          return 'continue'
        }
        if (result.type === 'account-delete') {
          if (!options.input || !options.onAccountDelete) {
            protocolError = 'unexpected accounts worker delete result'
            return 'stop'
          }
          if (result.requestId !== options.input.verb.requestId) {
            protocolError = 'accounts worker delete result requestId mismatch'
            return 'stop'
          }
          if (
            result.ok &&
            result.pool.accounts.some(
              account => account.id === options.input!.verb.accountId,
            )
          ) {
            protocolError = 'accounts worker successful delete retained target account'
            return 'stop'
          }
        } else if (options.input || !options.onPool) {
          protocolError = 'unexpected accounts worker pool result'
          return 'stop'
        }
        accepted.value = result
        outcome = 'delivered'
        return 'continue'
      },
    })

  if (aborted) throw new Error('accounts worker aborted')
  if (timedOut) throw new Error('accounts worker timed out')
  if (stdinError !== null) {
    throw new Error('accounts worker stdin failed', { cause: stdinError })
  }
  if (protocolError !== null) throw new Error(protocolError)
  if (code !== 0) {
    throw new Error(
      `accounts worker failed (code=${String(code)} signal=${String(signal)})`,
    )
  }
  if (trailingBytes !== 0 || !recordSeen) {
    throw new Error('accounts worker ended without a valid result record')
  }
  const acceptedResult = accepted.value
  if (acceptedResult?.type === 'account-delete') {
    try {
      options.onAccountDelete?.(acceptedResult)
    } catch (error) {
      throw new Error('accounts worker result callback failed', { cause: error })
    }
  } else if (acceptedResult?.type === 'pool') {
    try {
      options.onPool?.(acceptedResult.pool)
      if (acceptedResult.usageStats) {
        options.onUsageStats?.(acceptedResult.usageStats)
      }
    } catch (error) {
      throw new Error('accounts worker result callback failed', { cause: error })
    }
  }
  return outcome
}
