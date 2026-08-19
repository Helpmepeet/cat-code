/**
 * The subagent face stamp — a 9x9 pixel silhouette computed from the worker's
 * name, drawn as a solid mass in the state colour with every feature cleared out
 * of it.
 *
 * Why generated rather than authored: an earlier pass drew six cats as line
 * marks on a 24 grid at stroke-width 1.6, which measures ~1.3px effective at the
 * 19px a card renders and collapses entirely below ~16px. Nothing here depends
 * on a hairline stroke — the silhouette is filled, and a feature is an absent
 * cell.
 *
 * IDENTITY IS THE SILHOUETTE. Ears, ear fill, head width, chin, mouth and
 * markings come from the name and never change; EYES are state and change every
 * time. Two workers must never share a silhouette, and a worker must never
 * change silhouette mid-session — which is what `createAgentFaceRegistry`
 * enforces, because the connectivity fallback below can otherwise drop the one
 * axis that separated two names.
 *
 * Pipeline: FNV-1a hash of the name (one salt per axis) -> fallback ladder ->
 * connectivity check -> session dedupe -> run-length the grid into rects. A
 * missing name skips the hash and uses the featureless base.
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
 * State, not identity. `open` is a live or unsettled worker, `shut` a completed
 * one, `closed` a face with nothing cleared at all — the featureless base, worn
 * both by a worker with no name yet and by a worker facing away (backgrounded).
 */
export type FaceEyes = 'open' | 'shut' | 'closed'

