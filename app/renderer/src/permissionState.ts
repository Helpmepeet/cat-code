/**
 * Permissions domain state — PROGRAM-PLAN §5 layer 3 (per-domain selector).
 *
 * This is the renderer half of the P2-4 domain recipe every later W4 domain
 * copies: a reducer over raw `ServerFrame`s + local UI actions, plus read-time
 * selectors. It stays OUT of `transcriptProjector.ts` on purpose — permission
 * state is not transcript state.
 *
 * Protocol facts this models (S2 spec §1–§2):
 *  - multiple permission requests can be pending simultaneously within a turn
 *    (parallel tool calls) — the queue is keyed by engine-minted `requestId`,
 *    deduped on insert, with NO timeout ("keep pending" = do nothing);
 *  - `permission.resolved` is the UNIVERSAL dismiss: it fires whether this
 *    window answered, another surface answered, or an abort mass-denied;
 *  - the C3 `permission.context` snapshot is the engine's live context,
 *    faithful by construction — never reconstructed here from update echoes.
 */

import type { AppSessionEvent } from '@cat-code/engine/session-events'
import type {
  PermissionContextSnapshot,
  PermissionResponseInput,
  ServerFrame,
  SessionId,
} from '../../shared/protocol.js'

export type PermissionRequest = Extract<
  AppSessionEvent,
  { type: 'permission.requested' }
>['request']

type SessionPermissionState = {
  /**
   * The pending queue in arrival order. Semantically a Map keyed by
   * `requestId` (inserts dedupe on requestId; `permission.resolved` is the
   * only true removal); stored as an array to keep arrival order first-class.
   */
  pending: PermissionRequest[]
  /** Locally snoozed cards (Esc). Still pending engine-side — display only. */
  dismissedRequestIds: string[]
  /** Answers in flight (sent, not yet resolved) — prevents double-submit. */
  submittedRequestIds: string[]
  /** C3 — latest engine context snapshot; null until the first frame. */
  context: PermissionContextSnapshot | null
}

export type PermissionState = {
  sessions: Record<SessionId, SessionPermissionState>
}

export type PermissionAction =
  | { type: 'frame'; frame: ServerFrame }
  | { type: 'submitted'; sessionId: SessionId; requestId: string }
  | { type: 'submissionFailed'; sessionId: SessionId; requestId: string }
  | { type: 'dismissed'; sessionId: SessionId; requestId: string }
  | { type: 'restored'; sessionId: SessionId; requestId: string }

export function createPermissionState(): PermissionState {
  return { sessions: {} }
}

function createSessionPermissionState(): SessionPermissionState {
  return {
    pending: [],
    dismissedRequestIds: [],
    submittedRequestIds: [],
    context: null,
  }
}

