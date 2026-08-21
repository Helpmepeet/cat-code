/**
 * The subagent face stamp — a 9x9 pixel silhouette computed from the worker's
 * identity, drawn as a solid mass in that worker's own colour with every feature
 * cleared out of it.
 *
 * Why generated rather than authored: an earlier pass drew six cats as line
 * marks on a 24 grid at stroke-width 1.6, which measures ~1.3px effective at the
 * 19px a card renders and collapses entirely below ~16px. Nothing here depends
 * on a hairline stroke — the silhouette is filled, and a feature is an absent
 * cell.
 *
 * THE WHOLE STAMP IS IDENTITY, shape and colour both, and nothing about a
 * worker's run reaches it. Two workers must never share a silhouette, and a
 * worker must never change silhouette mid-session — which is what
 * `createAgentFaceRegistry` enforces, because the connectivity fallback below can
 * otherwise drop the one axis that separated two identifiers.
 *
 * Pipeline: FNV-1a hash of the worker's identifier (one salt per axis, plus one
 * for the colour) -> fallback ladder -> connectivity check -> session dedupe ->
 * run-length the grid into rects. A missing identifier skips the hash and uses
 * the featureless base.
 *
 * Ported deliberately from the design source
 * (`docs/design-html/2026-08-19-subagent-card-spec.html`,
 * 2026-08-19) rather than reimplemented: the algorithm is the contract, so the
 * grid arithmetic, the fallback order and the dedupe walk are the source's, step
 * for step.
 */

import { createContext, useContext } from 'react'

export type FaceEar = 'pointy' | 'outer' | 'tuft' | 'folded' | 'tall'
export type FaceFill = 'solid' | 'notch' | 'deep'
export type FaceWidth = 'wide' | 'narrow'
export type FaceChin = 'round' | 'flat' | 'pointed' | 'fringe'
export type FaceMouth = 'none' | 'slit' | 'smile' | 'omega'
export type FaceMark = 'none' | 'brow' | 'cheek' | 'temple' | 'chindot'
/**
 * The head's own outline: `rounded` clears the four corners of the head block.
 *
 * A SHAPE axis, deliberately, not another carve. Under the distance rule
 * (`MIN_FACE_DISTANCE`) an axis that moves fewer cells than the bar adds no
 * distinguishable faces at all — it produces near-twins the registry then
 * refuses. A carve worth one or two cells would have been free supply on paper
 * and none in practice. Four corners is the smallest change that clears the bar
 * on its own.
 */
export type FaceHead = 'square' | 'rounded'

/** The seven hashed axes that decide one worker's silhouette. */
export type FaceAxes = {
  ear: FaceEar
  fill: FaceFill
  width: FaceWidth
  chin: FaceChin
  mouth: FaceMouth
  mark: FaceMark
  head: FaceHead
}

/** One run-length rect of filled cells, in the 9x9 viewBox's own units. */
export type FaceRect = { x: number; y: number; w: number; h: number }

const GRID = 9

const EARS: readonly FaceEar[] = ['pointy', 'outer', 'tuft', 'folded', 'tall']
const FILLS: readonly FaceFill[] = ['solid', 'notch', 'deep']
const WIDTHS: readonly FaceWidth[] = ['wide', 'narrow']
const CHINS: readonly FaceChin[] = ['round', 'flat', 'pointed', 'fringe']
const MOUTHS: readonly FaceMouth[] = ['none', 'slit', 'smile', 'omega']
const MARKS: readonly FaceMark[] = ['none', 'brow', 'cheek', 'temple', 'chindot']
const HEADS: readonly FaceHead[] = ['square', 'rounded']

/**
 * The nameless card's stamp: pointy ears, solid fill, wide head, round chin, no
 * mouth, no marking. Registered as taken before any named worker resolves, so a
 * named worker can never wear the "we do not know who this is" face.
 */
const FEATURELESS_AXES: FaceAxes = {
  ear: 'pointy',
  fill: 'solid',
  width: 'wide',
  chin: 'round',
  mouth: 'none',
  mark: 'none',
  head: 'square',
}

/** FNV-1a over the name, one salt per axis. Same name, same face, every session. */
export function faceHash(text: string, salt: number): number {
  let x = 2166136261 ^ salt
  for (let i = 0; i < text.length; i += 1) {
    x ^= text.charCodeAt(i)
    x = Math.imul(x, 16777619)
  }
  return x >>> 0
}

