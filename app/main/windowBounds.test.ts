import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clampWindowBounds,
  readWindowBounds,
  writeWindowBounds,
} from './windowBounds.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cat-code-window-bounds-'))
  roots.push(root)
  return root
}

const MINIMUM = { width: 852, height: 467 }

describe('window bounds persistence', () => {
  // The regression: createWindow used literal width/height and never read or
  // wrote geometry, so every launch discarded the operator's arrangement.
  test('round-trips the geometry it was given', () => {
    const root = tempRoot()
    expect(readWindowBounds(root)).toBeNull()

    writeWindowBounds(root, { x: 120, y: 64, width: 1440, height: 900 })

    expect(readWindowBounds(root)).toEqual({
      x: 120,
      y: 64,
      width: 1440,
      height: 900,
    })
  })

  test('a negative origin is preserved, as a display left of or above the primary', () => {
    const root = tempRoot()
    writeWindowBounds(root, { x: -1600, y: -300, width: 1200, height: 800 })

    expect(readWindowBounds(root)).toEqual({
      x: -1600,
      y: -300,
      width: 1200,
      height: 800,
    })
  })

  // Fail OPEN: every unreadable shape means "open at the defaults", never
  // "fail the launch".
  test('reads null rather than throwing on an absent, corrupt or foreign file', () => {
    expect(readWindowBounds(join(tempRoot(), 'no-such-directory'))).toBeNull()

    const corrupt = tempRoot()
    writeFileSync(join(corrupt, 'window-bounds.json'), '{ half a fi')
    expect(readWindowBounds(corrupt)).toBeNull()

    const wrongVersion = tempRoot()
    writeFileSync(
      join(wrongVersion, 'window-bounds.json'),
      JSON.stringify({ version: 2, x: 0, y: 0, width: 1100, height: 720 }),
    )
    expect(readWindowBounds(wrongVersion)).toBeNull()
  })

  test('rejects a file whose numbers are not usable geometry', () => {
    for (const partial of [
      { x: 0, y: 0, width: 0, height: 720 },
      { x: 0, y: 0, width: 1100, height: -720 },
      { x: 'left', y: 0, width: 1100, height: 720 },
      { x: 0, y: 0, width: 1100 },
      { x: 0, y: 0, width: null, height: 720 },
    ]) {
      const root = tempRoot()
      writeFileSync(
        join(root, 'window-bounds.json'),
        JSON.stringify({ version: 1, ...partial }),
      )
      expect(readWindowBounds(root)).toBeNull()
    }
  })

  test('never writes geometry it would refuse to read back', () => {
    const root = tempRoot()
    writeWindowBounds(root, { x: 0, y: 0, width: Number.NaN, height: 720 })

    expect(readWindowBounds(root)).toBeNull()
  })

  test('an unwritable directory is silent, not fatal', () => {
    // A path whose parent is a FILE cannot be created as a directory.
    const root = tempRoot()
    const file = join(root, 'occupied')
    writeFileSync(file, 'not a directory')

    expect(() =>
      writeWindowBounds(join(file, 'nested'), {
        x: 0,
        y: 0,
        width: 1100,
        height: 720,
      }),
    ).not.toThrow()
  })
})

describe('clampWindowBounds', () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1080 }

  test('leaves bounds that already fit alone', () => {
    expect(
      clampWindowBounds(
        { x: 200, y: 100, width: 1400, height: 800 },
        primary,
        MINIMUM,
      ),
    ).toEqual({ x: 200, y: 100, width: 1400, height: 800 })
  })

  // The reason the clamp exists: a window saved on an external display that is
  // no longer attached would otherwise open entirely off-screen, where it can be
  // neither seen nor dragged back.
  test('pulls a window saved on a detached display back onto the visible area', () => {
    const restored = clampWindowBounds(
      { x: 3200, y: -1400, width: 1200, height: 800 },
      primary,
      MINIMUM,
    )

    expect(restored.x).toBeGreaterThanOrEqual(primary.x)
    expect(restored.y).toBeGreaterThanOrEqual(primary.y)
    expect(restored.x + restored.width).toBeLessThanOrEqual(
      primary.x + primary.width,
    )
    expect(restored.y + restored.height).toBeLessThanOrEqual(
      primary.y + primary.height,
    )
  })

  test('shrinks a window larger than the target display to fit it', () => {
    const small = { x: 0, y: 0, width: 1280, height: 720 }

    expect(
      clampWindowBounds({ x: 0, y: 0, width: 3840, height: 2160 }, small, MINIMUM),
    ).toEqual({ x: 0, y: 0, width: 1280, height: 720 })
  })

  // The existing minimum-size behaviour must survive the restore: Electron's own
  // minWidth/minHeight would fight anything smaller.
  test('never returns anything below the layout minimum', () => {
    const clamped = clampWindowBounds(
      { x: 0, y: 0, width: 200, height: 120 },
      primary,
      MINIMUM,
    )

    expect(clamped.width).toBe(MINIMUM.width)
    expect(clamped.height).toBe(MINIMUM.height)
  })

  test('keeps the minimum even when the work area is smaller than it', () => {
    const tiny = { x: 0, y: 0, width: 400, height: 300 }
    const clamped = clampWindowBounds(
      { x: 0, y: 0, width: 1100, height: 720 },
      tiny,
      MINIMUM,
    )

    expect(clamped.width).toBe(MINIMUM.width)
    expect(clamped.height).toBe(MINIMUM.height)
    // Pinned to the area's own origin rather than pushed off its left edge.
    expect(clamped.x).toBe(tiny.x)
    expect(clamped.y).toBe(tiny.y)
  })

  test('respects a work area that does not start at the origin', () => {
    // A secondary display placed to the right of the primary, with a menu bar.
    const secondary = { x: 1920, y: 25, width: 1512, height: 920 }

    expect(
      clampWindowBounds(
        { x: 4000, y: 0, width: 1200, height: 800 },
        secondary,
        MINIMUM,
      ),
    ).toEqual({ x: 2232, y: 25, width: 1200, height: 800 })
  })
})
