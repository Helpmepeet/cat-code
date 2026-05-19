import { describe, expect, test } from 'bun:test'
import { LogUpdate } from './log-update.js'
import Output from './output.js'
import {
  CharPool,
  HyperlinkPool,
  StylePool,
  charInCellAt,
  createScreen,
  diff,
} from './screen.js'
import { writeDiffToTerminal } from './terminal.js'

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

function renderFrame(
  stylePool: StylePool,
  charPool: CharPool,
  hyperlinkPool: HyperlinkPool,
  text: string,
) {
  const screen = createScreen(80, 20, stylePool, charPool, hyperlinkPool)
  const output = new Output({ width: 80, height: 20, stylePool, screen })
  output.write(0, 0, text)
  return {
    screen: output.get(),
    viewport: { width: 80, height: 40 },
    cursor: { x: 0, y: 20, visible: false },
  }
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

  test('preserves multipart iTerm2 inline image sequences', () => {
    const sequence =
      '\x1b]1337;MultipartFile=inline=1;size=4;width=48;height=16;type=image/png\x07' +
      '\x1b]1337;FilePart=AAAA\x07' +
      '\x1b]1337;FileEnd\x07'
    const { rendered, changes } = renderLine(sequence)

    expect(charInCellAt(rendered, 0, 0)).toBe(sequence)
    expect(changes).toHaveLength(1)
    expect(changes[0]?.[2]?.char).toBe(sequence)
  })

  test('marks iTerm2 inline image regions as non-selectable', () => {
    const sequence =
      '\x1b]1337;MultipartFile=inline=1;size=4;width=3;height=2;type=image/png\x07' +
      '\x1b]1337;FilePart=AAAA\x07' +
      '\x1b]1337;FileEnd\x07'
    const { rendered } = renderLine(sequence)

    expect(rendered.noSelect[0]).toBe(1)
    expect(rendered.noSelect[1]).toBe(1)
    expect(rendered.noSelect[2]).toBe(1)
    expect(rendered.noSelect[80]).toBe(1)
    expect(rendered.noSelect[81]).toBe(1)
    expect(rendered.noSelect[82]).toBe(1)
    expect(rendered.noSelect[3]).toBe(0)
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

  test('clears stale text before writing an inline image', () => {
    const stylePool = new StylePool()
    const charPool = new CharPool()
    const hyperlinkPool = new HyperlinkPool()
    const sequence =
      '\x1b]1337;MultipartFile=inline=1;size=4;width=48;height=16;type=image/png\x07' +
      '\x1b]1337;FilePart=AAAA\x07' +
      '\x1b]1337;FileEnd\x07'

    const patches = new LogUpdate({ isTTY: true, stylePool }).render(
      renderFrame(stylePool, charPool, hyperlinkPool, 'Rendering preview…'),
      renderFrame(stylePool, charPool, hyperlinkPool, `${sequence}\n\n`),
    )
    const imagePatchIndex = patches.findIndex(
      patch => patch.type === 'stdout' && patch.content === sequence,
    )

    expect(imagePatchIndex).toBeGreaterThanOrEqual(0)
    expect(
      patches
        .slice(0, imagePatchIndex)
        .some(
          patch =>
            patch.type === 'stdout' &&
            patch.content === ' '.repeat(48),
        ),
    ).toBe(true)
    expect(
      patches
        .slice(imagePatchIndex + 1)
        .some(
          patch =>
            patch.type === 'stdout' &&
            patch.content === ' '.repeat(48),
        ),
    ).toBe(false)
  })

  test('does not wrap inline images in synchronized output markers', () => {
    const sequence =
      '\x1b]1337;MultipartFile=inline=1;size=4;width=48;height=16;type=image/png\x07' +
      '\x1b]1337;FilePart=AAAA\x07' +
      '\x1b]1337;FileEnd\x07'
    let written = ''
    const stream = {
      write(chunk: string) {
        written += chunk
        return true
      },
    }

    writeDiffToTerminal(
      { stdout: stream, stderr: stream } as never,
      [{ type: 'stdout', content: sequence }],
    )

    expect(written).toBe(sequence)
  })
})
