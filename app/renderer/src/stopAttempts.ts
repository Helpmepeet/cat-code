/**
 * The stop that closing a chat requests, tracked per chat so its warning shows
 * only after a stop was refused or could not be confirmed, never while a normal
 * stop is still running (docs/migration/decisions/WARNINGS.md §8).
 *
 * Each close request starts a new attempt. Dismissing a warning dismisses that
 * attempt only, so a retry that fails is shown again. The shell reducer drops an
 * attempt once its chat is stopped, gone, or reopened, so a late exit clears the
 * warning.
 */

import type { HostResult, SessionDescriptor } from '../../shared/hostApi.js'
import type { SessionId } from '../../shared/protocol.js'
import type { BannerAction, BannerNotice } from './BannerStack.js'
import { isSessionDismissed, type SessionDismissals } from './sessionDismissal.js'
import { tabLabel } from './tabBarModel.js'

export type StopAttempt = {
  attempt: number
  phase: 'pending' | 'unconfirmed' | 'refused'
  /** The host's reason, kept only for a refusal. */
  reason: string | null
  dismissed: boolean
}

export type StopAttempts = Readonly<Record<SessionId, StopAttempt>>

export type StopOutcome =
  | { kind: 'stopped' }
  | { kind: 'unconfirmed' }
  | { kind: 'refused'; reason: string }

export type StopAttemptAction =
  /** `attempt` comes from the caller, unique per request, so a late result can be matched. */
  | { type: 'stop-requested'; sessionId: SessionId; attempt: number }
  | { type: 'stop-settled'; sessionId: SessionId; attempt: number; outcome: StopOutcome }
  | { type: 'stop-notice-dismissed'; sessionId: SessionId; attempt: number }

export const NO_STOP_ATTEMPTS: StopAttempts = Object.freeze({})

export function classifyStopResult(result: HostResult<void>): StopOutcome {
  if (result.ok) return { kind: 'stopped' }
  // The host holds no such chat, so nothing is left running to stop.
  if (result.error.code === 'session_not_found') return { kind: 'stopped' }
  if (result.error.code === 'stop_unconfirmed') return { kind: 'unconfirmed' }
  return { kind: 'refused', reason: result.error.message }
}

export function reduceStopAttempts(attempts: StopAttempts, action: StopAttemptAction): StopAttempts {
  const current = attempts[action.sessionId]
  switch (action.type) {
    case 'stop-requested':
      return {
        ...attempts,
        [action.sessionId]: { attempt: action.attempt, phase: 'pending', reason: null, dismissed: false },
      }
    case 'stop-settled': {
      if (!current || current.attempt !== action.attempt || current.phase !== 'pending') return attempts
      if (action.outcome.kind === 'stopped') return withoutAttempt(attempts, action.sessionId)
      return {
        ...attempts,
        [action.sessionId]: {
          ...current,
          phase: action.outcome.kind,
          reason: action.outcome.kind === 'refused' ? action.outcome.reason : null,
        },
      }
    }
    case 'stop-notice-dismissed':
      if (!current || current.attempt !== action.attempt || current.dismissed) return attempts
      return { ...attempts, [action.sessionId]: { ...current, dismissed: true } }
  }
}

/** A descriptor with no live process. `restorable` is set only when none is live. */
export function isSessionStopped(session: SessionDescriptor): boolean {
  return session.status === 'exited' || session.restorable
}

/** Drop attempts whose chat is gone, stopped, or no longer closed. */
export function pruneStopAttempts(
  attempts: StopAttempts,
  byId: Readonly<Record<SessionId, SessionDescriptor>>,
  dismissals: SessionDismissals,
): StopAttempts {
  let next: Record<SessionId, StopAttempt> | null = null
  for (const sessionId of Object.keys(attempts)) {
    const session = byId[sessionId]
    if (session && !isSessionStopped(session) && isSessionDismissed(dismissals, session)) continue
    next ??= { ...attempts }
    delete next[sessionId]
  }
  return next ?? attempts
}

/**
 * After a reload the renderer no longer knows how an earlier stop went. A chat
 * the user closed that still has a live process is reported as unconfirmed, so
 * it never keeps running out of sight.
 */
export function seedUnconfirmedStops(
  attempts: StopAttempts,
  byId: Readonly<Record<SessionId, SessionDescriptor>>,
  dismissals: SessionDismissals,
): StopAttempts {
  let next: Record<SessionId, StopAttempt> | null = null
  for (const session of Object.values(byId)) {
    if (attempts[session.appSessionId] || isSessionStopped(session) || !isSessionDismissed(dismissals, session)) continue
    next ??= { ...attempts }
    // Attempt 0 never matches a request, whose numbers start at 1.
    next[session.appSessionId] = { attempt: 0, phase: 'unconfirmed', reason: null, dismissed: false }
  }
  return next ?? attempts
}

export type StopNotice = { sessionId: SessionId; attempt: number; banner: BannerNotice }

const NO_STOP_NOTICES: readonly StopNotice[] = Object.freeze([])

export const STOP_NOTICE_ACTIONS: readonly BannerAction[] = Object.freeze([
  { key: 'retry', label: 'Retry stop' },
  { key: 'open', label: 'Open chat' },
])

export function selectStopNotices(
  attempts: StopAttempts,
  byId: Readonly<Record<SessionId, SessionDescriptor>>,
  dismissals: SessionDismissals,
): readonly StopNotice[] {
  const notices: StopNotice[] = []
  for (const [sessionId, attempt] of Object.entries(attempts)) {
    if (attempt.phase === 'pending' || attempt.dismissed) continue
    const session = byId[sessionId]
    if (!session || isSessionStopped(session) || !isSessionDismissed(dismissals, session)) continue
    const name = tabLabel(session)
    notices.push({
      sessionId,
      attempt: attempt.attempt,
      banner: {
        id: `stop:${sessionId}:${attempt.attempt}`,
        tone: 'warn',
        title: attempt.phase === 'unconfirmed' ? `Couldn't confirm "${name}" stopped.` : `Couldn't stop "${name}".`,
        ...(attempt.phase === 'refused' && attempt.reason ? { detail: attempt.reason } : {}),
        live: 'polite',
        actions: [...STOP_NOTICE_ACTIONS],
      },
    })
  }
  return notices.length === 0 ? NO_STOP_NOTICES : notices
}

function withoutAttempt(attempts: StopAttempts, sessionId: SessionId): StopAttempts {
  const next = { ...attempts }
  delete next[sessionId]
  return next
}