export type FaceAxes = {
  ear: FaceEar
  fill: FaceFill
  width: FaceWidth
  chin: FaceChin
  mouth: FaceMouth
  mark: FaceMark
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

/** The six axes the hash proposes. An empty/absent name uses the featureless base. */
export function axesForName(name: string | null | undefined): FaceAxes {
  if (!name) return FEATURELESS_AXES
  return {
    ear: EARS[faceHash(name, 1) % EARS.length],
    fill: FILLS[faceHash(name, 2) % FILLS.length],
    width: WIDTHS[faceHash(name, 3) % WIDTHS.length],
    chin: CHINS[faceHash(name, 4) % CHINS.length],
    mouth: MOUTHS[faceHash(name, 5) % MOUTHS.length],
    mark: MARKS[faceHash(name, 6) % MARKS.length],
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
 * Draw one grid at a given fallback `level`. Level 0 is what the hash asked for;
 * each step up drops the next-weakest carve so a severed silhouette can recover:
 * markings -> none, then mouth -> none, then ear fill deep -> notch -> solid.
 * Narrow ears that join the head in a single column cannot be notched and land
 * here by construction.
 */
function drawFace(axes: FaceAxes, eyes: FaceEyes, level: number): boolean[][] {
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

  const fill: FaceFill =
    level >= 3 ? 'solid' : level === 2 && axes.fill === 'deep' ? 'notch' : axes.fill
  // Mouth and chin-dot both live in row 6, so a face gets one or the other. The
  // ladder drops the mouth one step before it drops the markings, which is the
  // order that keeps the two off each other.
  const mouth: FaceMouth = level >= 2 ? 'none' : axes.mouth
  const mark: FaceMark = level >= 1 ? 'none' : axes.mark

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
    clr(mid, 6)
  }

  if (eyes === 'open') {
    clr(L + 2, 4)
    clr(R - 2, 4)
  } else if (eyes === 'shut') {
    clr(L + 1, 4)
    clr(L + 2, 4)
    clr(R - 2, 4)
    clr(R - 1, 4)
  }

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

const EYE_MODES: readonly FaceEyes[] = ['open', 'shut', 'closed']

const levelByAxes = new Map<string, number>()

/**
 * The fallback level this face draws at, chosen ONCE per identity and shared by
 * every eye state.
 *
 * DELIBERATE DEVIATION from the design source, which re-runs the ladder per eye
 * mode. Clearing the eyes can sever a silhouette that was whole without them, so
 * per-mode laddering means a worker's mouth or marking can vanish the moment it
 * settles: the same worker, a different silhouette, mid-session. That is the one
 * thing the spec's own prose says must never happen ("a worker must never change
 * silhouette mid-session"), so the level is picked from the strictest mode — the
 * lowest at which ALL THREE draw as one mass — and identity holds across states.
 *
 * Memoised by axes rather than by name: the map is bounded by the axis product
 * (2,400 entries at the absolute worst), and a face is redrawn on every render of
 * every card.
 */
function fallbackLevelFor(axes: FaceAxes): number {
  const key = axesKey(axes)
  const cached = levelByAxes.get(key)
  if (cached !== undefined) return cached
  let chosen = 3
  for (let level = 0; level <= 3; level += 1) {
    if (EYE_MODES.every(eyes => isConnected(drawFace(axes, eyes, level)))) {
      chosen = level
      break
    }
  }
  levelByAxes.set(key, chosen)
  return chosen
}

function axesKey(axes: FaceAxes): string {
  return `${axes.ear}|${axes.fill}|${axes.width}|${axes.chin}|${axes.mouth}|${axes.mark}`
}

/** The drawn stamp for one set of axes, with the connectivity fallback applied. */
export function faceRects(axes: FaceAxes, eyes: FaceEyes): FaceRect[] {
  return gridToRects(drawFace(axes, eyes, fallbackLevelFor(axes)))
}

/**
 * Silhouette identity: the drawn mass with EYES EXCLUDED, which is what dedupe
 * compares. Eyes are state, so two workers whose stamps differ only by an eye
 * row are the same face as far as a reader is concerned.
 */
function silhouetteKey(axes: FaceAxes): string {
  return JSON.stringify(faceRects(axes, 'closed'))
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
]

/**
 * The first axis combination whose drawn silhouette nobody holds, scanned in a
 * fixed order so the answer never depends on iteration timing. Null when every
 * distinct silhouette the generator can produce is already spoken for.
 */
function firstFreeAxes(taken: ReadonlySet<string>): FaceAxes | null {
  for (const width of WIDTHS) {
    for (const ear of EARS) {
      for (const chin of CHINS) {
        for (const fill of FILLS) {
          for (const mark of MARKS) {
            for (const mouth of MOUTHS) {
              const candidate: FaceAxes = { ear, fill, width, chin, mouth, mark }
              if (!taken.has(silhouetteKey(candidate))) return candidate
            }
          }
        }
      }
    }
  }
  return null
}

export type AgentFaceRegistry = {
  /**
   * The axes this worker wears for the rest of the session. First call for a
   * name decides them; every later call returns the same answer, so a card never
   * changes silhouette underneath the reader. A null/empty name is the
   * featureless base and is never registered.
   */
  axesFor: (name: string | null | undefined) => FaceAxes
}

/**
 * One registry per session. The hash proposes, but a stamp already live in the
 * session wins: the connectivity fallback can collapse the only axis that
 * separated two names, so two different hashes really do converge. On a clash we
 * walk the axis lists until the DRAWN silhouette is unique, and keep the axes it
 * ended up with — they are what the face actually is now.
 *
 * Assignment order is first-render order, which is transcript order, so the
 * answer is stable for the life of the session without anything being stored.
 * A name that survives the whole walk still taken (every axis exhausted) keeps
 * its own stamp rather than none: a shared silhouette is a worse reading than a
 * missing one, but a blank card is worse than both.
 */
export function createAgentFaceRegistry(): AgentFaceRegistry {
  const assigned = new Map<string, FaceAxes>()
  const taken = new Set<string>([silhouetteKey(FEATURELESS_AXES)])

  return {
    axesFor(name) {
      if (!name) return FEATURELESS_AXES
      const cached = assigned.get(name)
      if (cached !== undefined) return cached
      let axes = axesForName(name)
      for (const axis of DEDUPE_AXES) {
        if (!taken.has(silhouetteKey(axes))) break
        for (let step = 1; step < axis.count; step += 1) {
          const candidate = axis.rotate(axes, step)
          if (!taken.has(silhouetteKey(candidate))) {
            axes = candidate
            break
          }
        }
      }
      // The walk above only ever substitutes ONE axis at a time, which is what
      // keeps a deduped face close to the one the name asked for. Once the
      // session holds enough workers, every single substitution can itself be
      // taken, and the design source stops there and hands out a duplicate. The
      // sweep below is the guarantee behind it: a deterministic scan of the whole
      // axis product, so a silhouette is shared only when the space is genuinely
      // exhausted. It runs at most once per colliding name and never in the
      // ordinary case.
      if (taken.has(silhouetteKey(axes))) {
        const unique = firstFreeAxes(taken)
        if (unique !== null) axes = unique
      }
      taken.add(silhouetteKey(axes))
      assigned.set(name, axes)
      return axes
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
const UNSCOPED_REGISTRY: AgentFaceRegistry = { axesFor: axesForName }

/**
 * Read the registry, not one face: a group header draws one stamp per member, and
 * a hook per member would be a hook inside a loop.
 */
export function useAgentFaceRegistry(): AgentFaceRegistry {
  return useContext(AgentFaceRegistryContext) ?? UNSCOPED_REGISTRY
}
