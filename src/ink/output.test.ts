import { describe, expect, test } from 'bun:test'
import Output from './output.js'
import {
  CharPool,
  HyperlinkPool,
  StylePool,
  charInCellAt,
  createScreen,
  diff,
} from './screen.js'

function renderLine(
  line: string,
  clip?: {
    x1?: number
    x2?: number
    y1?: number
    y2?: number
  },
) {
  const stylePool = new StylePool()
  const charPool = new CharPool()
  const hyperlinkPool = new HyperlinkPool()
  const prev = createScreen(80, 2, stylePool, charPool, hyperlinkPool)
  const screen = createScreen(80, 2, stylePool, charPool, hyperlinkPool)
  const output = new Output({ width: 80, height: 2, stylePool, screen })

  if (clip) output.clip(clip)
  output.write(0, 0, line)
  if (clip) output.unclip()
  const rendered = output.get()

  return { rendered, changes: diff(prev, rendered) }
}

describe('Output', () => {
  test('preserves whole-line iTerm2 inline image sequences', () => {
    const sequence = '\x1b]1337;File=inline=1;size=4:AAAA\x07'
    const { rendered, changes } = renderLine(sequence)

    expect(charInCellAt(rendered, 0, 0)).toBe(sequence)
    expect(changes).toHaveLength(1)
    expect(changes[0]?.[2]?.char).toBe(sequence)
  })

  test('preserves whole-line iTerm2 inline image sequences inside horizontal clips', () => {
    const sequence = '\x1b]1337;File=inline=1;size=4:AAAA\x07'
    const { rendered, changes } = renderLine(`${sequence}\n\n`, {
      x1: 0,
      x2: 80,
    })

    expect(charInCellAt(rendered, 0, 0)).toBe(sequence)
    expect(changes).toHaveLength(1)
    expect(changes[0]?.[2]?.char).toBe(sequence)
  })

  test('preserves whole-line tmux-wrapped iTerm2 inline image sequences', () => {
    const sequence = '\x1bPtmux;\x1b\x1b]1337;File=inline=1;size=4:AAAA\x07\x1b\\'
    const { rendered, changes } = renderLine(sequence)

    expect(charInCellAt(rendered, 0, 0)).toBe(sequence)
    expect(changes).toHaveLength(1)
    expect(changes[0]?.[2]?.char).toBe(sequence)
  })

  test('preserves whole-line tmux-wrapped iTerm2 inline image sequences inside horizontal clips', () => {
    const sequence = '\x1bPtmux;\x1b\x1b]1337;File=inline=1;size=4:AAAA\x07\x1b\\'
    const { rendered, changes } = renderLine(`${sequence}\n\n`, {
      x1: 0,
      x2: 80,
    })

    expect(charInCellAt(rendered, 0, 0)).toBe(sequence)
    expect(changes).toHaveLength(1)
    expect(changes[0]?.[2]?.char).toBe(sequence)
  })
})
