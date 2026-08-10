/**
 * The Electron-free half of `main.ts`.
 *
 * `main.ts` is the Electron entry point: importing it starts an Electron app, so
 * nothing inside it can be exercised by a unit test. What was left there could
 * only be checked by grepping its own source, which proves the TEXT of a call
 * and never its behaviour. These decisions need no Electron API, so they
 * live here and are tested directly, the same shape as `replayBuffer.ts` and
 * `attachmentGate.ts`:
 *
 *   - translating a `SupervisorEvent` into the `ServerFrame` the renderer sees;
 *   - the HC1 one-time directory-token store;
 *   - choosing which rows a PL-B transcript backfill should read;
 *   - the Bun runtime flags required by the real engine sidecar;
 *   - the HC1 validation of a `saveTextToFile` request (P4-35);
 *   - the cancellable post-paint window that arms the background drivers.
 *   - deciding when renderer health loss becomes durable error evidence.
 *
 * `main.ts` keeps the Electron wiring and calls in here.
 */

import { randomUUID } from 'node:crypto'

import {
  MAX_LIVE_SESSIONS,
  type SaveTextErrorCode,
  type SessionDescriptor,
} from '../shared/hostApi.js'
import { MAX_SAVE_NAME_CHARS, MAX_SAVE_TEXT_BYTES } from '../shared/limits.js'
import { MAX_OPERATIONAL_STRING_BYTES } from '../shared/operationalLog.js'
import {
  PROTOCOL_VERSION,
  type ServerFrame,
  type SessionId,
} from '../shared/protocol.js'
import type { TranscriptBackfillItem } from '../shared/transcriptBackfill.js'
import type { SupervisorEvent } from '../supervisor/supervisor.js'

/**
 * Keep the unbundled desktop sidecar on the engine build's default classifier
 * feature. Without this runtime flag Bun folds every classifier branch away.
 */
export const SIDECAR_RUNTIME_ARGS = [
  '--feature=TRANSCRIPT_CLASSIFIER',
  'run',
] as const

export const RENDERER_HEALTH_DEGRADED_MISSES = 3
export const RENDERER_HEALTH_UNAVAILABLE_MISSES = 6
export const RENDERER_HEALTH_UNAVAILABLE_INTERVAL_MS = 60_000
export const RENDERER_HEALTH_SAMPLE_INTERVAL_MS = 30_000

export type RendererHealthEvent = Readonly<{
  event: 'renderer.health.missed' | 'renderer.health.unavailable'
  level: 'warn' | 'error'
  fields: Readonly<{ missed: number; elapsedMs: number }>
}>

export type RendererHealthResponse = Readonly<{
  recovered: boolean
  priorMisses: number
  outageDurationMs: number
  /** False when this response falls inside the current sampling interval. */
  shouldSample: boolean
}>

export function createRendererHealthMonitor({
  now = () => performance.now(),
}: {
  now?: () => number
} = {}) {
  let misses = 0
  let lastResponseAt = now()
  let degradedAt: number | null = null
  let lastUnavailableAt: number | null = null
  let lastSampleAt: number | null = null

  return {
    reset(): void {
      misses = 0
      lastResponseAt = now()
      degradedAt = null
      lastUnavailableAt = null
      lastSampleAt = null
    },
    probe(): RendererHealthEvent | null {
      const current = now()
      const elapsedMs = current - lastResponseAt
      if (elapsedMs <= 5_500) return null

      misses++
      if (misses === RENDERER_HEALTH_DEGRADED_MISSES) {
        degradedAt = current
        return {
          event: 'renderer.health.missed',
          level: 'warn',
          fields: { missed: misses, elapsedMs },
        }
      }
      if (
        misses >= RENDERER_HEALTH_UNAVAILABLE_MISSES &&
        (lastUnavailableAt === null ||
          current - lastUnavailableAt >= RENDERER_HEALTH_UNAVAILABLE_INTERVAL_MS)
      ) {
        lastUnavailableAt = current
        return {
          event: 'renderer.health.unavailable',
          level: 'error',
          fields: { missed: misses, elapsedMs },
        }
      }
      return null
    },
    response(): RendererHealthResponse {
      const current = now()
      const recovered = degradedAt !== null
      // The sampling cadence used to be a module global in main, which reset()
      // did not clear, so the first sample after a window reopened could be
      // suppressed for a full interval. All health state lives here now.
      const shouldSample = recovered ||
        lastSampleAt === null ||
        current - lastSampleAt >= RENDERER_HEALTH_SAMPLE_INTERVAL_MS
      if (shouldSample) lastSampleAt = current
      const result = {
        recovered,
        priorMisses: misses,
        outageDurationMs: degradedAt === null ? 0 : current - degradedAt,
        shouldSample,
      }
      misses = 0
      degradedAt = null
      lastUnavailableAt = null
      lastResponseAt = current
      return result
    },
  }
}

