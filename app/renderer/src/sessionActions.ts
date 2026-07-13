/**
 * P4-6b — the SessionActionsMenu decision core (`SessionActions.jsx`).
 *
 * A PURE function that turns a merged catalog row + the one contextual fact the
 * renderer knows (is this row the session currently open+attached in a tab?)
 * into the resolved menu: which verbs show, which are live, and — for every
 * disabled verb — the honest, source-cited reason it is not wired yet.
 *
 * Why this shape (the P4-6b security/parity posture, recorded here so nobody
 * re-adds a Potemkin button):
 *
 *  - **Zero inbound vocabulary.** 6b adds NO client→sidecar frame. Every verb
 *    below is either a renderer-only read (Open reuses the host control plane;
 *    Copy/Inspect read transcript state the `EventFrame` stream already
 *    populated) or an honest disable. The recon that grounds each disable:
 *      · Export — clean text/md/json + file download need
 *        `renderMessagesToPlainText` (`src/utils/exportRenderer.tsx:91`), which
 *        is engine-graph-bound and NOT renderer-importable; deferred.
 *      · Branch — `createFork` forks the whole conversation at HEAD
 *        (`src/commands/branch/branch.ts:61`, no from-message-N) and then RESUMES
 *        into the fork, which in the N-process model is a new sidecar = a host
 *        control-plane spawn. History/fork rows have no host restore path today
 *        (`sessionsCatalogState.ts` MergedSessionRow doc) — a branch verb would
 *        mint a fork nobody could open. Deferred, not faked.
 *      · Rewind — `rewindConversationTo` (`src/screens/REPL.tsx:4034`) is
 *        in-memory REPL truncation; the only engine `rewind_files` verb is a git
 *        file-checkpoint, not conversation truncation, and is not in the sidecar
 *        vocabulary. No clean seam → deferred.
 *      · Rename — a title WRITE exists (`saveCustomTitle`,
 *        `src/utils/sessionStorage.ts:2938`) but needs a new inbound
 *        `session.rename` verb, and the spawn-frozen `sessions.snapshot` would
 *        not reflect it without a re-emit. Deferred (documented seam).
 *  - **Cut, not disabled:** Tag / Archive / Delete have NO local engine backing
 *    (`archiveSession` is remote-bridge only; there is no `deleteSession` in
 *    `src/`). They are omitted from the menu entirely (a §0 CUT), never shown as
 *    dead controls.
 *  - **Active-open gating.** Copy and Inspect-metadata read the CURRENT session's
 *    transcript, which the renderer only holds for the session open+attached in a
 *    tab. For any other row they are shown DISABLED with the reason (opening a
 *    cross-session transcript needs a transcript-by-id read seam, not built).
 */

import type { MergedSessionRow } from './sessionsCatalogState.js'

export type SessionActionKind =
  | 'open'
  | 'rename'
  | 'branch'
  | 'rewind'
  | 'metadata'
  | 'copy'
  | 'export'

/** Menu grouping (dividers between non-empty sections), mirroring the prototype. */
export type SessionActionSection = 'primary' | 'history' | 'transfer'

export type SessionActionItem = {
  kind: SessionActionKind
  label: string
  section: SessionActionSection
  /** false ⇒ rendered but not clickable, `reason` explains why (honest disable). */
  enabled: boolean
  /** Present iff `enabled === false`: the source-cited reason it is not wired. */
  reason?: string
  /** Destructive styling. No destructive verb survives recon today (all CUT). */
  danger?: boolean
}

export type SessionActionsContext = {
  /**
   * True when THIS row is the session currently open AND attached in a tab — the
   * only session whose transcript + raw message log the renderer holds. Copy and
   * Inspect-metadata require it; every other verb ignores it.
   */
  isActiveOpen: boolean
}

const DEFER = {
  export:
    'Export deferred — clean text/Markdown/JSON + file download need the engine renderer (renderMessagesToPlainText, src/utils/exportRenderer.tsx:91), not reachable from the renderer.',
  branch:
    'Branch deferred — fork-at-HEAD (src/commands/branch/branch.ts:61) needs a host restore path for the fork; none exists yet.',
  rewind:
    'Rewind deferred — no engine conversation-rewind verb (REPL-only, src/screens/REPL.tsx:4034).',
  rename:
    'Rename deferred — needs a session.rename write verb over saveCustomTitle (src/utils/sessionStorage.ts:2938).',
  notOpen:
    'Open this session first — its transcript is only available while it is the attached tab (cross-session read seam deferred).',
} as const

/**
 * Resolve the ordered, honest menu for one row. CUT verbs (tag/archive/delete)
 * are never returned. Deferred verbs are returned DISABLED with a reason so the
 * affordance is discoverable without lying about being functional.
 */
export function resolveSessionActions(
  row: MergedSessionRow,
  ctx: SessionActionsContext,
): SessionActionItem[] {
  const openable = row.appSessionId != null
  return [
    {
      kind: 'open',
      label: openable ? (row.live ? 'Open' : 'Restore') : 'Open',
      section: 'primary',
      enabled: openable,
      ...(openable
        ? {}
        : {
            reason:
              'Not restorable from the desktop yet — history-only row has no registry entry (P4-6b host-API gap).',
          }),
    },
    {
      kind: 'rename',
      label: 'Rename',
      section: 'primary',
      enabled: false,
      reason: DEFER.rename,
    },
    {
      kind: 'branch',
      label: 'Branch from HEAD…',
      section: 'history',
      enabled: false,
      reason: DEFER.branch,
    },
    {
      kind: 'rewind',
      label: 'Rewind…',
      section: 'history',
      enabled: false,
      reason: DEFER.rewind,
    },
    {
      kind: 'metadata',
      label: 'Inspect metadata…',
      section: 'history',
      enabled: ctx.isActiveOpen,
      ...(ctx.isActiveOpen ? {} : { reason: DEFER.notOpen }),
    },
    {
      kind: 'copy',
      label: 'Copy transcript for LLM',
      section: 'transfer',
      enabled: ctx.isActiveOpen,
      ...(ctx.isActiveOpen ? {} : { reason: DEFER.notOpen }),
    },
    {
      kind: 'export',
      label: 'Export…',
      section: 'transfer',
      enabled: false,
      reason: DEFER.export,
    },
  ]
}

/** The section order the menu renders, so dividers are stable + tested. */
export const SESSION_ACTION_SECTIONS: readonly SessionActionSection[] = [
  'primary',
  'history',
  'transfer',
]
