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
 *  - **Three WIRED mutating verbs (P4-6b).** Rename / Export / Branch are now
 *    real, each an app-owned inbound frame validated at the sidecar and dispatched
 *    to the engine's OWN machinery (protocol.ts SESSION_ACTION_VERB_TYPES):
 *      · Rename → `saveCustomTitle` (`src/utils/sessionStorage.ts:3009`); the
 *        sidecar also reuses the `session-title` outbound frame → `host.setTitle`
 *        so the sidebar/tab relabel live.
 *      · Export → `renderMessagesToPlainText` (`src/utils/exportRenderer.tsx:91`,
 *        TEXT-only — md/json have no engine render path → §0-deferred); the
 *        rendered text rides back on the result frame.
 *      · Branch → `createFork` (`src/commands/branch/branch.ts:61`, forks the whole
 *        conversation at HEAD — no from-message-N, so the label ADAPTS to "Branch
 *        from HEAD…"). The fork is written for real; AUTO-OPENING it is §0-DEFERRED
 *        (a fork has no registry row and the sidecar has no host control-plane
 *        channel — `sessionActionRuntimeState.ts` / protocol.ts record the gap).
 *    All three run inside the session's OWN live engine, so they are enabled ONLY
 *    for a LIVE row (a running sidecar to receive the verb); a restorable/history
 *    row shows them DISABLED with the reason (open/restore it first).
 *  - **Still disabled (no engine seam):** Rewind — `rewindConversationTo`
 *    (`src/screens/REPL.tsx:4034`) is in-memory REPL truncation; the only engine
 *    `rewind_files` verb is a git file-checkpoint, not conversation truncation, and
 *    is not in the sidecar vocabulary. No clean seam → deferred.
 *  - **Cut, not disabled:** Tag / Archive / Delete have NO local engine backing
 *    (`archiveSession` is remote-bridge only; there is no `deleteSession` in
 *    `src/`). They are omitted from the menu entirely (a §0 CUT), never shown as
 *    dead controls. (Fidelity note: the prototype SHOWS these; a follow-on may
 *    prefer a visible-disabled row with a reason over an omission.)
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
  rewind: 'Rewind is not available in the desktop app yet.',
  notLive:
    'Open or restore this session first. Rename, Export and Branch run in its live engine, which a closed session has stopped.',
  notOpen:
    'Open this session first. Its transcript is only readable while it is the attached tab.',
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
  // Rename / Export / Branch run inside the session's OWN live engine (the verb is
  // dispatched to its sidecar), so they are reachable ONLY for a LIVE row.
  const live = row.live === true
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
              'Not restorable from the desktop yet. This session came from terminal history.',
          }),
    },
    {
      kind: 'rename',
      label: 'Rename',
      section: 'primary',
      enabled: live,
      ...(live ? {} : { reason: DEFER.notLive }),
    },
    {
      kind: 'branch',
      label: 'Branch from HEAD…',
      section: 'history',
      enabled: live,
      ...(live ? {} : { reason: DEFER.notLive }),
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
      enabled: live,
      ...(live ? {} : { reason: DEFER.notLive }),
    },
  ]
}

/** The section order the menu renders, so dividers are stable + tested. */
export const SESSION_ACTION_SECTIONS: readonly SessionActionSection[] = [
  'primary',
  'history',
  'transfer',
]
