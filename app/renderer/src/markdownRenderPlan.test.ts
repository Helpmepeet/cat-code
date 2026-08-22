/**
 * The defect these tests pin (CC-59): the plan used to cut the SOURCE STRING
 * into chunks and hand each chunk to its own Markdown parse. A table cut
 * mid-body lost its header row, an ordered list restarted at 1, a reference
 * link whose definition landed in another chunk rendered as literal text, and a
 * message under the line ceiling produced exactly one leaf that bounded
 * nothing.
 *
 * The plan now parses the whole source ONCE and slices that single document, so
 * every assertion below is made against BOTH the retained plan and the markup a
 * bounded window actually mounts.
 */
import { describe, expect, test } from 'bun:test'
import type { ElementContent } from 'hast'
import { renderToStaticMarkup } from 'react-dom/server'
import { REHYPE_PLUGINS } from './markdownPlugins.js'
import {
  MAX_MARKDOWN_LEAF_CHARACTERS,
  MAX_MOUNTED_MARKDOWN_LEAVES,
  markdownMeasurementKey,
  mergeMountedMarkdownLeaves,
  planMarkdownLeaves,
  renderMarkdownTree,
  resolveMarkdownMeasurements,
  selectMarkdownLeafWindow,
  type MarkdownRenderLeaf,
} from './markdownRenderPlan.js'

function mount(leaves: readonly MarkdownRenderLeaf[], start: number, end: number): string {
  return mergeMountedMarkdownLeaves(leaves, start, end)
    .map(unit => renderToStaticMarkup(renderMarkdownTree(unit.tree)))
    .join('')
}

function count(html: string, needle: RegExp): number {
  return html.match(needle)?.length ?? 0
}

/** Element and text nodes a bounded window actually puts in the DOM. */
function mountedNodeCount(source: string): number {
  const leaves = planMarkdownLeaves('row-1', source)
  const leafWindow = selectMarkdownLeafWindow(leaves, 0, 800)
  let total = 0
  for (const unit of mergeMountedMarkdownLeaves(leaves, leafWindow.start, leafWindow.end)) {
    total += countNodes(unit.tree.children as ElementContent[])
  }
  return total
}

function countNodes(children: readonly ElementContent[]): number {
  let total = 0
  for (const child of children) {
    if (child.type === 'element') total += 1 + countNodes(child.children)
    else if (child.type === 'text') total += 1
  }
  return total
}

/** A table of `columns` headed columns over one empty body row. */
function wideTable(columns: number): string {
  const header = `|${Array.from({ length: columns }, (_, index) => `h${index}`).join('|')}|`
  const rule = `|${Array.from({ length: columns }, () => '---').join('|')}|`
  const body = `|${Array.from({ length: columns }, () => '').join('|')}|`
  return `${header}\n${rule}\n${body}`
}

function headerCellCount(source: string): number {
  const leaves = planMarkdownLeaves('row-1', source)
  const leafWindow = selectMarkdownLeafWindow(leaves, 0, 800)
  return count(mount(leaves, leafWindow.start, leafWindow.end), /<th[ >]/g)
}

