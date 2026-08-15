/**
 * Per-line syntax colouring for the bounded tool-output bodies (CC-62).
 *
 * WHY THIS EXISTS. Every coloured body used to hand a WHOLE slice of source to
 * one `<Markdown>` element and paint the token tree it returned as a single
 * block beside a separate gutter column. That shape cannot be virtualized: one
 * block is one DOM subtree, so a 20,000-line write mounted 20,000 lines of
 * text however small the viewport was. It also forced the two-parse split a
 * head+tail window needs, and a token opened in the head and closed in the tail
 * was tokenized twice, against two different fences.
 *
 * So the parse happens ONCE over exactly the lines that are painted, and its
 * tree is cut into per-line pieces here, before React sees it. The caller then
 * mounts whichever rows its virtualizer asks for. Cutting a hast tree by
 * newline is the same operation `diffHighlight.ts` performs on React elements
 * and for the same reason: a token can span lines (a block comment, a template
 * literal), so the split has to descend into the element rather than run over
 * the flat text.
 *
 * BOUNDING IS MOUNTED DOM ONLY. The caller keeps every source line; nothing
 * here truncates what is searched or copied. Two ceilings apply:
 *
 *   1. Whether to colour at all. A parse builds an element tree proportional to
 *      the source, and that tree is built even for rows no viewport will show,
 *      so past `MAX_HIGHLIGHTED_SOURCE_LINES` / `MAX_HIGHLIGHTED_SOURCE_CHARS`
 *      this returns null and the caller paints the same text uncoloured.
 *   2. What one row may mount. A row is cut to `MAX_MOUNTED_CHUNK_CHARS`
 *      characters (`lineWindow.ts`, budget 2) and `MAX_MOUNTED_SOURCE_TOKENS`
 *      nodes, so a single logical line of several megabytes, or one pathological
 *      line the tokenizer split into a hundred thousand spans, still mounts a
 *      bounded row.
 */

import type { Element, ElementContent, Root, RootContent } from 'hast'
import type { ReactNode } from 'react'
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import rehypeHighlight from 'rehype-highlight'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { MAX_MOUNTED_CHUNK_CHARS } from './lineWindow.js'
import { sourceFence } from './readSource.js'

/**
 * Lines this module will colour at all. A parse materialises nodes for every
 * line, mounted or not, so this is the ceiling on WORK, not on DOM; the row
 * ceiling still comes from the virtualizer. 2,000 lines is well past any file a
 * reader scrolls inside a card, and a bigger body loses only its colour.
 */
export const MAX_HIGHLIGHTED_SOURCE_LINES = 2_000

/** Characters this module will colour at all, for the same reason. */
export const MAX_HIGHLIGHTED_SOURCE_CHARS = 200_000

/**
 * Nodes one coloured row may mount. `MAX_MOUNTED_CHUNK_CHARS` alone does not
 * bound this: a tokenizer that emits one span per character turns a 4,000
 * character row into 8,000 nodes. Past this the rest of the row paints as one
 * plain run, which is several full visual lines below where anyone is reading.
 */
export const MAX_MOUNTED_SOURCE_TOKENS = 300

/** Marks a row the mount budget cut. Plain text, never a control. */
const ROW_CUT = '…'

/**
 * One rendered row per input line, or null when the slice is not coloured:
 * an unknown language, an empty slice, a body past the ceilings, or a tree that
 * did not come back with one piece per line. The caller paints plain text in
 * every one of those cases, so a null is a degrade, never an error.
 */
export function selectHighlightedSourceRows(
  lines: readonly string[],
  lang: string | null,
): readonly ReactNode[] | null {
  if (lang === null || lines.length === 0) return null
  if (lines.length > MAX_HIGHLIGHTED_SOURCE_LINES) return null
  let characters = 0
  for (const line of lines) {
    characters += line.length + 1
    if (characters > MAX_HIGHLIGHTED_SOURCE_CHARS) return null
  }
  try {
    const code = findCodeElement(highlightFence(lines.join('\n'), lang))
    if (code === null) return null
    const split = splitLines(code.children)
    // `mdast-util-to-hast` closes a code block with a newline, so the split
    // carries one trailing empty piece the source does not have.
    if (
      split.length === lines.length + 1 &&
      split[split.length - 1].length === 0
    ) {
      split.pop()
    }
    // A gutter that has drifted from its source is worse than no colour: the
    // numbers beside the rows would name the wrong lines.
    if (split.length !== lines.length) return null
    return split.map(children => renderRow(boundRow(children)))
  } catch {
    return null
  }
}

