/**
 * Which project the Settings screen is bound to, and what to call it.
 *
 * Every value the Settings screen shows is resolved engine-side for ONE session
 * (`settingsState.ts` `selectSettingsSnapshot` is keyed by `SessionId`, because
 * settings resolve against a session's cwd and there is no engine without a
 * session — N-process). The screen therefore always describes whichever session
 * is focused, and until it names that project the operator is reading someone
 * else's configuration with no way to tell. This module answers the two halves
 * of that question — which project, and whether one is bound at all — once, so
 * no pane re-derives it (the `settingsReadState.ts` doctrine, applied to the
 * other fact every pane silently assumes).
 *
 * Two rules hold it together:
 *
 *  - **Identity is the cwd, never the label.** The label is derived and moves as
 *    other workspaces appear or disappear; the cwd is what the engine actually
 *    resolved the settings files against, so it is the only stable key.
 *  - **The label is disambiguated against the WHOLE roster, not the header.**
 *    See `resolveWorkspaceName` below — this is the part that is easy to get
 *    wrong in the safe-looking direction.
 */

import type { SessionId } from '../../shared/protocol.js'
import { groupByWorkspace, type MergedSessionRow } from './sessionsCatalogState.js'

/** Why nothing can be named. Each is a different fact, not one empty state. */
export type SettingsProjectUnboundReason =
  /**
   * No session is focused. Settings are session-keyed, so there is no project,
   * no snapshot, and nothing in flight — this is the resting state of a launched
   * app with every tab closed, not a transient one.
   */
  | 'no-session'
  /**
   * A session is focused but the merged roster carries no row for it — the
   * roster and the active id are separate renderer state and can be one render
   * apart. Transient, but not nameable while it lasts.
   */
  | 'unknown-session'
  /**
   * The bound session's row records no workspace path at all (MAJOR-1, an
   * unreconcilable transcript workspace — `sessionsCatalogState.ts:97`). A
   * session exists; its project does not resolve.
   */
  | 'unknown-workspace'

export type SettingsProjectBinding =
  | {
      readonly bound: true
      /** The focused session this binding was resolved from. */
      readonly appSessionId: SessionId
      /** Stable identity: the workspace the engine resolved settings against. */
      readonly cwd: string
      /**
       * What to render. Derived — never a key, never compared, never persisted.
       * `resolveWorkspaceName` explains what it is disambiguated against.
       */
      readonly name: string
    }
  | { readonly bound: false; readonly reason: SettingsProjectUnboundReason }

/**
 * The shared copy for each unbound reason. A `Record` over the union so adding a
 * reason without writing its sentence is a compile error, and so no pane invents
 * a phrasing that reads as a real answer ("None", "Default project", an empty
 * header) — the failure mode this whole surface keeps reproducing. Like
 * `SETTINGS_UNREAD_NOTE`, none of these promises that something is arriving.
 */
export const SETTINGS_PROJECT_UNBOUND_NOTE: Readonly<
  Record<SettingsProjectUnboundReason, string>
> = {
  'no-session': 'No session is open, so these settings belong to no project.',
  'unknown-session': 'The open session is not in the roster yet, so its project is unknown.',
  'unknown-workspace': 'The open session records no workspace, so its project cannot be identified.',
}

/**
 * The project the Settings screen is currently bound to.
 *
 * `rows` is the shared merged catalog (`selectMergedSessionRows`) and
 * `activeSessionId` is App's focus state — the same two values every other
 * surface reads, so this grows no feed of its own. Matching is on
 * `row.appSessionId`, NOT `row.sessionId`: the latter becomes the
 * engineSessionId once one is assigned (`sessionsCatalogState.ts:185`), so
 * matching on it would miss a resumed session — the same rule App applies to the
 * active row (`App.tsx:906`).
 */
export function selectSettingsProjectBinding(
  rows: readonly MergedSessionRow[],
  activeSessionId: SessionId | null,
): SettingsProjectBinding {
  if (activeSessionId == null) return { bound: false, reason: 'no-session' }

  const row = rows.find(candidate => candidate.appSessionId === activeSessionId)
  if (!row) return { bound: false, reason: 'unknown-session' }
  if (row.cwd.trim().length === 0) {
    return { bound: false, reason: 'unknown-workspace' }
  }

  return {
    bound: true,
    appSessionId: activeSessionId,
    cwd: row.cwd,
    name: resolveWorkspaceName(rows, row.cwd),
  }
}

/**
 * The display label for one workspace, disambiguated against EVERY workspace in
 * the roster.
 *
 * `disambiguateWorkspaceLabels` (`sessionsCatalogState.ts:449`) gives a workspace
 * the shortest leading path that separates it from the others ON SCREEN, and the
 * Welcome recents deliberately hand it only the entries that will render, so an
 * invisible project never widens a visible label. Reading that rule literally
 * here would be a bug: the Settings header renders exactly ONE workspace, a
 * one-element set never collides, and the label would always collapse to depth 1
 * — a bare `app` — which is precisely the defect that helper was added to remove
 * (two adjacent groups both reading `APP`, `/Users/pt/cat-code/app` and
 * `/Users/pt/PTClove/app`, operator-reported 2026-07-26).
 *
 * The set that matters is not what shares the header; it is the set of candidate
 * answers to the question the header asks — *which of my projects is this?* That
 * population is every distinct workspace in the merged roster, which is exactly
 * the set the sidebar's group headers are drawn from. So we call
 * `groupByWorkspace` itself rather than re-deriving labels: one call site, one
 * invariant, and for an unfiltered rail the header reads byte-identical to the
 * sidebar group the operator is comparing it against. (The sidebar filters rows
 * before grouping — search text, dead-workspace rows — so its rail can show a
 * SHORTER label for the same project. Grouping over the full roster can only ever
 * be equal or longer, i.e. never more ambiguous, which is the safe direction for
 * a header that names one thing.)
 *
 * `activeCwd` is passed as null: only the `current` flag reads it, and this is a
 * label lookup.
 */
function resolveWorkspaceName(
  rows: readonly MergedSessionRow[],
  cwd: string,
): string {
  const group = groupByWorkspace(rows, null).find(
    candidate => candidate.cwd === cwd,
  )
  // Unreachable — `cwd` came from a row in `rows`, so it IS a group key. The
  // fallback is the full path, which is unique by construction and so can never
  // be more ambiguous than the label it stands in for.
  return group?.name ?? cwd
}
