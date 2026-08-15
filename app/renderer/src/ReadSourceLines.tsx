/**
 * The gutter-beside-source ROWS: a file READ (numbered), a file WRITE
 * (`+`-prefixed) and a search hit (`path:line:`). All three are prototype
 * bodies whose every line goes through its own `hl()`
 * (`~/catcode_prototype/cat-app/Messages.jsx:598-607`, `:624-630`, `:695`), and
 * all three share the type and the two-cell geometry below.
 *
 * WHY A HIGHLIGHTER AND NOT THE PROTOTYPE'S `hl()`. The prototype hand-rolls a
 * regex colorer with a fixed One-Dark-ish palette and says so
 * (`Messages.jsx:1725` "GUI equivalent, not the same lib"). Porting that here
 * would paint a sixth palette that the Settings code-theme picker cannot reach.
 * The source is tokenized by `rehype-highlight` instead, so it emits the same
 * `hljs-*` classes a fenced block in the transcript already emits and takes
 * whichever of the five themes the operator picked, with no prop and no
 * re-render (`CodeThemeProvider` / `theme.css`).
 *
 * WHY ROWS AND NOT TWO COLUMNS (CC-62). These used to be a gutter column beside
 * a source column, because one highlighter parse returns ONE tree whose
 * newlines live inside spans and the tree could not be cut into rows. It can
 * now: `sourceHighlight.ts` cuts the tree by line before React sees it, the
 * same operation `diffHighlight.ts` performs for the diff body. Rows are what
 * the line virtualizer needs, and they end the head/tail double parse the
 * two-column shape forced, which tokenized a token opened in the head and
 * closed in the tail against two different fences.
 *
 * `body` is a ReactNode so the caller passes either the coloured row or the
 * plain, already-bounded string the virtualizer handed it. Neither path mounts
 * more than one line.
 *
 * The type, size and leading are set once on the caller's scroll box and
 * inherited, which is also what makes the wrap mode part of that box's class
 * list rather than each row's (`ToolInspector.tsx` says why that matters to the
 * measured geometry).
 */

import type { ReactNode } from 'react'

/** `min-w-8` rather than `w-8`: these are real file lines now, so a read deep
 * into a large file can need more than four digits. */
const GUTTER_CLASS =
  'mr-3 min-w-8 shrink-0 select-none text-right tabular-nums text-text-subtle/60'

/**
 * The source cell. `hljs` supplies the selected theme's base colour and its
 * token rules colour the spans inside; `theme.css` gives `.hljs` a colour and
 * nothing else, so carrying it on a row rather than a block adds no box.
 */
const SOURCE_CELL_CLASS = 'hljs min-w-0 flex-1'

/**
 * A file whose language we cannot name is not source we are quoting, it is text
 * we could not read: it keeps the body tone rather than the code theme's base.
 */
const PLAIN_CELL_CLASS = 'min-w-0 flex-1 text-text-muted'

export function ReadSourceRow({
  number,
  body,
  coloured,
}: {
  number: number
  body: ReactNode
  /** False when the file's language is unknown and the row is uncoloured. */
  coloured: boolean
}) {
  return (
    <div className="flex">
      <span className={GUTTER_CLASS}>{number}</span>
      <span className={coloured ? SOURCE_CELL_CLASS : PLAIN_CELL_CLASS}>
        {body}
      </span>
    </div>
  )
}

/**
 * The search body's locator gutter: `path:line:` per row, receded so the matched
 * source reads first. Padded by `grepRowModel.ts` rather than truncated, because
 * a locator that is silently cut is worse than one that makes the row wide.
 *
 * Carrying `hljs` here IS correct, unlike the write body next door: these rows
 * are source being quoted, with no additions semantics to preserve, so they take
 * the code theme's own foreground exactly as a read body does.
 */
const LOCATOR_GUTTER_CLASS = 'mr-3 shrink-0 select-none text-text-faint'

export function GrepSourceRow({
  locator,
  body,
  coloured,
}: {
  /** null for a line carrying no locator, which spans the whole row. */
  locator: string | null
  body: ReactNode
  /** False when the run's language is unknown and the row is uncoloured. */
  coloured: boolean
}) {
  if (locator === null) {
    return <div className="text-text-muted">{body}</div>
  }
  return (
    <div className="flex">
      <span className={LOCATOR_GUTTER_CLASS}>{locator}</span>
      <span className={coloured ? SOURCE_CELL_CLASS : PLAIN_CELL_CLASS}>
        {body}
      </span>
    </div>
  )
}

/** The prototype's `+` gutter: 14px wide, add-green, one marker per line. */
const ADDITION_GUTTER_CLASS = 'w-3.5 shrink-0 select-none text-[#86efac]'

/**
 * One `+`-prefixed, syntax-coloured line of a file-WRITE card's body (prototype
 * `Messages.jsx:624-630`).
 *
 * The ledger declined this on 2026-08-03 because "there is no source here to
 * color" — a Write RESULT is a one-sentence ack. That premise stopped holding
 * the same day: the written file is the tool's INPUT (`input.content`) and is
 * what `WriteBody` already renders, so the source was on the row all along. The
 * operator's 2026-08-13 decision makes the source column code-themed while the
 * green `+` gutter stays the additions signal.
 */
export function AdditionSourceRow({ body }: { body: ReactNode }) {
  return (
    <div className="flex">
      <span className={ADDITION_GUTTER_CLASS}>+</span>
      <span className={SOURCE_CELL_CLASS}>{body}</span>
    </div>
  )
}
