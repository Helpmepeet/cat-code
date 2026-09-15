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
 *  - **Two WIRED mutating verbs (P4-6b).** Rename / Export are
 *    real, each an app-owned inbound frame validated at the sidecar and dispatched
 *    to the engine's OWN machinery (protocol.ts SESSION_ACTION_VERB_TYPES):
 *      · Rename → `saveCustomTitle` (`src/utils/sessionStorage.ts:3009`); the
 *        sidecar also reuses the `session-title` outbound frame → `host.setTitle`
 *        so the sidebar/tab relabel live.
 *      · Export → `renderMessagesToPlainText` (`src/utils/exportRenderer.tsx:91`,
 *        TEXT-only — md/json have no engine render path → §0-deferred); the
 *        rendered text rides back on the result frame.
 *    Both run inside the session's OWN live engine, so they are enabled ONLY
 *    for a LIVE row (a running sidecar to receive the verb); a restorable/history
 *    row shows them DISABLED with the reason (open/restore it first).
 *  - **Cut, not disabled:** Archive / Delete have NO local engine backing
 *    (`archiveSession` is remote-bridge only; there is no `deleteSession` in
 *    `src/`). They are omitted from the menu entirely (a §0 CUT), never shown as
 *    dead controls. (Fidelity note: the prototype SHOWS these; a follow-on may
 *    prefer a visible-disabled row with a reason over an omission.)
 *  - **Tag was wrongly listed as cut here** (corrected P4-29). `saveTag`
 *    (`src/utils/sessionStorage.ts:3257`) is a real per-session engine write —
 *    the `/tag` command's own — so tag was a missing SIDECAR verb, not an absent
 *    capability. It now crosses as `session.tag`. It is not a row in THIS menu:
 *    the Sessions page tags from the row's own `#tag` / `+ tag` control, which is
 *    also where the tag is read, so a second entry point here would duplicate it
 *    (§0 deferred — a menu entry needs a menu→popover request path).
 *  - **Active-open gating.** Copy and Inspect-metadata read the CURRENT session's
 *    transcript, which the renderer only holds for the session open+attached in a
 *    tab. For any other row they are shown DISABLED with the reason (opening a
 *    cross-session transcript needs a transcript-by-id read seam, not built).
 */

import type { MergedSessionRow } from './sessionsCatalogState.js'

export type SessionActionKind =
  | 'open'
  | 'rename'
  | 'metadata'
  /** The flyout HOST (`SessionActions.jsx:174`). Never dispatched — it only opens its submenu. */
  | 'copy'
  | 'copy-md'
  | 'copy-text'
  /**
   * The two ids that address this session — the app's own and the engine's
   * transcript key. It replaces the dev-only debug line the composer carried
   * from 2026-07-28 to 2026-08-17, which printed them for the ACTIVE pane only
   * and could not ship to a real build (§7 forbids a session id on a text
   * surface). Copying them is not the same as displaying them, so this row is
   * live in every build and for EVERY row, not just the attached tab.
   */
  | 'copy-ids'
  | 'export'
  /**
   * P4-36 — the transcript-mode hidden-row reveal (`Chat.jsx:1199-1203`). TWO
   * kinds, not one stateful row, because the glyph vocabulary is keyed by kind
   * alone (`SessionActionIcons.tsx`) and the prototype's control swaps eye ↔
   * eye-off with its state. Exactly one of them is ever present, and only when
   * the session HAS a hidden tier.
   */
  | 'reveal-hidden'
  | 'hide-hidden'
  /**
   * PEER-SESSIONS §6 — the user's standing "don't let peers reopen this session"
   * decision, and the ONE user-side control over the ruling that a peer message
   * may wake a closed session.
   *
   * ONE kind, not the `reveal-hidden`/`hide-hidden` pair: that pair exists
   * because its two states are two different verbs with two different glyphs
   * (show vs hide), while this row is a single standing decision whose state is
   * rendered as a check, not as a relabelled verb. The label must stay constant
   * for that to read as a setting rather than as an action.
   */
  | 'peer-wake-blocked'

/** Menu grouping (dividers between non-empty sections), mirroring the prototype. */
export type SessionActionSection = 'primary' | 'view' | 'transfer'

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
  /**
   * Present iff this row is a TOGGLE that carries its own persisted state, and
   * it is the state itself, never a request. A row without it is an ordinary
   * verb; a row with it renders as a checkable menu item and dispatches the SAME
   * kind either way, so the parent sends the opposite of what it sees here.
   *
   * It exists because a durable decision the user alone can clear
   * (PEER-SESSIONS §6) cannot be a fire-and-forget action: a control that writes
   * persisted state and then cannot show it is a lie about that state.
   */
  checked?: boolean
  /**
   * P4-30 — this row HOSTS a side submenu instead of acting (the prototype's
   * `hasFlyout` Copy row, `SessionActions.jsx:172-182`). A hosting row is never
   * dispatched; only its children are. `enabled` still gates the host, so the
   * whole group carries one honest reason when the transcript is unreadable.
   */
  flyout?: readonly SessionActionItem[]
}