describe('semantic leaves keep their document context', () => {
  const table = [
    '| Alpha | Beta |',
    '| --- | --- |',
    ...Array.from({ length: 500 }, (_, index) => `| a${index} | b${index} |`),
  ].join('\n')

  test('a table body past the row budget keeps its header at every window', () => {
    const leaves = planMarkdownLeaves('row-1', table)
    expect(leaves.length).toBeGreaterThan(2)

    const middle = Math.floor(leaves.length / 2)
    const windows: [number, number][] = [
      [0, 1],
      [middle, middle + 1],
      [leaves.length - 1, leaves.length],
    ]

    for (const [start, end] of windows) {
      const html = mount(leaves, start, end)
      expect(html).toContain('<thead>')
      expect(html).toContain('Alpha')
      expect(html).toContain('Beta')
      expect(count(html, /<table/g)).toBe(1)
      expect(count(html, /<tr/g)).toBeGreaterThan(1)
    }

    // Bounding is real: the first window does not carry the last row.
    expect(mount(leaves, 0, 1)).not.toContain('a499')
    expect(mount(leaves, leaves.length - 1, leaves.length)).toContain('a499')
  })

  test('consecutive chunks of one table fold back into a single table', () => {
    const leaves = planMarkdownLeaves('row-1', table)
    const html = mount(leaves, 0, leaves.length)

    expect(count(html, /<table/g)).toBe(1)
    expect(count(html, /<thead/g)).toBe(1)
    expect(count(html, /<tr/g)).toBe(501)
  })

  test('an ordered list crossing a window boundary keeps its numbering', () => {
    const source = Array.from({ length: 500 }, (_, index) => `${index + 1}. Item ${index + 1}`).join('\n')
    const leaves = planMarkdownLeaves('row-1', source)
    expect(leaves.length).toBeGreaterThan(1)

    const html = mount(leaves, 1, 2)
    const declared = /<ol start="(\d+)"/.exec(html)
    const firstItem = /<li>Item (\d+)</.exec(html)

    expect(declared).not.toBeNull()
    expect(firstItem).not.toBeNull()
    expect(Number(declared?.[1])).toBeGreaterThan(1)
    // The retained <ol> declares exactly the number its first mounted item carries.
    expect(Number(declared?.[1])).toBe(Number(firstItem?.[1]))
    expect(html).not.toContain('>Item 1<')
  })

  test('a list that already starts at an offset keeps that offset when chunked', () => {
    const source = Array.from({ length: 400 }, (_, index) => `${index + 7}. Item ${index + 7}`).join('\n')
    const leaves = planMarkdownLeaves('row-1', source)
    const html = mount(leaves, 1, 2)
    const declared = /<ol start="(\d+)"/.exec(html)
    const firstItem = /<li>Item (\d+)</.exec(html)

    expect(Number(declared?.[1])).toBe(Number(firstItem?.[1]))
    expect(Number(declared?.[1])).toBeGreaterThan(7)
  })

  test('a nested task list keeps its nesting inside a bounded window', () => {
    const source = Array.from(
      { length: 300 },
      (_, index) => `- [ ] Task ${index}\n  - [x] Sub ${index}`,
    ).join('\n')
    const leaves = planMarkdownLeaves('row-1', source)
    expect(leaves.length).toBeGreaterThan(1)

    const middle = Math.floor(leaves.length / 2)
    const html = mount(leaves, middle, middle + 1)

    // Outer list plus at least one nested list, both still task lists.
    expect(count(html, /contains-task-list/g)).toBeGreaterThan(1)
    expect(html).toContain('task-list-item')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('checked=""')
    expect(/<li class="task-list-item">[\s\S]*?<ul/.test(html)).toBe(true)
  })

  test('a blockquote cut mid-body still renders as a blockquote', () => {
    const source = Array.from({ length: 400 }, (_, index) => `> Quoted ${index}`).join('\n>\n')
    const leaves = planMarkdownLeaves('row-1', source)
    expect(leaves.length).toBeGreaterThan(1)

    const html = mount(leaves, leaves.length - 1, leaves.length)
    expect(html).toContain('<blockquote>')
    expect(html).toContain('Quoted 399')
    expect(html).not.toContain('Quoted 0<')
  })

  test('a callout cut across leaf windows retains one callout container', () => {
    const body = Array.from(
      { length: 400 },
      (_, index) => `> Paragraph ${index}.`,
    ).join('\n>\n')
    const leaves = planMarkdownLeaves('row-1', `> [!NOTE]\n>\n${body}`, {
      recognizeCallouts: true,
    })
    expect(leaves.length).toBeGreaterThan(1)

    for (const [start, end] of [
      [0, 1],
      [Math.floor(leaves.length / 2), Math.floor(leaves.length / 2) + 1],
      [leaves.length - 1, leaves.length],
    ] as [number, number][]) {
      const html = mount(leaves, start, end)
      expect(count(html, /<aside/g)).toBe(1)
      expect(html).toContain('class="md-callout"')
      expect(html).toContain('data-callout-kind="note"')
      expect(html).not.toContain('[!NOTE]')
    }
  })

  test('a reference link resolves when its definition is outside the mounted range', () => {
    const prose = Array.from({ length: 300 }, (_, index) => `Paragraph ${index}.`).join('\n\n')
    const source = `${prose}\n\nSee the [manual][ref] for details.\n\n[ref]: https://example.com/manual\n`
    const leaves = planMarkdownLeaves('row-1', source)
    expect(leaves.length).toBeGreaterThan(1)

    const html = mount(leaves, leaves.length - 1, leaves.length)
    expect(html).toContain('href="https://example.com/manual"')
    expect(html).toContain('>manual</a>')
    expect(html).not.toContain('[manual][ref]')
    // The first window never carried the definition either; it was consumed by
    // the single parse rather than living in some other chunk's source.
    expect(mount(leaves, 0, 1)).not.toContain('example.com')
  })
})

