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
import { basename, dirname, join } from 'node:path'

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
import { readTranscriptRunFacts } from '../shared/transcriptRunFacts.js'
import {
  bootstrapWorkerEngine,
  emitWorkerRecord,
  errorText,
  runDisposableWorker,
} from './workerRuntime.js'

// Set the one-switch minimal mode before ANY engine module is dynamically
// imported. conversationRecovery always calls processSessionStartHooks('resume'),
// whose first branch returns [] under this flag, before user/plugin hook loading.
// `workerRuntime.js` above is engine-free by contract, so importing it does not
// pre-empt this.
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
    { getProjectDir, loadDisplayTranscriptFromJsonlPath },
    { mergeDisplayHistoryWithSeed, projectResumedHistory },
    { createMessageEvent },
    { getContextWindowForModel },
    { withRestoredSubagentHistory },
    { assertSessionNotMoving, readSessionRelocation },
    { getCwd, runWithCwdOverride },
  ] = await Promise.all([
    import('../../src/bootstrap/state.js'),
    import('../../src/utils/conversationRecovery.js'),
    import('../../src/utils/sessionStorage.js'),
    import('./historyProjection.js'),
    import('../../src/app-runtime/sessionEvents.js'),
    import('../../src/utils/context.js'),
    import('./subagentHistory.js'),
    import('../../src/utils/sessionRelocationState.js'),
    import('../../src/utils/cwd.js'),
  ])
  await bootstrapWorkerEngine()

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
      // A preview is not a resume from the app's launch directory. Resolve the
      // completed move's authoritative location, retaining both identities and
      // its canonical transcript path; former-project copies stay ineligible.
      // Moving/unreadable records still hit the engine's ordinary refusal gate.
      assertSessionNotMoving(item.engineSessionId)
      const relocation = readSessionRelocation(item.engineSessionId)
      if (
        relocation &&
        (relocation.appSessionId !== item.appSessionId ||
          item.transcriptPath !==
            join(getProjectDir(relocation.target.cwd), `${item.engineSessionId}.jsonl`))
      ) {
        await emit({
          ...failureIdentity(item),
          type: 'failure',
          reason: 'session_mismatch',
        })
        continue
      }
      switchSession(item.engineSessionId as never, dirname(item.transcriptPath))
      const loaded = await runWithCwdOverride(
        relocation?.target.cwd ?? getCwd(),
        () =>
          loadConversationForResume(
            item.engineSessionId,
            item.transcriptPath,
            // Preview must leave durable interruption recovery for real resume.
            { interruptedTurn: 'ignore' },
          ),
      )
      if (!loaded) {
        await emit({ ...failureIdentity(item), type: 'failure', reason: 'invalid' })
        continue
      }
      const fileSessionId = basename(item.transcriptPath, '.jsonl')
      if (fileSessionId !== item.engineSessionId) {
        await emit({
          ...failureIdentity(item),
          type: 'failure',
          reason: 'session_mismatch',
        })
        continue
      }
      if (
        loaded.sessionId !== undefined &&
        loaded.sessionId !== item.engineSessionId
      ) {
        process.stderr.write(
          `[backfill-worker] transcript identity drift: file=${item.engineSessionId} latest_stamp=${loaded.sessionId}\n`,
        )
      }

      const display = await loadDisplayTranscriptFromJsonlPath(
        item.transcriptPath,
        {
          maxMessages: MAX_HISTORY_REPLAY_FRAMES,
          maxBytes: MAX_HISTORY_REPLAY_BYTES * 2,
        },
      )
      const merged = mergeDisplayHistoryWithSeed(
        display.messages,
        projectResumedHistory(loaded.messages),
      )
      // Same nesting join the live restore applies (`index.ts`). Without it a
      // cached preview shows Agent cards with no children while the live
      // session shows the same cards with children — one session, two
      // transcripts, depending only on which path produced the frames.
      const nested = await withRestoredSubagentHistory(
        item.engineSessionId,
        merged.history,
        message => process.stderr.write(`${message}\n`),
      )
      const frames = buildBoundedFrames(
        item.appSessionId,
        nested.history.map(createMessageEvent),
        display.truncated || merged.truncated,
        nested.unavailableParentToolUseIds,
      )
      const result: TranscriptBackfillSessionResult = {
        type: 'session',
        appSessionId: item.appSessionId,
        engineSessionId: item.engineSessionId,
        frames,
        // Read from the RAW transcript, not from the projected frames above: the
        // `toSDKMessages` conversion keeps conversation turns and drops the
        // telemetry these come from, so by that point they no longer exist.
        //
        // The context window is the exception: nothing persists it, so it is
        // resolved from the model (see `resolveContextWindow` above).
        runFacts: readTranscriptRunFacts(item.transcriptPath, resolveContextWindow)
          .facts,
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
  sourceTruncated = false,
  unavailableParentToolUseIds: readonly string[] = [],
): ServerFrame[] {
  const retained: ServerFrame[] = []
  const unavailable = new Set(unavailableParentToolUseIds)
  const retainedUnavailable = new Set<string>()
  const availability: ServerFrame & { kind: 'history.availability' } = {
    kind: 'history.availability', protocolVersion: PROTOCOL_VERSION,
    sessionId: appSessionId, unavailableParentToolUseIds: [],
  }
  const truncationFrame = (count: number): ServerFrame => ({
    kind: 'error', protocolVersion: PROTOCOL_VERSION, sessionId: appSessionId,
    requestId: HISTORY_REPLAY_TRUNCATION_REQUEST_ID, code: 'internal_error',
    message: `Only the ${count} most recent messages are shown.`, retryable: false,
  })
  // Reserve both metadata frames and array punctuation inside the existing
  // replay ceiling. The maximum-count error is at least as large as the one
  // eventually emitted, even if trimming discovers truncation later.
  let retainedBytes = 2 + Buffer.byteLength(JSON.stringify(availability), 'utf8') +
    Buffer.byteLength(JSON.stringify(truncationFrame(MAX_HISTORY_REPLAY_FRAMES)), 'utf8') + 1
  let truncated = sourceTruncated
  const noteOmittedChild = (message: unknown) => {
    if (typeof message !== 'object' || message === null) return
    const parent = (message as Record<string, unknown>).parent_tool_use_id
    if (typeof parent === 'string' && parent.length > 0) unavailable.add(parent)
  }
  for (let i = events.length - 1; i >= 0; i--) {
    let event: (typeof events)[number]
    try {
      event = structuredClone(events[i]!)
    } catch {
      truncated = true
      noteOmittedChild(events[i]!.message)
      continue
    }
    omitUndefinedObjectProperties(event)
    if (!checkJsonSafe(event).ok || !scanForSecrets(event).ok) {
      truncated = true
      noteOmittedChild(event.message)
      continue
    }
    const frame: ServerFrame = {
      kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: appSessionId,
      replay: true, event: event as never,
    }
    const ids: string[] = []
    const message = event.message as { type?: string; message?: { content?: unknown[] } }
    if (message.type === 'assistant' && Array.isArray(message.message?.content)) {
      for (const block of message.message.content) {
        if (typeof block !== 'object' || block === null) continue
        const value = block as Record<string, unknown>
        if (value.type === 'tool_use' && typeof value.id === 'string' &&
          unavailable.has(value.id) && !retainedUnavailable.has(value.id) && !ids.includes(value.id)) {
          ids.push(value.id)
        }
      }
    }
    // Parent frames precede their spliced children. Walking backward learns
    // about omitted children before deciding whether their card fits, and
    // reserves each retained card's full marker alongside that frame.
    let markerBytes = 0
    for (const [index, id] of ids.entries()) {
      markerBytes += Buffer.byteLength(JSON.stringify(id), 'utf8') +
        (retainedUnavailable.size + index > 0 ? 1 : 0)
    }
    const bytes = Buffer.byteLength(JSON.stringify(frame), 'utf8')
    if (
      bytes > MAX_OUTBOUND_FRAME_BYTES ||
      retained.length + 1 > MAX_HISTORY_REPLAY_FRAMES ||
      retainedUnavailable.size + ids.length > MAX_HISTORY_REPLAY_FRAMES ||
      retainedBytes + bytes + 1 + markerBytes > MAX_HISTORY_REPLAY_BYTES
    ) {
      truncated = true
      break
    }
    retained.push(frame)
    retainedBytes += bytes + 1 + markerBytes
    for (const id of ids) retainedUnavailable.add(id)
  }
  retained.reverse()
  if (truncated) retained.unshift(truncationFrame(retained.length))
  availability.unavailableParentToolUseIds = [...retainedUnavailable]
  retained.push(availability)
  return retained
}

function emit(result: TranscriptBackfillResult): Promise<void> {
  return emitWorkerRecord(
    result,
    MAX_TRANSCRIPT_BACKFILL_RECORD_BYTES,
    'backfill result',
  )
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

runDisposableWorker('backfill-worker', main)
