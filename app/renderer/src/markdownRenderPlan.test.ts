import { describe, expect, test } from 'bun:test'
import {
  MAX_MARKDOWN_LEAF_CHARACTERS,
  MAX_MARKDOWN_LEAF_LINES,
  MAX_MOUNTED_MARKDOWN_LEAVES,
  markdownMeasurementKey,
  planMarkdownLeaves,
  selectMarkdownLeafWindow,
} from './markdownRenderPlan.js'

describe('planMarkdownLeaves', () => {
  test('keeps unchanged append-only leaves stable', () => {
    const initial = planMarkdownLeaves('row-1', 'First paragraph.\n\nSecond paragraph.')
    const appended = planMarkdownLeaves(
      'row-1',
      'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.',
    )

    expect(appended.slice(0, initial.length).map(leaf => leaf.id)).toEqual(
      initial.map(leaf => leaf.id),
    )
  })

  test('splits a large fenced block into fixed-size self-contained leaves', () => {
    const code = Array.from({ length: MAX_MARKDOWN_LEAF_LINES * 3 + 1 }, (_, index) => `line ${index + 1}`).join('\n')
    const leaves = planMarkdownLeaves('row-1', `\`\`\`ts\n${code}\n\`\`\``)

    expect(leaves).toHaveLength(4)
    expect(leaves.every(leaf => leaf.kind === 'fenced-code')).toBe(true)
    expect(leaves.every(leaf => leaf.content.startsWith('```ts\n'))).toBe(true)
    expect(leaves.every(leaf => leaf.content.endsWith('\n```'))).toBe(true)
    expect(leaves.every(leaf => leaf.content.split('\n').length <= MAX_MARKDOWN_LEAF_LINES + 2)).toBe(true)
  })

  test('uses bounded atomic leaves for one pathological paragraph', () => {
    const source = 'x'.repeat(MAX_MARKDOWN_LEAF_CHARACTERS * 2 + 1)
    const leaves = planMarkdownLeaves('row-1', source)

    expect(leaves).toHaveLength(3)
    expect(leaves.every(leaf => leaf.kind === 'atomic-text')).toBe(true)
    expect(leaves.every(leaf => leaf.content.length <= MAX_MARKDOWN_LEAF_CHARACTERS)).toBe(true)
    expect(leaves.map(leaf => leaf.content).join('')).toBe(source)
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
    // The scanner splits prose only at MAX_MARKDOWN_LEAF_LINES, so a source
    // needs more than one chunk before any leaf is settled.
    const source = Array.from({ length: MAX_MARKDOWN_LEAF_LINES + 10 }, (_, index) => `Line ${index}`).join('\n')
    const first = planMarkdownLeaves('row-1', source)
    const second = planMarkdownLeaves('row-1', `${source}\nLine appended`)

    expect(first.length).toBeGreaterThan(1)
    expect(markdownMeasurementKey(second[0])).toBe(markdownMeasurementKey(first[0]))
    expect(markdownMeasurementKey(second[second.length - 1])).not.toBe(
      markdownMeasurementKey(first[first.length - 1]),
    )
  })
})

describe('selectMarkdownLeafWindow', () => {
  test('keeps the mounted window fixed as source grows', () => {
    const source = Array.from({ length: 1_000 }, (_, index) => `Paragraph ${index}\n`).join('\n')
    const leaves = planMarkdownLeaves('row-1', source)
    const window = selectMarkdownLeafWindow(leaves, 0, 800, 800)

    expect(window.end - window.start).toBeLessThanOrEqual(MAX_MOUNTED_MARKDOWN_LEAVES)
    expect(window.bottomSpacerHeight).toBeGreaterThan(0)
  })

  test('returns prefix and suffix spacer heights around a later viewport', () => {
    const source = Array.from({ length: 500 }, (_, index) => `Paragraph ${index}\n`).join('\n')
    const leaves = planMarkdownLeaves('row-1', source)
    const window = selectMarkdownLeafWindow(leaves, 10_000, 600, 0, 3)

    expect(window.start).toBeGreaterThan(0)
    expect(window.end - window.start).toBeLessThanOrEqual(3)
    expect(window.topSpacerHeight).toBeGreaterThan(0)
    expect(window.bottomSpacerHeight).toBeGreaterThan(0)
  })
})