/** The seven axes the hash proposes. An empty/absent name uses the featureless base. */
export function axesForName(name: string | null | undefined): FaceAxes {
  if (!name) return FEATURELESS_AXES
  return {
    ear: EARS[faceHash(name, 1) % EARS.length],
    fill: FILLS[faceHash(name, 2) % FILLS.length],
    width: WIDTHS[faceHash(name, 3) % WIDTHS.length],
    chin: CHINS[faceHash(name, 4) % CHINS.length],
    mouth: MOUTHS[faceHash(name, 5) % MOUTHS.length],
    mark: MARKS[faceHash(name, 6) % MARKS.length],
    head: HEADS[faceHash(name, 7) % HEADS.length],
  }
}

function blankGrid(): boolean[][] {
  const grid: boolean[][] = []
  for (let r = 0; r < GRID; r += 1) {
    const row: boolean[] = []
    for (let c = 0; c < GRID; c += 1) row.push(false)
    grid.push(row)
  }
  return grid
}

/**
 * Every drawn face must be ONE 4-connected mass. A hard check, not a guideline:
 * three faces shipped severed before it existed, and a severed stamp reads as
 * two unrelated marks rather than one animal.
 */
function isConnected(grid: boolean[][]): boolean {
  let filled = 0
  let start: [number, number] | null = null
  for (let r = 0; r < GRID; r += 1) {
    for (let c = 0; c < GRID; c += 1) {
      if (!grid[r][c]) continue
      filled += 1
      if (start === null) start = [c, r]
    }
  }
  if (start === null) return false
  const seen = blankGrid()
  const stack: [number, number][] = [start]
  seen[start[1]][start[0]] = true
  let hit = 0
  const deltas: readonly (readonly [number, number])[] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]
  while (stack.length > 0) {
    const point = stack.pop()
    if (point === undefined) break
    hit += 1
    for (const [dx, dy] of deltas) {
      const x = point[0] + dx
      const y = point[1] + dy
      if (x < 0 || x >= GRID || y < 0 || y >= GRID) continue
      if (!grid[y][x] || seen[y][x]) continue
      seen[y][x] = true
      stack.push([x, y])
    }
  }
  return hit === filled
}

/**
 * What a face may give up to stay in one piece, cheapest first.
 *
 * A SEARCH, not the design source's linear ladder, because the conflicts that
 * sever a silhouette are PAIRWISE and a fixed order cannot see them. The source
 * relaxes markings, then the mouth, then the ear fill, and stops at the first
 * level that connects — so a face severed by its ear fill loses its mouth and
 * markings on the way to fixing it, and a face severed by a mouth-chin
 * collision loses its marking for nothing. Measured on the source's order, in
 * the six-axis space it was measured on: 35% of all 2,400 combinations drew as a
 * bare slab with no interior feature at all
 * (75% of `folded` ears, 76% of `tall`), and 840 faces asked for a mouth and did
 * not get one. That is what put a featureless blob on a card whose hash had
 * asked for a deep ear fill, an omega mouth and a chin-dot.
 *
 * Each candidate is scored by what it costs the reader: an ear fill is one or
 * two cells at the tips, a marking is a single cell, a mouth is the most legible
 * carve on the face. First candidate that draws as one mass wins; ties break by
 * list order, so the choice stays deterministic.
 *
 * Dropping the mouth can RESTORE a chin-dot the exclusion above had suppressed,
 * which is why the two are searched rather than stripped in sequence.
 */
type Relaxation = {
  readonly fill: FaceFill | 'keep' | 'soften'
  readonly dropMouth: boolean
  readonly dropMark: boolean
}

const RELAXATIONS: readonly Relaxation[] = ([] as Relaxation[])
  .concat(
    ...(['keep', 'soften', 'solid'] as const).map(fill =>
      [false, true].flatMap(dropMark =>
        [false, true].map(dropMouth => ({ fill, dropMouth, dropMark })),
      ),
    ),
  )
  .map(candidate => ({
    candidate,
    cost:
      (candidate.fill === 'keep' ? 0 : candidate.fill === 'soften' ? 1 : 2) +
      (candidate.dropMark ? 3 : 0) +
      (candidate.dropMouth ? 5 : 0),
  }))
  .sort((a, b) => a.cost - b.cost)
  .map(scored => scored.candidate)

