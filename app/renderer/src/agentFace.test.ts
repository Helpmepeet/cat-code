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
  createAgentFaceRegistryStore,
  faceHash,
  faceRects,
  type FaceAxes,
  type FaceRect,
} from './agentFace.js'

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
  return JSON.stringify(faceRects(axes))
}

/** The seven axes as one readable line, for pinning a face by value. */
function axesKeyOf(axes: FaceAxes): string {
  return `${axes.ear}|${axes.fill}|${axes.width}|${axes.chin}|${axes.mouth}|${axes.mark}|${axes.head}`
}

/** The identity draw as one cell per byte, so two faces can be compared by distance. */
function maskOf(axes: FaceAxes): Uint8Array {
  const mask = new Uint8Array(81)
  const grid = rasterize(faceRects(axes))
  for (let y = 0; y < 9; y += 1) {
    for (let x = 0; x < 9; x += 1) if (grid[y][x]) mask[y * 9 + x] = 1
  }
  return mask
}

/** Cells that differ between two silhouettes, out of 81. */
function cellsApart(a: Uint8Array, b: Uint8Array): number {
  let apart = 0
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) apart += 1
  return apart
}

/** The closest pair among a session's faces, which is the number a reader feels. */
function closestPair(masks: readonly Uint8Array[]): number {
  let closest = 81
  for (let i = 0; i < masks.length; i += 1) {
    for (let j = i + 1; j < masks.length; j += 1) {
      closest = Math.min(closest, cellsApart(masks[i], masks[j]))
    }
  }
  return closest
}

describe('the stamp itself', () => {
  test('every face that draws is one 4-connected mass', () => {
    for (const name of NAMES) {
      expect(isOneMass(rasterize(faceRects(axesForName(name))))).toBe(true)
    }
  })

  test('a face is drawn entirely inside the 9x9 grid', () => {
    for (const name of NAMES) {
      for (const rect of faceRects(axesForName(name))) {
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
      const rects = faceRects(axesForName(name))
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
      head: 'square',
    }
    expect(axesForName(null)).toEqual(base)
    expect(axesForName('')).toEqual(base)
    expect(axesForName(undefined)).toEqual(base)
  })



  test('the hash is FNV-1a over the name, salted per axis', () => {
    // A different salt must actually change the draw, or six of the seven axes
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
      const key = silhouette(registry.faceFor(name).axes)
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }
  })

  test('a named worker never wears the nameless stamp', () => {
    const registry = createAgentFaceRegistry()
    const nameless = silhouette(registry.faceFor(null).axes)
    for (const name of NAMES) {
      expect(silhouette(registry.faceFor(name).axes)).not.toBe(nameless)
    }
  })

  test('a worker keeps its silhouette for the whole session', () => {
    const registry = createAgentFaceRegistry()
    const first = NAMES.map(name => registry.faceFor(name).axes)
    // Interleave other names between the repeat reads: a registry that recomputed
    // instead of remembering would drift as the taken set grew.
    for (let index = 0; index < NAMES.length; index += 1) {
      registry.faceFor(`late-arrival-${index}`)
      expect(registry.faceFor(NAMES[index]).axes).toEqual(first[index])
    }
  })

  test('deduped faces still draw as one mass', () => {
    // The dedupe walk swaps axis values AFTER the connectivity fallback picked a
    // level, so its result has to be re-checked rather than assumed.
    const registry = createAgentFaceRegistry()
    for (const name of NAMES) {
      expect(isOneMass(rasterize(faceRects(registry.faceFor(name).axes)))).toBe(true)
    }
  })

  test('two registries are independent — one session never colours another', () => {
    const a = createAgentFaceRegistry()
    const b = createAgentFaceRegistry()
    for (const name of NAMES.slice(0, 40)) {
      expect(a.faceFor(name)).toEqual(b.faceFor(name))
    }
  })
})

