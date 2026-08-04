/**
 * P4-30 — `BranchDialog` + `ExportDialog` (`SessionActions.jsx:280-303` and
 * `:351-387`), the confirmation/preview layer PARITY-LEDGER §17 recorded as
 * dropped with no §0 flag. P4-35 (operator ruling 2026-07-30) then wired
 * **Download**, which P4-30 had to ship disabled: `saveTextToFile` now exists, so
 * Export finally reaches a file instead of only the clipboard.
 *
 * What each one is FOR, in this app rather than in the prototype:
 *
 *  - **Branch** closes a live defect. `session.branch` runs the engine's own
 *    `createFork` and writes a real fork transcript on disk; before this dialog
 *    it fired straight off a menu click with no gate at all. The dialog IS the
 *    gate: nothing is dispatched until `onConfirm`.
 *  - **Export** turns a fire-and-forget verb into what the prototype shows: the
 *    engine-rendered transcript on screen, with its own file name, before the
 *    user does anything with it. The text is NOT re-derived here; it is the
 *    `exportText` the sidecar rendered with `renderMessagesToPlainText` and sent
 *    back on `session-action.result`, matched by the dialog's own `requestId`.
 *
 * THREE §0 deviations are carried by this file, each recorded on the ledger row
 * it belongs to (they are PROPOSALS to the operator, not closures, and PARITY-
 * LEDGER Part C counts the same three):
 *
 *  1. **No message count in the Export subtitle.** The prototype shows
 *     "N messages · title". `MergedSessionRow.messageCount` cannot supply it: the
 *     bounded catalog loader never populates it (`sessionsCatalogState.ts:374`),
 *     so every session would read "0 messages".
 *  2. **No format segmented control.** md/json remain the owner-flagged §0 defer
 *     (`sessionActions.ts:20-21`); the engine renders text only, so there is one
 *     format and nothing to segment.
 *  3. **Branch preview describes the naming rule, not a guessed name** — see
 *     `branchPreviewLines`.
 */
import type { ReactNode } from 'react'
import { SAButton, SAModal } from './SAModal.js'
import { ActionBranchIcon, ActionExportIcon } from './SessionActionIcons.js'
import {
  branchPreviewLines,
  type ExportPreviewState,
} from './sessionActionDialogState.js'

/**
 * Confirm a fork before it happens. Presentation only: `onConfirm` is what
 * dispatches `session.branch`, so a Cancel or a dismissal leaves the transcript
 * completely untouched.
 */
export function BranchDialog({
  title,
  onConfirm,
  onClose,
}: {
  title: string | null
  onConfirm: () => void
  onClose: () => void
}): ReactNode {
  const preview = branchPreviewLines(title)
  return (
    <SAModal
      icon={<ActionBranchIcon />}
      tint="info"
      title="Branch session"
      subtitle="Fork a copy of this conversation"
      onClose={onClose}
      footer={
        <>
          <SAButton label="Cancel" onClick={onClose} />
          <SAButton label="Create branch" variant="primary" onClick={onConfirm} />
        </>
      }
    >
      <SectionLabel>What happens</SectionLabel>
      <div className="rounded-[10px] border border-tone-info/[0.18] bg-tone-info/[0.06] px-[13px] py-[11px]">
        <div className="flex items-center gap-2 text-[12.5px] text-tone-info">
          <span className="flex shrink-0">
            <ActionBranchIcon />
          </span>
          <span className="min-w-0 truncate font-semibold">
            {preview.headline}
          </span>
        </div>
        <div className="mt-[5px] pl-[23px] text-[11.5px] text-text-subtle">
          {preview.detail}
        </div>
      </div>
    </SAModal>
  )
}

/**
 * Show the engine-rendered transcript with its file name before it goes
 * anywhere. `preview` is the projection of THIS dialog's own export result
 * (`selectExportPreview`); `fileName` is derived from the session title.
 *
 * Copy and Download are the same shape: both stay disabled with the same honest
 * reason until a transcript has actually arrived, so neither is ever a button
 * that appears live and does nothing. `fileName` is a SUGGESTION main sanitizes
 * and the user overrides in the save dialog, never a destination (HC1).
 */
export function ExportDialog({
  title,
  fileName,
  preview,
  onCopy,
  onDownload,
  onClose,
}: {
  title: string | null
  fileName: string
  preview: ExportPreviewState
  /** Undefined until the transcript has arrived, which disables Copy. */
  onCopy?: () => void
  /** Undefined until the transcript has arrived, which disables Download. */
  onDownload?: () => void
  onClose: () => void
}): ReactNode {
  const waiting = { disabled: true, reason: 'The transcript is still rendering.' }
  return (
    <SAModal
      icon={<ActionExportIcon />}
      tint="accent"
      title="Export session"
      {...(title ? { subtitle: title } : {})}
      width="wide"
      onClose={onClose}
      footer={
        <>
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-text-faint">
            {fileName}
          </span>
          <SAButton
            label="Copy"
            {...(preview.status === 'ready' && onCopy
              ? { onClick: onCopy }
              : waiting)}
          />
          <SAButton
            label="Download"
            variant="primary"
            {...(preview.status === 'ready' && onDownload
              ? { onClick: onDownload }
              : waiting)}
          />
        </>
      }
    >
      <SectionLabel>Transcript</SectionLabel>
      <div className="max-h-[300px] overflow-y-auto rounded-[10px] border border-shell-seam bg-app-bg px-[15px] py-[13px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {preview.status === 'ready' ? (
          <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[11.5px] leading-[1.65] text-text-muted">
            {preview.text}
          </pre>
        ) : (
          <div className="py-6 text-center text-[12px] text-text-subtle">
            {preview.status === 'failed'
              ? preview.message
              : 'Rendering this session, one moment.'}
          </div>
        )}
      </div>
    </SAModal>
  )
}

/** `SectionLabel` (`SessionActions.jsx:144-146`), the dialog-body variant. */
function SectionLabel({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="mb-[9px] text-[11px] font-bold uppercase tracking-[0.06em] text-text-faint">
      {children}
    </div>
  )
}