/**
 * Draw one grid under a given relaxation (an index into `RELAXATIONS`).
 */
function drawFace(axes: FaceAxes, level: number): boolean[][] {
  const grid = blankGrid()
  const L = axes.width === 'wide' ? 0 : 1
  const R = axes.width === 'wide' ? 8 : 7
  const mid = Math.round((L + R) / 2)
  const set = (x: number, y: number): void => {
    if (x >= 0 && x < GRID && y >= 0 && y < GRID) grid[y][x] = true
  }
  const clr = (x: number, y: number): void => {
    if (x >= 0 && x < GRID && y >= 0 && y < GRID) grid[y][x] = false
  }

  for (let r = 2; r <= 6; r += 1) for (let c = L; c <= R; c += 1) set(c, r)

  const eL = L + 1
  const eR = R - 1
  if (axes.ear === 'pointy' || axes.ear === 'tuft' || axes.ear === 'folded') {
    for (let c = L; c <= L + 2; c += 1) set(c, 1)
    for (let c = R - 2; c <= R; c += 1) set(c, 1)
    if (axes.ear === 'pointy') {
      set(eL, 0)
      set(eR, 0)
    }
    if (axes.ear === 'tuft') {
      set(L, 0)
      set(eL, 0)
      set(eR, 0)
      set(R, 0)
    }
  } else if (axes.ear === 'outer') {
    set(L, 0)
    set(R, 0)
    set(L, 1)
    set(L + 1, 1)
    set(R - 1, 1)
    set(R, 1)
  } else {
    set(eL, 0)
    set(eL, 1)
    set(eR, 0)
    set(eR, 1)
  }

  // The head's corners, cleared before every carve below so a marking or a mouth
  // that lands on a corner cell is not silently spent on an already-empty one.
  if (axes.head === 'rounded') {
    clr(L, 2)
    clr(R, 2)
    clr(L, 6)
    clr(R, 6)
  }

  if (axes.chin === 'round') {
    for (let c = L + 1; c <= R - 1; c += 1) set(c, 7)
    for (let c = L + 2; c <= R - 2; c += 1) set(c, 8)
  } else if (axes.chin === 'flat') {
    for (let c = L + 1; c <= R - 1; c += 1) set(c, 7)
  } else if (axes.chin === 'pointed') {
    for (let c = L + 2; c <= R - 2; c += 1) set(c, 7)
    for (let c = mid - 1; c <= mid + 1; c += 1) set(c, 8)
  } else {
    set(L, 7)
    set(L + 1, 7)
    for (let c = mid - 1; c <= mid + 1; c += 1) set(c, 7)
    set(R - 1, 7)
    set(R, 7)
  }

  const step = RELAXATIONS[Math.min(level, RELAXATIONS.length - 1)] as Relaxation
  const fill: FaceFill =
    step.fill === 'keep'
      ? axes.fill
      : step.fill === 'soften'
        ? axes.fill === 'deep'
          ? 'notch'
          : axes.fill
        : step.fill
  const mouth: FaceMouth = step.dropMouth ? 'none' : axes.mouth
  // A chin-dot and a mouth both want row 6, so the dot MOVES DOWN to row 7 when
  // a mouth is present rather than being dropped, which is what it used to be
  // against any mouth at all — a face lost its only marking to a collision a
  // slit does not have. Only `smile` still takes it outright, because a smile
  // already clears (mid, 7) and a dot there would be invisible. An omega loses it
  // too, but by the connectivity search rather than by rule: a dot at (mid, 7)
  // strands (mid, 6), and a severed face costs more than a marking.
  const mark: FaceMark =
    step.dropMark || (axes.mark === 'chindot' && mouth === 'smile')
      ? 'none'
      : axes.mark
  const chinDotRow = mouth === 'none' ? 6 : 7

  if (fill !== 'solid') {
    // Ear-tip columns are the filled columns of the TOPMOST filled row, so the
    // ear fill follows whichever ear shape the hash chose.
    const cols: number[] = []
    for (let r = 0; r < GRID && cols.length === 0; r += 1) {
      for (let c = 0; c < GRID; c += 1) if (grid[r][c]) cols.push(c)
    }
    for (const col of cols) {
      clr(col, 2)
      if (fill === 'deep') clr(col, 3)
    }
  }

  if (mouth === 'slit') {
    clr(mid - 1, 6)
    clr(mid, 6)
    clr(mid + 1, 6)
  } else if (mouth === 'smile') {
    clr(mid - 1, 6)
    clr(mid + 1, 6)
    clr(mid, 7)
  } else if (mouth === 'omega') {
    clr(mid, 5)
    clr(mid - 1, 6)
    clr(mid + 1, 6)
  }

  if (mark === 'brow') {
    clr(mid - 1, 2)
    clr(mid + 1, 2)
  } else if (mark === 'cheek') {
    clr(L + 1, 5)
  } else if (mark === 'temple') {
    clr(R - 1, 2)
  } else if (mark === 'chindot') {
    clr(mid, chinDotRow)
  }

  // Eyes, carved for EVERY face and never as a state. Operator ruling,
  // 2026-08-21: they used to be state (open live, shut completed, away
  // backgrounded), which is why a fan-out of five backgrounded workers drew five
  // blank slabs at the one moment a reader most needs to tell them apart. They
  // are also what stops a mouth being read as a pair of eyes two rows too low.
  clr(L + 2, 4)
  clr(R - 2, 4)

  return grid
}