describe('telling two workers apart', () => {
  // The bar used to be byte-inequality, and a cell is ~2px on a 19px card. These
  // pin the DISTANCE rule, which is the only thing standing between the registry
  // and a pair of faces it calls distinct and a reader calls identical.

  test('the reported near-twins separate', () => {
    // @scout and @deckard drew one cell apart — a single temple marking — and the
    // registry reported them unique. This is the case that motivated the rule.
    const registry = createAgentFaceRegistry()
    const scout = maskOf(registry.faceFor('scout').axes)
    const deckard = maskOf(registry.faceFor('deckard').axes)
    expect(cellsApart(scout, deckard)).toBeGreaterThanOrEqual(4)
  })

  test('a plausible session has no pair a reader would confuse', () => {
    const registry = createAgentFaceRegistry()
    const masks = NAMES.slice(0, 40).map(name => maskOf(registry.faceFor(name).axes))
    expect(closestPair(masks)).toBeGreaterThanOrEqual(4)
  })

  test('the well-separated supply lasts well past any real session', () => {
    // 336 workers before the ladder has to drop a bar. Stated as a floor rather
    // than pinned exactly: the figure moves with the axis space, and what the
    // rule promises is "far more than a session holds", not a constant.
    const registry = createAgentFaceRegistry()
    const masks: Uint8Array[] = []
    let separated = 0
    for (let index = 0; index < 300; index += 1) {
      const mask = maskOf(registry.faceFor(`worker-${index}`).axes)
      const closest = masks.reduce((best, held) => Math.min(best, cellsApart(held, mask)), 81)
      if (closest < 4) break
      separated += 1
      masks.push(mask)
    }
    expect(separated).toBeGreaterThanOrEqual(250)
  })

  test('outrunning the supply degrades to distinct, never to shared', () => {
    // The ladder's whole point: the strict bar must not make the crowded case
    // WORSE than the byte-inequality rule it replaced.
    const registry = createAgentFaceRegistry()
    const seen = new Set<string>()
    for (let index = 0; index < 300; index += 1) {
      const key = silhouette(registry.faceFor(`crowd-${index}`).axes)
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }
  })

  test('the dedupe walk hands out the same faces it always has', () => {
    // Every property above is satisfied by MANY different assignments, so none of
    // them notices the dedupe ladder being re-ordered or an axis rotating through
    // a different value list. This pins the answers themselves: one registry, one
    // fixed registration order, and the face each of these names ends up wearing.
    // The picks span the whole ladder — `deckard` and `worker-20` move on mouth,
    // `worker-7`/`worker-13`/`worker-25` on chin, `worker-35`/`worker-47` on
    // width, `worker-40`/`worker-58` on ear, `worker-59` on fill — plus `Wren`
    // and `Ledger`, which the walk never touches, as controls.
    const PINNED: Record<string, [string, number]> = {
      Wren: ['tuft|notch|wide|fringe|smile|brow|square', 4],
      Ledger: ['tall|deep|narrow|round|slit|brow|rounded', 0],
      deckard: ['pointy|solid|wide|flat|none|temple|square', 3],
      'worker-6': ['tall|notch|narrow|round|smile|cheek|rounded', 2],
      'worker-7': ['pointy|solid|wide|round|smile|brow|square', 1],
      'worker-13': ['pointy|solid|narrow|fringe|slit|chindot|rounded', 2],
      'worker-20': ['folded|deep|narrow|round|none|none|rounded', 8],
      'worker-25': ['folded|deep|wide|pointed|none|chindot|square', 1],
      'worker-35': ['tall|solid|wide|pointed|slit|none|rounded', 2],
      'worker-40': ['outer|deep|narrow|pointed|slit|cheek|rounded', 8],
      'worker-47': ['folded|solid|narrow|fringe|none|none|square', 3],
      'worker-58': ['pointy|deep|wide|fringe|none|chindot|square', 5],
      'worker-59': ['outer|deep|narrow|round|omega|none|rounded', 6],
    }
    const order = [
      'scout', 'deckard', 'Wren', 'Ledger', 'Beacon', 'Drift', 'Quill', 'Ash', 'Nim', 'Odo',
      ...Array.from({ length: 60 }, (_unused, index) => `worker-${index}`),
    ]
    const registry = createAgentFaceRegistry()
    const drawn = new Map<string, [string, number]>()
    for (const name of order) {
      const identity = registry.faceFor(name)
      drawn.set(name, [axesKeyOf(identity.axes), identity.fill])
    }
    for (const [name, expected] of Object.entries(PINNED)) {
      expect(drawn.get(name)).toEqual(expected)
    }
  })
})

