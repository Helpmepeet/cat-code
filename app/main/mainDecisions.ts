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
 *   - the HC1 validation of a `saveTextToFile` request (P4-35).
 *
 * `main.ts` keeps the Electron wiring and calls in here.
 */

import { randomUUID } from 'node:crypto'

import type { SaveTextErrorCode, SessionDescriptor } from '../shared/hostApi.js'
import { MAX_SAVE_NAME_CHARS, MAX_SAVE_TEXT_BYTES } from '../shared/limits.js'
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

/**
 * The renderer-visible frame a supervisor event becomes, or null when the event
 * says nothing the renderer needs. A process `exit` and a terminal transport
 * status both surface as a `lifecycle` frame so the renderer learns the session
 * is gone from one frame shape.
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
  if (
    event.status === 'disconnected' ||
    event.status === 'failed' ||
    event.status === 'exited'
  ) {
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