/**
 * Run-length the grid into rects, merging vertically identical rows. A 9x9 face
 * costs ~8-12 rects instead of up to 81, which matters because every agent card,
 * group header and finish row draws one.
 */
function gridToRects(grid: boolean[][]): FaceRect[] {
  const runsOf = (row: boolean[]): [number, number][] => {
    const runs: [number, number][] = []
    let c = 0
    while (c < GRID) {
      if (row[c]) {
        const start = c
        while (c < GRID && row[c]) c += 1
        runs.push([start, c - start])
      } else {
        c += 1
      }
    }
    return runs
  }
  const out: FaceRect[] = []
  let r = 0
  while (r < GRID) {
    const signature = JSON.stringify(runsOf(grid[r]))
    let span = 1
    while (r + span < GRID && JSON.stringify(runsOf(grid[r + span])) === signature) {
      span += 1
    }
    for (const [x, w] of runsOf(grid[r])) out.push({ x, y: r, w, h: span })
    r += span
  }
  return out
}

const levelByAxes = new Map<string, number>()

/**
 * The fallback level this face draws at.
 *
 * Memoised by axes rather than by identity: the map is bounded by the axis
 * product (4,800 entries at the absolute worst), and a face is redrawn on every
 * render of every card.
 */
function fallbackLevelFor(axes: FaceAxes): number {
  const key = axesKey(axes)
  const cached = levelByAxes.get(key)
  if (cached !== undefined) return cached
  let chosen = RELAXATIONS.length - 1
  for (let level = 0; level < RELAXATIONS.length; level += 1) {
    if (isConnected(drawFace(axes, level))) {
      chosen = level
      break
    }
  }
  levelByAxes.set(key, chosen)
  return chosen
}

function axesKey(axes: FaceAxes): string {
  return `${axes.ear}|${axes.fill}|${axes.width}|${axes.chin}|${axes.mouth}|${axes.mark}|${axes.head}`
}

/** The drawn stamp for one set of axes, with the connectivity fallback applied. */
export function faceRects(axes: FaceAxes): FaceRect[] {
  return gridToRects(drawFace(axes, fallbackLevelFor(axes)))
}

const silhouetteByAxes = new Map<string, Uint8Array>()

/**
 * Silhouette identity: the drawn mass, one cell per byte, which is what dedupe
 * compares.
 *
 * A MASK rather than a string key, because dedupe asks how FAR apart two faces
 * draw and a string can only answer whether they are identical. Identity is not
 * lost by the change: byte-identical is `differsBy(..., 1) === false`.
 *
 * Memoised on the same bound as `levelByAxes` (the axis product), because the
 * dedupe sweep below asks for up to 4,800 of these in one call and each one is a
 * fresh draw. Without it a session past the distinct-silhouette supply pays that
 * sweep, in the render phase, for every worker after the first collision.
 */
