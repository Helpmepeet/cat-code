/**
 * P4-30 — the pure decision core behind the Branch / Export dialogs
 * (`SessionActions.jsx` `BranchDialog` `:280-303`, `ExportDialog` `:351-387`).
 *
 * Everything here is a function of data the app already holds, kept OUT of the
 * `.tsx` files for two reasons: the renderer's Fast Refresh boundary (CLAUDE.md
 * §3) and the fact that the `app/` test harness is SSR-only, so a keyboard or
 * derivation rule is only really provable as a pure unit (the `tasksState.ts` /
 * `tasksDialogKeyAction` precedent).
 *
 * Nothing here invents a field. Where the prototype shows a value the desktop
 * cannot derive, the helper returns the honest shape instead and the §0 flag is
 * recorded on the calling component.
 */

import type { SessionActionResultFrame } from '../../shared/protocol'

/** What a keypress means to an open dialog. */
export type SessionActionModalKey = 'close' | null

/**
 * Escape closes; a modifier chord belongs to the app, not to the dialog (so ⌘K
 * still reaches the command palette while a dialog is open — the same bail
 * `tasksDialogKeyAction` makes).
 */
export function sessionActionModalKeyAction(event: {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
}): SessionActionModalKey {
  if (event.metaKey || event.ctrlKey || event.altKey) return null
  return event.key === 'Escape' ? 'close' : null
}

/**
 * The export's suggested file name (`SessionActions.jsx:356` — slugified title +
 * extension), shown in the dialog footer.
 *
 * §0 ADAPTED — the prototype offers `.md`/`.json`. The engine has exactly ONE
 * transcript render path, `renderMessagesToPlainText`
 * (`src/utils/exportRenderer.tsx:91`), and md/json are the owner-flagged §0
 * defer this session did not lift, so the honest extension is `.txt`. The
 * slug rule itself is the prototype's, unchanged.
 *
 * An empty/symbol-only title degrades to `session` rather than a bare extension.
 */
export function exportFileName(
  title: string | null | undefined,
  extension = 'txt',
): string {
  const slug = (title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return `${slug || 'session'}.${extension}`
}

/** What the Export dialog is showing right now. */
export type ExportPreviewState =
  | { status: 'pending' }
  | { status: 'ready'; text: string }
  | { status: 'failed'; message: string }

/**
 * Project the session's latest `session-action.result` into the dialog's view,
 * matched by the `requestId` the dialog itself minted (T5a-analog). A result for
 * a DIFFERENT request (an older export, or a rename/branch that finished while
 * this dialog was open) leaves the dialog pending — it must never show another
 * action's outcome as its own.
 */
export function selectExportPreview(
  // Derived from the wire contract, not a restated shape: the verb union grows
  // (P4-29 added `tag`) and a hand-copied literal silently rots until a merge
  // exposes it. Picked rather than taking the whole frame, so this stays a pure
  // selector over the payload and callers need not build an envelope.
  result: Pick<
    SessionActionResultFrame,
    'requestId' | 'verb' | 'ok' | 'message' | 'exportText'
  > | null,
  requestId: string,
): ExportPreviewState {
  if (!result || result.requestId !== requestId || result.verb !== 'export') {
    return { status: 'pending' }
  }
  if (!result.ok) return { status: 'failed', message: result.message }
  if (result.exportText === undefined) {
    // ok with no text is not a shape the sidecar produces, but display degrades
    // gracefully rather than rendering an empty pane as a successful export.
    return { status: 'failed', message: result.message }
  }
  return { status: 'ready', text: result.exportText }
}

/** A resolved export preview, remembered against the dialog that asked for it. */
export type LatchedExportPreview = {
  requestId: string
  state: ExportPreviewState
}

/**
 * Read the latched preview for THIS dialog.
 *
 * Why a latch exists at all: `sessionActionRuntimeState` keeps only the LATEST
 * result per session, by design. Without this, a rename or branch result landing
 * while the Export dialog is open makes the export result no longer latest, so
 * `selectExportPreview` returns pending again, the rendered transcript blanks
 * back to "Rendering this session, one moment." and Copy re-disables forever.
 * Once a result for this `requestId` has arrived it is kept.
 *
 * Keyed by `requestId` rather than by session so a SECOND export opens pending
 * instead of flashing the previous export's transcript.
 */
export function selectLatchedExportPreview(
  latched: LatchedExportPreview | null,
  requestId: string,
): ExportPreviewState {
  return latched && latched.requestId === requestId
    ? latched.state
    : { status: 'pending' }
}

/**
 * The Branch dialog's confirmation callout (`SessionActions.jsx:292-300`).
 *
 * §0 ADAPTED, and this is the row where the prototype and the engine genuinely
 * disagree. The prototype previews a from-message-N fork: a new name
 * `"<title> (branch)"` and "keeps 1–N, drops the M after it". The engine's
 * `createFork` (`src/commands/branch/branch.ts:61`) forks the WHOLE conversation
 * at HEAD, so:
 *
 *  - there is no keeps/drops split to preview: nothing is dropped;
 *  - the new name is NOT `"<title> (branch)"`. The sidecar names the fork
 *    `` `${deriveFirstPrompt(firstUser)} (Branch)` ``
 *    (`app/sidecar/sessionActionsDomain.ts:97-99`), i.e. from the fork's first
 *    USER message, which no frame carries to the renderer before the action
 *    runs. Printing the prototype's string would be inventing a name the user
 *    will not see, so the callout describes the naming RULE instead of guessing
 *    the result.
 */
export function branchPreviewLines(title: string | null | undefined): {
  headline: string
  detail: string
} {
  const shown = (title ?? '').trim()
  return {
    headline: shown
      ? `A full copy of "${shown}"`
      : 'A full copy of this session',
    detail:
      'Every message is copied and this session stays untouched. The copy is named after its first prompt, so it will not carry this name.',
  }
}
