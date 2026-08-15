/**
 * Every other assertion about a mounting budget reads
 * `expect(measured).toBeLessThanOrEqual(MAX_SOMETHING)`, which compares the
 * budget against itself: raising the constant WEAKENS the assertion instead of
 * failing it. An adversarial review confirmed it, taking
 * `MAX_MOUNTED_MARKDOWN_LEAVES` and `MAX_MOUNTED_OUTPUT_LINES` to a billion
 * with the whole suite still green.
 *
 * These are the absolute values. Raising one is a deliberate act with a
 * measured reason, so it should have to come through this file.
 */
import { describe, expect, test } from 'bun:test'
import {
  MAX_MOUNTED_COMPOSITE_CHILDREN,
  MAX_RETAINED_CHILD_MEASUREMENTS,
} from './compositeChildWindow.js'
import { MAX_MOUNTED_CHUNK_CHARS, MAX_MOUNTED_OUTPUT_LINES } from './lineWindow.js'
import {
  MAX_MARKDOWN_LEAF_CHARACTERS,
  MAX_MARKDOWN_LEAF_CHILDREN,
  MAX_MARKDOWN_LEAF_LINES,
  MAX_MOUNTED_MARKDOWN_LEAVES,
} from './markdownRenderPlan.js'
import { MAX_RENDERED_HIGHLIGHT_SEGMENTS } from './outputSearchModel.js'

describe('mounting budgets are pinned to their measured values', () => {
  test('markdown leaves', () => {
    expect(MAX_MARKDOWN_LEAF_LINES).toBe(200)
    expect(MAX_MARKDOWN_LEAF_CHARACTERS).toBe(12_000)
    expect(MAX_MARKDOWN_LEAF_CHILDREN).toBe(200)
    expect(MAX_MOUNTED_MARKDOWN_LEAVES).toBe(120)
  })

  test('tool output lines and chunks', () => {
    expect(MAX_MOUNTED_OUTPUT_LINES).toBe(200)
    expect(MAX_MOUNTED_CHUNK_CHARS).toBe(4_000)
    expect(MAX_RENDERED_HIGHLIGHT_SEGMENTS).toBe(300)
  })

  test('composite container children', () => {
    expect(MAX_MOUNTED_COMPOSITE_CHILDREN).toBe(80)
    // Three times the mount ceiling, so a child can leave and return without
    // losing its height.
    expect(MAX_RETAINED_CHILD_MEASUREMENTS).toBe(MAX_MOUNTED_COMPOSITE_CHILDREN * 3)
  })
})
