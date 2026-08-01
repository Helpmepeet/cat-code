/**
 * PL-B cache-backfill worker. One disposable engine-graph process handles all
 * candidates SERIALly. It is intentionally separate from the live N-process
 * sidecars: switchSession mutates process-global cwd/id state, and resume also
 * restores process-global skill latches. Those mutations are safe only inside
 * this short-lived, single-purpose process and disappear when it exits.
 *
 * Main is the sole cache writer. This worker emits bounded, secret-guarded NDJSON
 * records over stdout; stderr is diagnostics only.
 */

import { statSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  MAX_TRANSCRIPT_BACKFILL_INPUT_BYTES,
  MAX_TRANSCRIPT_BACKFILL_RECORD_BYTES,
  TRANSCRIPT_BACKFILL_BOUNDARY_VERSION,
  parseTranscriptBackfillRequest,
  parseTranscriptBackfillResult,
  type TranscriptBackfillFailureResult,
  type TranscriptBackfillResult,
  type TranscriptBackfillSessionResult,
} from '../shared/transcriptBackfill.js'
import {
  MAX_HISTORY_REPLAY_BYTES,
  MAX_HISTORY_REPLAY_FRAMES,
  MAX_OUTBOUND_FRAME_BYTES,
} from '../shared/limits.js'
import {
  HISTORY_REPLAY_TRUNCATION_REQUEST_ID,
  PROTOCOL_VERSION,
  type ServerFrame,
} from '../shared/protocol.js'
import { checkJsonSafe, omitUndefinedObjectProperties } from '../shared/jsonSafe.js'
import { scanForSecrets } from '../shared/secretGuard.js'
import { readTranscriptRunFacts } from './transcriptRunFacts.js'

// Set the one-switch minimal mode before ANY engine module is dynamically
// imported. conversationRecovery always calls processSessionStartHooks('resume'),
// whose first branch returns [] under this flag, before user/plugin hook loading.
process.env.CLAUDE_CODE_SIMPLE = '1'

async function main(): Promise<void> {
  const raw = await readBoundedStdin()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('backfill request is not valid JSON')
  }
  const request = parseTranscriptBackfillRequest(parsed)
  if (!request || request.version !== TRANSCRIPT_BACKFILL_BOUNDARY_VERSION) {
    throw new Error('backfill request failed validation')
  }

  // Engine imports happen only after SIMPLE/bare is fixed for the process.
  const [
    { switchSession, getSdkBetas },
    { loadConversationForResume },
    { toSDKMessages },
    { createMessageEvent },
    { ensureEngineMacro },
    { enableConfigs },
    { getContextWindowForModel },
  ] = await Promise.all([
    import('../../src/bootstrap/state.js'),
    import('../../src/utils/conversationRecovery.js'),
    import('../../src/utils/messages/mappers.js'),
    import('../../src/app-runtime/sessionEvents.js'),
    import('./initializeRuntime.js'),
    import('../../src/utils/config.js'),
    import('../../src/utils/context.js'),
  ])
  // OBSERVATION-ONLY BOOTSTRAP, same reasoning as `accountsPoolWorker.ts`: the
  // full `init()` this used to run fires `void initAccountPool()`
  // (`src/entrypoints/init.ts:86-90`), which starts periodic token refresh, a
  // 1-second quarantine probe, and a usage POST with real OAuth tokens — none of
  // which a transcript read needs, and any of which the unconditional
  // `process.exit(0)` below can hard-kill mid-write. Reading transcripts needs
  // the MACRO shim plus config reads and nothing else.
  ensureEngineMacro()
  enableConfigs()

  // The engine's OWN window lookup, the same call the live donut's number comes
  // from (`src/cost-tracker.ts:107`), rather than a second window table in the
  // app. If it breaks (engine drift, a bad import under the bare/SIMPLE
  // bootstrap) it breaks for EVERY session in the batch and the whole feature
  // reverts to the renderer's default window, so it is reported once instead of
  // failing silently the way a per-session data gap would.
  let contextWindowResolverFailed = false
  const resolveContextWindow = (model: string): number | null => {
    try {
      return getContextWindowForModel(model, getSdkBetas())
    } catch (error) {
      if (!contextWindowResolverFailed) {
        contextWindowResolverFailed = true
        process.stderr.write(
          `[backfill-worker] context-window resolver failed, previews fall back to the default window: ${errorText(error)}\n`,
        )
      }
      return null
    }
  }

  for (const item of request.items) {
    try {
      let isFile = false
      try {
        isFile = statSync(item.transcriptPath).isFile()
      } catch {
        isFile = false
      }
      if (!isFile) {
        await emit({ ...failureIdentity(item), type: 'failure', reason: 'missing' })
        continue
      }

      // O1: mapper stamping and transcript resolution both consult process-global
      // session state. Explicit JSONL loading avoids the log branch's plan/history
      // copies; switchSession still adopts the exact id for toSDKMessages.
      switchSession(item.engineSessionId as never, dirname(item.transcriptPath))
      const loaded = await loadConversationForResume(
        item.engineSessionId,
        item.transcriptPath,
      )
      if (!loaded) {
        await emit({ ...failureIdentity(item), type: 'failure', reason: 'invalid' })
        continue
      }
      if (loaded.sessionId !== item.engineSessionId) {
        await emit({
          ...failureIdentity(item),
          type: 'failure',
          reason: 'session_mismatch',
        })
        continue
      }

      const history = toSDKMessages(loaded.messages)
      const frames = buildBoundedFrames(
        item.appSessionId,
        history.map(createMessageEvent),
      )
      const result: TranscriptBackfillSessionResult = {
        type: 'session',
        appSessionId: item.appSessionId,
        engineSessionId: item.engineSessionId,
        frames,
        // Read from the RAW transcript, not from `history` above: the
        // `toSDKMessages` conversion keeps conversation turns and drops the
        // telemetry these come from, so by that point they no longer exist.
        //
        // The context window is the exception: nothing persists it, so it is
        // resolved from the model (see `resolveContextWindow` above).
        runFacts: readTranscriptRunFacts(item.transcriptPath, resolveContextWindow),
      }
      const secret = scanForSecrets(result)
      if (!secret.ok) {
        process.stderr.write(
          `[backfill-worker] blocked secret-keyed result for ${item.appSessionId}\n`,
        )
        await emit({ ...failureIdentity(item), type: 'failure', reason: 'invalid' })
        continue
      }
      // Self-check against main's OWN parser before emitting.
      //
      // Main is fail-closed on this boundary: a record it cannot validate does
      // not just get dropped, it TERMINATES the run (`transcriptBackfill.ts`,
      // the `parseTranscriptBackfillResult` reject branch), so every session
      // still queued behind this one is silently abandoned. That is the right
      // posture toward a worker that has proven untrustworthy, but it makes the
      // batch only as complete as its least-typical session: one unknown
      // content block cost 30 sessions their run facts (2026-07-28).
      //
      // Validating here converts that class of drift into a `failure` record,
      // which the runner already counts and steps past. Main's own validation
      // is unchanged and still authoritative; this only ensures the record it
      // rejects is one this worker already knows is bad.
      if (!parseTranscriptBackfillResult(result)) {
        process.stderr.write(
          `[backfill-worker] result failed boundary validation for ${item.appSessionId}\n`,
        )
        await emit({ ...failureIdentity(item), type: 'failure', reason: 'invalid' })
        continue
      }
      await emit(result)
    } catch (error) {
      process.stderr.write(
        `[backfill-worker] failed ${item.appSessionId}: ${errorText(error)}\n`,
      )
      await emit({ ...failureIdentity(item), type: 'failure', reason: 'internal' })
    }
  }
  await emit({ type: 'done', attempted: request.items.length })
  // The engine registers long-lived handles (config watchers). This is a
  // disposable batch process, so a clean result must terminate explicitly
  // instead of waiting for those unrelated handles to drain.
  process.exit(0)
}