describe('the relaxation search', () => {
  const EAR = ['pointy', 'outer', 'tuft', 'folded', 'tall'] as const
  const FILL = ['solid', 'notch', 'deep'] as const
  const WIDTH = ['wide', 'narrow'] as const
  const CHIN = ['round', 'flat', 'pointed', 'fringe'] as const
  const MOUTH = ['none', 'slit', 'smile', 'omega'] as const
  const MARK = ['none', 'brow', 'cheek', 'temple', 'chindot'] as const
  const HEAD = ['square', 'rounded'] as const

  /** Every axis combination the hash can propose. */
  function everyAxes(): FaceAxes[] {
    const out: FaceAxes[] = []
    for (const ear of EAR)
      for (const fill of FILL)
        for (const width of WIDTH)
          for (const chin of CHIN)
            for (const mouth of MOUTH)
              for (const mark of MARK)
                for (const head of HEAD)
                  out.push({ ear, fill, width, chin, mouth, mark, head })
    return out
  }

  /**
   * A face with nothing cut out of its head reads as a slab with ears, not as an
   * animal. Rows 2, 3, 5 and 6 are where every interior carve lands (ear fill,
   * mouth, markings); solid across all four means the search gave everything up.
   */
  function isFeatureless(axes: FaceAxes): boolean {
    const grid = rasterize(faceRects(axes))
    const left = axes.width === 'wide' ? 0 : 1
    const right = axes.width === 'wide' ? 8 : 7
    const solid = (row: number): boolean => {
      for (let c = left; c <= right; c += 1) if (!grid[row][c]) return false
      return true
    }
    return solid(2) && solid(3) && solid(5) && solid(6)
  }

  test('the reported case draws a face, not a slab', () => {
    // @Backus, seen on a real card as a featureless blob (2026-08-19). Its hash
    // asked for a deep ear fill, an omega mouth and a chin-dot; the design
    // source's linear ladder dropped all three. The omega really does sever a
    // narrow pointed chin, so the mouth has to go — but giving it up RESTORES
    // the chin-dot the mouth-vs-chin-dot exclusion was suppressing, and the face
    // keeps a mark of its own.
    const backus: FaceAxes = {
      ear: 'folded',
      fill: 'deep',
      width: 'narrow',
      chin: 'pointed',
      mouth: 'omega',
      mark: 'chindot',
      head: 'square',
    }
    expect(isFeatureless(backus)).toBe(false)
    expect(isOneMass(rasterize(faceRects(backus)))).toBe(true)
  })

  test('a featureless slab stays the rare exception, not a third of the space', () => {
    // The linear ladder this replaced left 838 of 2,400 (35%) with no interior
    // feature at all — 75% of `folded` ears and 76% of `tall`. Pinned well above
    // the current 168 of 4,800 so ordinary tuning does not trip it, and far below
    // the regression it exists to catch. `head` is a shape axis, so doubling the
    // space with it left the slab COUNT untouched and halved its share.
    const all = everyAxes()
    const bare = all.filter(isFeatureless).length
    expect(all).toHaveLength(4800)
    expect(bare).toBeLessThan(300)
  })

  test('a face gives up the cheaper carve before the more legible one', () => {
    // The search is ordered by what a relaxation costs a reader. Concretely: no
    // face may lose its mouth while a merely-softened ear fill would have kept
    // it whole, which is the mistake the fixed ladder made on every `folded` and
    // `tall` ear.
    const keptMouth = everyAxes().filter(axes => {
      if (axes.mouth === 'none') return false
      const grid = rasterize(faceRects(axes))
      const mid = axes.width === 'wide' ? 4 : 4
      // Any mouth carves row 5 or row 6 near the midline.
      return !grid[5][mid] || !grid[6][mid - 1] || !grid[6][mid + 1] || !grid[6][mid]
    }).length
    // 1,800 combinations ask for a mouth; the fixed ladder delivered 960.
    expect(keptMouth).toBeGreaterThan(1400)
  })
})