/* ------------------------------------------------------------------------- *
 * Health flight recorder (2026-08-10, from the 2026-08-09 renderer OOM).
 *
 * Health is measured every 5s but `shouldSample` above logs at most one reading
 * per 30s, so the renderer that died at 22:13:46 left a last sample 29.8s old:
 * the six readings that could have shown the terminal lag spike or heap climb
 * were parsed and then dropped. The steady-state thrift is correct, so the
 * dedup stays; this ring keeps the raw readings in memory and pays bytes only
 * where an anomaly already happened.
 * ------------------------------------------------------------------------- */

/** Twelve 5s readings is a minute of history, ~250 bytes once encoded. */
export const RENDERER_HEALTH_RING_CAPACITY = 12

export type RendererHealthReading = Readonly<{
  eventLoopLagMs: number
  visible: boolean
  heapUsedBytes: number | null
}>

export type RendererHealthFlightRecorderFlush = Readonly<{
  count: number
  samples: string
}>

export type RendererHealthFlightRecorder = {
  /** Keep one raw reading, evicting the oldest past the ring's capacity. */
  record(reading: RendererHealthReading): void
  /**
   * Encode and CLEAR the ring, or null when it holds nothing. Clearing is what
   * stops a crash that fires both triggers from writing the same readings
   * twice, and what stops stale pre-recovery readings reaching a later record.
   */
  flush(): RendererHealthFlightRecorderFlush | null
}

/**
 * One reading as `<ageMs>:<lagMs>:<heapMiB>:<v|h>`, age measured back from the
 * flush. Unknown heap is `-`.
 *
 * ASCII by construction, so the byte budget below can count characters, and
 * free of the shapes `sanitizeOperationalText` rewrites (no path separator, no
 * scheme, no `@`) so the stored string is the string that was measured.
 */
function encodeHealthReading(ageMs: number, reading: RendererHealthReading): string {
  const heapMiB = reading.heapUsedBytes === null
    ? '-'
    : String(Math.round(reading.heapUsedBytes / 1_048_576))
  const age = Math.max(0, Math.round(ageMs))
  return `${age}:${Math.round(reading.eventLoopLagMs)}:${heapMiB}:${reading.visible ? 'v' : 'h'}`
}

/**
 * The ring, as one capped string rather than one record per reading.
 *
 * Both alternatives are foreclosed by the record contract, not merely awkward:
 * `sanitizeOperationalFields` takes only scalars and caps at
 * `MAX_OPERATIONAL_FIELDS`, so twelve readings of four values can be neither an
 * array nor flat fields; and a burst of same-event records would be collapsed
 * by the main sink's 1000ms `${event}:${appSessionId}:${reason}` dedup
 * (`operationalLogSink.ts`), destroying the evidence this exists to keep.
 *
 * Whole readings are dropped when the budget runs out, newest kept first:
 * `sanitizeOperationalText` truncates mid-string, which would corrupt an entry
 * rather than lose one, and the readings nearest the failure are the point.
 */
