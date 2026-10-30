import type { QueuedPromptItem } from '../../shared/protocol.js'

export function RecoveredInputReview({ inputs, total, onReview, onRemove }: {
  inputs: readonly QueuedPromptItem[]
  total: number
  onReview?: ((id: string) => void) | null
  onRemove?: ((id: string) => void) | null
}) {
  if (total === 0 && inputs.length === 0) return null
  const remainder = Math.max(0, total - inputs.length)
  return (
    <section aria-label="Recovered inputs for review" className="mx-auto flex w-full max-w-[var(--transcript-width)] flex-col gap-2 px-8 py-3">
      <div className="flex items-center gap-2 text-xs">
        <h3 className="font-medium text-text-primary">Recovered inputs</h3>
        <span className="rounded border border-shell-seam px-1.5 py-0.5 text-text-subtle">Delivery unknown</span>
      </div>
      <p className="text-xs text-text-subtle">These saved inputs are not queued and will not be sent automatically.</p>
      <p className="text-xs text-text-subtle">Copying to a draft keeps the saved input here until you remove it.</p>
      <ul className="flex flex-col gap-2">
        {inputs.map(input => (
          <li key={input.id} className="flex items-start gap-3 rounded-md border border-shell-seam px-3 py-2">
            <p id={`recovered-input-${input.id}`} className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm text-text-primary">{input.text || 'Image input'}</p>
            <button type="button" aria-describedby={`recovered-input-${input.id}`} disabled={!onReview}
              className="shrink-0 rounded px-2 py-1 text-xs text-text-subtle transition-colors hover:text-text-primary disabled:opacity-50"
              onClick={() => onReview?.(input.id)}>Copy to draft</button>
            <button type="button" aria-describedby={`recovered-input-${input.id}`} disabled={!onRemove}
              className="shrink-0 rounded px-2 py-1 text-xs text-text-subtle transition-colors hover:text-text-primary disabled:opacity-50"
              onClick={() => onRemove?.(input.id)}>Remove from review</button>
          </li>
        ))}
      </ul>
      {remainder > 0 ? (
        <p role="status" className="text-xs text-text-subtle">
          {inputs.length > 0
            ? `${remainder} more saved inputs are not shown. Removing listed inputs loads the next group. Larger inputs remain in the saved session files.`
            : `${remainder} saved inputs are not shown. Close and reopen this chat to reload them, or inspect the saved session files for inputs beyond review limits.`}
        </p>
      ) : null}
    </section>
  )
}
