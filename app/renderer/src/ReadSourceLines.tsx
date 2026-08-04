/**
 * The two gutter-beside-source card bodies: a file READ (`ReadSourceLines`,
 * numbered) and a file WRITE (`AdditionSourceLines`, `+`-prefixed). Both are
 * prototype bodies whose every line goes through its own `hl()`
 * (`~/catcode_prototype/cat-app/Messages.jsx:598-607` and `:624-630`), and both
 * share the highlighter setup and the two-column geometry below.
 *
 * WHY A HIGHLIGHTER AND NOT THE PROTOTYPE'S `hl()`. The prototype hand-rolls a
 * regex colorer with a fixed One-Dark-ish palette and says so
 * (`Messages.jsx:1725` "GUI equivalent, not the same lib"). Porting that here
 * would paint a sixth palette that the Settings code-theme picker cannot reach.
 * Running the source through `rehype-highlight` instead emits the same `hljs-*`
 * classes a fenced block in the transcript already emits, so a read body is
 * colored by whichever of the five themes the operator picked, with no prop and
 * no re-render (`CodeThemeProvider` / `theme.css`). Reached through
 * react-markdown, exactly as `CodeThemePreview` reaches it, so no second
 * tokenizer and no new dependency.
 *
 * WHY TWO COLUMNS. The highlighter returns ONE token tree for the whole slice,
 * and its newlines live inside spans (a block comment is a single node), so the
 * tree cannot be cut into per-line rows without re-parsing it. The gutter is
 * therefore its own column beside the source rather than a cell in each row.
 * They stay aligned because both are `whitespace-pre` at one shared font size
 * and line height, so every source line occupies exactly one row in each.
 */

import Markdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { sourceFence } from './readSource.js'

/** Type/size/leading shared by both columns; see WHY TWO COLUMNS above. */
const SOURCE_TYPE = 'whitespace-pre font-mono text-[11.5px] leading-relaxed'

/** `min-w-8` rather than `w-8`: these are real file lines now, so a read deep
 * into a large file can need more than four digits. */
const GUTTER_CLASS = `${SOURCE_TYPE} mr-3 min-w-8 shrink-0 select-none text-right tabular-nums text-text-subtle/60`

/**
 * `detect: false` matches the transcript's own configuration
 * (`TranscriptView.tsx` `REHYPE_PLUGINS`): color only what we can name, never
 * guess a language and color a text file wrong.
 */
const REHYPE_PLUGINS: [
  typeof rehypeHighlight,
  { detect: boolean; ignoreMissing: boolean },
][] = [[rehypeHighlight, { detect: false, ignoreMissing: true }]]

/**
 * A fenced block always ends in a newline, which would give the source column
 * one more row than the gutter and slide the two out of step at the bottom.
 */
function trimTrailingNewline(children: ReactNode): ReactNode {
  if (typeof children === 'string') return children.replace(/\n$/, '')
  if (!Array.isArray(children)) return children
  const last = children[children.length - 1]
  if (typeof last !== 'string') return children
  const trimmed = last.replace(/\n$/, '')
  return trimmed === ''
    ? children.slice(0, -1)
    : [...children.slice(0, -1), trimmed]
}

/**
 * The bridge from react-markdown's `<pre><code>` to the source column: unwrap
 * the `<pre>` so the block below owns the only one, and keep `hljs` on the
 * element the token classes are colored under.
 */
const SOURCE_COMPONENTS = {
  pre: ({ children }: ComponentPropsWithoutRef<'pre'>) => <>{children}</>,
  code: ({ children }: ComponentPropsWithoutRef<'code'>) => (
    <pre className={`${SOURCE_TYPE} hljs`}>{trimTrailingNewline(children)}</pre>
  ),
}

export function ReadSourceLines({
  lines,
  numbers,
  lang,
}: {
  lines: string[]
  numbers: number[]
  /** null when the file's language is unknown: the slice renders uncolored. */
  lang: string | null
}) {
  const code = lines.join('\n')
  return (
    <div className="flex">
      <pre className={GUTTER_CLASS}>
        {numbers.map(number => (
          <div key={number}>{number}</div>
        ))}
      </pre>
      {lang === null ? (
        <pre className={`${SOURCE_TYPE} text-text-muted`}>{code}</pre>
      ) : (
        <Markdown components={SOURCE_COMPONENTS} rehypePlugins={REHYPE_PLUGINS}>
          {sourceFence(code, lang)}
        </Markdown>
      )}
    </div>
  )
}

/** The prototype's `+` gutter: 14px wide, add-green, one marker per line. */
const ADDITION_GUTTER_CLASS = `${SOURCE_TYPE} w-3.5 shrink-0 select-none text-[#86efac]`

/**
 * The write body's source column. Identical to `SOURCE_COMPONENTS` except that
 * it deliberately does NOT carry the `hljs` class.
 *
 * That one omission is what lets a written file read as ADDITIONS and as source
 * at the same time, which is what the prototype does: its `hl()` colors only the
 * tokens it recognizes and every untouched character inherits the surrounding
 * `FE_T.add` (`Messages.jsx:626-627`). `.hljs` sets an explicit base color
 * (`theme.css:325`), so carrying it here would repaint the whole file in the
 * code theme's foreground and the green would survive only on the `+` markers.
 * The per-token rules (`.hljs-keyword`, `.hljs-string`, …) are independent
 * selectors on the inner spans, so they still apply, and still follow whichever
 * of the five code themes is selected. No new CSS, and no specificity fight with
 * the `[data-code-theme]` blocks.
 */
const ADDITION_COMPONENTS = {
  pre: ({ children }: ComponentPropsWithoutRef<'pre'>) => <>{children}</>,
  code: ({ children }: ComponentPropsWithoutRef<'code'>) => (
    <pre className={`${SOURCE_TYPE} text-[#86efac]`}>
      {trimTrailingNewline(children)}
    </pre>
  ),
}

/**
 * One `+`-prefixed, syntax-colored slice of a file-WRITE card's body (prototype
 * `Messages.jsx:624-630`).
 *
 * The ledger declined this on 2026-08-03 because "there is no source here to
 * color" — a Write RESULT is a one-sentence ack. That premise stopped holding
 * the same day: the written file is the tool's INPUT (`input.content`) and is
 * what `WriteBody` already renders, so the source was on the row all along.
 */
export function AdditionSourceLines({
  lines,
  lang,
}: {
  lines: string[]
  /** null when the file's language is unknown: the slice stays plain green. */
  lang: string | null
}) {
  const code = lines.join('\n')
  return (
    <div className="flex">
      <pre className={ADDITION_GUTTER_CLASS}>
        {lines.map((_, index) => (
          <div key={index}>+</div>
        ))}
      </pre>
      {lang === null ? (
        <pre className={`${SOURCE_TYPE} text-[#86efac]`}>{code}</pre>
      ) : (
        <Markdown components={ADDITION_COMPONENTS} rehypePlugins={REHYPE_PLUGINS}>
          {sourceFence(code, lang)}
        </Markdown>
      )}
    </div>
  )
}