export function createRendererHealthFlightRecorder({
  now = () => performance.now(),
  capacity = RENDERER_HEALTH_RING_CAPACITY,
  maxBytes = MAX_OPERATIONAL_STRING_BYTES,
}: {
  now?: () => number
  capacity?: number
  maxBytes?: number
} = {}): RendererHealthFlightRecorder {
  let ring: Array<{ at: number } & RendererHealthReading> = []
  return {
    record(reading: RendererHealthReading): void {
      ring.push({ at: now(), ...reading })
      if (ring.length > capacity) ring.shift()
    },
    flush(): RendererHealthFlightRecorderFlush | null {
      if (ring.length === 0) return null
      const current = now()
      const readings = ring
      ring = []
      const kept: string[] = []
      let bytes = 0
      for (let index = readings.length - 1; index >= 0; index--) {
        const entry = encodeHealthReading(current - readings[index].at, readings[index])
        const cost = entry.length + (kept.length === 0 ? 0 : 1)
        if (bytes + cost > maxBytes) break
        bytes += cost
        kept.push(entry)
      }
      if (kept.length === 0) return null
      return { count: kept.length, samples: kept.reverse().join(';') }
    },
  }
}

export const RENDERER_RECOVERY_MAX_ATTEMPTS = 3
export const RENDERER_RECOVERY_WINDOW_MS = 10 * 60_000

/**
 * Every reason this policy can be asked about: Electron's own
 * `render-process-gone` reasons, plus `load-failed` for a recovery load that
 * never committed a document. Declared here rather than imported so this file
 * stays Electron-free.
 */
export type RendererDeathReason =
  | 'clean-exit'
  | 'abnormal-exit'
  | 'killed'
  | 'crashed'
  | 'oom'
  | 'launch-failed'
  | 'integrity-failure'
  | 'load-failed'

export type RendererRecoveryDecision =
  | Readonly<{ action: 'reload'; attempt: number }>
  | Readonly<{ action: 'give-up' }>
  | Readonly<{ action: 'ignore' }>

/**
 * Reload policy for a dead renderer process. Before 2026-08-09 a renderer
 * crash (an OOM trap in that incident) left the window permanently black:
 * `render-process-gone` only wrote a log record, and nothing ever recreated
 * the document. Reload every abnormal death, but cap attempts inside a
 * sliding window so a renderer that dies during load cannot reload forever.
 * `clean-exit` is what quitting looks like and is never reloaded.
 */
export function createRendererRecoveryPolicy({
  now = () => Date.now(),
}: {
  now?: () => number
} = {}) {
  const attemptsAt: number[] = []
  return {
    decide(reason: RendererDeathReason): RendererRecoveryDecision {
      if (reason === 'clean-exit') return { action: 'ignore' }
      const current = now()
      while (attemptsAt.length > 0 && current - attemptsAt[0] >= RENDERER_RECOVERY_WINDOW_MS) {
        attemptsAt.shift()
      }
      if (attemptsAt.length >= RENDERER_RECOVERY_MAX_ATTEMPTS) return { action: 'give-up' }
      attemptsAt.push(current)
      return { action: 'reload', attempt: attemptsAt.length }
    },
  }
}

/**
 * The renderer-visible frame a supervisor event becomes, or null when the event
 * says nothing the renderer needs. A process `exit` and a terminal transport
 * status both surface as a `lifecycle` frame so the renderer learns the session
 * is gone from one frame shape.
 *
 * A `status:'exited'` event is deliberately NOT one of them. The supervisor moves
 * a record to `'exited'` in exactly one place — inside its `child.on('exit')`
 * handler, immediately AFTER emitting the `exit` event for that same death
 * (`app/supervisor/supervisor.ts:280-281`) — so this branch could only ever mint
 * a second, strictly poorer copy of the frame the `exit` arm just produced: same
 * status, no `exit` payload. Emitting it cost real behaviour rather than mere
 * duplication: the exit CODE is the only signal that separates an intentional
 * park from a crash (IDLE-PARK.md §2), the renderer folds lifecycle frames
 * last-write-wins (`app/renderer/src/connectionState.ts`), and this code-less
 * copy always landed last — so every parked session was re-labelled a crash one
 * frame after being classified correctly. Dropping it also stops main running the
 * terminal persist + replay-evict twice per death.
 */
