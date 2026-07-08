/**
 * Resume-flow presentation (P4-16) — adapts prototype `ResumeStates.jsx`
 * (`CrossProjectResumeDialog` + `HydrationOverlay`) as a thin visualization
 * layer over the REAL synchronous restore machinery
 * (`host.restoreSession` → `sessionResume.ts`, RESTORE-HISTORY.md F1/F2). No
 * new resume path: both components are pure presentation, driven by
 * `resumeDialogState.ts` around App.tsx's single `bridge.restoreSession` call.
 *
 * Adaptations from source (PARITY-LEDGER.md §28 / FLOW-7):
 *  - The dialog is reframed from a "different project" WARNING into a plain
 *    restore CONFIRM, because desktop always resumes a row in its OWN cwd
 *    (D1 one-cwd-per-session — `host.ts:283` re-validates `row.cwd`, never a
 *    "current" cwd). The from→to badges only render when the row picked
 *    really does differ from the currently active tab's cwd — a real,
 *    source-backed comparison, not the prototype's always-shown warning.
 *  - "What will differ" (MCP/plugins/permission diff rows) is CUT: the engine
 *    computes no such diff on resume (`crossProjectResume.ts` is directory-only).
 *  - The `cd … && claude --resume …` copy-command escape hatch is CUT: it is a
 *    TUI-flow affordance (`ResumeConversation.tsx`), not applicable to the
 *    desktop path which restores in-app via `host.restoreSession`.
 *  - HydrationOverlay's failed state describes the real fail-loud posture
 *    (`SidecarResumeError`, `sessionResume.ts:33`) via the `message` prop —
 *    the prototype's copy is the fallback when no message is given.
 */
import { useEffect } from 'react'
import { basename } from './pathUtils.js'

export type ResumeDialogKeyAction = 'confirm' | 'cancel'

/** Pure keyboard mapping (mirrors `permissionActionForKey`) — Enter confirms, Escape cancels. */
export function resumeDialogActionForKey(event: {
  key: string
}): ResumeDialogKeyAction | null {
  if (event.key === 'Enter') return 'confirm'
  if (event.key === 'Escape') return 'cancel'
  return null
}

