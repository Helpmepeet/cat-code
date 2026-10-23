import type { SessionId } from '../../shared/protocol.js'

/**
 * The session whose pane is on screen. It follows the preferred (active)
 * session once that session owns a pane, and otherwise stays on the session
 * already shown, so a just-created or just-selected session that has not
 * produced its pane yet never blanks the workspace. Falls back to the first
 * pane when the shown session is gone.
 */
export function reconcileShownSession(
  current: SessionId | null,
  paneSessionIds: readonly SessionId[],
  preferredSessionId: SessionId | null,
): SessionId | null {
  const panes = new Set(paneSessionIds)
  if (preferredSessionId && panes.has(preferredSessionId)) return preferredSessionId
  if (current && panes.has(current)) return current
  return paneSessionIds[0] ?? null
}