export function supervisorEventToServerFrame(
  event: SupervisorEvent,
): ServerFrame | null {
  if (event.type === 'frame') return event.frame
  if (event.type === 'exit') {
    return {
      kind: 'lifecycle',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: event.sessionId,
      status: 'exited',
      exit: { code: event.code, signal: event.signal },
    }
  }
  if (event.status === 'disconnected' || event.status === 'failed') {
    return {
      kind: 'lifecycle',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: event.sessionId,
      status: event.status,
    }
  }
  return null
}

/** A frame after which the session has no live process left to talk to. */
export function isTerminalLifecycleFrame(frame: ServerFrame): boolean {
  return (
    frame.kind === 'lifecycle' &&
    (frame.status === 'disconnected' ||
      frame.status === 'failed' ||
      frame.status === 'exited')
  )
}

/* ------------------------------------------------------------------------- *
 * HC1 directory-token store. A `pickDirectory()` result is a one-time token
 * bound to a realpath MAIN validated; `createSession` consumes it. This makes
 * the renderer structurally incapable of authoring a cwd string — it only ever
 * holds an opaque token that main issued for a path the USER chose in the native
 * dialog. Tokens are single-use and short-lived.
 * ------------------------------------------------------------------------- */

export const CWD_TOKEN_TTL_MS = 5 * 60 * 1000

export type CwdTokenStore = {
  /** Issue a single-use token for a realpath main has already validated. */
  mint(realpath: string): string
  /** Resolve + INVALIDATE a token. Undefined if unknown, reused, or expired. */
  consume(token: string): string | undefined
}

export function createCwdTokenStore(
  options: {
    now?: () => number
    newToken?: () => string
    ttlMs?: number
  } = {},
): CwdTokenStore {
  const now = options.now ?? Date.now
  const newToken = options.newToken ?? randomUUID
  const ttlMs = options.ttlMs ?? CWD_TOKEN_TTL_MS
  const tokens = new Map<string, { realpath: string; expiresAt: number }>()

  return {
    mint(realpath: string): string {
      const token = newToken()
      tokens.set(token, { realpath, expiresAt: now() + ttlMs })
      return token
    },
    consume(token: string): string | undefined {
      const entry = tokens.get(token)
      if (!entry) return undefined
      // Deleted before the expiry check so an expired token is also spent.
      tokens.delete(token)
      if (entry.expiresAt < now()) return undefined
      return entry.realpath
    },
  }
}

/* ------------------------------------------------------------------------- *
 * P4-35 — the file sink's validation (operator ruling 2026-07-30).
 *
 * `saveTextToFile` is the second control-plane method whose input is
 * security-relevant in the HC1 sense, and it is the mirror image of the first.
 * `pickDirectory` stops the renderer NAMING a directory by having main ask the
 * user; this stops the renderer naming a FILE the same way. Both rules live here
 * rather than in `main.ts` so they are exercised for real instead of grepped.
 * ------------------------------------------------------------------------- */

/**
 * Reduce a renderer-supplied `suggestedName` to a bare file name, or reject it.
 *
 * HC1 — the renderer must not be able to name a destination, so this is a
 * whitelist reduction, not an escaping pass:
 *
 *  - everything up to and including the last `/` or `\` is DISCARDED, so
 *    `../../etc/passwd`, `/etc/passwd` and `C:\Windows\x` all reduce to their last
 *    segment. The result cannot contain a separator, so main can never be induced
 *    to join a path fragment;
 *  - any character outside `[A-Za-z0-9._-]` becomes `-`, which removes NUL bytes,
 *    newlines, control characters and shell metacharacters as a class rather than
 *    one blocklist at a time;
 *  - a name that is only dots (`.`, `..`, `...`) has no usable stem, and an empty
 *    stem is rejected. `.` and `..` are the traversal segments the first rule
 *    leaves behind when the input ends in a separator.
 *
 * This is a SUGGESTION either way: it becomes the save dialog's default name, and
 * the user is free to rename or relocate. It is not the path that gets written.
 * That is why rejecting is cheap and being conservative costs nothing.
 */
