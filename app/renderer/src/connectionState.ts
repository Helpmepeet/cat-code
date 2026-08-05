import { PARKED_EXIT_CODE } from '../../shared/limits.js'
import type {
  LifecycleFrame,
  ReadyFrame,
  ServerFrame,
  SessionId,
} from '../../shared/protocol.js'

export type ConnectionSnapshot = {
  status:
    | 'connecting'
    | 'starting'
    | 'ready'
    | 'dead'
    /**
     * IDLE-PARK (decisions/IDLE-PARK.md) — the engine process behind this session
     * was reclaimed ON PURPOSE because the session sat idle, and the transcript is
     * still on disk. Renderer-local: nothing on the wire says "parked", and the
     * host descriptor stays byte-identical to a crash by design (§11). The
     * classifier is the EXIT CODE the lifecycle frame already carries, so this
     * costs no protocol change and no new inbound vocabulary.
     *
     * It is not a failure and it is not terminal: no danger tone, no recovery
     * sentence, no Restart requirement. It is the "no engine attached yet, and the
     * user's own intent starts one" state the composer already models for a
     * preview pane, reached from the other direction.
     */
    | 'parked'
    | LifecycleFrame['status']
  inputEnabled: boolean
}

export type ConnectionState = {
  sessions: Record<SessionId, ConnectionSnapshot>
}

const CONNECTING: ConnectionSnapshot = {
  status: 'connecting',
  inputEnabled: false,
}

export function createConnectionState(): ConnectionState {
  return { sessions: {} }
}

export function selectConnection(
  state: ConnectionState,
  sessionId: SessionId | null,
): ConnectionSnapshot {
  return sessionId ? (state.sessions[sessionId] ?? CONNECTING) : CONNECTING
}

/**
 * Terminal vs transient for the connection union — the partition a recovery
 * affordance must read before it calls a session failed.
 *
 * `starting` is TRANSIENT, not a spawn-lifecycle failure. It is projected below
 * from an `error` frame carrying `session_not_ready`, which the supervisor mints
 * only while the child is still `spawning`/`connecting`
 * (`sendFailureCodeForStatus`, `app/supervisor/supervisor.ts:509`) and which is
 * the single send-failure code the wire marks `retryable: true`
 * (`SidecarSendError.retryable`, `supervisor.ts:127`; `ErrorFrame.retryable`,
 * `app/shared/protocol.ts:564`). The spawn has not failed, it has not finished.
 * The other two codes are non-retryable and map to `dead` / `disconnected`.
 *
 * This partition must agree with `resolvePendingSubmit` (`composerState.ts`),
 * which splits the SAME union for parked prompts: everything terminal here is
 * exactly what it `release`s. `connectionState.test.ts` pins that agreement.
 */
export function isTerminalConnectionStatus(
  status: ConnectionSnapshot['status'],
): boolean {
  switch (status) {
    case 'connecting':
    case 'starting':
    case 'ready':
    // A parked session is the opposite of terminal: its transcript is intact, its
    // row is restorable, and the next submit brings the engine back under the
    // user. Classifying it here is what keeps the tone neutral, the recovery
    // sentence absent, and the parked prompt held instead of released.
    case 'parked':
      return false
    case 'dead':
    case 'disconnected':
    case 'failed':
    case 'exited':
      return true
    default: {
      const exhaustive: never = status
      return exhaustive
    }
  }
}

/**
 * Is there an engine process behind this session that a verb could reach — either
 * attached, or on its way up?
 *
 * Deliberately NOT derived from `isTerminalConnectionStatus`, and the reason is
 * the whole point of this predicate: those two questions used to have the same
 * answer for every status, and `'parked'` is the first member where they come
 * apart. A parked session is not terminal (its prompt is held, its composer stays
 * open) and yet has no process at all, so a caller that asked "is it terminal?"
 * to mean "can I send to it?" would send into the void. That reply is a
 * `session_not_found` error frame, which the reducer below maps to `dead` — a
 * false terminal state raised over a perfectly good session, which is the exact
 * defect the context-breakdown popover was fixed for once already.
 *
 * The exhaustive switch is the tripwire: a new status has to answer this question
 * explicitly rather than inherit an answer that happens to be right today.
 */
export function connectionHasEngine(
  status: ConnectionSnapshot['status'],
): boolean {
  switch (status) {
    case 'connecting':
    case 'starting':
    case 'ready':
      return true
    case 'parked':
    case 'dead':
    case 'disconnected':
    case 'failed':
    case 'exited':
      return false
    default: {
      const exhaustive: never = status
      return exhaustive
    }
  }
}

/**
 * The connection tone grammar (24b ruling): exactly two tones, and the transient
 * one is the ABSENCE of a failure presentation, not a second style.
 *
 * Derived from `isTerminalConnectionStatus` rather than from a second switch, so
 * a status can never be transient for the recovery guard and danger for its
 * paint. A member added to the union has to be classified once, above, and
 * inherits its tone here — which is the whole point: the next transient state
 * cannot present as a failure because its author picked a colour.
 */
export type ConnectionTone = 'neutral' | 'danger'

export function connectionTone(
  status: ConnectionSnapshot['status'],
): ConnectionTone {
  return isTerminalConnectionStatus(status) ? 'danger' : 'neutral'
}

/**
 * What a `danger` connection says to the user, in place of the engine's own
 * discriminant (`Session dead.` was the literal prior copy).
 *
 * Transient statuses have no sentence because they mount no bar;
 * `connectionState.test.ts` pins the null-vs-sentence split to the tone so the
 * two lists cannot drift, and pins that no sentence contains its own status word.
 */
