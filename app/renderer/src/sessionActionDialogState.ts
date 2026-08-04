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

import type { SaveTextResult } from '../../shared/hostApi'
import type { SessionActionResultFrame } from '../../shared/protocol'

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
 * P4-35 — what the user is told after a save attempt, or nothing at all.
 *
 * `null` is the load-bearing case: a DISMISSED save dialog is the user changing
 * their mind, and toasting "cancelled" back at them restates the state they just
 * chose. Only an outcome that could surprise them earns a line.
 *
 * The failure text is main's own (`validateSaveTextRequest` / the write catch), so
 * a reason the renderer cannot know is never guessed at here. Counts are supplied
 * by the caller: a single export says nothing about how many sessions it held.
 */
export function describeSaveOutcome(
  result: SaveTextResult,
  savedMessage: string,
): { message: string; tone: 'success' | 'warn' } | null {
  if (result.ok) {
    return result.saved ? { message: savedMessage, tone: 'success' } : null
  }
  return { message: result.error.message, tone: 'warn' }
}

/** One session's leg of a bulk export, as the renderer dispatched it. */
export type BulkExportRequest = {
  sessionId: string
  /** The id THIS renderer minted for that session's `session.export` verb. */
  requestId: string
  title: string | null
}

/** Where a bulk export has got to. `waiting` while any leg is unsettled. */
export type BulkExportOutcome =
  | { status: 'waiting' }
  | {
      status: 'settled'
      sections: readonly { title: string | null; text: string }[]
      /** Legs the sidecar could not render. Reported, never written to the file. */
      failed: number
    }

/**
 * P4-35 — fold N per-session export results into one outcome.
 *
 * Every leg is matched by the `requestId` this renderer minted for it, through the
 * same `selectExportPreview` a single dialog uses (T5a-analog), so an unrelated
 * rename or branch result landing mid-flight cannot be mistaken for an export.
 * That matters more here than in the dialog: the runtime state keeps only the
 * LATEST result per session, and a bulk export is one verb per session, so each
 * session's slot holds exactly this export until something else overwrites it.
 *
 * Two settle-failure shapes, kept distinct on purpose:
 *
 *  - the slot holds an explicit `null`, which is the reducer recording a lifecycle
 *    reset on that session (its engine died). The transcript is not coming, so the
 *    leg counts as FAILED rather than hanging the file forever;
 *  - the slot holds someone ELSE's result, or nothing yet. That reads as pending
 *    and holds the whole outcome at `waiting`, because the alternative is silently
 *    saving a partial file and calling it complete. The caller owns giving up.
 */
export function selectBulkExportOutcome(
  requests: readonly BulkExportRequest[],
  resultBySession: Readonly<
    Record<
      string,
      | Pick<
          SessionActionResultFrame,
          'requestId' | 'verb' | 'ok' | 'message' | 'exportText'
        >
      | null
      | undefined
    >
  >,
): BulkExportOutcome {
  const sections: { title: string | null; text: string }[] = []
  let failed = 0
  for (const request of requests) {
    const slot = resultBySession[request.sessionId]
    // An explicit null is the lifecycle reset, not an absent key: that session's
    // engine is gone, so waiting on it would strand every other leg with it.
    if (slot === null) {
      failed += 1
      continue
    }
    const preview = selectExportPreview(slot ?? null, request.requestId)
    if (preview.status === 'pending') return { status: 'waiting' }
    if (preview.status === 'failed') failed += 1
    else sections.push({ title: request.title, text: preview.text })
  }
  return { status: 'settled', sections, failed }
}

/**
 * What the user is told after a bulk export was written. Says how many sessions
 * landed in the file, and names the shortfall only when there IS one.
 */
export function bulkExportSavedMessage(exported: number, failed: number): string {
  const sessions = (count: number) => `${count} session${count === 1 ? '' : 's'}`
  return failed === 0
    ? `Saved ${sessions(exported)} to one file`
    : `Saved ${exported} of ${sessions(exported + failed)}: the rest could not be read`
}

/**
 * P4-35 — one file out of several sessions' transcripts, because a save dialog
 * names ONE destination and ten transcripts cannot go to the clipboard.
 *
 * §0 ADAPTED. The prototype's bulk Export is a mock toast with no destination at
 * all (`SessionsPage.jsx:626` → `runAction('export')`), so any real behaviour is
 * an adaptation; this is the smallest one that uses the real verb. Each section is
 * the sidecar's own `renderMessagesToPlainText` output, untouched, under a heading
 * carrying the session's real title. A session whose export FAILED is omitted
 * rather than represented by its error text: a file of error messages is not an
 * export, and the caller reports the shortfall instead.
 */
export function buildBulkExportDocument(
  sections: readonly { title: string | null; text: string }[],
): string {
  return sections
    .map(section => `=== ${section.title?.trim() || 'Untitled session'} ===\n\n${section.text}`)
    .join('\n\n')
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
