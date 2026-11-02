import { useEffect, useRef, useState } from 'react'
import type { PromptDraftProtection } from './promptDraftPersistence.js'

export function DraftProtectionNotice({ protection, olderCopy, onRetry }: {
  protection: PromptDraftProtection | null
  olderCopy: boolean
  onRetry(): void
}) {
  const text = protection?.text ?? ''
  const currentText = useRef(text)
  currentText.current = text
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => { setCopyState('idle') }, [text])

  if (!protection || protection.status === 'saved') {
    return olderCopy ? (
      <p role="status" aria-label="Older draft restored" className="mx-1 mb-2 text-[11px] text-text-subtle">
        Restored an older copy. Your last changes to this draft were not saved.
      </p>
    ) : null
  }

  const message = protection.reason === 'length'
    ? 'This draft is too long to keep if the app closes. Send it or copy it first.'
    : protection.reason === 'capacity'
      ? 'This draft cannot be kept if the app closes. Send it or copy it first.'
      : 'This draft could not be saved. Copy it before closing the app.'
  return (
    <div role="status" aria-label="Draft saving" className="mx-1 mb-2 flex flex-wrap items-center gap-3 rounded-md border border-tone-warn/30 bg-tone-warn/[0.06] px-3 py-2 text-[12px] text-text-muted">
      <span className="min-w-0 flex-1">{message}</span>
      <button type="button" className="shrink-0 rounded border border-shell-seam px-2.5 py-1 font-medium text-text-primary hover:bg-shell-hover" onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          if (currentText.current === text) setCopyState('copied')
        } catch {
          if (currentText.current === text) setCopyState('failed')
        }
      }}>{copyState === 'copied' ? 'Copied' : 'Copy draft'}</button>
      {protection.reason === 'storage' ? (
        <button type="button" className="shrink-0 rounded border border-shell-seam px-2.5 py-1 font-medium text-text-primary hover:bg-shell-hover" onClick={onRetry}>Try again</button>
      ) : null}
      {copyState === 'failed' ? <span className="w-full">Could not copy. Select and copy the draft in the composer.</span> : null}
    </div>
  )
}