describe('code fences', () => {
  const fence = ['```ts', ...Array.from({ length: 400 }, (_, index) => `const line${index} = ${index}`), '```'].join('\n')

  test('a 400 line fence is one group whose copy source is the whole fence', () => {
    const leaves = planMarkdownLeaves('row-1', fence)
    const code = leaves.filter(leaf => leaf.kind === 'code')

    expect(code.length).toBeGreaterThan(1)
    expect(new Set(code.map(leaf => leaf.groupId)).size).toBe(1)
    expect(code[0].codeLanguage).toBe('ts')
    expect(code[0].codeSource.split('\n')).toHaveLength(400)
    expect(code[0].codeSource.startsWith('const line0 = 0')).toBe(true)
    expect(code[0].codeSource.endsWith('const line399 = 399')).toBe(true)
    // Every chunk of the fence carries the same complete copy payload, so the
    // card's copy action is complete at any scroll position.
    expect(code.every(leaf => leaf.codeSource === code[0].codeSource)).toBe(true)
  })

  test('any mounted range of one fence folds into a single card', () => {
    const leaves = planMarkdownLeaves('row-1', fence)
    for (const [start, end] of [
      [0, 1],
      [1, 3],
      [0, leaves.length],
    ] as [number, number][]) {
      const units = mergeMountedMarkdownLeaves(leaves, start, end)
      expect(units).toHaveLength(1)
      expect(units[0].kind).toBe('code')
      expect(count(renderToStaticMarkup(renderMarkdownTree(units[0].tree)), /<pre/g)).toBe(1)
    }
  })

  test('a fence small enough to mount whole stays an ordinary child', () => {
    const leaves = planMarkdownLeaves('row-1', 'Before.\n\n```ts\nconst a = 1\n```\n\nAfter.')
    expect(leaves).toHaveLength(1)
    expect(leaves[0].kind).toBe('block')

    const html = mount(leaves, 0, 1)
    expect(html).toContain('<pre>')
    expect(html).toContain('language-ts')
    expect(html).toContain('Before.')
    expect(html).toContain('After.')
  })

  test('an unclosed streaming fence keeps its final line and stays plain text', () => {
    const streaming = 'Here is the patch.\n\n```ts\nconst first = 1\nconst last = 2'
    const leaves = planMarkdownLeaves('row-1', streaming)
    const html = mount(leaves, 0, leaves.length)

    expect(html).toContain('Here is the patch.')
    expect(html).toContain('const last = 2')
    expect(html).toContain('```ts')
    expect(html).not.toContain('<pre>')
    expect(leaves.some(leaf => leaf.kind === 'code')).toBe(false)
  })

  test('the same fence becomes a card once it settles', () => {
    const settled = 'Here is the patch.\n\n```ts\nconst first = 1\nconst last = 2\n```'
    const html = mount(planMarkdownLeaves('row-1', settled), 0, 1)

    expect(html).toContain('<pre>')
    expect(html).toContain('language-ts')
    expect(html).toContain('const last = 2')
  })

  test('an indented code block is never mistaken for an open fence', () => {
    const leaves = planMarkdownLeaves('row-1', 'Prose.\n\n    indented line')
    const html = mount(leaves, 0, leaves.length)

    expect(html).toContain('<pre>')
    expect(html).toContain('indented line')
  })

  test('a settled prefix is reused while the fence above it is still open', () => {
    const cache = { current: null }
    const prefix = 'Settled prose.\n\n```ts\n'
    const first = planMarkdownLeaves('row-1', `${prefix}const a = 1`, { cache })
    const cached = cache.current
    const second = planMarkdownLeaves('row-1', `${prefix}const a = 1\nconst b = 2`, { cache })

    expect(cached).not.toBeNull()
    // Same parsed prefix object, so a streamed token reparses nothing settled.
    expect(cache.current).toBe(cached)
    expect(first[0].id).toBe(second[0].id)
    expect(mount(second, 0, second.length)).toContain('const b = 2')

    // Settling replaces the entry outright rather than reusing it.
    const settled = planMarkdownLeaves('row-1', `${prefix}const a = 1\n\`\`\``, { cache })
    expect(cache.current).toBeNull()
    expect(mount(settled, 0, settled.length)).toContain('<pre>')
  })

  test('the settled-prefix fast path releases as soon as the fence closes', () => {
    const cache = { current: null }
    const prefix = 'Settled prose.\n\n```ts\n'
    planMarkdownLeaves('row-1', `${prefix}const a = 1`, { cache })

    // A closing delimiter with prose after it must not be swallowed by the
    // cached open-fence tail.
    const after = planMarkdownLeaves('row-1', `${prefix}const a = 1\n\`\`\`\n\nAnd afterwards.`, {
      cache,
    })
    const html = mount(after, 0, after.length)

    expect(cache.current).toBeNull()
    expect(html).toContain('<pre>')
    expect(html).toContain('language-ts')
    expect(html).toContain('<p>And afterwards.</p>')
    expect(html).not.toContain('```')
  })
})

