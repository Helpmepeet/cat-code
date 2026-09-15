/**
 * Main-owned PL-B worker runner. This module contains no Electron imports and is
 * unit-testable. It spawns exactly ONE serialized engine-graph worker (the
 * spawn/framing/teardown mechanism is `ndjsonWorker.ts`), sends one bounded
 * manifest, validates every record fail-closed, re-scans for secret-keyed
 * material, and hands accepted session results to main (the sole cache writer).
 */

import type { spawn } from 'node:child_process'

import type { SessionDescriptor } from '../shared/hostApi.js'
import { scanForSecrets } from '../shared/secretGuard.js'
import {
  MAX_TRANSCRIPT_BACKFILL_INPUT_BYTES,
  MAX_TRANSCRIPT_BACKFILL_RECORD_BYTES,
  TRANSCRIPT_BACKFILL_BOUNDARY_VERSION,
  parseTranscriptBackfillRequest,
  parseTranscriptBackfillResult,
  type TranscriptBackfillItem,
  type TranscriptBackfillSessionResult,
} from '../shared/transcriptBackfill.js'
import {
  TRANSCRIPT_CACHE_RUN_FACTS_VERSION,
  createTranscriptCache,
  readCache,
  hasAnyRunFact,
  writeCache,
} from './transcriptCache.js'
import { runNdjsonWorker, type WorkerProcessLifecycle } from './ndjsonWorker.js'

export const TRANSCRIPT_BACKFILL_TIMEOUT_MS = 5 * 60 * 1000

export type TranscriptBackfillRunOptions = {
  items: TranscriptBackfillItem[]
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs?: number
  spawnWorker?: typeof spawn
  onSession: (result: TranscriptBackfillSessionResult) => void
  /** Metadata-only process lifecycle hook; it never receives worker output. */
  onWorkerLifecycle?: (event: WorkerProcessLifecycle) => void
  log?: (line: string) => void
}

export type TranscriptBackfillRunSummary = {
  attempted: number
  accepted: number
  failed: number
  rejected: number
}

export type TranscriptBackfillPersistResult =
  | 'written'
  | 'ineligible'
  | 'already_cached'
  | 'rejected'

/**
 * Final main-side race gate + single-writer commit. The caller supplies a FRESH
 * host descriptor and transcript existence check; a live/removed/re-keyed row
 * or a cache written concurrently while the worker ran is never overwritten.
 */
export function persistTranscriptBackfillResult(
  options: {
    cacheDir: string
    getCurrentSession: (appSessionId: string) => SessionDescriptor | undefined
    transcriptExists: (session: SessionDescriptor) => boolean
    /**
     * Whether a complete existing cache should still be replaced. Main sets this
     * for a row whose engine transcript has grown since the cache was written —
     * a session continued outside the desktop app — which is the only path that
     * refreshes a cache already carrying run facts. Absent means never.
     */
    isCacheStale?: (
      session: SessionDescriptor,
      existingWrittenAt: number,
    ) => boolean
  },
  result: TranscriptBackfillSessionResult,
): TranscriptBackfillPersistResult {
  const current = options.getCurrentSession(result.appSessionId)
  if (
    !current?.restorable ||
    current.engineSessionId !== result.engineSessionId ||
    !options.transcriptExists(current)
  ) {
    return 'ineligible'
  }
  // A cache with no transcript frames is worse than no cache: the renderer
  // treats a readable cache as a preview and holds a loading placeholder for a
  // transcript that will never arrive.
  if (result.frames.length === 0) return 'ineligible'
  // A cache whose run facts predate the current derivation is refreshed rather
  // than kept: it previews fine but can say nothing (or nothing complete) about
  // what the session ran on, and the worker has just read that from the raw
  // transcript. A cache already at the current version is left alone unless the
  // caller says the transcript moved on, so a re-run is still a no-op.
  //
  // VERSION, not presence: this gate and `cacheHasCurrentRunFacts` must agree,
  // or discovery queues a session that persistence then refuses to write.
  const existing = readCache(options.cacheDir, result.appSessionId)
  if (
    existing !== null &&
    (existing.header.runFactsVersion ?? 0) >= TRANSCRIPT_CACHE_RUN_FACTS_VERSION &&
    !(options.isCacheStale?.(current, existing.header.writtenAt) ?? false)
  ) {
    return 'already_cached'
  }
  // A WEAKER gate than the close path's, and deliberately so.
  //
  // Both writers must obey the same principle — never write a header thinner
  // than what that cache's own frames could supply, because the renderer trusts
  // a header wholesale and stops reading frames. But the two caches have very
  // different frames, so the same principle yields different rules:
  //
  //   CLOSE: the frames are the live replay buffer, carrying `result` messages
  //     (usage + the exact context window) and `permissionMode` on user turns.
  //     A rich fallback, so only a COMPLETE header may displace it.
  //   BACKFILL (here): the frames come from the engine's `toSDKMessages`
  //     conversion, which keeps conversation and drops telemetry. Measured on
  //     this machine's real caches: ZERO `result` frames and zero frame-level
  //     `permissionMode`. The fallback can name the model and nothing else, so
  //     any fact at all is an improvement and requiring completeness would throw
  //     away the window and effort this worker uniquely resolved.
  //
  // What both refuse is an ALL-NULL object, which cannot beat any fallback and
  // is reachable whenever the transcript could not be read.
  const runFacts = hasAnyRunFact(result.runFacts) ? result.runFacts : undefined
  writeCache(
    options.cacheDir,
    createTranscriptCache(
      result.appSessionId,
      result.engineSessionId,
      result.frames,
      runFacts,
    ),
  )
  return readCache(options.cacheDir, result.appSessionId) === null
    ? 'rejected'
    : 'written'
}

