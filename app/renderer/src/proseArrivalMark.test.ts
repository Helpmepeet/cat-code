import { expect, test } from 'bun:test'
import type { Element, Root, RootContent, ElementContent } from 'hast'
import {
  mergeMountedMarkdownLeaves,
  planMarkdownLeaves,
} from './markdownRenderPlan.js'
import { markArrivedText, type ArrivalMarkOptions } from './proseArrivalMark.js'

/** The real production parse, so positions are the ones the app actually gets. */
function treeFor(source: string): Root {
  const planned = planMarkdownLeaves('row-1', source)
  const mounted = mergeMountedMarkdownLeaves(planned, 0, planned.length)
  return { type: 'root', children: mounted.flatMap(unit => unit.tree.children) }
}

const SMOOTH: Omit<ArrivalMarkOptions, 'fromOffset'> = {
  className: 'arrive',
  staggerMs: 0,
  maxStaggerMs: 400,
}
const FLOWING: Omit<ArrivalMarkOptions, 'fromOffset'> = {
  className: 'arrive',
  staggerMs: 25,
  maxStaggerMs: 400,
}

function walk(
  nodes: readonly (RootContent | ElementContent)[],
  visit: (node: RootContent | ElementContent) => void,
): void {
  for (const node of nodes) {
    visit(node)
    if (node.type === 'element') {
      walk(node.children, visit)
    }
  }
}

/** Every character the tree will render, marked or not. */
function textOf(tree: Root): string {
  let out = ''
  walk(tree.children, node => {
    if (node.type === 'text') out += node.value
  })
  return out
}

/** The words that carry the arrival class, in document order. */
function markedWords(tree: Root): string[] {
  const out: string[] = []
  walk(tree.children, node => {
    if (node.type !== 'element') return
    const classes = node.properties?.className
    if (Array.isArray(classes) && classes.includes('arrive')) {
      out.push(node.children.map(c => (c.type === 'text' ? c.value : '')).join(''))
    }
  })
  return out
}

function markedDelays(tree: Root): (string | undefined)[] {
  const out: (string | undefined)[] = []
  walk(tree.children, node => {
    if (node.type !== 'element') return
    const classes = node.properties?.className
    if (Array.isArray(classes) && classes.includes('arrive')) {
      const style = (node as Element).properties?.style
      out.push(typeof style === 'string' ? style : undefined)
    }
  })
  return out
}

test('nothing arriving leaves the tree untouched, by reference', () => {
  const source = 'Hello there, this is settled.'
  const tree = treeFor(source)
  const marked = markArrivedText(tree, { ...SMOOTH, fromOffset: source.length })
  // Reference equality, not deep equality: an unchanged render must remount
  // nothing, and rebuilding an equal tree would replace every DOM node.
  expect(marked).toBe(tree)
})

test('the first batch marks every word', () => {
  const source = 'alpha beta gamma'
  const marked = markArrivedText(treeFor(source), { ...SMOOTH, fromOffset: 0 })
  expect(markedWords(marked)).toEqual(['alpha', 'beta', 'gamma'])
})

test('only the appended tail is marked', () => {
  const before = 'alpha beta '
  const source = `${before}gamma delta`
  const marked = markArrivedText(treeFor(source), {
    ...SMOOTH,
    fromOffset: before.length,
  })
  expect(markedWords(marked)).toEqual(['gamma', 'delta'])
})

test('no character is lost, gained, or reordered', () => {
  // The whole transform is invisible if this ever fails. This repo has already
  // shipped a bug that ate word separators, so the guard is on the full string.
  const source = 'one  two\tthree\nfour *five* `six`'
  for (const fromOffset of [0, 4, 12, source.length]) {
    const marked = markArrivedText(treeFor(source), { ...SMOOTH, fromOffset })
    expect(textOf(marked)).toBe(textOf(treeFor(source)))
  }
})

test('a batch that ends mid-word marks only the characters that arrived', () => {
  // The settled policy: animate whatever arrived rather than hold back a partial
  // trailing word, because holding text back would break chunk timing.
  const source = 'hello'
  const marked = markArrivedText(treeFor(source), { ...SMOOTH, fromOffset: 3 })
  expect(markedWords(marked)).toEqual(['lo'])
  expect(textOf(marked)).toBe('hello')
})

test('flowing staggers by word and stops at the ceiling', () => {
  const source = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ')
  const delays = markedDelays(
    markArrivedText(treeFor(source), { ...FLOWING, fromOffset: 0 }),
  )
  expect(delays[0]).toBeUndefined() // first word: zero delay, no style at all
  expect(delays[1]).toBe('animation-delay:25ms')
  expect(delays[2]).toBe('animation-delay:50ms')
  // 400ms ceiling: past word 16 every remaining word shares the final delay,
  // so a huge replayed batch cannot schedule an animation minutes out.
  expect(delays[delays.length - 1]).toBe('animation-delay:400ms')
})

test('smooth adds no per-word delay at all', () => {
  const source = 'alpha beta gamma'
  const delays = markedDelays(
    markArrivedText(treeFor(source), { ...SMOOTH, fromOffset: 0 }),
  )
  expect(delays).toEqual([undefined, undefined, undefined])
})

test('text that survives a retroactive restructure is not re-animated', () => {
  // The claim the whole offset-based design rests on. `| a | b |` alone is a
  // paragraph; once the delimiter row arrives the SAME characters become table
  // cells, a completely different tree. A diff of the rendered tree would call
  // all of it new and replay the fade over text already on screen.
  const before = '| a | b |\n'
  const source = `${before}| - | - |\n| c | d |`

  const asParagraph = treeFor(before)
  const asTable = treeFor(source)
  // Guard the premise: the shapes really do differ, or this proves nothing.
  expect(asParagraph.children[0]).not.toEqual(asTable.children[0])

  const marked = markArrivedText(asTable, { ...SMOOTH, fromOffset: before.length })
  const words = markedWords(marked)
  expect(words).toContain('c')
  expect(words).toContain('d')
  expect(words).not.toContain('a')
  expect(words).not.toContain('b')
})

test('a settled subtree is shared by reference, not rebuilt', () => {
  // What keeps the per-batch cost proportional to the new tail rather than to
  // the length of the answer so far.
  const before = 'First paragraph, long since settled.\n\n'
  const source = `${before}Second paragraph arriving now.`
  const tree = treeFor(source)
  const marked = markArrivedText(tree, { ...SMOOTH, fromOffset: before.length })

  expect(marked).not.toBe(tree)
  expect(marked.children[0]).toBe(tree.children[0])
})

test('a node with no position data is left alone rather than guessed at', () => {
  const tree: Root = {
    type: 'root',
    children: [
      {
        type: 'element',
        tagName: 'p',
        properties: {},
        children: [{ type: 'text', value: 'no positions here' }],
      },
    ],
  }
  const marked = markArrivedText(tree, { ...SMOOTH, fromOffset: 0 })
  expect(marked).toBe(tree)
  expect(markedWords(marked)).toEqual([])
})