/** The confirm step reached by picking a restorable row (Sidebar offer / palette). */
export function ResumeConfirmDialog({
  title,
  cwd,
  currentCwd,
  onConfirm,
  onClose,
}: {
  title: string
  cwd: string
  /** The active tab's cwd, if any — only source of the from→to comparison. */
  currentCwd?: string
  onConfirm: () => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = resumeDialogActionForKey(event)
      if (action === 'confirm') onConfirm()
      else if (action === 'cancel') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onConfirm, onClose])

  const crossProject = currentCwd !== undefined && currentCwd !== cwd

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4"
      onMouseDown={onClose}
    >
      <div
        aria-label="Resume session"
        aria-modal="true"
        className="w-full max-w-[480px] overflow-hidden rounded-2xl border border-shell-seam bg-shell-chrome shadow-[0_24px_70px_rgba(0,0,0,0.6)]"
        onMouseDown={event => event.stopPropagation()}
        role="dialog"
      >
        <div className="flex items-start gap-3 px-5 pb-3.5 pt-4">
          <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] bg-tone-warn/10 text-tone-warn">
            <WarnIcon />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-text-primary">
              {crossProject ? 'Resume from a different project?' : 'Resume session?'}
            </div>
            <div className="mt-0.5 text-xs leading-relaxed text-text-muted">
              <span className="font-medium text-text-primary/90">{title}</span>{' '}
              {crossProject
                ? 'was started in another directory. Resuming here re-spawns it in its own project.'
                : 'will re-spawn the engine and replay its saved transcript.'}
            </div>
          </div>
        </div>

        {crossProject ? (
          <div className="mx-5 mb-3 flex items-center gap-2.5 rounded-[9px] border border-shell-seam bg-text-primary/[0.025] px-3 py-2.5">
            <ProjBadge path={cwd} tone="warn" />
            <ArrowIcon />
            <ProjBadge path={currentCwd} tone="ok" />
          </div>
        ) : (
          <div className="mx-5 mb-3 rounded-[9px] border border-shell-seam bg-text-primary/[0.025] px-3 py-2.5 font-mono text-[11px] text-text-subtle">
            {cwd}
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-shell-seam bg-text-primary/[0.012] px-5 py-3">
          <button
            className="rounded-lg border border-shell-seam px-3.5 py-1.5 text-xs text-text-muted"
            onClick={onClose}
            type="button"
          >
            Cancel <span className="ml-0.5 text-text-subtle">Esc</span>
          </button>
          <button
            className="rounded-lg bg-accent px-3.5 py-1.5 text-xs font-semibold text-app-bg"
            onClick={onConfirm}
            type="button"
          >
            Resume here <span className="ml-0.5 opacity-60">⏎</span>
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Visualizes the real synchronous replay (`replay:true` frames,
 * RESTORE-HISTORY.md F2) as a loading/failed overlay. `state==='hydrating'`
 * covers the restore attach/replay window (there is no discrete engine-side
 * hydration ENUM to bind to — the ledger's SOURCE note: `ResumeStates.jsx:24`);
 * `'failed'` surfaces the real fail-loud error text.
 */
export function HydrationOverlay({
  state,
  sessionTitle,
  message,
  onRetry,
  onDismiss,
}: {
  state: 'hydrating' | 'failed'
  sessionTitle: string
  /** The real host/sidecar failure text (`hostErrorMessage`/thrown error). */
  message?: string
  onRetry: () => void
  onDismiss: () => void
}) {
  const failed = state === 'failed'
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-[rgba(9,9,11,0.72)] backdrop-blur-sm">
      <div
        aria-live="polite"
        className={
          'flex max-w-[340px] flex-col items-center gap-3 rounded-2xl border bg-surface-raised px-7 py-6 text-center shadow-[0_20px_60px_rgba(0,0,0,0.6)] ' +
          (failed ? 'border-tone-danger/25' : 'border-shell-seam')
        }
        role="status"
      >
        {failed ? (
          <>
            <div className="flex h-[38px] w-[38px] items-center justify-center rounded-full bg-tone-danger/10 text-tone-danger">
              <AlertIcon />
            </div>
            <div>
              <div className="mb-1 text-sm font-semibold text-tone-danger">
                Couldn&rsquo;t resume session
              </div>
              <div className="text-xs leading-relaxed text-text-muted">
                {message ??
                  'The transcript log failed to deserialize. The file may be corrupt or from an incompatible version.'}
              </div>
            </div>
            <div className="mt-0.5 flex gap-2">
              <button
                className="rounded-lg bg-accent px-3.5 py-1.5 text-xs font-semibold text-app-bg"
                onClick={onRetry}
                type="button"
              >
                Retry
              </button>
              <button
                className="rounded-lg border border-shell-seam px-3.5 py-1.5 text-xs text-text-muted"
                onClick={onDismiss}
                type="button"
              >
                Start fresh
              </button>
            </div>
          </>
        ) : (
          <>
            <div
              aria-hidden="true"
              className="h-[30px] w-[30px] animate-spin rounded-full border-[2.5px] border-accent/25 border-t-accent"
            />
            <div className="text-[13px] text-text-muted">
              Resuming{' '}
              <span className="font-semibold text-text-primary">
                {sessionTitle}
              </span>
              …
            </div>
            <div className="text-[11px] text-text-subtle">
              Hydrating transcript from log
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function ProjBadge({ path, tone }: { path: string; tone: 'warn' | 'ok' }) {
  const toneClass = tone === 'warn' ? 'text-tone-warn' : 'text-accent-soft'
  const label = basename(path) || path
  return (
    <div className="min-w-0 flex-1">
      <div
        className={`flex items-center gap-1 truncate font-mono text-[11px] font-semibold ${toneClass}`}
      >
        <FolderIcon />
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-0.5 truncate font-mono text-[10px] text-text-subtle">
        {path}
      </div>
    </div>
  )
}

function WarnIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="18"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2.2"
      viewBox="0 0 24 24"
      width="18"
    >
      <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    </svg>
  )
}

function AlertIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="20"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2.2"
      viewBox="0 0 24 24"
      width="20"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" x2="12" y1="8" y2="12" />
      <line x1="12" x2="12.01" y1="16" y2="16" />
    </svg>
  )
}

function ArrowIcon() {
  return (
    <svg
      aria-hidden="true"
      className="shrink-0 text-text-subtle"
      fill="none"
      height="16"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="16"
    >
      <line x1="5" x2="19" y1="12" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  )
}

/** Folder glyph — same source-approved shape as WorkspacePanels' project pill. */
function FolderIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="9"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2.4"
      viewBox="0 0 24 24"
      width="9"
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  )
}