export type SessionActionsContext = {
  /**
   * True when THIS row is the session currently open AND attached in a tab — the
   * only session whose transcript + raw message log the renderer holds. Copy and
   * Inspect-metadata require it; every other verb ignores it.
   */
  isActiveOpen: boolean
  /**
   * The frame-plane answer to whether this row's sidecar can receive a verb.
   * A host row can remain `live` after its supervisor reports a disconnect, so
   * write verbs require both planes to agree. Omitted only by static/test
   * callers that deliberately exercise the row-only contract.
   */
  hasEngine?: boolean
  /** True while this session's persisted transcript is still being written. */
  hasActiveTurn?: boolean
  /**
   * P4-36 — does this session's transcript hold hidden-tier rows
   * (`selectHasHiddenRows`)? The reveal row only exists when it does, matching
   * the prototype's `messages.some(m => m.meta)` guard: no toggle for an empty
   * tier, and no disabled row promising a view that has nothing in it.
   */
  hasHiddenRows?: boolean
  /** P4-36 — is the hidden tier currently revealed for this session? */
  hiddenRevealed?: boolean
}

const DEFER = {
  copyMarkdown:
    'Markdown export is not available yet. Use the plain-text copy below.',
  notLive:
    'Open or restore this session first. Rename and Export run in its live engine, which a closed session has stopped.',
  notOpen:
    'Open this session first. Its transcript is only readable while it is the attached tab.',
  // PEER-SESSIONS §6 — a transcript the app has never opened has nothing to hold
  // this decision, and no peer can name it either, so there is nothing to block.
  // Says the surprising half (why it is moot here), not the obvious half.
  notTracked:
    'Open this session here first. Peers can only reopen sessions opened in this app.',
  exporting:
    'Wait for this response to finish before exporting. The saved transcript is still being updated.',
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
  const openable = row.appSessionId != null && (row.live || row.cwdExists)
  // Rename / Export run inside the session's OWN live engine (the verb is
  // dispatched to its sidecar), so both the host row AND the frame plane must
  // confirm that an engine is reachable. A `disconnected` frame can arrive while
  // the host still describes the row as live; sending in that state only returns
  // an undeliverable result.
  const live = row.live === true && ctx.hasEngine !== false
  const exportable = live && ctx.hasActiveTurn !== true
  // PEER-SESSIONS §6 — is there a row for the user's peer-reopen decision to be
  // written on? `appSessionId` rather than `inRegistry` because the id IS what
  // the write names, so this gates on the argument the dispatch actually needs;
  // the merge sets the two together, so they never disagree.
  const tracked = row.appSessionId != null
  // P4-36 — the reveal changes what the TRANSCRIPT PANE draws, so it is offered
  // only for the row that IS the attached tab (the same reason Copy and
  // Inspect-metadata are active-open gated), and only when that transcript
  // actually holds a hidden tier. Absent rather than disabled: an empty tier has
  // nothing to promise. The prototype hosts this in a chat header; that header
  // was deleted by the 2026-07-12 fidelity correction (`App.tsx:2969-2973`), and
  // the operator placed it here on 2026-07-30.
  const hiddenTier: SessionActionItem[] =
    ctx.isActiveOpen && ctx.hasHiddenRows === true
      ? [
          ctx.hiddenRevealed === true
            ? {
                kind: 'hide-hidden',
                label: 'Hide hidden messages',
                section: 'view',
                enabled: true,
              }
            : {
                kind: 'reveal-hidden',
                label: 'Show hidden messages',
                section: 'view',
                enabled: true,
              },
        ]
      : []
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
              row.inRegistry
                ? 'This workspace is no longer available, so this session cannot be restored.'
                : 'Not restorable from the desktop yet. This session came from terminal history.',
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
      // PEER-SESSIONS §6 — a per-session STANDING DECISION, so it sits in
      // `primary` beside the other things that are true of the session itself,
      // not in `view` (what this window draws) or `transfer` (what leaves it).
      //
      // Deliberately NOT gated on `live`, unlike Rename and Export. Those two
      // dispatch a verb into the session's own running engine and are impossible
      // without one; this writes host-side state about the row and reaches no
      // engine at all. Gating it on live would disable it for exactly the rows it
      // exists for — the parked and closed ones a peer can wake — which is the
      // whole reason §6 asked for it.
      kind: 'peer-wake-blocked',
      label: 'Don’t let peers reopen',
      section: 'primary',
      enabled: tracked,
      checked: row.peerWakeBlocked === true,
      ...(tracked ? {} : { reason: DEFER.notTracked }),
    },
    ...hiddenTier,
    {
      kind: 'metadata',
      label: 'Inspect metadata…',
      section: 'view',
      enabled: ctx.isActiveOpen,
      ...(ctx.isActiveOpen ? {} : { reason: DEFER.notOpen }),
    },
    {
      // P4-30 — the flyout HOST. It carries the group's honest reason and never
      // dispatches; the two variants below are the actionable rows. The
      // plain-text child keeps its own label because the action behind it is the
      // debug export (`App.tsx` `copyForLlm`), not the prototype's readable
      // transcript — calling it "Copy as text" would misdescribe what lands on
      // the clipboard.
      kind: 'copy',
      label: 'Copy',
      section: 'transfer',
      enabled: ctx.isActiveOpen,
      ...(ctx.isActiveOpen ? {} : { reason: DEFER.notOpen }),
      flyout: [
        {
          kind: 'copy-md',
          label: 'Copy as Markdown',
          section: 'transfer',
          enabled: false,
          reason: DEFER.copyMarkdown,
        },
        {
          kind: 'copy-text',
          label: 'Copy transcript for LLM',
          section: 'transfer',
          enabled: ctx.isActiveOpen,
          ...(ctx.isActiveOpen ? {} : { reason: DEFER.notOpen }),
        },
      ],
    },
    {
      // A SIBLING of the Copy group, not a child of it: that group's host is
      // gated on `isActiveOpen` because every child reads the transcript, and
      // these two ids are held by the catalog row itself. Folding them into the
      // flyout would have hidden the ids behind the one gate they do not need,
      // for exactly the rows (a closed or history session) whose ids you most
      // often want.
      //
      // It is also the one unconditionally enabled row in this menu: the merge
      // key guarantees at least one id (`selectRowEngineSessionId`), so there is
      // no state in which it has nothing to answer with. A row missing the OTHER
      // id copies `none` for it, which is the honest value, not a failure.
      kind: 'copy-ids',
      label: 'Copy session ids',
      section: 'transfer',
      enabled: true,
    },
    {
      kind: 'export',
      label: 'Export…',
      section: 'transfer',
      enabled: exportable,
      ...(exportable ? {} : { reason: live ? DEFER.exporting : DEFER.notLive }),
    },
  ]
}