describe('the head axis and the chin-dot', () => {
  const BASE: FaceAxes = {
    ear: 'pointy',
    fill: 'solid',
    width: 'wide',
    chin: 'round',
    mouth: 'none',
    mark: 'none',
    head: 'square',
  }

  test('a rounded head clears the distance bar on its own', () => {
    // The reason `head` is a SHAPE axis and not another carve: under the distance
    // rule an axis worth one or two cells adds no faces the registry will accept,
    // because every pair it creates is a near-twin it then refuses.
    for (const ear of ['pointy', 'outer', 'tuft', 'folded', 'tall'] as const) {
      const square = maskOf({ ...BASE, ear })
      const rounded = maskOf({ ...BASE, ear, head: 'rounded' })
      expect(cellsApart(square, rounded)).toBeGreaterThanOrEqual(4)
    }
  })

  test('a chin-dot moves down beside a slit instead of being dropped', () => {
    // It used to be dropped against ANY mouth, which cost the face its only
    // marking for a collision a slit does not actually have.
    const withDot = rasterize(faceRects({ ...BASE, mouth: 'slit', mark: 'chindot' }))
    const without = rasterize(faceRects({ ...BASE, mouth: 'slit', mark: 'none' }))
    expect(withDot).not.toEqual(without)
  })

  test('an omega still loses the dot, because the two really do conflict', () => {
    // Not the old blanket exclusion — a genuine geometric collision the
    // connectivity search finds on its own. An omega clears (mid, 5), (mid-1, 6)
    // and (mid+1, 6); a dot at (mid, 7) would strand (mid, 6) with no filled
    // neighbour left, so the face would draw severed and the ladder gives the
    // marking up to keep it whole.
    const withDot = rasterize(faceRects({ ...BASE, mouth: 'omega', mark: 'chindot' }))
    const without = rasterize(faceRects({ ...BASE, mouth: 'omega', mark: 'none' }))
    expect(withDot).toEqual(without)
  })

  test('a chin-dot still gives way to a smile, which already takes its row', () => {
    const withDot = rasterize(faceRects({ ...BASE, mouth: 'smile', mark: 'chindot' }))
    const without = rasterize(faceRects({ ...BASE, mouth: 'smile', mark: 'none' }))
    expect(withDot).toEqual(without)
  })
})