describe('bounding', () => {
  test('one logical line of several hundred thousand characters never mounts unbounded', () => {
    const source = 'x'.repeat(400_000)
    const leaves = planMarkdownLeaves('row-1', source)

    expect(leaves.length).toBeGreaterThan(30)
    expect(leaves.every(leaf => leaf.kind === 'atomic-text')).toBe(true)
    expect(leaves.every(leaf => leaf.characters <= MAX_MARKDOWN_LEAF_CHARACTERS)).toBe(true)
    expect(leaves.map(leaf => leaf.text).join('')).toBe(source)

    const leafWindow = selectMarkdownLeafWindow(leaves, 0, 800)
    const units = mergeMountedMarkdownLeaves(leaves, leafWindow.start, leafWindow.end)
    const mountedCharacters = units.reduce((total, unit) => total + unit.text.length, 0)

    expect(leafWindow.end - leafWindow.start).toBeLessThan(leaves.length)
    expect(mountedCharacters).toBeLessThan(source.length / 10)
    expect(leafWindow.bottomSpacerHeight).toBeGreaterThan(0)
  })

  test('one pathological line inside a table cell stays inside its cell', () => {
    const source = `| Alpha |\n| --- |\n| ${'y'.repeat(60_000)} |`
    const leaves = planMarkdownLeaves('row-1', source)
    const html = mount(leaves, 0, 1)

    expect(html).toContain('<table')
    expect(html).toContain('<thead>')
    expect(leaves.every(leaf => leaf.characters <= MAX_MARKDOWN_LEAF_CHARACTERS)).toBe(true)
  })

  test('mounted children stay fixed while the source grows ten times', () => {
    const paragraph = (index: number) => `Paragraph ${index} with a sentence of prose.`
    const small = Array.from({ length: 400 }, (_, index) => paragraph(index)).join('\n\n')
    const large = Array.from({ length: 4_000 }, (_, index) => paragraph(index)).join('\n\n')

    const smallLeaves = planMarkdownLeaves('row-1', small)
    const largeLeaves = planMarkdownLeaves('row-1', large)
    const smallWindow = selectMarkdownLeafWindow(smallLeaves, 0, 800)
    const largeWindow = selectMarkdownLeafWindow(largeLeaves, 0, 800)

    const smallHtml = mount(smallLeaves, smallWindow.start, smallWindow.end)
    const largeHtml = mount(largeLeaves, largeWindow.start, largeWindow.end)

    expect(largeLeaves.length).toBeGreaterThan(smallLeaves.length * 5)
    expect(count(largeHtml, /<p>/g)).toBe(count(smallHtml, /<p>/g))
    expect(largeWindow.end - largeWindow.start).toBe(smallWindow.end - smallWindow.start)
    expect(largeWindow.end - largeWindow.start).toBeLessThanOrEqual(MAX_MOUNTED_MARKDOWN_LEAVES)
  })

  test('a short message with no fence is still bounded rather than one whole leaf', () => {
    const source = Array.from({ length: 150 }, (_, index) => `- item ${index}`).join('\n')
    const leaves = planMarkdownLeaves('row-1', source)

    expect(leaves.length).toBeGreaterThan(0)
    expect(leaves.every(leaf => leaf.children.length <= 200)).toBe(true)
  })
})