function silhouetteMask(axes: FaceAxes): Uint8Array {
  const key = axesKey(axes)
  const cached = silhouetteByAxes.get(key)
  if (cached !== undefined) return cached
  const mask = new Uint8Array(GRID * GRID)
  for (const rect of faceRects(axes)) {
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      for (let x = rect.x; x < rect.x + rect.w; x += 1) mask[y * GRID + x] = 1
    }
  }
  silhouetteByAxes.set(key, mask)
  return mask
}

/**
 * Whether two silhouettes differ in at least `bar` of the grid's 81 cells.
 * Counts only to `bar` and stops: the sweep below asks this question millions of
 * times and never needs the exact figure.
 */
function differsBy(a: Uint8Array, b: Uint8Array, bar: number): boolean {
  let differences = 0
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] === b[index]) continue
    differences += 1
    if (differences >= bar) return true
  }
  return false
}

/**
 * How far apart two faces in one session must draw, in cells of the 81.
 *
 * The bar used to be byte-inequality — one differing cell counted as a different
 * face. A cell is ~2px at the 19px a card renders, so the registry was handing
 * out pairs no reader could tell apart and reporting them as distinct: measured
 * over the whole axis space, 467 pairs of drawn silhouettes differ by exactly one
 * cell and 1,836 by two, and in simulation 155 of 300 eight-worker sessions
 * contained a pair within two cells.
 *
 * 4 is what the supply affords. A greedy packing of the 1,897 distinct
 * silhouettes yields 592 faces at 3 cells apart, 340 at 4, and 200 at 5; 340 is
 * far past any plausible session, and 4 is the point where both measured
 * near-twins separate (a lone marking is 1 cell, two isolated single cells are
 * 4).
 */
const MIN_FACE_DISTANCE = 4

/**
 * The bars a name is offered, strictest first. Falling back to 1 is what keeps
 * the strict rule from making the crowded case WORSE than it was: 1 is exactly
 * the old byte-inequality bar, so a session that outruns the well-separated
 * supply degrades to previous behaviour rather than to shared faces.
 */
const DISTANCE_BARS: readonly number[] = [MIN_FACE_DISTANCE, 1]

/** Whether `axes` draws clear of every face the session already holds. */
function isFreeAgainst(taken: readonly Uint8Array[], axes: FaceAxes, bar: number): boolean {
  const mask = silhouetteMask(axes)
  for (const held of taken) {
    if (!differsBy(held, mask, bar)) return false
  }
  return true
}

/**
 * The dedupe walk, in the order it steps: the cheapest differences first (mouth,
 * markings), the silhouette-shaping ones last. Each entry rotates its own axis by
 * `step` values, which keeps the walk cast-free and makes the axis list the only
 * place a value set is written down.
 */
const DEDUPE_AXES: readonly {
  readonly count: number
  readonly rotate: (axes: FaceAxes, step: number) => FaceAxes
}[] = [
  {
    count: MOUTHS.length,
    rotate: (a, step) => ({
      ...a,
      mouth: MOUTHS[(MOUTHS.indexOf(a.mouth) + step) % MOUTHS.length],
    }),
  },
  {
    count: MARKS.length,
    rotate: (a, step) => ({
      ...a,
      mark: MARKS[(MARKS.indexOf(a.mark) + step) % MARKS.length],
    }),
  },
  {
    count: CHINS.length,
    rotate: (a, step) => ({
      ...a,
      chin: CHINS[(CHINS.indexOf(a.chin) + step) % CHINS.length],
    }),
  },
  {
    count: EARS.length,
    rotate: (a, step) => ({
      ...a,
      ear: EARS[(EARS.indexOf(a.ear) + step) % EARS.length],
    }),
  },
  {
    count: FILLS.length,
    rotate: (a, step) => ({
      ...a,
      fill: FILLS[(FILLS.indexOf(a.fill) + step) % FILLS.length],
    }),
  },
  {
    count: WIDTHS.length,
    rotate: (a, step) => ({
      ...a,
      width: WIDTHS[(WIDTHS.indexOf(a.width) + step) % WIDTHS.length],
    }),
  },
  {
    count: HEADS.length,
    rotate: (a, step) => ({
      ...a,
      head: HEADS[(HEADS.indexOf(a.head) + step) % HEADS.length],
    }),
  },
]

