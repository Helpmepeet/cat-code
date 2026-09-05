/**
 * Sidebar expanded WIDTH — the drag-resizable width of the left rail, persisted
 * so it survives a relaunch. Operator request, 2026-08-28: the default was too
 * narrow and session labels were truncated, and a width the operator drags is
 * worth nothing if the next launch throws it away.
 *
 * Fixed pixels, NOT a fraction of the window. The rail holds text at a fixed
 * font size, so its useful width is set by how many characters a session label
 * needs, not by how big the display is: a proportional rail would be absurd on a
 * large monitor and would re-truncate the labels the moment the window is tiled.
 * Every comparable desktop app (VS Code, Xcode, Finder, Slack, Notion) does the
 * same. The one window-relative rule that IS worth having is the ceiling below.
 *
 * Renderer-local persistence through the shared codec (`viewPreference.ts`):
 * versioned JSON under a `catcode.`-prefixed key, read/written through an
 * injectable storage, best-effort. No protocol frame, no registry field, no
 * preload channel — a view preference with no engine meaning
 * (SECURITY-MINIMUM §2).
 */

import {
  readViewPreference,
  writeViewPreference,
  type ViewPreferenceStorage,
} from './viewPreference.js'

export const SIDEBAR_WIDTH_STORAGE_KEY = 'catcode.sidebarWidth.v1'

/** Narrow enough to be a rail, wide enough for the icon + a word of label. */
export const SIDEBAR_MIN_WIDTH = 192

/** Fixed ceiling. `clampSidebarWidth` lowers it further on a narrow window. */
export const SIDEBAR_MAX_WIDTH = 420

/**
 * Chosen against the labels, not the screen: 240 truncated ordinary session
 * titles (operator, 2026-08-28). At ~6.7px per character in the rail's 14px DM
 * Sans, the row's text column is this value minus its ~72px of icon, padding and
 * status chrome, so 288 reads ~32 characters against 240's ~25.
 */
export const SIDEBAR_DEFAULT_WIDTH = 288

/**
 * Window-relative ceiling. The window's own floor is `minWidth: 852`
 * (`app/main/main.ts:1323`), where the fixed 420 cap would hand the rail 49% of
 * the frame and leave the transcript a gutter. A third keeps the rail
 * subordinate to the transcript at every window size while staying above
 * `SIDEBAR_MIN_WIDTH` (852/3 = 284) at the narrowest window, so this ceiling can
 * never collide with the floor and invert the range.
 */
export const SIDEBAR_MAX_WIDTH_WINDOW_FRACTION = 1 / 3

/**
 * Hold `width` inside the allowed range: the fixed 192–420 bounds, with the
 * ceiling lowered to a third of `windowWidth` when the window is narrow enough
 * for that to bite. `windowWidth` of 0 or less (SSR, an unlaid-out frame) means
 * "no window to measure", and only the fixed bounds apply.
 */
export function clampSidebarWidth(width: number, windowWidth: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH
  const ceiling =
    windowWidth > 0
      ? Math.min(
          SIDEBAR_MAX_WIDTH,
          Math.round(windowWidth * SIDEBAR_MAX_WIDTH_WINDOW_FRACTION),
        )
      : SIDEBAR_MAX_WIDTH
  return Math.min(Math.max(ceiling, SIDEBAR_MIN_WIDTH), Math.max(SIDEBAR_MIN_WIDTH, width))
}

/**
 * The persisted width, or null when nothing valid is stored. Clamped against the
 * FIXED bounds only: the window it is about to be rendered in is not this
 * function's business, and `clampSidebarWidth` runs again at layout time.
 */
export function readSidebarWidthFromStorage(
  storage: ViewPreferenceStorage | null,
): number | null {
  return readViewPreference(storage, SIDEBAR_WIDTH_STORAGE_KEY, 'width', value => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    return Math.min(
      SIDEBAR_MAX_WIDTH,
      Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)),
    )
  })
}

export function writeSidebarWidthToStorage(
  storage: ViewPreferenceStorage | null,
  width: number,
): void {
  writeViewPreference(
    storage,
    SIDEBAR_WIDTH_STORAGE_KEY,
    'width',
    Math.round(width),
  )
}