describe('preserved rendering rules', () => {
  test('raw HTML stays disabled and shows as the literal text it is', () => {
    const leaves = planMarkdownLeaves('row-1', '<b>bold</b> and <script>alert(1)</script>')
    const html = mount(leaves, 0, leaves.length)

    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;')
    expect(html).toContain('&lt;script&gt;')
  })

  test('an unsafe link protocol is emptied before it reaches the DOM', () => {
    const leaves = planMarkdownLeaves('row-1', '[x](javascript:alert(1)) and [y](https://example.com)')
    const html = mount(leaves, 0, leaves.length)

    expect(html).not.toContain('javascript:')
    expect(html).toContain('href="https://example.com"')
  })

  test('GFM tables, strikethrough, and autolinks survive the single parse', () => {
    const leaves = planMarkdownLeaves('row-1', '| a |\n| --- |\n| b |\n\n~~gone~~ https://example.com')
    const html = mount(leaves, 0, leaves.length)

    expect(html).toContain('<table')
    expect(html).toContain('<del>gone</del>')
    expect(html).toContain('href="https://example.com"')
  })
})

describe('markdownMeasurementKey', () => {
  test('a streamed leaf keeps its id but not its measurement key', () => {
    const [before] = planMarkdownLeaves('row-1', 'The answer is')
    const [after] = planMarkdownLeaves('row-1', 'The answer is forty two.')

    expect(after.id).toBe(before.id)
    expect(markdownMeasurementKey(after)).not.toBe(markdownMeasurementKey(before))
  })

  test('a settled leaf ahead of the streaming tail keeps its measurement key', () => {
    const source = Array.from({ length: 400 }, (_, index) => `Line ${index}.`).join('\n\n')
    const first = planMarkdownLeaves('row-1', source)
    const second = planMarkdownLeaves('row-1', `${source}\n\nLine appended.`)

    expect(first.length).toBeGreaterThan(1)
    expect(markdownMeasurementKey(second[0])).toBe(markdownMeasurementKey(first[0]))
    expect(markdownMeasurementKey(second[second.length - 1])).not.toBe(
      markdownMeasurementKey(first[first.length - 1]),
    )
  })
})

