/**
 * Remembered window geometry, main-owned.
 *
 * `createWindow` built the `BrowserWindow` from literal `width: 1100,
 * height: 720` and never read or wrote a saved size, so every launch discarded
 * whatever the operator had arranged.
 *
 * Stored beside the other main-owned bounded state under the desktop config
 * directory, the `glassPreference.ts` idiom verbatim: one small versioned JSON
 * file, written temp-then-rename so a crash mid-write cannot leave a half file,
 * and read fail-open. A window that cannot be positioned from a saved value must
 * still open at the defaults; geometry is never worth blocking launch for.
 *
 * The clamp is the part that matters and it is pure, so it is tested directly:
 * bounds saved on a display that is no longer attached would otherwise place the
 * window entirely off-screen, where it cannot be reached or moved back.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const WINDOW_BOUNDS_FILE = 'window-bounds.json'

export type WindowBounds = Readonly<{
  x: number
  y: number
  width: number
  height: number
}>

export type WindowBoundsArea = Readonly<{
  x: number
  y: number
  width: number
  height: number
}>

type PersistedWindowBounds = { version: 1 } & WindowBounds

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * The saved bounds, or null when there are none to apply. Null covers a first
 * launch, an unreadable directory, a truncated or hand-edited file, and a
 * version this build does not understand: every one of them means "open at the
 * defaults", never "fail".
 */
export function readWindowBounds(userDataDir: string): WindowBounds | null {
  try {
    const value = JSON.parse(
      readFileSync(join(userDataDir, WINDOW_BOUNDS_FILE), 'utf8'),
    ) as Partial<PersistedWindowBounds>
    if (value.version !== 1) return null
    if (
      !isFiniteInteger(value.x) ||
      !isFiniteInteger(value.y) ||
      !isFiniteInteger(value.width) ||
      !isFiniteInteger(value.height)
    ) {
      return null
    }
    if (value.width <= 0 || value.height <= 0) return null
    return {
      x: Math.round(value.x),
      y: Math.round(value.y),
      width: Math.round(value.width),
      height: Math.round(value.height),
    }
  } catch {
    return null
  }
}

export function writeWindowBounds(
  userDataDir: string,
  bounds: WindowBounds,
): void {
  try {
    if (
      !isFiniteInteger(bounds.x) ||
      !isFiniteInteger(bounds.y) ||
      !isFiniteInteger(bounds.width) ||
      !isFiniteInteger(bounds.height) ||
      bounds.width <= 0 ||
      bounds.height <= 0
    ) {
      return
    }
    mkdirSync(userDataDir, { recursive: true })
    const target = join(userDataDir, WINDOW_BOUNDS_FILE)
    const temporary = `${target}.${process.pid}.tmp`
    const value: PersistedWindowBounds = {
      version: 1,
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    }
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(temporary, target)
  } catch {
    // Remembering the window must never make the window unusable when
    // user-data storage fails (`glassPreference.ts`).
  }
}

/**
 * Fit saved bounds to a display area that may not be the one they were saved on.
 *
 * `area` is the target display's WORK area (`screen.getDisplayMatching(...)`
 * picks the display with the most overlap, and the primary one when a saved
 * rectangle overlaps nothing — the disconnected-external-display case). Size is
 * clamped to the minimum the layout needs (`main.ts` `minWidth`/`minHeight`,
 * themselves derived from the composition) and to the area, then the origin is
 * pulled back inside it. Order matters: clamping position before size could
 * leave the window hanging off the right or bottom edge.
 *
 * The window therefore always lands somewhere the operator can grab it, and the
 * existing minimum-size behaviour is unchanged: this never returns something
 * smaller than the minimum, so Electron's own `minWidth`/`minHeight` still hold.
 */
export function clampWindowBounds(
  bounds: WindowBounds,
  area: WindowBoundsArea,
  minimum: Readonly<{ width: number; height: number }>,
): WindowBounds {
  const width = Math.min(
    Math.max(bounds.width, minimum.width),
    Math.max(area.width, minimum.width),
  )
  const height = Math.min(
    Math.max(bounds.height, minimum.height),
    Math.max(area.height, minimum.height),
  )
  // `Math.max(area.x, …)` runs second so a window wider than the area is pinned
  // to the area's left edge rather than pushed off it to the left.
  const x = Math.max(area.x, Math.min(bounds.x, area.x + area.width - width))
  const y = Math.max(area.y, Math.min(bounds.y, area.y + area.height - height))
  return { x: Math.round(x), y: Math.round(y), width, height }
}
