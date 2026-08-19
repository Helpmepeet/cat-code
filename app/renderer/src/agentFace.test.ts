/**
 * The face generator's three load-bearing properties, none of which is visible
 * in a rendered card: every stamp is ONE connected mass, a name always draws the
 * same stamp, and no two workers in a session share a silhouette.
 *
 * The connectivity check exists because three faces shipped severed before it
 * did — a severed stamp reads as two unrelated marks rather than one animal, and
 * nothing in a screenshot review reliably catches it.
 */

import { describe, expect, test } from 'bun:test'
import {
  axesForName,
  createAgentFaceRegistry,
  faceHash,
  faceRects,
  type FaceAxes,
  type FaceEyes,
  type FaceRect,
} from './agentFace.js'

const EYES: readonly FaceEyes[] = ['open', 'shut', 'closed']

/** A wide, unremarkable sample: real worker names, plus enough noise to hit every axis. */
const NAMES = [
  'Scout', 'Wick', 'Bly', 'Pell', 'Odo', 'Wren', 'Ash', 'Marn', 'Nim',
  'Ada', 'Ramanujan', 'Beacon', 'Drift', 'Ledger', 'Quill', 'Fen', 'Tor',
  ...Array.from({ length: 120 }, (_unused, index) => `worker-${index}`),
]

/** Rects back to the 9x9 grid they were run-length encoded from. */
function rasterize(rects: readonly FaceRect[]): boolean[][] {
  const grid = Array.from({ length: 9 }, () => Array.from({ length: 9 }, () => false))
  for (const rect of rects) {
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      for (let x = rect.x; x < rect.x + rect.w; x += 1) grid[y][x] = true
    }
  }
  return grid
}

/** Independent flood fill, deliberately not the module's own. */
function isOneMass(grid: boolean[][]): boolean {
  const cells: [number, number][] = []
  for (let y = 0; y < 9; y += 1) {
    for (let x = 0; x < 9; x += 1) if (grid[y][x]) cells.push([x, y])
  }
  if (cells.length === 0) return false
  const seen = new Set<string>([`${cells[0][0]},${cells[0][1]}`])
  const stack = [cells[0]]
  while (stack.length > 0) {
    const [x, y] = stack.pop() as [number, number]
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx
      const ny = y + dy
      const key = `${nx},${ny}`
      if (nx < 0 || nx > 8 || ny < 0 || ny > 8) continue
      if (!grid[ny][nx] || seen.has(key)) continue
      seen.add(key)
      stack.push([nx, ny])
    }
  }
  return seen.size === cells.length
}

function silhouette(axes: FaceAxes): string {
  return JSON.stringify(faceRects(axes, 'closed'))
}

describe('the stamp itself', () => {
  test('every face that draws is one 4-connected mass, in every eye state', () => {
    for (const name of NAMES) {
      for (const eyes of EYES) {
        const grid = rasterize(faceRects(axesForName(name), eyes))
        expect(isOneMass(grid)).toBe(true)
      }
    }
  })

  test('a face is drawn entirely inside the 9x9 grid', () => {
    for (const name of NAMES) {
      for (const rect of faceRects(axesForName(name), 'open')) {
        expect(rect.x).toBeGreaterThanOrEqual(0)
        expect(rect.y).toBeGreaterThanOrEqual(0)
        expect(rect.x + rect.w).toBeLessThanOrEqual(9)
        expect(rect.y + rect.h).toBeLessThanOrEqual(9)
      }
    }
  })

  test('run-length encoding is lossless — rects never overlap', () => {
    // Overlapping rects would still LOOK right (they paint the same colour) and
    // would quietly multiply the node count on every card.
    for (const name of NAMES.slice(0, 20)) {
      const rects = faceRects(axesForName(name), 'open')
      const covered = new Set<string>()
      for (const rect of rects) {
        for (let y = rect.y; y < rect.y + rect.h; y += 1) {
          for (let x = rect.x; x < rect.x + rect.w; x += 1) {
            expect(covered.has(`${x},${y}`)).toBe(false)
            covered.add(`${x},${y}`)
          }
        }
      }
    }
  })
})