describe('resolveMarkdownMeasurements', () => {
  const source = Array.from({ length: 500 }, (_, index) => `| a${index} | b${index} |`).join('\n')
  const table = `| Alpha | Beta |\n| --- | --- |\n${source}`

  test('a height measured on a merged run lands on every leaf of that run', () => {
    const leaves = planMarkdownLeaves('row-1', table)
    const [unit] = mergeMountedMarkdownLeaves(leaves, 0, 2)
    const { heights, live } = resolveMarkdownMeasurements(
      leaves,
      new Map([[unit.measurementKey, 4_800]]),
    )

    expect(live.has(unit.measurementKey)).toBe(true)
    expect(heights.get(leaves[0].id)).toBeGreaterThan(0)
    expect(heights.get(leaves[1].id)).toBeGreaterThan(0)
    expect(heights.get(leaves[0].id)! + heights.get(leaves[1].id)!).toBeCloseTo(4_800, -1)
  })

  test('a height whose leaves left the plan is not live and is dropped', () => {
    const leaves = planMarkdownLeaves('row-1', table)
    const [unit] = mergeMountedMarkdownLeaves(leaves, 0, 2)
    const shorter = planMarkdownLeaves('row-1', '| Alpha | Beta |\n| --- | --- |\n| a0 | b0 |')

    const { heights, live } = resolveMarkdownMeasurements(
      shorter,
      new Map([[unit.measurementKey, 4_800]]),
    )

    expect(live.size).toBe(0)
    expect(heights.size).toBe(0)
  })

  test('a run whose content changed under the same ids is not live', () => {
    const leaves = planMarkdownLeaves('row-1', table)
    const [unit] = mergeMountedMarkdownLeaves(leaves, 0, 2)
    const grown = planMarkdownLeaves('row-1', `${table}\n| tail | tail |`)

    const stale = new Map([[unit.measurementKey, 4_800]])
    const resolved = resolveMarkdownMeasurements(grown, stale)
    const rows = grown.filter(leaf => leaf.id === unit.key)

    expect(rows).toHaveLength(1)
    expect(resolved.live.has(unit.measurementKey)).toBe(
      leaves[0].characters + leaves[1].characters ===
        grown[0].characters + grown[1].characters,
    )
  })
})

describe('selectMarkdownLeafWindow', () => {
  test('keeps the mounted window fixed as source grows', () => {
    const source = Array.from({ length: 4_000 }, (_, index) => `Paragraph ${index}\n`).join('\n')
    const leaves = planMarkdownLeaves('row-1', source)
    const leafWindow = selectMarkdownLeafWindow(leaves, 0, 800, 800)

    expect(leafWindow.end - leafWindow.start).toBeLessThanOrEqual(MAX_MOUNTED_MARKDOWN_LEAVES)
    expect(leafWindow.bottomSpacerHeight).toBeGreaterThan(0)
  })

  test('returns prefix and suffix spacer heights around a later viewport', () => {
    const source = Array.from({ length: 2_000 }, (_, index) => `Paragraph ${index}\n`).join('\n')
    const leaves = planMarkdownLeaves('row-1', source)
    const leafWindow = selectMarkdownLeafWindow(leaves, 10_000, 600, 0, 3)

    expect(leafWindow.start).toBeGreaterThan(0)
    expect(leafWindow.end - leafWindow.start).toBeLessThanOrEqual(3)
    expect(leafWindow.topSpacerHeight).toBeGreaterThan(0)
    expect(leafWindow.bottomSpacerHeight).toBeGreaterThan(0)
  })
})

/**
 * Gate B in the CC-59 plan assumed bounded highlighting was impossible, because
 * `highlight.js` has no API for tokenizing a line window with the continuation
 * state of the lines before it. Highlighting the whole document ONCE and then
 * slicing the tokenized tree dissolves that: a token opened long before the
 * mounted window is already closed correctly by the time anything is cut.
 */
describe('highlighting survives chunk boundaries', () => {
  const fence = [
    '```ts',
    'const before = 1',
    'const banner = `',
    ...Array.from({ length: 400 }, (_, index) => `template line ${index}`),
    '`',
    'const after = 2',
    '```',
  ].join('\n')

  test('a string opened before the window is still a string inside it', () => {
    const leaves = planMarkdownLeaves('row-1', fence, { rehypePlugins: REHYPE_PLUGINS })
    const code = leaves.filter(leaf => leaf.kind === 'code')
    expect(code.length).toBeGreaterThan(1)

    // A chunk deep inside the template literal, far past the line that opened it.
    const inside = leaves
      .map((leaf, index) => ({ leaf, index }))
      .filter(entry => entry.leaf.kind === 'code')
      .map(entry => ({ ...entry, html: mount(leaves, entry.index, entry.index + 1) }))
      .find(entry => entry.html.includes('template line 399'))

    expect(inside).toBeDefined()
    expect(inside!.html).toContain('hljs-string')
    // The line that opened the string is not mounted, so the token class cannot
    // have come from re-tokenizing this chunk on its own.
    expect(inside!.html).not.toContain('const banner')
  })
})