/**
 * The prototype's `hide=['metadata']` for the Sessions-page entry point
 * (`SessionsPage.jsx:656`). The inspector reads the ATTACHED tab, so on a manager
 * page listing every session it would be disabled for all rows but one.
 *
 * A function rather than an inline filter at the mount site (where P4-29 left it),
 * so what the Sessions page actually offers is assertable.
 */
export function selectSessionsPageActions(
  items: readonly SessionActionItem[],
): SessionActionItem[] {
  return items.filter(item => item.kind !== 'metadata')
}

/** The section order the menu renders, so dividers are stable + tested. */
export const SESSION_ACTION_SECTIONS: readonly SessionActionSection[] = [
  'primary',
  'view',
  'transfer',
]

/**
 * P4-30 — `SectionLabel` text per section (`SessionActions.jsx:169`). The
 * The surviving metadata and hidden-message controls are view options, so their
 * section uses a truthful label rather than the obsolete History label.
 */
export const SESSION_ACTION_SECTION_LABELS: Record<
  SessionActionSection,
  string | null
> = {
  primary: null,
  view: 'View',
  transfer: null,
}

/* ------------------------------------------------------------------------- *
 * Pure geometry — where the anchored panel goes (P4-39)
 * ------------------------------------------------------------------------- */

/**
 * The trigger the menu hangs off: the ⋯/⋮ button's rect, or a right-click point
 * (which collapses to a zero-height rect, `top === bottom === clientY`).
 *
 * `left` is the DESIRED left edge, decided by the call site — a button
 * right-aligns the panel to itself (`rect.right - SESSION_ACTIONS_MENU_WIDTH`),
 * a context menu opens rightward from the pointer (`clientX`). The clamp into
 * the viewport is not the call site's job; `placeSessionActionsMenu` owns it.
 */
export type SessionActionsAnchor = {
  /** Viewport y of the trigger's top edge. */
  top: number
  /** Viewport y of the trigger's bottom edge (a pointer repeats `top`). */
  bottom: number
  /** Desired viewport x of the panel's left edge, before clamping. */
  left: number
}

/** Panel width, matching `w-[232px]` on the menu AND the rename popover. */
export const SESSION_ACTIONS_MENU_WIDTH = 232
/** Gap between the trigger edge and the panel, either direction. */
export const SESSION_ACTIONS_MENU_GAP = 4
/** Minimum distance from the viewport's left/right edge (the pre-P4-39 clamp). */
export const SESSION_ACTIONS_VIEWPORT_MARGIN = 8

