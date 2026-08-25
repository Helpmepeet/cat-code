/**
 * Marks the text a delivered batch just appended, so it can be faded in.
 *
 * WHY SOURCE OFFSETS AND NOT A TREE DIFF. The markdown source reparses per
 * batch and the tree can restructure retroactively: text already on screen as a
 * paragraph becomes a table cell the moment a closing row arrives, and a diff
 * of the rendered tree would call all of it new and replay the animation over
 * settled text. The SOURCE only ever grows by append, so "new" is the character
 * range past the previous length, and that answer survives any amount of
 * re-parenting.
 *
 * Nothing here changes WHEN text is visible. A node's own characters are
 * emitted in place; the only additions are wrapper spans and, for `flowing`, a
 * per-word delay on a fade that has already begun. Cadences that hold text back
 * were rejected on 2026-08-25 (`proseArrival.ts`).
 *
 * The input tree is never mutated. It is cached and reused across renders by
 * the plan that produced it, so this rebuilds only the branches it touches and
 * shares everything else by reference.
 */

import type { Element, ElementContent, Root, RootContent, Text } from 'hast'

export type ArrivalMarkOptions = {
  /** Characters before this source offset are settled and left alone. */
  fromOffset: number
  /** Class applied to each arriving word. */
  className: string
  /** Delay added per arriving word, in milliseconds. Zero fades the batch as one. */
  staggerMs: number
  /** Ceiling on accumulated stagger; past it, words share the final delay. */
  maxStaggerMs: number
}

/** Words and the whitespace between them, whitespace preserved as its own part.
 *
 * Splitting on whitespace and dropping it renders `*a* *b*` as `ab`, which this
 * repo has already shipped once (`markdownRenderPlan.ts` carries the same
 * warning at its own separator handling). The capture group keeps the runs. */
function splitKeepingSeparators(value: string): string[] {
  return value.split(/(\s+)/).filter(part => part !== '')
}

function isWhitespace(part: string): boolean {
  return /^\s+$/.test(part)
}

/**
 * Walks a tree, wrapping the arriving tail of every text node it reaches.
 *
 * `counter` is shared across the whole walk so the per-word delay is ordered by
 * position in the batch, not restarted inside each paragraph or list item.
 */
function markNodes<T extends RootContent | ElementContent>(
  nodes: readonly T[],
  options: ArrivalMarkOptions,
  counter: { index: number },
): { nodes: T[]; changed: boolean } {
  let changed = false
  const out: T[] = []

  for (const node of nodes) {
    if (node.type === 'text') {
      const marked = markText(node, options, counter)
      if (marked === null) {
        out.push(node)
      } else {
        changed = true
        out.push(...(marked as unknown as T[]))
      }
      continue
    }

    if (node.type === 'element') {
      const end = node.position?.end.offset
      // A whole element that ends before the boundary cannot contain arriving
      // text, so the entire subtree is shared by reference. This is what keeps
      // the transform cheap on a long settled answer with a short new tail.
      if (end !== undefined && end <= options.fromOffset) {
        out.push(node)
        continue
      }
      const inner = markNodes(node.children, options, counter)
      if (!inner.changed) {
        out.push(node)
        continue
      }
      changed = true
      out.push({ ...node, children: inner.nodes } as unknown as T)
      continue
    }

    out.push(node)
  }

  return { nodes: out, changed }
}

/**
 * Splits one text node at the arrival boundary.
 *
 * Returns null when the node is entirely settled, which is the common case and
 * lets the caller share the node by reference.
 */
function markText(
  node: Text,
  options: ArrivalMarkOptions,
  counter: { index: number },
): ElementContent[] | null {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  // Without positions there is no way to tell settled text from arriving text,
  // and guessing would replay the animation over the whole answer. Leaving it
  // alone degrades to `instant` for that node, which is the honest fallback.
  if (start === undefined || end === undefined) return null
  if (end <= options.fromOffset) return null

  const cut = Math.max(0, options.fromOffset - start)
  const settled = node.value.slice(0, cut)
  const arriving = node.value.slice(cut)
  if (arriving === '') return null

  const out: ElementContent[] = []
  if (settled !== '') out.push({ type: 'text', value: settled })

  for (const part of splitKeepingSeparators(arriving)) {
    if (isWhitespace(part)) {
      // Whitespace stays a bare text node: wrapping it would add a span per gap
      // for no visual gain, and an inline-block on a separator changes wrapping.
      out.push({ type: 'text', value: part })
      continue
    }
    out.push(wordSpan(part, options, counter))
  }

  return out
}

function wordSpan(
  word: string,
  options: ArrivalMarkOptions,
  counter: { index: number },
): Element {
  const delay = Math.min(
    counter.index * options.staggerMs,
    options.maxStaggerMs,
  )
  counter.index += 1
  const properties: Element['properties'] =
    delay > 0
      ? { className: [options.className], style: `animation-delay:${delay}ms` }
      : { className: [options.className] }
  return {
    type: 'element',
    tagName: 'span',
    properties,
    children: [{ type: 'text', value: word }],
  }
}

/**
 * A copy of `tree` with the text after `fromOffset` wrapped in marked spans.
 *
 * Returns the input unchanged when nothing arrived, so an unchanged render does
 * no work and remounts nothing.
 */
export function markArrivedText(
  tree: Root,
  options: ArrivalMarkOptions,
): Root {
  // `0` is legitimate and means the first batch: every character is arriving.
  // A settled or restored row must simply not be marked at all, which is the
  // caller's call to make; guarding `<= 0` here would silently swallow the very
  // first chunk of every response.
  if (options.fromOffset < 0) return tree
  const counter = { index: 0 }
  const result = markNodes(tree.children, options, counter)
  if (!result.changed) return tree
  return { ...tree, children: result.nodes }
}
