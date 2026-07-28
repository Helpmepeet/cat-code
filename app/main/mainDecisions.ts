/**
 * The Electron-free half of `main.ts`.
 *
 * `main.ts` is the Electron entry point: importing it starts an Electron app, so
 * nothing inside it can be exercised by a unit test. What was left there could
 * only be checked by grepping its own source, which proves the TEXT of a call
 * and never its behaviour. These three decisions need no Electron API, so they
 * live here and are tested directly, the same shape as `replayBuffer.ts` and
 * `attachmentGate.ts`:
 *
 *   - translating a `SupervisorEvent` into the `ServerFrame` the renderer sees;
 *   - the HC1 one-time directory-token store;
 *   - choosing which rows a PL-B transcript backfill should read.
 *
 * `main.ts` keeps the Electron wiring and calls in here.
 */

import { randomUUID } from 'node:crypto'

import type { SessionDescriptor } from '../shared/hostApi.js'
import {
  PROTOCOL_VERSION,
  type ServerFrame,
  type SessionId,
} from '../shared/protocol.js'
import type { TranscriptBackfillItem } from '../shared/transcriptBackfill.js'
import type { SupervisorEvent } from '../supervisor/supervisor.js'

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