export type SessionActionsPlacement =
  | { placeAbove: true; bottom: number; left: number }
  | { placeAbove: false; top: number; left: number }

/**
 * Place an anchored panel the way `placeTagPopover`
 * (`sessionsPageState.ts:237-253`) does: a discriminated placement, so the
 * flipped case anchors CSS `bottom` and the panel grows upward, plus a left
 * clamp. Pure, so placement is testable without a DOM.
 *
 * Two differences from that precedent, both because this panel is ~6x taller
 * than the tag popover:
 *
 *  - The flip is decided by whether the panel FITS below, not by a viewport
 *    midpoint. `placeTagPopover`'s midpoint rule would flip a 260px menu opened
 *    at y=410 in an 800px window that has 390px of room below it.
 *  - It prefers below on a tie and only flips when above is genuinely roomier,
 *    so a panel taller than the whole viewport picks the larger side instead of
 *    always flipping off the top.
 *
 * `panelHeight` is an ESTIMATE (`estimateSessionActionsMenuHeight`), never a
 * measurement. Its error budget is soft: it moves the y at which the flip
 * happens and nothing else, because the CSS anchoring does the actual layout.
 */
export function placeSessionActionsMenu(
  anchor: SessionActionsAnchor,
  viewport: { width: number; height: number },
  panelHeight: number,
): SessionActionsPlacement {
  const left = Math.max(
    SESSION_ACTIONS_VIEWPORT_MARGIN,
    Math.min(
      anchor.left,
      viewport.width - SESSION_ACTIONS_MENU_WIDTH - SESSION_ACTIONS_VIEWPORT_MARGIN,
    ),
  )
  const spaceBelow = viewport.height - anchor.bottom - SESSION_ACTIONS_MENU_GAP
  const spaceAbove = anchor.top - SESSION_ACTIONS_MENU_GAP
  if (spaceBelow < panelHeight && spaceAbove > spaceBelow) {
    return {
      placeAbove: true,
      bottom: viewport.height - anchor.top + SESSION_ACTIONS_MENU_GAP,
      left,
    }
  }
  return { placeAbove: false, top: anchor.bottom + SESSION_ACTIONS_MENU_GAP, left }
}

/**
 * Model the menu's height from the rows it is about to render, rather than from
 * the prototype's constant 320 (`SessionActions.jsx:112`) — that constant suits
 * the prototype's row set, fonts and zoom, not this menu's.
 *
 * The numbers below re-state the panel's own Tailwind classes, which is the
 * cost of not measuring: a class change here drifts the model silently. It is
 * paid because the alternative (a ref + `getBoundingClientRect` in a layout
 * effect) makes placement a second render pass and is invisible to this
 * package's SSR-only renderer tests. A few px of error only nudges the flip
 * threshold; it cannot mis-lay-out the panel.
 *
 *  - row: `px-2.5 py-1.5` (12px) + a 15px glyph/label line ≈ 30
 *  - section label: `pt-[7px] pb-[3px]` (10px) + a 9.5px line ≈ 22
 *  - divider: `my-1` (8px) + 1px rule = 9
 *  - panel chrome: `p-1.5` (12px) + 1px border top and bottom = 14
 */
export const SESSION_ACTIONS_ROW_HEIGHT = 30
export const SESSION_ACTIONS_SECTION_LABEL_HEIGHT = 22
export const SESSION_ACTIONS_DIVIDER_HEIGHT = 9
export const SESSION_ACTIONS_PANEL_CHROME_HEIGHT = 14

export function estimateSessionActionsMenuHeight(
  items: readonly SessionActionItem[],
): number {
  const sections = SESSION_ACTION_SECTIONS.filter(section =>
    items.some(item => item.section === section),
  )
  const labelled = sections.filter(
    section => SESSION_ACTION_SECTION_LABELS[section] != null,
  )
  return (
    SESSION_ACTIONS_PANEL_CHROME_HEIGHT +
    items.length * SESSION_ACTIONS_ROW_HEIGHT +
    labelled.length * SESSION_ACTIONS_SECTION_LABEL_HEIGHT +
    Math.max(0, sections.length - 1) * SESSION_ACTIONS_DIVIDER_HEIGHT
  )
}

/**
 * The rename popover is ONE input in the same panel chrome, so it gets its own
 * height instead of the menu's: sharing the menu's would flip it hundreds of px
 * early, off an edge it clears easily. `p-1.5` (12) + border (2) + the input's
 * `py-1.5` + border + 12.5px line ≈ 44.
 */
export const SESSION_RENAME_POPOVER_HEIGHT = 44
