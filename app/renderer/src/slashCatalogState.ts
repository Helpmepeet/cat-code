/**
 * Slash-command catalog domain state — the renderer half of the
 * `slash-catalog.snapshot` read seam. A reducer over the read-only frame plus a
 * read-time selector; stays OUT of `transcriptProjector.ts`, matching
 * `runControlsState.ts` (the recipe this copies). The catalog is spawn-frozen
 * (the sidecar never re-broadcasts it), so unlike run-controls this seam only
 * folds the one snapshot per session; a process/transport reset drops it and a
 * fresh one arrives on re-attach.
 *
 * The composer SlashCommandPicker reads this for its rich rows (name + arg-hint +
 * description). When absent (a session that predates the snapshot, or a probe),
 * the composer falls back to the names-only `selectSlashCommands` catalog.
 */

import type {
  ServerFrame,
  SessionId,
  SlashCatalogEntry,
} from '../../shared/protocol.js'

export type SlashCatalogState = {
  /** Latest catalog per session; null once dropped by a lifecycle reset. */
  sessions: Record<SessionId, readonly SlashCatalogEntry[] | null>
}

export type SlashCatalogAction = { type: 'frame'; frame: ServerFrame }

export function createSlashCatalogState(): SlashCatalogState {
  return { sessions: {} }
}

export function reduceSlashCatalogState(
  state: SlashCatalogState,
  action: SlashCatalogAction,
): SlashCatalogState {
  const { frame } = action

  if (frame.kind === 'slash-catalog.snapshot') {
    return {
      ...state,
      sessions: { ...state.sessions, [frame.sessionId]: frame.commands },
    }
  }

  // A process/transport reset drops the stale catalog; a fresh one arrives on
  // re-attach. Untracked sessions are left alone (mirrors runControlsState).
  if (frame.kind === 'lifecycle') {
    if (!(frame.sessionId in state.sessions)) return state
    return {
      ...state,
      sessions: { ...state.sessions, [frame.sessionId]: null },
    }
  }

  return state
}

/** The latest slash catalog for a session (empty before the first frame). */
export function selectSlashCatalog(
  state: SlashCatalogState,
  sessionId: SessionId | null,
): readonly SlashCatalogEntry[] {
  const catalog = sessionId ? state.sessions[sessionId] : undefined
  return catalog ?? []
}