/**
 * Review finding: `usableChildren` dropped every whitespace-only text child of a
 * block container so hast's inter-block filler would not become a leaf. Inside a
 * list item those same nodes are word separators, so a list item past the line
 * ceiling rendered `*a* *b*` as `ab` with the space deleted from the DOM.
 */
describe('text conservation across bounded leaves', () => {
  test('a space between inline elements in a long list item survives', () => {
    const filler = Array.from({ length: 260 }, () => '  continuation line').join('\n')
    const leaves = planMarkdownLeaves('row-1', `- *a* *b*\n${filler}\n`)
    expect(mount(leaves, 0, leaves.length)).toContain('<em>a</em> <em>b</em>')
  })

  test('whitespace filler between block siblings never becomes its own leaf', () => {
    // Long enough that the list item is split, which is the only path where
    // `usableChildren` runs at all.
    const paragraphs = Array.from({ length: 300 }, (_, index) => `  Paragraph ${index}.`).join('\n\n')
    const leaves = planMarkdownLeaves('row-1', `- lead in\n\n${paragraphs}\n`)

    expect(leaves.length).toBeGreaterThan(1)
    for (const leaf of leaves) {
      const text = leaf.children
        .map(child => (child.type === 'text' ? child.value : 'x'))
        .join('')
      expect(text.trim()).not.toBe('')
    }
    expect(mount(leaves, 0, leaves.length)).toContain('Paragraph 299')
  })
})

/**
 * The second defect (CC-61): `weigh` measured text characters and source line
 * span only, so a child that is element-dense and text-sparse was never
 * oversized, was never recursed into, and mounted whole. Fifty thousand empty
 * anchors on ONE source line cost a single leaf and fifty thousand mounted
 * nodes: exactly linear in the input, which is what this file exists to stop.
 *
 * Every number below is absolute. `expect(measured).toBeLessThanOrEqual(BUDGET)`
 * compares a budget against itself and stays green however high the budget
 * goes, which is how a whole dimension of bounding stayed missing. See the
 * header of `mountingBudgets.test.ts`.
 */
describe('element density is bounded like text density', () => {
  const pathological: readonly {
    name: string
    build: (columns: number) => string
    small: number
    large: number
    mounted: number
  }[] = [
    {
      name: 'inline links',
      build: n => Array.from({ length: n }, (_, index) => `[](u${index})`).join(''),
      small: 2_000,
      large: 20_000,
      mounted: 201,
    },
    {
      name: 'images',
      build: n => Array.from({ length: n }, (_, index) => `![](b${index}.svg)`).join(''),
      small: 1_000,
      large: 10_000,
      mounted: 201,
    },
    {
      name: 'nested blockquotes',
      build: n => `${'> '.repeat(n)}note`,
      small: 500,
      large: 5_000,
      mounted: 823,
    },
    {
      name: 'inline code spans',
      build: n => Array.from({ length: n }, () => '`a`').join(' '),
      small: 500,
      large: 5_000,
      mounted: 301,
    },
    {
      name: 'wide table columns',
      build: wideTable,
      small: 400,
      large: 4_000,
      mounted: 799,
    },
  ]

  for (const entry of pathological) {
    test(`${entry.name}: ten times the source still mounts ${entry.mounted} nodes`, () => {
      const small = entry.build(entry.small)
      const large = entry.build(entry.large)

      expect(large.length).toBeGreaterThan(small.length * 5)
      expect(mountedNodeCount(small)).toBe(entry.mounted)
      expect(mountedNodeCount(large)).toBe(entry.mounted)
    })
  }

  test('bounding is mounted DOM only: the whole plan still holds every element', () => {
    const source = Array.from({ length: 2_000 }, (_, index) => `[](u${index})`).join('')
    const leaves = planMarkdownLeaves('row-1', source)

    // The source was cut into many leaves rather than buffered into one.
    expect(leaves.length).toBe(10)
    expect(count(mount(leaves, 0, leaves.length), /<a /g)).toBe(2_000)
  })

  test('a linear nesting chain is truncated, because no window can cut it', () => {
    // Every level of `> > > …` is an ancestor of the text, so there is no
    // sibling run to window. The retained chain stops at a depth past any
    // readable nesting and the remainder is dropped from the DOM.
    const html = mount(planMarkdownLeaves('row-1', `${'> '.repeat(5_000)}note`), 0, 1)
    expect(count(html, /<blockquote/g)).toBe(424)
  })
})

