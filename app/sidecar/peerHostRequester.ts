/**
 * The sidecar half of HOST-REQUEST-PLANE (`decisions/HOST-REQUEST-PLANE.md`),
 * as the PEER TOOLS see it.
 *
 * The tools are built inside `createNormalSidecarQueryEngineConfig`, which runs
 * BEFORE the socket server exists (`app/sidecar/index.ts` constructs the session
 * controller, then `new SidecarServer(...)`). So a tool cannot be handed the
 * request client at construction time; it resolves one at CALL time from this
 * module, which `index.ts` points at the live server once that server exists.
 * Module scope is the same shape `commandLifecycleOwner` already uses in
 * `sidecarServer.ts` and is correct here for the same reason: N-process means
 * one server per process (LOCKED decision, CLAUDE.md §5).
 *
 * Every tool factory still TAKES a requester, so a test injects one and never
 * touches this module's state.
 */

import type {
  HostRequestArgs,
  HostRequestError,
  HostRequestVerb,
} from '../shared/protocol.js'
// Type-only: erased at runtime, so this does not make an import cycle with the
// server module that sets the requester below.
import type { HostRequestOutcome } from './sidecarServer.js'

/**
 * Ask main to do one bounded thing. Mirrors `SidecarServer.requestHost`: it
 * never throws and never hangs, and a local failure arrives in the same closed
 * shape main's own refusals use.
 */
export type PeerHostRequester = <V extends HostRequestVerb>(
  verb: V,
  args: HostRequestArgs[V],
) => Promise<HostRequestOutcome<V>>

let liveRequester: PeerHostRequester | null = null

/**
 * Point the peer tools at the live request client. Called once, by the process
 * entry point, immediately after the server that owns the socket is built.
 * Passing null detaches (used by tests that must leave no live requester behind).
 */
export function setPeerHostRequester(next: PeerHostRequester | null): void {
  liveRequester = next
}

/**
 * The default requester the peer tools are built with. Resolves the live client
 * per call, so a tool constructed before the server still reaches it, and a tool
 * running in a process that never had one fails closed with the plane's own
 * `unavailable` code rather than throwing into the engine's tool loop.
 */
export const requestPeerHost: PeerHostRequester = (verb, args) => {
  if (liveRequester === null) {
    return Promise.resolve({
      ok: false,
      error: {
        code: 'unavailable',
        message: 'not connected to the host',
      },
    })
  }
  return liveRequester(verb, args)
}

/**
 * One plain sentence per host-request error code, for a tool result a model
 * reads. Main's own `message` is deliberately NOT forwarded: it is written for
 * an operator reading a log line, and a tool result is a user-visible surface
 * under CLAUDE.md §7. The switch is exhaustive so a new code cannot ship
 * without a sentence.
 */
export function describeHostRequestError(error: HostRequestError): string {
  switch (error.code) {
    case 'bad_request':
      return 'That request was not accepted.'
    case 'too_large':
      return 'That request was too large.'
    case 'rate_limited':
      // The session-wide allowance, counted over a minute, and spent by EVERY
      // peer call. So the sentence has to name the recovery a model reaches for
      // first: listing peers again is charged to the same allowance that just
      // refused it, and a second refusal reads as the peer system being down.
      return 'Too many requests from this session in the past minute. Checking the peer list spends the same allowance, so do something else first, then try again.'
    case 'unknown_verb':
      return 'That action is not available in this session.'
    case 'session_not_found':
      return 'There is no session by that name in this workspace.'
    case 'session_limit':
      // THREE conditions share this code, and two of them recover in opposite
      // ways (`app/host/host.ts`: the live-process cap, the registry row bound
      // with nothing reapable, and the spawn rate cap). The rate cap is the one
      // a fan-out actually hits, and it clears by itself in seconds, so the
      // recovery a model should try FIRST is named first. All three are counted
      // across the app, not per workspace, so the sentence must not send the
      // user looking at one workspace's tabs.
      return 'No new session can start right now. Wait a few seconds and try again: a burst of new sessions clears on its own. If it fails again, too many sessions are open and some have to be closed first.'
    case 'invalid_cwd':
      return 'This workspace is no longer available.'
    case 'spawn_failed':
      return 'The new session could not be started.'
    case 'internal_error':
      return 'The app could not complete that request.'
    case 'timeout':
      return 'The app did not answer in time.'
    case 'unavailable':
      return 'This session is not connected to the app.'
    default: {
      const exhaustive: never = error.code
      return exhaustive
    }
  }
}

/**
 * This session's own peer identity, read from the spawn env.
 *
 * **The absent value is the EMPTY STRING, not an unset key** (`SpawnConfig` in
 * `app/supervisor/supervisor.ts`): main writes all five keys on every spawn so a
 * key left unset could not be inherited from main's own environment. A reader
 * that tests for presence would boot believing it is called the empty string.
 */
export type PeerIdentity = {
  /** This session's name, or null when it has none. */
  name: string | null
  /** The creating session's name, or null for a user-created session. */
  createdByName: string | null
  /**
   * The creating session's `appSessionId`, or null for a user-created session.
   *
   * The name above is what the model reads and writes; this is what a send to
   * the creator is CHECKED against (F17, ruling 11 of 2026-09-06). A name is
   * released when its row is reaped and may be handed out again, so the
   * remembered name can come to mean a different session; ids are never reused,
   * which is why the registry stores `createdBy` as one (PEER-SESSIONS §2).
   * Never shown to the model and never accepted from it.
   */
  createdById: string | null
}

export function readPeerIdentity(
  env: Record<string, string | undefined> = process.env,
): PeerIdentity {
  const name = env.CATCODE_SIDECAR_NAME
  const createdByName = env.CATCODE_SIDECAR_CREATED_BY_NAME
  const createdById = env.CATCODE_SIDECAR_CREATED_BY
  return {
    name: name === undefined || name === '' ? null : name,
    createdByName:
      createdByName === undefined || createdByName === ''
        ? null
        : createdByName,
    createdById:
      createdById === undefined || createdById === '' ? null : createdById,
  }
}
