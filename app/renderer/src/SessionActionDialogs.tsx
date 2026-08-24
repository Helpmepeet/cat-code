/**
 * The Export confirmation/preview layer. It shows the engine-rendered transcript
 * and supports the existing clipboard and main-owned file sinks.
 */
import type { ReactNode } from 'react'
import { SAButton, SAModal } from './SAModal.js'
import { ActionExportIcon } from './SessionActionIcons.js'
import type { ExportPreviewState } from './sessionActionDialogState.js'

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