export function connectionRecoveryMessage(
  status: ConnectionSnapshot['status'],
): string | null {
  switch (status) {
    case 'connecting':
    case 'starting':
    case 'ready':
    // Nothing to say. Parking is backend housekeeping the user did not ask for
    // and cannot act on; the composer stays usable and the next message brings
    // the engine back, so a sentence here would be reporting our own bookkeeping
    // as if it were the user's problem.
    case 'parked':
      return null
    case 'dead':
      return 'This session is no longer available. Restart it to keep working.'
    case 'disconnected':
      return 'This session lost its connection. Restart it to reconnect.'
    case 'failed':
      return 'This session could not start. Restart it to try again.'
    case 'exited':
      return 'This session stopped unexpectedly. Restart it to keep working.'
    default: {
      const exhaustive: never = status
      return exhaustive
    }
  }
}

/**
 * IDLE-PARK — read the death's REASON off the frame that reports it.
 *
 * `PARKED_EXIT_CODE` is the sidecar's self-exit code for a gated, host-requested
 * park (`app/sidecar/index.ts` `onPark`), and the same code the host classifies on
 * (`app/host/host.ts` `onSupervisorEvent`). Main already forwards it inside
 * `LifecycleFrame.exit`, so the renderer reads the identical signal from the
 * identical source rather than inferring park-ness from a descriptor that is
 * deliberately indistinguishable from a crash.
 *
 * Only an `exited` frame is reclassified. A `disconnected` or `failed` frame is a
 * transport/spawn failure with no exit code behind it and stays exactly as honest
 * as it was; so does an `exited` frame carrying any other code, including the
 * `RESUME_FAILED_EXIT_CODE` death of a restore that could not load its transcript.
 */
function lifecycleConnectionStatus(
  frame: LifecycleFrame,
): ConnectionSnapshot['status'] {
  if (frame.status === 'exited' && frame.exit?.code === PARKED_EXIT_CODE) {
    return 'parked'
  }
  return frame.status
}

export function reduceConnectionState(
  state: ConnectionState,
  frame: ServerFrame,
): ConnectionState {
  if (isAppReadyFrame(frame)) {
    return {
      ...state,
      sessions: {
        ...state.sessions,
        [frame.sessionId]: {
          status: 'ready',
          inputEnabled: frame.payload.inputEnabled,
        },
      },
    }
  }
  if (frame.kind === 'lifecycle') {
    return {
      ...state,
      sessions: {
        ...state.sessions,
        [frame.sessionId]: {
          status: lifecycleConnectionStatus(frame),
          inputEnabled: false,
        },
      },
    }
  }
  // The engine's live turn boundary (`AppSessionController.setActiveTurn`).
  // Without it `inputEnabled` would only ever hold the value the `ready`
  // handshake carried at attach, so a session that started a turn afterwards
  // still read as idle — which is what silently disabled the whole in-turn
  // activity surface (indicator, Stop, Esc, the mid-turn composer queue).
  //
  // Only `inputEnabled` moves: `status` stays whatever the lifecycle/error
  // frames last said, so a turn event can never resurrect a dead session.
  if (frame.kind === 'event' && frame.event.type === 'turn.status') {
    const existing = state.sessions[frame.sessionId]
    if (!existing) return state
    const inputEnabled = !frame.event.activeTurn
    if (existing.inputEnabled === inputEnabled) return state
    return {
      ...state,
      sessions: {
        ...state.sessions,
        [frame.sessionId]: { ...existing, inputEnabled },
      },
    }
  }

  if (frame.kind === 'error') {
    const status =
      frame.code === 'session_not_found'
        ? 'dead'
        : frame.code === 'session_not_ready'
          ? 'starting'
          : frame.code === 'session_disconnected'
            ? 'disconnected'
            : null
    if (!status) return state
    // IDLE-PARK — a send failure tells a PARKED session nothing it does not
    // already know. We reclaimed its engine on purpose, so "there is no engine"
    // is the state, not news; both `session_disconnected` (the tombstone record)
    // and `session_not_found` (already deregistered) are the expected replies.
    //
    // Without this guard a single stray verb from a parked pane converted an
    // intentional park straight back into a terminal `disconnected`/`dead`: the
    // danger banner and Restart button returned, the composer went read-only, and
    // any held prompt was released. That is the whole defect, restored by one
    // click, and the composer is deliberately LIVE on a parked session now, so
    // such a click is reachable rather than hypothetical.
    //
    // Only these two no-engine codes are absorbed. `session_not_ready` still
    // moves the session to `starting`, because that one is minted only while a
    // child is genuinely spawning — which is exactly the unpark in progress.
    const existing = state.sessions[frame.sessionId]
    if (
      existing?.status === 'parked' &&
      (frame.code === 'session_disconnected' || frame.code === 'session_not_found')
    ) {
      return state
    }
    return {
      ...state,
      sessions: {
        ...state.sessions,
        [frame.sessionId]: {
          status,
          inputEnabled: false,
        },
      },
    }
  }
  return state
}

export function isAppReadyFrame(frame: unknown): frame is ReadyFrame {
  if (typeof frame !== 'object' || frame === null) return false
  const candidate = frame as {
    kind?: unknown
    sessionId?: unknown
    engineSessionId?: unknown
    payload?: { type?: unknown }
  }
  return (
    candidate.kind === 'ready' &&
    typeof candidate.sessionId === 'string' &&
    typeof candidate.engineSessionId === 'string' &&
    candidate.engineSessionId.length > 0 &&
    typeof candidate.payload === 'object' &&
    candidate.payload !== null &&
    candidate.payload.type === 'app.ready'
  )
}