/**
 * The whole axis space in ONE fixed order, which is the order the sweep walks,
 * so the answer never depends on iteration timing.
 */
const AXIS_SPACE: readonly FaceAxes[] = WIDTHS.flatMap(width =>
  EARS.flatMap(ear =>
    CHINS.flatMap(chin =>
      HEADS.flatMap(head =>
        FILLS.flatMap(fill =>
          MARKS.flatMap(mark =>
            MOUTHS.map(mouth => ({ ear, fill, width, chin, mouth, mark, head }) as FaceAxes),
          ),
        ),
      ),
    ),
  ),
)

/**
 * How many identity fills exist. Kept here rather than imported so this module
 * stays free of the renderer's class maps; `agentChromeModel.test.ts` pins it
 * equal to `AGENT_FACE_IDENTITY_FILL.length`, so the two cannot drift.
 */
export const FACE_FILL_COUNT = 10

/** One worker's whole stamp: the shape it draws and the colour it draws in. */
export type AgentFaceIdentity = { axes: FaceAxes; fill: number }

export type AgentFaceRegistry = {
  /**
   * The face this worker wears for the rest of the session. First call decides
   * it; every later call returns the same answer, so a card never changes face
   * underneath the reader.
   *
   * `key` is the worker's agent id where the surface has one, because an id is
   * unique per spawn and a name is not: two workers told to run under the same
   * handle are two workers and must not share a face.
   *
   * `alias` is that worker's name, and it exists because two surfaces have no id
   * to offer. A completion notification is parsed out of a summary string
   * (`TranscriptView.tsx` `TaskNotificationBox`) and knows only `@name`, and a
   * foreground card has no id until its result lands. Without the alias those
   * would mint a second face for a worker already on screen.
   */
  faceFor: (key: string | null | undefined, alias?: string | null) => AgentFaceIdentity
}

/**
 * One registry per session. The hash proposes, but a stamp already live in the
 * session wins: the connectivity fallback can collapse the only axis that
 * separated two names, so two different hashes really do converge. On a clash we
 * walk the axis lists until the DRAWN silhouette is clear of every live face, and
 * keep the axes it ended up with — they are what the face actually is now.
 *
 * "Clear of" is a DISTANCE, not inequality — see `MIN_FACE_DISTANCE`. A name is
 * offered each bar in `DISTANCE_BARS` in turn, so a session takes well-separated
 * faces while the supply lasts and only then falls back to the merely-distinct
 * ones.
 *
 * Assignment order is first-render order, which is transcript order, so the
 * answer is stable for the life of the session without anything being stored.
 * A name that survives every bar still crowded keeps its own stamp rather than
 * none: a shared silhouette is a worse reading than a missing one, but a blank
 * card is worse than both.
 */