export function reducePermissionState(
  state: PermissionState,
  action: PermissionAction,
): PermissionState {
  if (action.type === 'submitted' || action.type === 'dismissed') {
    const session = state.sessions[action.sessionId]
    if (!session) return state
    const field =
      action.type === 'submitted'
        ? 'submittedRequestIds'
        : 'dismissedRequestIds'
    if (session[field].includes(action.requestId)) return state
    return updateSession(state, action.sessionId, {
      ...session,
      [field]: [...session[field], action.requestId],
    })
  }

  if (action.type === 'restored') {
    const session = state.sessions[action.sessionId]
    if (!session?.dismissedRequestIds.includes(action.requestId)) return state
    return updateSession(state, action.sessionId, {
      ...session,
      dismissedRequestIds: session.dismissedRequestIds.filter(
        requestId => requestId !== action.requestId,
      ),
    })
  }

  if (action.type === 'submissionFailed') {
    const session = state.sessions[action.sessionId]
    if (!session?.submittedRequestIds.includes(action.requestId)) return state
    return updateSession(state, action.sessionId, {
      ...session,
      submittedRequestIds: session.submittedRequestIds.filter(
        requestId => requestId !== action.requestId,
      ),
    })
  }

  const { frame } = action
  if (frame.kind === 'ready') {
    // Rebuild the queue from the engine's authoritative pending snapshot
    // (S2 §2 rule 1); local bookkeeping survives only for ids still pending.
    const previous =
      state.sessions[frame.sessionId] ?? createSessionPermissionState()
    const pendingIds = new Set(
      frame.payload.pendingPermissionRequests.map(request => request.requestId),
    )
    return {
      ...state,
      sessions: {
        ...state.sessions,
        [frame.sessionId]: {
          pending: frame.payload.pendingPermissionRequests,
          dismissedRequestIds: previous.dismissedRequestIds.filter(requestId =>
            pendingIds.has(requestId),
          ),
          submittedRequestIds: previous.submittedRequestIds.filter(requestId =>
            pendingIds.has(requestId),
          ),
          // The context snapshot is re-emitted right after every ready frame;
          // keep the previous one meanwhile rather than flashing to null.
          context: previous.context,
        },
      },
    }
  }

  // C3 — a snapshot is standalone truth (engine's live context); accept it
  // even if it raced ahead of any session bookkeeping.
  if (frame.kind === 'permission.context') {
    const session =
      state.sessions[frame.sessionId] ?? createSessionPermissionState()
    return updateSession(state, frame.sessionId, {
      ...session,
      context: frame.context,
    })
  }

  const session = state.sessions[frame.sessionId]
  if (!session) return state

  if (frame.kind === 'lifecycle') {
    return updateSession(
      state,
      frame.sessionId,
      createSessionPermissionState(),
    )
  }

  if (frame.kind === 'error' && frame.requestId) {
    if (!session.submittedRequestIds.includes(frame.requestId)) return state
    return updateSession(state, frame.sessionId, {
      ...session,
      submittedRequestIds: session.submittedRequestIds.filter(
        requestId => requestId !== frame.requestId,
      ),
    })
  }

  if (frame.kind !== 'event') return state

  if (frame.event.type === 'permission.requested') {
    const request = frame.event.request
    return updateSession(state, frame.sessionId, {
      ...session,
      pending: [
        ...session.pending.filter(
          candidate => candidate.requestId !== request.requestId,
        ),
        request,
      ],
      dismissedRequestIds: session.dismissedRequestIds.filter(
        requestId => requestId !== request.requestId,
      ),
      submittedRequestIds: session.submittedRequestIds.filter(
        requestId => requestId !== request.requestId,
      ),
    })
  }

  if (frame.event.type === 'permission.resolved') {
    return updateSession(
      state,
      frame.sessionId,
      removeRequest(session, frame.event.request.requestId),
    )
  }

  return state
}

/** One queue entry with its local display flags. */
export type PermissionQueueItem = {
  request: PermissionRequest
  /** An answer is in flight for this card. */
  submitted: boolean
  /** Locally snoozed (Esc) — still pending engine-side. */
  dismissed: boolean
}

/** The full pending queue in arrival order (every card, including snoozed). */
export function selectPermissionQueue(
  state: PermissionState,
  sessionId: SessionId | null,
): PermissionQueueItem[] {
  const session = sessionId ? state.sessions[sessionId] : undefined
  if (!session) return []
  return session.pending.map(request => ({
    request,
    submitted: session.submittedRequestIds.includes(request.requestId),
    dismissed: session.dismissedRequestIds.includes(request.requestId),
  }))
}

/**
 * The engine tool whose permission request IS a plan review
 * (`src/tools/ExitPlanModeTool/constants.ts:2`). A literal, not an engine
 * import — the renderer stays out of the engine runtime graph (P0-3). Owned
 * HERE (not `planState.ts`) so the ACTION path (`selectVisiblePermission` /
 * keyboard) and the RENDER path (`planState.selectNonPlanPermissionQueue`)
 * share ONE predicate.
 */
export const EXIT_PLAN_MODE_TOOL_NAME = 'ExitPlanMode'

/** Single source of truth for "is this pending request a plan review". */
export function isPlanPermissionRequest(request: PermissionRequest): boolean {
  return request.request.tool_name === EXIT_PLAN_MODE_TOOL_NAME
}

/**
 * The card keyboard shortcuts act on: first un-answered, un-snoozed pending.
 * Plan requests are EXCLUDED — the same predicate `selectNonPlanPermissionQueue`
 * uses to keep `ExitPlanMode` out of the render queue. A plan can only be
 * resolved through `PlanPanel`'s two-step `setPermissionMode`-then-allow
 * compose; a bare keyboard `allow` here would send a plain
 * `buildAllowResponse(request, [])`, skipping the mode switch and stranding the
 * session in `plan` mode (decisions/PERMISSION-BOUNDARY.md §3).
 */