export function sanitizeSaveFileName(suggestedName: unknown): string | null {
  if (typeof suggestedName !== 'string') return null
  const lastSeparator = Math.max(
    suggestedName.lastIndexOf('/'),
    suggestedName.lastIndexOf('\\'),
  )
  const basename = suggestedName.slice(lastSeparator + 1)
  const cleaned = basename.replace(/[^A-Za-z0-9._-]/g, '-')
  // Only-dots (or empty) leaves no stem: `.`/`..` are directory references, and a
  // leading-dot-only name would create a hidden file the user did not ask for.
  if (cleaned.replace(/\./g, '') === '') return null
  return cleaned.slice(0, MAX_SAVE_NAME_CHARS)
}

/** A save request main has accepted, or the typed reason it has not. */
export type SaveTextValidation =
  | { ok: true; text: string; fileName: string }
  | { ok: false; code: SaveTextErrorCode; message: string }

/**
 * Validate a `saveTextToFile` payload at MAIN, the trust boundary. The preload
 * checks the same bounds for a fast local failure, but the preload runs in the
 * renderer's process and is not a boundary — nothing here may assume it ran.
 *
 * Messages are user-facing (they reach a toast), so they say what to do rather
 * than which constant was breached.
 */
export function validateSaveTextRequest(payload: unknown): SaveTextValidation {
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, code: 'invalid_text', message: 'There was nothing to save.' }
  }
  const { text, suggestedName } = payload as Record<string, unknown>
  if (typeof text !== 'string' || text === '') {
    return { ok: false, code: 'invalid_text', message: 'There was nothing to save.' }
  }
  if (new TextEncoder().encode(text).byteLength > MAX_SAVE_TEXT_BYTES) {
    return {
      ok: false,
      code: 'invalid_text',
      message: 'This is too large to save as one file. Save fewer sessions at a time.',
    }
  }
  const fileName = sanitizeSaveFileName(suggestedName)
  if (fileName === null) {
    return {
      ok: false,
      code: 'invalid_name',
      message: 'That file name cannot be used.',
    }
  }
  return { ok: true, text, fileName }
}

/* ------------------------------------------------------------------------- *
 * IDLE-PARK visible-pane hint (decisions/IDLE-PARK.md §4, option (b), resolved
 * 2026-08-05).
 *
 * The one fact the park policy needs and main structurally cannot derive: which
 * sessions the user is looking at. Workspace panels are renderer state by design
 * (`shellState.ts` keeps `activeSessionId` out of the roster so a background frame
 * can never steal focus), and switching panes bumps no registry stamp, so main's
 * only view of "visible" is what the renderer tells it.
 *
 * Trust posture — this is a HINT, and a deliberately weak one. It names sessions
 * to EXEMPT from an optimisation; it can start nothing, address nothing, and
 * carries no path, policy, permission id, or engine object. Ids that match no live
 * session are inert. The worst a hostile renderer achieves by naming every id it
 * can invent is that main declines to park sessions it would otherwise park — it
 * retains its own RAM, recoverable by closing a tab or relaunching. That is why
 * this rides the host control plane and never becomes sidecar vocabulary: no
 * inbound frame kind, no engine reachability, no `checkStrictKeys` entry.
 * ------------------------------------------------------------------------- */

/**
 * Validate a renderer-supplied visible-pane hint at MAIN, the trust boundary.
 *
 * Shape-only by intent: ids are matched against the live set at USE time by the
 * driver, so this rejects the things that would make the payload dangerous as a
 * data structure rather than trying to authenticate its contents. Non-array,
 * non-string entries, and anything past `MAX_LIVE_SESSIONS` (already the ceiling
 * on live engines, so a longer list cannot protect anything real) are dropped
 * rather than throwing — a malformed hint degrades to less protection, never to a
 * failed IPC or a park that skips its own gate.
 */
