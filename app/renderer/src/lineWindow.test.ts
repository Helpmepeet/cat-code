import { describe, expect, test } from 'bun:test'
import {
  MAX_MOUNTED_OUTPUT_LINES,
  OUTPUT_LINE_HEIGHT,
  selectLineWindow,
} from './lineWindow.js'

describe('selectLineWindow', () => {
  test('bounds the mounted range for arbitrarily long output', () => {
    const window = selectLineWindow(100_000, 0, 600)

    expect(window.end - window.start).toBeLessThanOrEqual(MAX_MOUNTED_OUTPUT_LINES)
    expect(window.bottomSpacerHeight).toBeGreaterThan(0)
  })

  test('preserves the logical scroll extent around a later viewport', () => {
    const window = selectLineWindow(1_000, 500 * OUTPUT_LINE_HEIGHT, 600, OUTPUT_LINE_HEIGHT, 0, 20)

    expect(window.start).toBe(500)
    expect(window.end).toBe(520)
    expect(window.topSpacerHeight).toBe(500 * OUTPUT_LINE_HEIGHT)
    expect(window.bottomSpacerHeight).toBe(480 * OUTPUT_LINE_HEIGHT)
  })
})