function highlightFence(code: string, lang: string): Root {
  const processor = unified()
    .use(remarkParse)
    .use(remarkRehype)
    // The transcript's own configuration (`markdownPlugins.ts`): colour only
    // what we can name, never guess a language and colour a text file wrong.
    .use(rehypeHighlight, { detect: false, ignoreMissing: true })
  return processor.runSync(processor.parse(sourceFence(code, lang))) as Root
}

/** The `<code>` inside the single fenced block the source was wrapped in. */
function findCodeElement(tree: Root): Element | null {
  for (const child of tree.children) {
    const pre = asElement(child)
    if (pre === null || pre.tagName !== 'pre') continue
    for (const inner of pre.children) {
      const code = asElement(inner)
      if (code !== null && code.tagName === 'code') return code
    }
  }
  return null
}

function asElement(node: RootContent | ElementContent): Element | null {
  return node.type === 'element' ? node : null
}

/**
 * Cut a token tree into one piece per line. A node whose text spans a newline
 * is reproduced on both sides with only its own share of the text, so a block
 * comment keeps its colour on every line it covers.
 */
function splitLines(children: readonly ElementContent[]): ElementContent[][] {
  let lines: ElementContent[][] = [[]]
  for (const child of children) {
    const pieces = splitNode(child)
    lines[lines.length - 1].push(...pieces[0])
    for (let index = 1; index < pieces.length; index++) {
      lines.push(pieces[index])
    }
  }
  return lines
}

function splitNode(node: ElementContent): ElementContent[][] {
  if (node.type === 'text') {
    return node.value
      .split('\n')
      .map(part => (part === '' ? [] : [{ type: 'text' as const, value: part }]))
  }
  if (node.type !== 'element') return [[node]]
  // An empty share yields NO node rather than a childless clone: a token
  // covering a blank line would otherwise paint an empty element there, and
  // inside a `whitespace-pre` row that is a stray box on a line with no text.
  return splitLines(node.children).map(children =>
    children.length === 0 ? [] : [{ ...node, children }],
  )
}

type MountBudget = { chars: number; nodes: number; exhausted: boolean }

function boundRow(children: readonly ElementContent[]): ElementContent[] {
  const budget: MountBudget = {
    chars: MAX_MOUNTED_CHUNK_CHARS,
    nodes: MAX_MOUNTED_SOURCE_TOKENS,
    exhausted: false,
  }
  const bounded: ElementContent[] = []
  for (const child of children) {
    const copy = copyBounded(child, budget)
    if (copy === null) break
    bounded.push(copy)
  }
  if (budget.exhausted) bounded.push({ type: 'text', value: ROW_CUT })
  return bounded
}

function copyBounded(
  node: ElementContent,
  budget: MountBudget,
): ElementContent | null {
  if (budget.nodes <= 0 || budget.chars <= 0) {
    budget.exhausted = true
    return null
  }
  budget.nodes -= 1
  if (node.type === 'text') {
    if (node.value.length > budget.chars) {
      const value = node.value.slice(0, budget.chars)
      budget.chars = 0
      budget.exhausted = true
      return { type: 'text', value }
    }
    budget.chars -= node.value.length
    return node
  }
  if (node.type !== 'element') return node
  const children: ElementContent[] = []
  for (const child of node.children) {
    const copy = copyBounded(child, budget)
    if (copy === null) break
    children.push(copy)
  }
  return { ...node, children }
}

function renderRow(children: readonly ElementContent[]): ReactNode {
  return toJsxRuntime(
    { type: 'root', children: [...children] },
    { Fragment, ignoreInvalidStyle: true, jsx, jsxs, passKeys: true },
  )
}

export const _forTest = {
  splitLines,
  boundRow,
}