function buildBoundedFrames(
  appSessionId: string,
  events: Array<{ type: 'message'; message: unknown }>,
): ServerFrame[] {
  const retained: ServerFrame[] = []
  let retainedBytes = 0
  let truncated = false
  for (let i = events.length - 1; i >= 0; i--) {
    let event: (typeof events)[number]
    try {
      event = structuredClone(events[i]!)
    } catch {
      truncated = true
      continue
    }
    omitUndefinedObjectProperties(event)
    if (!checkJsonSafe(event).ok || !scanForSecrets(event).ok) {
      truncated = true
      continue
    }
    const frame: ServerFrame = {
      kind: 'event',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: appSessionId,
      replay: true,
      event: event as never,
    }
    const bytes = Buffer.byteLength(JSON.stringify(frame), 'utf8')
    if (
      bytes > MAX_OUTBOUND_FRAME_BYTES ||
      retained.length + 1 > MAX_HISTORY_REPLAY_FRAMES ||
      retainedBytes + bytes > MAX_HISTORY_REPLAY_BYTES
    ) {
      truncated = true
      break
    }
    retained.push(frame)
    retainedBytes += bytes
  }
  retained.reverse()
  if (truncated) {
    retained.unshift({
      kind: 'error',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: appSessionId,
      requestId: HISTORY_REPLAY_TRUNCATION_REQUEST_ID,
      code: 'internal_error',
      message: `Only the ${retained.length} most recent messages are shown.`,
      retryable: false,
    })
  }
  return retained
}

function emit(result: TranscriptBackfillResult): Promise<void> {
  const line = JSON.stringify(result)
  if (Buffer.byteLength(line, 'utf8') > MAX_TRANSCRIPT_BACKFILL_RECORD_BYTES) {
    throw new Error('backfill result exceeds record limit')
  }
  return new Promise((resolve, reject) => {
    process.stdout.write(`${line}\n`, error => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function readBoundedStdin(): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > MAX_TRANSCRIPT_BACKFILL_INPUT_BYTES) {
      throw new Error('backfill request exceeds input limit')
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function failureIdentity(item: {
  appSessionId: string
  engineSessionId: string
}): Pick<TranscriptBackfillFailureResult, 'appSessionId' | 'engineSessionId'> {
  return {
    appSessionId: item.appSessionId,
    engineSessionId: item.engineSessionId,
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

void main().catch(error => {
  process.stderr.write(`[backfill-worker] fatal: ${errorText(error)}\n`)
  process.exit(1)
})
