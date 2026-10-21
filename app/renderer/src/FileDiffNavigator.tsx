import { useState, type ReactNode } from 'react'
import type { ToolDiffProjection } from './transcriptProjector.js'

const OPERATION_LABEL = { update: 'Modified', add: 'Added', delete: 'Deleted' } as const

/** One mounted diff, regardless of how many files the retained patch contains. */
export function FileDiffNavigator({
  diffs,
  initialFileIndex = 0,
  showPath = true,
  barClassName = 'mb-2',
  bodyClassName,
  renderDiff,
}: {
  diffs: readonly ToolDiffProjection[]
  initialFileIndex?: number
  showPath?: boolean
  barClassName?: string
  bodyClassName?: string
  renderDiff: (diff: ToolDiffProjection, index: number) => ReactNode
}): ReactNode {
  const [fileIndex, setFileIndex] = useState(initialFileIndex)
  const selectedIndex = Math.min(Math.max(fileIndex, 0), Math.max(diffs.length - 1, 0))
  const diff = diffs[selectedIndex]
  if (!diff) return null
  const multiple = diffs.length > 1
  const buttonClass = 'h-6 shrink-0 rounded border border-shell-seam px-2 text-text-muted hover:text-text-primary disabled:opacity-30'
  return (
    <>
      {multiple || showPath || diff.operation ? (
        <div className={`${barClassName} flex min-w-0 items-center gap-2 font-mono text-[11px] text-text-muted`}>
          {multiple ? (
            <>
              <button type="button" aria-label="Previous file" className={buttonClass}
                disabled={selectedIndex === 0} onClick={() => setFileIndex(selectedIndex - 1)}>‹</button>
              <input type="number" aria-label="File number" min={1} max={diffs.length}
                value={selectedIndex + 1}
                onChange={event => {
                  const value = event.currentTarget.valueAsNumber
                  if (Number.isSafeInteger(value) && value >= 1 && value <= diffs.length) {
                    setFileIndex(value - 1)
                  }
                }}
                className="h-6 w-12 shrink-0 rounded border border-shell-seam bg-transparent px-1 text-center tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent" />
              <span className="shrink-0 tabular-nums">/ {diffs.length}</span>
              <button type="button" aria-label="Next file" className={buttonClass}
                disabled={selectedIndex === diffs.length - 1} onClick={() => setFileIndex(selectedIndex + 1)}>›</button>
            </>
          ) : null}
          {diff.operation ? <span className="shrink-0 text-text-subtle">{OPERATION_LABEL[diff.operation]}</span> : null}
          {showPath ? <span className="min-w-0 truncate" title={diff.filePath}>{diff.filePath}</span> : null}
        </div>
      ) : null}
      <div key={`${selectedIndex}:${diff.filePath}`} className={bodyClassName}>{renderDiff(diff, selectedIndex)}</div>
    </>
  )
}
