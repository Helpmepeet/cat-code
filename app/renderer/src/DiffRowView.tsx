import type { ReactNode } from 'react'
import { highlightedWordSegments } from './diffHighlight.js'
import type { DiffRow, WordDiffSide } from './diffRowModel.js'
import { DIFF_ROW_CLASS, DIFF_SIGN_CLASS, WORD_DIM_CLASS, WORD_EMPH_CLASS } from './toolCardPalette.js'

/** A diff paints snippet rows without pretending they have file line numbers. */
export function DiffRowView({
  row,
  body,
  segments,
  showLineNumber = true,
}: {
  row: DiffRow | undefined
  body: ReactNode
  segments: WordDiffSide | null
  showLineNumber?: boolean
}) {
  if (row === undefined) return null
  const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '
  const side = row.kind === 'del' ? 'del' : 'add'
  const painted = segments === null
    ? body
    : highlightedWordSegments([body], segments, WORD_EMPH_CLASS[side], WORD_DIM_CLASS[side])
  if (!showLineNumber) {
    return (
      <div className={`edit-permission-diff-row ${DIFF_ROW_CLASS[row.kind]}`}>
        <span className={`edit-permission-diff-sign ${DIFF_SIGN_CLASS[row.kind]}`}>{sign}</span>
        <span className="edit-permission-diff-source hljs">{painted}</span>
      </div>
    )
  }
  return (
    <div className={`flex ${DIFF_ROW_CLASS[row.kind]}`}>
      <span className="w-[26px] shrink-0 select-none pr-[7px] text-right tabular-nums text-text-ghost">
        {row.currentLabel}
      </span>
      <span className="min-w-0 flex-1 border-l border-white/[0.05] pl-2.5 pr-3.5 hljs">
        <span className={DIFF_SIGN_CLASS[row.kind]}>{sign}</span>{' '}
        {painted}
      </span>
    </div>
  )
}