export function createAgentFaceRegistry(): AgentFaceRegistry {
  const assigned = new Map<string, AgentFaceIdentity>()
  /**
   * Which key owns each alias, or null when a key-less surface bound it first.
   *
   * This is what lets the two rules coexist. A name bound by a key-less call is
   * UNOWNED and the first id to arrive adopts it, so a card that rendered before
   * its result landed keeps the face it already drew. A name owned by an id is
   * spoken for, so a SECOND worker running under the same handle mints its own
   * face instead of inheriting one. Without the distinction you get whichever of
   * those two defects you did not write the check for.
   */
  const aliasOwner = new Map<string, string | null>()
  const taken: Uint8Array[] = [silhouetteMask(FEATURELESS_AXES)]
  const takenFills = new Set<number>()
  const sweptTo = new Map<number, number>()

  /**
   * A deterministic scan of the whole axis product for something free at `bar`.
   *
   * RESUMED, not restarted, because a candidate rejected once can never come
   * back: `taken` only ever grows, so a face already too close to a live one
   * stays too close forever. That turns the sweep from a full 4,800-candidate
   * scan per colliding worker into a single walk of the space spread across the
   * session.
   */
  const sweep = (bar: number): FaceAxes | null => {
    let index = sweptTo.get(bar) ?? 0
    while (index < AXIS_SPACE.length && !isFreeAgainst(taken, AXIS_SPACE[index], bar)) {
      index += 1
    }
    sweptTo.set(bar, index)
    return index < AXIS_SPACE.length ? AXIS_SPACE[index] : null
  }

  /** The shape this identifier can have at one bar, or null when the bar is spent. */
  const resolveAt = (identifier: string, bar: number): FaceAxes | null => {
    if (sweptTo.get(bar) === AXIS_SPACE.length) return null
    let axes = axesForName(identifier)
    for (const axis of DEDUPE_AXES) {
      if (isFreeAgainst(taken, axes, bar)) break
      for (let step = 1; step < axis.count; step += 1) {
        const candidate = axis.rotate(axes, step)
        if (isFreeAgainst(taken, candidate, bar)) {
          axes = candidate
          break
        }
      }
    }
    // The walk above only ever substitutes ONE axis at a time, which is what
    // keeps a deduped face close to the one the identifier asked for. Once the
    // session holds enough workers, every single substitution can itself be
    // crowded, and the design source stops there and hands out a duplicate. The
    // sweep is the guarantee behind it: a face is shared only when the space is
    // genuinely spent at every bar.
    return isFreeAgainst(taken, axes, bar) ? axes : sweep(bar)
  }

  /**
   * The colour, deduped like the shape. The hash proposes and the first free
   * fill from there wins, so a session of ten or fewer workers is ten different
   * colours rather than the ~70% chance of a shared one that ten independent
   * hashes give five workers.
   */
  const resolveFill = (identifier: string): number => {
    const proposed = faceHash(identifier, 8) % FACE_FILL_COUNT
    if (takenFills.size >= FACE_FILL_COUNT) return proposed
    for (let step = 0; step < FACE_FILL_COUNT; step += 1) {
      const candidate = (proposed + step) % FACE_FILL_COUNT
      if (!takenFills.has(candidate)) return candidate
    }
    return proposed
  }

  return {
    faceFor(key, alias = null) {
      const owned = key ? assigned.get(key) : undefined
      // An alias only answers for a worker that has not been claimed by some
      // OTHER key. `aliasOwner` holding null means a key-less surface bound it,
      // which is the case a late-arriving id is meant to adopt.
      const adoptable =
        alias !== null && alias !== undefined && (!key || (aliasOwner.get(alias) ?? key) === key)
          ? assigned.get(alias)
          : undefined
      const known = owned ?? adoptable
      const bind = (face: AgentFaceIdentity): AgentFaceIdentity => {
        if (key) assigned.set(key, face)
        if (alias) {
          if (!assigned.has(alias)) assigned.set(alias, face)
          if (!aliasOwner.has(alias)) aliasOwner.set(alias, key ?? null)
          else if (key && aliasOwner.get(alias) === null) aliasOwner.set(alias, key)
        }
        return face
      }
      if (known !== undefined) return bind(known)
      const identifier = key ?? alias
      if (!identifier) return { axes: FEATURELESS_AXES, fill: 0 }
      let resolved: FaceAxes | null = null
      for (const bar of DISTANCE_BARS) {
        resolved = resolveAt(identifier, bar)
        if (resolved !== null) break
      }
      const axes = resolved ?? axesForName(identifier)
      const fill = resolveFill(identifier)
      taken.push(silhouetteMask(axes))
      takenFills.add(fill)
      return bind({ axes, fill })
    },
  }
}

/**
 * The session's registry, handed down so every face on screen is deduped against
 * every other one. Null outside a transcript.
 */
export const AgentFaceRegistryContext = createContext<AgentFaceRegistry | null>(null)

/**
 * The fallback when no transcript is above: the raw hash, with no dedupe.
 * Deliberately NOT a shared registry — dedupe is a property of one session's set
 * of workers, and a module-level one would carry names between sessions and make
 * a face depend on what some other transcript rendered first.
 */
const UNSCOPED_REGISTRY: AgentFaceRegistry = {
  faceFor: (key, alias = null) => {
    const identifier = key ?? alias
    return {
      axes: axesForName(identifier),
      fill: identifier ? faceHash(identifier, 8) % FACE_FILL_COUNT : 0,
    }
  },
}

/**
 * Read the registry, not one face: a group header draws one stamp per member, and
 * a hook per member would be a hook inside a loop.
 */
export function useAgentFaceRegistry(): AgentFaceRegistry {
  return useContext(AgentFaceRegistryContext) ?? UNSCOPED_REGISTRY
}