/**
 * The wrapper prefix is the other half of the same defect: `<thead>` is
 * re-emitted into EVERY mounted unit of the table body, so a header wide enough
 * was charged to every window no matter how well the body chunked.
 */
describe('the sticky table header carries a bounded number of cells', () => {
  test('an ordinary header is untouched and a pathological one is cut', () => {
    expect(headerCellCount(wideTable(20))).toBe(20)
    expect(headerCellCount(wideTable(400))).toBe(198)
    expect(headerCellCount(wideTable(4_000))).toBe(198)
  })
})

/**
 * Review finding: `mergeMountedMarkdownLeaves` folded CONSECUTIVE leaves of one
 * group, but an oversized child interrupts its parent's group and leaves two
 * non-consecutive runs behind. A table whose body contained one oversized row
 * emitted leaves at three depths and rendered as four stacked tables, each
 * paying for the header again. Units are keyed on the outermost retained
 * wrapper now, so the whole container folds back into one.
 */
describe('a container interrupted by an oversized child stays one container', () => {
  const interrupted = [
    '| Alpha | Beta |',
    '| --- | --- |',
    '| a0 | b0 |',
    '| a1 | b1 |',
    `| ${'y'.repeat(60_000)} | mid |`,
    '| a3 | b3 |',
    '| a4 | b4 |',
  ].join('\n')

  test('a table body split around an oversized row renders as ONE table', () => {
    const leaves = planMarkdownLeaves('row-1', interrupted)

    // The plan really does emit non-consecutive runs of the body's own group.
    expect(new Set(leaves.map(leaf => leaf.groupId)).size).toBe(3)
    expect(leaves[0].groupId).toBe(leaves[leaves.length - 1].groupId)
    expect(leaves[0].groupId).not.toBe(leaves[1].groupId)
    // All of them belong to the same mounted unit regardless.
    expect(new Set(leaves.map(leaf => leaf.unitId)).size).toBe(1)

    const html = mount(leaves, 0, leaves.length)
    expect(mergeMountedMarkdownLeaves(leaves, 0, leaves.length)).toHaveLength(1)
    expect(count(html, /<table/g)).toBe(1)
    expect(count(html, /<thead/g)).toBe(1)
    expect(count(html, /<tr/g)).toBe(6)
    // Nothing was reordered or dropped on the way back into one table.
    expect(html.indexOf('>a0<')).toBeLessThan(html.indexOf('>a3<'))
    expect(html).toContain('>a4<')
    expect(html).toContain('>mid<')
  })
})

/**
 * Review finding: neutering the content-revision half of the liveness check
 * failed nothing, so the pruning that keeps a streamed message's measurement
 * map from growing one entry per token had no coverage at all.
 */
describe('measurement liveness follows content, not just position', () => {
  test('a run whose content changed is no longer live', () => {
    const settled = planMarkdownLeaves('row-1', 'The answer is')
    const key = markdownMeasurementKey(settled[0])
    const heights = new Map([[key, 84]])

    expect(resolveMarkdownMeasurements(settled, heights).live.has(key)).toBe(true)

    // Same leaf id and same position; one more token of content.
    const streamed = planMarkdownLeaves('row-1', 'The answer is forty two.')
    expect(streamed[0].id).toBe(settled[0].id)
    expect(resolveMarkdownMeasurements(streamed, heights).live.has(key)).toBe(false)
    expect(resolveMarkdownMeasurements(streamed, heights).heights.size).toBe(0)
  })

  test('an unchanged run stays live across a replan', () => {
    const source = Array.from({ length: 400 }, (_, index) => `Line ${index}`).join('\n')
    const first = planMarkdownLeaves('row-1', source)
    const key = markdownMeasurementKey(first[0])
    const heights = new Map([[key, 96]])
    const second = planMarkdownLeaves('row-1', `${source}\nLine appended`)

    expect(resolveMarkdownMeasurements(second, heights).live.has(key)).toBe(true)
  })
})
