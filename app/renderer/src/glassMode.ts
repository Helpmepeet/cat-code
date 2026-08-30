/**
 * Frosted-glass window mode: a renderer-owned view preference mirrored to main.
 *
 * Off by default, and off is the app exactly as it shipped. The only thing this
 * preference can do is take opacity away from the four window grounds in
 * `theme.css`; nothing it does not touch changes.
 *
 * NOT an engine setting, by the same test the accent colour fails
 * (`accentTheme.ts`): `rg -i "glass|vibrancy" app/shared/settingsEditable.ts`
 * finds nothing, because how this window paints itself is a property of the
 * window and not of the engine answering in it. So it persists where the accent,
 * the code theme and the tool-card style do, as versioned JSON in this
 * renderer's own storage, best-effort. Electron main keeps a synchronized,
 * bounded copy solely so it can choose the native background before the renderer
 * paints.
 *
 * A fixed boolean preload channel synchronizes the current value to main on mount
 * and change. Main updates only its persisted fallback and native background.
 * The window carries macOS vibrancy from creation and never removes or re-mints
 * it, avoiding `setVibrancy(null)`, which does not reliably clear on macOS.
 *
 * STAMP TARGET is `document.documentElement`, not the wrapper `<div>` the accent
 * stamps. The page ground is painted outside React's tree (`theme.css` base
 * layer, `body::before` — never `html`/`body` themselves, whose backgrounds
 * would become the document canvas and arm the render-surface latch that rule
 * documents), so a token redeclared on a wrapper would repaint the components
 * and leave the page behind them solid.
 */

import { createContext } from 'react'

export const GLASS_STORAGE_KEY = 'catcode.glass.v1'

/** The attribute `theme.css` selects on. Stamped only when glass is ON, so the
 * off state is the plain document the app has always rendered into. */
export const GLASS_ATTRIBUTE = 'data-glass'

export const GLASS_ATTRIBUTE_ON = 'on'

/** Solid, as the app has always shipped. */
export const DEFAULT_GLASS_ENABLED = false

type GlassStorage = Pick<Storage, 'getItem' | 'setItem'>

type PersistedGlass = {
  version: 1
  enabled: boolean
}

export function readGlassFromStorage(storage: GlassStorage | null): boolean | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(GLASS_STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<PersistedGlass>
    if (value.version !== 1 || typeof value.enabled !== 'boolean') return null
    return value.enabled
  } catch {
    return null
  }
}

export function writeGlassToStorage(
  storage: GlassStorage | null,
  enabled: boolean,
): void {
  if (!storage) return
  try {
    const value: PersistedGlass = { version: 1, enabled }
    storage.setItem(GLASS_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Renderer-owned view persistence is best-effort; a storage failure must not
    // affect the live session/control-plane state (codeTheme.ts:118).
  }
}

/**
 * The document element, narrowed to the two calls this needs so a test can drive
 * the real path without a DOM.
 */
export type GlassRoot = Pick<Element, 'setAttribute' | 'removeAttribute'>

/**
 * The attribute half of the mechanism. Off REMOVES the attribute rather than
 * writing `off`, so that a document with glass disabled is indistinguishable
 * from one whose renderer never knew about the preference, and `theme.css` needs
 * exactly one rule instead of two.
 */
export function applyGlassMode(root: GlassRoot | null, enabled: boolean): void {
  if (!root) return
  if (enabled) root.setAttribute(GLASS_ATTRIBUTE, GLASS_ATTRIBUTE_ON)
  else root.removeAttribute(GLASS_ATTRIBUTE)
}

export type GlassModeContextValue = {
  glass: boolean
  setGlass: (enabled: boolean) => void
}

/**
 * Published by `GlassModeProvider` at the composition root, beside
 * `AccentThemeContext` and for the same reason: the value is set in one subtree
 * (Settings) and painted by another (the document above the whole app).
 */
export const GlassModeContext = createContext<GlassModeContextValue>({
  glass: DEFAULT_GLASS_ENABLED,
  setGlass: () => {},
})