export function parseVisibleSessions(payload: unknown): Set<SessionId> {
  const ids = new Set<SessionId>()
  if (typeof payload !== 'object' || payload === null) return ids
  const { sessionIds } = payload as Record<string, unknown>
  if (!Array.isArray(sessionIds)) return ids
  for (const candidate of sessionIds) {
    if (ids.size >= MAX_LIVE_SESSIONS) break
    if (typeof candidate !== 'string' || candidate.length === 0) continue
    if (candidate.length > MAX_SESSION_ID_CHARS) continue
    ids.add(candidate)
  }
  return ids
}

/** A UUID is 36 chars; the bound just stops an unbounded string being retained. */
const MAX_SESSION_ID_CHARS = 128

export type TranscriptBackfillCandidateSources = {
  sessions: SessionDescriptor[]
  hasCache: (appSessionId: SessionId) => boolean
  cacheHasCurrentRunFacts: (appSessionId: SessionId) => boolean
  isTranscriptNewerThanCache: (session: SessionDescriptor) => boolean
  transcriptPath: (session: SessionDescriptor, engineSessionId: string) => string
  limit: number
}

/**
 * PL-B — which rows the backfill worker should read, most recently attached
 * first and bounded by `limit`. Only restorable rows with an engine transcript
 * qualify; a row whose cache carries CURRENT run facts is skipped unless its
 * engine transcript has since moved on (a session continued in the terminal).
 *
 * Current, not merely present: a cache built before a fact existed still has a
 * `runFacts` object, and skipping on presence pinned those caches to the older,
 * thinner facts forever.
 */
export function selectTranscriptBackfillCandidates(
  sources: TranscriptBackfillCandidateSources,
): TranscriptBackfillItem[] {
  return sources.sessions
    .filter(
      session =>
        session.restorable &&
        session.engineSessionId !== null &&
        (!sources.hasCache(session.appSessionId) ||
          !sources.cacheHasCurrentRunFacts(session.appSessionId) ||
          sources.isTranscriptNewerThanCache(session)),
    )
    .sort((a, b) => b.lastAttachedAt - a.lastAttachedAt)
    .slice(0, sources.limit)
    .flatMap(session => {
      const engineSessionId = session.engineSessionId
      if (engineSessionId === null) return []
      return [
        {
          appSessionId: session.appSessionId,
          engineSessionId,
          transcriptPath: sources.transcriptPath(session, engineSessionId),
        },
      ]
    })
}

/* ------------------------------------------------------------------------- *
 * Startup timers — the post-paint driver-arming window
 * ------------------------------------------------------------------------- */

export type StartupTimers = {
  /** Arm `run` to fire after the configured delay. */
  schedule: (run: () => void) => void
  /** Cancel every armed-but-unfired callback. Idempotent. */
  cancelAll: () => void
  /** Armed callbacks that have not fired or been cancelled. */
  pending: () => number
}

/**
 * The `ready-to-show` + delay window, made cancellable.
 *
 * Main arms four drivers a fixed delay after first paint so the engine-graph
 * worker imports stay off the launch critical path. A window closed inside that
 * delay used to leave the timers running: `window-all-closed` stopped drivers
 * that were not armed YET, then the timers fired and armed them against a host
 * that had just been torn down, and two of those drivers re-schedule themselves
 * forever. Teardown calls `cancelAll`, so an unfired arm is dropped rather than
 * resurrecting work after the window is gone.
 */
export function createStartupTimers<Handle>(deps: {
  delayMs: number
  setTimer: (run: () => void, ms: number) => Handle
  clearTimer: (handle: Handle) => void
}): StartupTimers {
  const armed = new Set<Handle>()
  return {
    schedule(run) {
      // Self-removal before `run` so a callback that fires normally does not
      // leak a spent handle into the cancel set.
      const handle = deps.setTimer(() => {
        armed.delete(handle)
        run()
      }, deps.delayMs)
      armed.add(handle)
    },
    cancelAll() {
      for (const handle of armed) deps.clearTimer(handle)
      armed.clear()
    },
    pending: () => armed.size,
  }
}