export function selectVisiblePermission(
  state: PermissionState,
  sessionId: SessionId | null,
): PermissionRequest | null {
  const session = sessionId ? state.sessions[sessionId] : undefined
  if (!session) return null
  return (
    session.pending.find(
      request =>
        !isPlanPermissionRequest(request) &&
        !session.dismissedRequestIds.includes(request.requestId) &&
        !session.submittedRequestIds.includes(request.requestId),
    ) ?? null
  )
}

/**
 * How many permission requests in this session still need an answer (not yet
 * submitted). Drives the TabBar's background-attention badge (P3-5a) — a request
 * arriving in a BACKGROUND session must be visibly signalled on its tab, never
 * silently queued. Snoozed (locally dismissed) cards still count: the engine
 * request is live and the tab should still pulse.
 */
export function selectPendingPermissionCount(
  state: PermissionState,
  sessionId: SessionId | null,
): number {
  const session = sessionId ? state.sessions[sessionId] : undefined
  if (!session) return 0
  return session.pending.filter(
    request => !session.submittedRequestIds.includes(request.requestId),
  ).length
}

/** C3 — the latest engine context snapshot (null before the first frame). */
export function selectPermissionContext(
  state: PermissionState,
  sessionId: SessionId | null,
): PermissionContextSnapshot | null {
  const session = sessionId ? state.sessions[sessionId] : undefined
  return session?.context ?? null
}

/**
 * C3 — the directories tools may access beyond the session's cwd
 * (`ToolPermissionContext.additionalWorkingDirectories`, `--add-dir` +
 * `permissions.additionalDirectories`). P4-14's WorkspaceTrust section reads
 * this SAME context the permission rules editor already renders (§10 — no
 * second seam for the same data). `[]` before the first `permission.context`
 * frame.
 */
export function selectAdditionalWorkingDirectories(
  state: PermissionState,
  sessionId: SessionId | null,
): PermissionContextSnapshot['additionalWorkingDirectories'] {
  return selectPermissionContext(state, sessionId)?.additionalWorkingDirectories ?? []
}

/**
 * Build an allow response. `applySuggestions` is the C1 "always allow"
 * affordance: indices into THIS request's engine-minted
 * `permission_suggestions`. The renderer only ever SELECTS — the sidecar
 * validates the indices and re-attaches the engine's own update objects
 * (decisions/PERMISSION-BOUNDARY.md §2); no rule content originates here.
 */
export function buildAllowResponse(
  _request: PermissionRequest,
  applySuggestions: number[] = [],
): Extract<PermissionResponseInput, { behavior: 'allow' }> {
  return {
    behavior: 'allow',
    // The sidecar substitutes its engine-owned gated input for this sentinel.
    // Do not echo potentially huge or renderer-mutated input across IPC.
    updatedInput: {},
    ...(applySuggestions.length > 0 ? { applySuggestions } : {}),
  }
}

/**
 * Build a deny response. The message is REQUIRED by the engine schema and is
 * what the model reads as the refusal — free-text feedback belongs here.
 */
export function buildDenyResponse(
  message?: string,
): Extract<PermissionResponseInput, { behavior: 'deny' }> {
  const trimmed = message?.trim()
  return {
    behavior: 'deny',
    message: trimmed && trimmed.length > 0 ? trimmed : 'Denied by user',
  }
}

function updateSession(
  state: PermissionState,
  sessionId: SessionId,
  session: SessionPermissionState,
): PermissionState {
  return {
    ...state,
    sessions: { ...state.sessions, [sessionId]: session },
  }
}

function removeRequest(
  state: SessionPermissionState,
  requestId: string,
): SessionPermissionState {
  return {
    ...state,
    pending: state.pending.filter(request => request.requestId !== requestId),
    dismissedRequestIds: state.dismissedRequestIds.filter(
      dismissedId => dismissedId !== requestId,
    ),
    submittedRequestIds: state.submittedRequestIds.filter(
      submittedId => submittedId !== requestId,
    ),
  }
}