describe('the face is identity, not state', () => {
  // 2026-08-21 operator ruling. The eyes used to be state — `open` live, `shut`
  // completed, `away` backgrounded — which is what made a fan-out of five
  // backgrounded workers render as five blank slabs. There is now ONE drawing per
  // worker, and the row's own slot carries the run.

  test('a worker draws the same face whatever it is doing', () => {
    // There is no state input left to vary, which is the property: the drawing
    // function cannot be told what the worker is up to.
    const registry = createAgentFaceRegistry()
    const first = NAMES.map(name => silhouette(registry.faceFor(name).axes))
    const second = NAMES.map(name => silhouette(registry.faceFor(name).axes))
    expect(second).toEqual(first)
  })

  test('every face has eyes', () => {
    // The eye carve is unconditional now. Two cleared cells on row 4 are what
    // makes the stamp read as an animal rather than a brick.
    for (const name of NAMES.slice(0, 60)) {
      const grid = rasterize(faceRects(axesForName(name)))
      const cleared = grid[4].filter(cell => !cell).length
      expect(cleared).toBeGreaterThanOrEqual(2)
    }
  })

  test('an id and a name for one worker resolve to one face', () => {
    // The completion notification has only a name; the card has an id. Without
    // the alias the same worker would wear two faces in one transcript.
    const registry = createAgentFaceRegistry()
    const fromCard = silhouette(registry.faceFor('agent_01H', 'scout').axes)
    expect(silhouette(registry.faceFor('scout').axes)).toBe(fromCard)
    expect(silhouette(registry.faceFor('agent_01H').axes)).toBe(fromCard)
  })

  test('the id arriving after the name does not move the face', () => {
    // The order a foreground card actually takes: it draws by name while it runs,
    // because the id only rides the settled result. Adopting the name's face is
    // what keeps the card from redrawing the moment the worker finishes.
    const registry = createAgentFaceRegistry()
    const byName = silhouette(registry.faceFor(null, 'lambert').axes)
    expect(silhouette(registry.faceFor('agent_05C', 'lambert').axes)).toBe(byName)
  })

  test('a second worker under a taken name does NOT adopt the first one', () => {
    // The other half of the same rule. An alias already owned by an id is spoken
    // for; only an unowned one is adoptable.
    const registry = createAgentFaceRegistry()
    const first = silhouette(registry.faceFor('agent_06D', 'kane').axes)
    expect(silhouette(registry.faceFor('agent_07E', 'kane').axes)).not.toBe(first)
  })

  test('colour is deduped like shape, so a plausible session has no repeat', () => {
    // Ten hashes over ten fills collide about 70% of the time at five workers.
    // The registry walks up from the proposed fill instead.
    const registry = createAgentFaceRegistry()
    const fills = NAMES.slice(0, 10).map(name => registry.faceFor(name).fill)
    expect(new Set(fills).size).toBe(10)
  })

  test('past the palette a colour repeats rather than going blank', () => {
    const registry = createAgentFaceRegistry()
    const fills = NAMES.slice(0, 14).map(name => registry.faceFor(name).fill)
    expect(new Set(fills).size).toBe(10)
    for (const fill of fills) {
      expect(fill).toBeGreaterThanOrEqual(0)
      expect(fill).toBeLessThan(10)
    }
  })

  test('the name arriving after the id does not move the face', () => {
    const registry = createAgentFaceRegistry()
    const byId = silhouette(registry.faceFor('agent_02K').axes)
    expect(silhouette(registry.faceFor('agent_02K', 'ripley').axes)).toBe(byId)
    expect(silhouette(registry.faceFor('ripley').axes)).toBe(byId)
  })

  test('two workers sharing a name still get two faces', () => {
    // The reason identity is keyed on the id: a name is not unique per spawn.
    const registry = createAgentFaceRegistry()
    const first = silhouette(registry.faceFor('agent_03A', 'scout').axes)
    const second = silhouette(registry.faceFor('agent_04B', 'scout').axes)
    expect(second).not.toBe(first)
  })
})

describe('the window store, one registry per session', () => {
  test('one session is one registry, and two sessions are two', () => {
    // The defect this replaced: the shell minted ONE registry from the active
    // session while up to MAX_WORKSPACE_PANELS panes rendered side by side, so
    // unrelated transcripts spent one pool of ten identity colours between them.
    const store = createAgentFaceRegistryStore()
    const first = store.registryFor('session-a')

    expect(store.registryFor('session-a')).toBe(first)
    expect(store.registryFor('session-b')).not.toBe(first)
    // Coming back is not re-minting. This is the focus change that used to
    // re-roll faces on rows a reader had already settled on.
    expect(store.registryFor('session-a')).toBe(first)
  })

  test('a session that is not there yet gets one stable registry, not a new one each ask', () => {
    // The shell reads null between sessions, and during a restore handover.
    const store = createAgentFaceRegistryStore()
    expect(store.registryFor(null)).toBe(store.registryFor(null))
    expect(store.registryFor(null)).not.toBe(store.registryFor('session-a'))
  })

  test('the store is bounded, and evicts the session nobody has asked for', () => {
    // Bounded rather than released on session close: a session ends down
    // several paths and the one nobody wires is an unbounded map in a renderer
    // that has already been OOMed once.
    const store = createAgentFaceRegistryStore(2)
    const a = store.registryFor('session-a')
    store.registryFor('session-b')
    // Asking for A again makes B the least recently asked for, so B is what
    // goes when C arrives — never a session still being drawn.
    expect(store.registryFor('session-a')).toBe(a)
    const c = store.registryFor('session-c')

    expect(store.heldCount()).toBe(2)
    expect(store.registryFor('session-a')).toBe(a)
    expect(store.registryFor('session-c')).toBe(c)
    expect(store.registryFor('session-b')).not.toBe(c)
  })

  test('an evicted session re-mints rather than throwing', () => {
    const store = createAgentFaceRegistryStore(1)
    const first = store.registryFor('session-a')
    store.registryFor('session-b')

    expect(store.heldCount()).toBe(1)
    expect(store.registryFor('session-a')).not.toBe(first)
  })
})