export async function runTranscriptBackfill(
  options: TranscriptBackfillRunOptions,
): Promise<TranscriptBackfillRunSummary> {
  const request = parseTranscriptBackfillRequest({
    version: TRANSCRIPT_BACKFILL_BOUNDARY_VERSION,
    items: options.items,
  })
  if (!request) throw new Error('invalid transcript-backfill manifest')
  const input = JSON.stringify(request)
  if (Buffer.byteLength(input, 'utf8') > MAX_TRANSCRIPT_BACKFILL_INPUT_BYTES) {
    throw new Error('transcript-backfill manifest exceeds input limit')
  }
  if (request.items.length === 0) {
    return { attempted: 0, accepted: 0, failed: 0, rejected: 0 }
  }

  const expected = new Map(
    request.items.map(item => [
      item.appSessionId,
      `${item.engineSessionId}\0${item.transcriptPath}`,
    ]),
  )
  const seen = new Set<string>()
  let accepted = 0
  let failed = 0
  let rejected = 0
  let doneAttempted: number | null = null
  let callbackError: unknown = null

  const { code, signal, aborted, timedOut, stdinError, trailingBytes } =
    await runNdjsonWorker({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? TRANSCRIPT_BACKFILL_TIMEOUT_MS,
      spawnWorker: options.spawnWorker,
      maxRecordBytes: MAX_TRANSCRIPT_BACKFILL_RECORD_BYTES,
      input,
      onWorkerLifecycle: options.onWorkerLifecycle,
      log: options.log,
      onOversizeRecord: () => {
        rejected += 1
      },
      onRecord: line => {
        let raw: unknown
        try {
          raw = JSON.parse(line.toString('utf8'))
        } catch {
          rejected += 1
          return 'stop'
        }
        const result = parseTranscriptBackfillResult(raw)
        if (!result || !scanForSecrets(result).ok) {
          rejected += 1
          return 'stop'
        }
        if (result.type === 'done') {
          if (doneAttempted !== null) {
            rejected += 1
            return 'stop'
          }
          doneAttempted = result.attempted
          return 'continue'
        }
        const identity = expected.get(result.appSessionId)
        if (
          !identity ||
          !identity.startsWith(`${result.engineSessionId}\0`) ||
          seen.has(result.appSessionId)
        ) {
          rejected += 1
          return 'stop'
        }
        seen.add(result.appSessionId)
        if (result.type === 'failure') {
          failed += 1
          return 'continue'
        }
        try {
          options.onSession(result)
          accepted += 1
        } catch (error) {
          // EventEmitter callbacks do not route thrown errors into the caller's
          // surrounding async try/catch. Capture the failure, stop the worker,
          // and reject only after its stdio has closed and it has been reaped.
          callbackError = error
          rejected += 1
          return 'stop'
        }
        return 'continue'
      },
    })

  if (aborted) throw new Error('transcript-backfill worker aborted')
  if (timedOut) throw new Error('transcript-backfill worker timed out')
  if (callbackError !== null) {
    throw new Error('transcript-backfill result callback failed', {
      cause: callbackError,
    })
  }
  if (stdinError !== null) {
    throw new Error('transcript-backfill worker stdin failed', {
      cause: stdinError,
    })
  }
  if (code !== 0) {
    throw new Error(
      `transcript-backfill worker failed (code=${String(code)} signal=${String(signal)})`,
    )
  }
  if (trailingBytes !== 0 || doneAttempted !== request.items.length) {
    throw new Error('transcript-backfill worker ended without a valid done record')
  }
  if (seen.size !== request.items.length) {
    throw new Error('transcript-backfill worker omitted a session result')
  }
  return {
    attempted: request.items.length,
    accepted,
    failed,
    rejected,
  }
}
