/**
 * Main-owned PL-B worker runner. This module contains no Electron imports and is
 * unit-testable. It spawns exactly ONE serialized engine-graph worker, sends one
 * bounded manifest, parses bounded NDJSON records, validates every record
 * fail-closed, re-scans for secret-keyed material, and hands accepted session
 * results to main (the sole cache writer).
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

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
  createTranscriptCache,
  readCache,
  writeCache,
} from './transcriptCache.js'

export const TRANSCRIPT_BACKFILL_TIMEOUT_MS = 5 * 60 * 1000
const MAX_BACKFILL_STDERR_BYTES = 64 * 1024

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
  // A cache written BEFORE run facts existed is refreshed rather than kept:
  // it previews fine but can say nothing about what the session ran on, and
  // the worker has just read that from the raw transcript. A cache that
  // already has them is left alone unless the caller says the transcript moved
  // on, so a re-run is still a no-op.
  const existing = readCache(options.cacheDir, result.appSessionId)
  if (
    existing !== null &&
    existing.header.runFacts !== undefined &&
    !(options.isCacheStale?.(current, existing.header.writtenAt) ?? false)
  ) {
    return 'already_cached'
  }
  writeCache(
    options.cacheDir,
    createTranscriptCache(
      result.appSessionId,
      result.engineSessionId,
      result.frames,
      result.runFacts,
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
  let pending = Buffer.alloc(0)
  let stderr = Buffer.alloc(0)
  let timedOut = false
  let aborted = false
  let callbackError: unknown = null
  let stdinError: unknown = null

  const terminate = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
  const timeout = setTimeout(() => {
    timedOut = true
    terminate()
  }, options.timeoutMs ?? TRANSCRIPT_BACKFILL_TIMEOUT_MS)
  const onAbort = () => {
    aborted = true
    terminate()
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })

  child.stderr.on('data', chunk => {
    if (stderr.byteLength >= MAX_BACKFILL_STDERR_BYTES) return
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    stderr = Buffer.concat([
      stderr,
      next.subarray(0, MAX_BACKFILL_STDERR_BYTES - stderr.byteLength),
    ])
  })

  child.stdout.on('data', chunk => {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    pending = Buffer.concat([pending, next])
    while (true) {
      const newline = pending.indexOf(0x0a)
      if (newline < 0) break
      const line = pending.subarray(0, newline)
      pending = pending.subarray(newline + 1)
      if (line.byteLength === 0) continue
      if (line.byteLength > MAX_TRANSCRIPT_BACKFILL_RECORD_BYTES) {
        rejected += 1
        terminate()
        return
      }
      let raw: unknown
      try {
        raw = JSON.parse(line.toString('utf8'))
      } catch {
        rejected += 1
        terminate()
        return
      }
      const result = parseTranscriptBackfillResult(raw)
      if (!result || !scanForSecrets(result).ok) {
        rejected += 1
        terminate()
        return
      }
      if (result.type === 'done') {
        if (doneAttempted !== null) {
          rejected += 1
          terminate()
          return
        }
        doneAttempted = result.attempted
        continue
      }
      const identity = expected.get(result.appSessionId)
      if (
        !identity ||
        !identity.startsWith(`${result.engineSessionId}\0`) ||
        seen.has(result.appSessionId)
      ) {
        rejected += 1
        terminate()
        return
      }
      seen.add(result.appSessionId)
      if (result.type === 'failure') {
        failed += 1
      } else {
        try {
          options.onSession(result)
          accepted += 1
        } catch (error) {
          // EventEmitter callbacks do not route thrown errors into the caller's
          // surrounding async try/catch. Capture the failure, stop the worker,
          // and reject only after its stdio has closed and it has been reaped.
          callbackError = error
          rejected += 1
          terminate()
          return
        }
      }
    }
    // Only the unterminated tail is one in-flight record. Several complete
    // records may arrive in one OS chunk and are drained above before this cap.
    if (pending.byteLength > MAX_TRANSCRIPT_BACKFILL_RECORD_BYTES) {
      rejected += 1
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
    child.stdin.end(input)
    ;({ code, signal } = await closed)
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', onAbort)
    child.stdin.removeListener('error', onStdinError)
  }

  const diagnostics = stderr.toString('utf8').trim()
  if (diagnostics) options.log?.(diagnostics)
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
  if (pending.byteLength !== 0 || doneAttempted !== request.items.length) {
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

function waitForClose(
  child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    // `exit` can precede delivery of the final stdout chunk. `close` is the
    // child-process guarantee that stdio has drained, so completion validation
    // below cannot race the terminal `done` record.
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
}