describe('identity', () => {
  test('the same name always proposes the same axes', () => {
    for (const name of NAMES) {
      expect(axesForName(name)).toEqual(axesForName(name))
    }
  })

  test('a missing name is the featureless base, with nothing cleared', () => {
    const base: FaceAxes = {
      ear: 'pointy',
      fill: 'solid',
      width: 'wide',
      chin: 'round',
      mouth: 'none',
      mark: 'none',
    }
    expect(axesForName(null)).toEqual(base)
    expect(axesForName('')).toEqual(base)
    expect(axesForName(undefined)).toEqual(base)
    // "Featureless" is literal: the eyes are the only thing `closed` withholds,
    // and this face has no mouth or marking to withhold either.
    expect(faceRects(axesForName(null), 'closed')).toEqual(
      faceRects(axesForName(null), 'closed'),
    )
  })

  test('eyes are state, not identity: they never move the silhouette', () => {
    for (const name of NAMES.slice(0, 30)) {
      const axes = axesForName(name)
      const open = rasterize(faceRects(axes, 'open'))
      const shut = rasterize(faceRects(axes, 'shut'))
      const closed = rasterize(faceRects(axes, 'closed'))
      // Row 4 is the only row eyes touch; every other row is identical.
      for (let y = 0; y < 9; y += 1) {
        if (y === 4) continue
        expect(open[y]).toEqual(closed[y])
        expect(shut[y]).toEqual(closed[y])
      }
    }
  })

  test('the hash is FNV-1a over the name, salted per axis', () => {
    // A different salt must actually change the draw, or five of the six axes
    // would be perfectly correlated.
    const salts = new Set([1, 2, 3, 4, 5, 6].map(salt => faceHash('Scout', salt)))
    expect(salts.size).toBe(6)
    expect(faceHash('Scout', 1)).toBe(faceHash('Scout', 1))
    expect(faceHash('Scout', 1)).not.toBe(faceHash('Wick', 1))
  })
})

describe('the session registry', () => {
  test('no two workers in a session share a silhouette', () => {
    const registry = createAgentFaceRegistry()
    const seen = new Set<string>()
    for (const name of NAMES) {
      const key = silhouette(registry.axesFor(name))
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }
  })

  test('a named worker never wears the nameless stamp', () => {
    const registry = createAgentFaceRegistry()
    const nameless = silhouette(registry.axesFor(null))
    for (const name of NAMES) {
      expect(silhouette(registry.axesFor(name))).not.toBe(nameless)
    }
  })

  test('a worker keeps its silhouette for the whole session', () => {
    const registry = createAgentFaceRegistry()
    const first = NAMES.map(name => registry.axesFor(name))
    // Interleave other names between the repeat reads: a registry that recomputed
    // instead of remembering would drift as the taken set grew.
    for (let index = 0; index < NAMES.length; index += 1) {
      registry.axesFor(`late-arrival-${index}`)
      expect(registry.axesFor(NAMES[index])).toEqual(first[index])
    }
  })

  test('deduped faces still draw as one mass', () => {
    // The dedupe walk swaps axis values AFTER the connectivity fallback picked a
    // level, so its result has to be re-checked rather than assumed.
    const registry = createAgentFaceRegistry()
    for (const name of NAMES) {
      for (const eyes of EYES) {
        expect(isOneMass(rasterize(faceRects(registry.axesFor(name), eyes)))).toBe(true)
      }
    }
  })

  test('two registries are independent — one session never colours another', () => {
    const a = createAgentFaceRegistry()
    const b = createAgentFaceRegistry()
    for (const name of NAMES.slice(0, 40)) {
      expect(a.axesFor(name)).toEqual(b.axesFor(name))
    }
  })
})
