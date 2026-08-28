/**
 * Light or dark appearance: a RENDERER-LOCAL view preference with ONE main-side
 * consequence.
 *
 * Three choices, the state machine every desktop app has: follow the system,
 * force light, force dark. `system` is the default and is what the app has
 * always effectively been, because the app has always been dark and this
 * machine's macOS was too.
 *
 * NOT an engine setting, by the same test the accent colour and glass mode fail
 * (`accentTheme.ts`, `glassMode.ts`): how this window paints itself is a
 * property of the window, not of the engine answering in it. So it persists
 * where they do, as versioned JSON in this renderer's own storage, best-effort.
 *
 * ── WHY THIS ONE NEEDS THE MAIN PROCESS, WHEN GLASS DID NOT ──────────────────
 *
 * Glass could stay renderer-only because macOS mounts the vibrancy material once
 * at window creation and the page just decides how much of it to cover. The
 * material's LIGHTNESS is a different question: `NSVisualEffectView` picks its
 * material from the app's effective `NSAppearance`, which is process-global and
 * reachable only from main, through `nativeTheme.themeSource`.
 *
 * Three things were measured rather than assumed, because guessing at this layer
 * has cost this project relaunches before:
 *
 *   1. Setting `nativeTheme.themeSource` moves `NSApplication.effectiveAppearance`
 *      even on a window that ALREADY EXISTS. So the preference does not have to
 *      be persisted somewhere main can read before `createWindow`; a message
 *      after the fact is enough, which is what `setAppearance` below is.
 *   2. The renderer cannot do it alone. A page that declares
 *      `color-scheme: light` and paints a light ground leaves
 *      `effectiveAppearance` at `dark`, so a forced-light app with glass on
 *      would sit a white page over the dark material.
 *   3. `matchMedia('(prefers-color-scheme: dark)')` in the renderer tracks
 *      `nativeTheme` exactly, from the OS and from `themeSource` alike.
 *
 * (3) is why this file is small. The renderer's rule is the same in all three
 * choices — follow `prefers-color-scheme` — and `system` is simply the choice
 * that sends main nothing to override. Main is a layer on top, not a fork.
 *
 * STAMP TARGET is `document.documentElement`, like glass and unlike the accent.
 * The page ground is painted outside React's tree (`theme.css` base layer,
 * `body::before`), and `color-scheme` has to reach the document for Chromium's
 * form controls and for every `light-dark()` in `theme.css` to resolve.
 */

import { createContext } from 'react'

export const COLOR_SCHEME_STORAGE_KEY = 'catcode.appearance.v1'

/** What the user picks. */
export const COLOR_SCHEME_KEYS = ['system', 'light', 'dark'] as const

export type ColorSchemeKey = (typeof COLOR_SCHEME_KEYS)[number]

/** What the app ends up painting, after `system` has been resolved against the
 * OS. Only these two ever reach the document or the main process. */
export type ResolvedAppearance = 'light' | 'dark'

export const COLOR_SCHEME_LABELS: Readonly<Record<ColorSchemeKey, string>> = {
  system: 'Match system',
  light: 'Light',
  dark: 'Dark',
}

/**
 * Follow the OS. The app was dark before this existed and stays dark on a dark
 * system, so nobody's window changes on the release that adds this.
 */
export const DEFAULT_COLOR_SCHEME: ColorSchemeKey = 'system'

/** The attribute `theme.css` selects on. Unlike `data-glass`, BOTH values are
 * stamped: only `light` carries rules, but writing `dark` explicitly means the
 * document always states which appearance is live, rather than leaving "dark"
 * and "the provider has not run yet" as the same empty state. */
export const APPEARANCE_ATTRIBUTE = 'data-appearance'

/** The media query that answers `system`, and that `themeSource` also drives. */
export const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)'

type ColorSchemeStorage = Pick<Storage, 'getItem' | 'setItem'>

type PersistedColorScheme = {
  version: 1
  scheme: ColorSchemeKey
}

export function isColorSchemeKey(value: unknown): value is ColorSchemeKey {
  return (
    typeof value === 'string' &&
    (COLOR_SCHEME_KEYS as readonly string[]).includes(value)
  )
}

export function readColorSchemeFromStorage(
  storage: ColorSchemeStorage | null,
): ColorSchemeKey | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(COLOR_SCHEME_STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<PersistedColorScheme>
    if (value.version !== 1 || !isColorSchemeKey(value.scheme)) return null
    return value.scheme
  } catch {
    return null
  }
}

export function writeColorSchemeToStorage(
  storage: ColorSchemeStorage | null,
  scheme: ColorSchemeKey,
): void {
  if (!storage) return
  try {
    const value: PersistedColorScheme = { version: 1, scheme }
    storage.setItem(COLOR_SCHEME_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Renderer-owned view persistence is best-effort; a storage failure must not
    // affect the live session/control-plane state (codeTheme.ts:118).
  }
}

/**
 * The choice, plus what the OS currently says, resolved to the one appearance
 * that gets painted. Kept a pure function of its two inputs so the provider can
 * recompute it on an OS change without re-reading anything.
 */
export function resolveAppearance(
  scheme: ColorSchemeKey,
  systemPrefersDark: boolean,
): ResolvedAppearance {
  if (scheme === 'light') return 'light'
  if (scheme === 'dark') return 'dark'
  return systemPrefersDark ? 'dark' : 'light'
}

/**
 * The document element, narrowed to the one call this needs so a test can drive
 * the real path without a DOM.
 */
export type AppearanceRoot = Pick<Element, 'setAttribute'>

export function applyAppearance(
  root: AppearanceRoot | null,
  appearance: ResolvedAppearance,
): void {
  if (!root) return
  root.setAttribute(APPEARANCE_ATTRIBUTE, appearance)
}

export type ColorSchemeContextValue = {
  /** What the user picked. */
  scheme: ColorSchemeKey
  /** What is actually painted right now; `system` resolves to one of these. The
   * Settings row shows it so "Match system" can say which way it currently
   * lands without the reader having to work it out. */
  appearance: ResolvedAppearance
  setScheme: (scheme: ColorSchemeKey) => void
}

/**
 * Published by `ColorSchemeProvider` at the composition root, beside
 * `AccentThemeContext` and for the same reason: the value is set in one subtree
 * (Settings) and painted by another (the document above the whole app).
 */
export const ColorSchemeContext = createContext<ColorSchemeContextValue>({
  scheme: DEFAULT_COLOR_SCHEME,
  appearance: 'dark',
  setScheme: () => {},
})
