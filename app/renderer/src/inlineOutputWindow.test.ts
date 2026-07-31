import { describe, expect, test } from 'bun:test'

import {
  INLINE_HEAD_LINES,
  INLINE_REVEAL_STEP,
  INLINE_TAIL_LINES,
  revealMoreLines,
  selectInlineOutputWindow,
} from './inlineOutputWindow.js'

const linesOf = (count: number) =>
  Array.from({ length: count }, (_, index) => `line ${index + 1}`)

describe('selectInlineOutputWindow', () => {
  test('under the window: everything renders and no band appears', () => {
    const lines = linesOf(INLINE_HEAD_LINES + INLINE_TAIL_LINES)
    const window = selectInlineOutputWindow(lines, INLINE_HEAD_LINES)

    expect(window.truncated).toBe(false)
    expect(window.hidden).toBe(0)
    expect(window.head).toEqual(lines)
    expect(window.tail).toEqual([])
  })

  test('one line over: the band appears and offers exactly that one line', () => {
    const lines = linesOf(INLINE_HEAD_LINES + INLINE_TAIL_LINES + 1)
    const window = selectInlineOutputWindow(lines, INLINE_HEAD_LINES)

    expect(window.truncated).toBe(true)
    expect(window.hidden).toBe(1)
    // Never offers to reveal more than is actually hidden.
    expect(window.revealStep).toBe(1)
  })

  test('far over: the head is bounded, the tail is the real last lines', () => {
    const lines = linesOf(900)
    const window = selectInlineOutputWindow(lines, INLINE_HEAD_LINES)

    expect(window.head).toHaveLength(INLINE_HEAD_LINES)
    expect(window.head.at(-1)).toBe('line 30')
    expect(window.tail).toHaveLength(INLINE_TAIL_LINES)
    // The defect this session fixes: the LAST line of the output stays visible,
    // so a truncated body can never read as a complete one.
    expect(window.tail.at(-1)).toBe('line 900')
    expect(window.hidden).toBe(900 - INLINE_HEAD_LINES - INLINE_TAIL_LINES)
    expect(window.revealStep).toBe(INLINE_REVEAL_STEP)
  })

  test('the tail carries its true line numbers, not 1..6', () => {
    const window = selectInlineOutputWindow(linesOf(900), INLINE_HEAD_LINES)

    expect(window.tailStartLine).toBe(895)
    expect(window.tail[0]).toBe('line 895')
  })

  test('a body shorter than the tail renders whole', () => {
    const lines = linesOf(3)
    const window = selectInlineOutputWindow(lines, INLINE_HEAD_LINES)

    expect(window.truncated).toBe(false)
    expect(window.head).toEqual(lines)
  })

  test('an empty result renders whole and never bands', () => {
    const window = selectInlineOutputWindow(''.split('\n'), INLINE_HEAD_LINES)

    expect(window.truncated).toBe(false)
    expect(window.hidden).toBe(0)
    expect(window.head).toEqual([''])
  })
})

describe('revealMoreLines', () => {
  test('progressive reveal shrinks the gap by one step at a time', () => {
    const lines = linesOf(900)

    const first = selectInlineOutputWindow(lines, INLINE_HEAD_LINES)
    const afterOne = revealMoreLines(INLINE_HEAD_LINES, lines.length)
    const second = selectInlineOutputWindow(lines, afterOne)

    expect(afterOne).toBe(INLINE_HEAD_LINES + INLINE_REVEAL_STEP)
    expect(second.head).toHaveLength(INLINE_HEAD_LINES + INLINE_REVEAL_STEP)
    expect(second.hidden).toBe(first.hidden - INLINE_REVEAL_STEP)
    // The tail does not move as the head grows.
    expect(second.tail).toEqual(first.tail)
  })

  test('repeated reveals converge on the whole body and retire the band', () => {
    const lines = linesOf(300)
    let headShown = INLINE_HEAD_LINES
    for (let step = 0; step < 10; step += 1) {
      headShown = revealMoreLines(headShown, lines.length)
    }

    expect(headShown).toBe(lines.length)
    const window = selectInlineOutputWindow(lines, headShown)
    expect(window.truncated).toBe(false)
    expect(window.head).toEqual(lines)
  })

  test('the head never grows past the content', () => {
    expect(revealMoreLines(INLINE_HEAD_LINES, 5)).toBe(5)
    expect(revealMoreLines(0, 0)).toBe(0)
  })
})
