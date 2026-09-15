/**
 * The renderer-local accent colour (P4-34, prototype `Settings.jsx:310-343`).
 *
 * App-local by nature, and by precedent: `rg -i "accent" src/utils/settings/types.ts
 * src/utils/config.ts` finds nothing, because an accent is a property of this
 * window rather than of the engine that answers in it. So it persists exactly
 * where the code theme and the reasoning layout do — this renderer's own storage
 * — and its Settings row carries no source badge, since no settings file has an
 * opinion about it.
 *
 * PAINT MECHANISM. `AccentThemeProvider` puts `data-accent` on a wrapper and
 * `theme.css` re-declares `--accent` / `--accent-soft` under that attribute. The
 * two reasons it is not a colour prop or an inline style: every accent-tinted
 * class in the app already resolves through `--accent` (Tailwind's
 * `--color-accent: var(--accent)`), so one attribute repaints all of them with
 * no component knowing; and a Tailwind class built by interpolating a hex
 * silently produces no CSS at all (the dynamic-class trap, `AgentsPage.tsx`
 * `AGENT_DOT_CLASS`). The swatch buttons themselves therefore carry STATIC
 * classes from `ACCENT_SWATCH_CLASS` below.
 *
 * `--accent-soft` is the one step brighter tint the shell's active states use
 * (`theme.css`). Each accent pairs a Tailwind 400 with its own 300 so that
 * relationship holds for every choice, exactly as pink-400/pink-300 does today.
 */

import { createContext } from 'react'
import {
  readViewPreference,
  writeViewPreference,
  type ViewPreferenceStorage,
} from './viewPreference.js'

export const ACCENT_STORAGE_KEY = 'catcode.accent.v1'

/** The prototype's five accents, in its order and under its names
 * (`Settings.jsx:310-313`). */
export const ACCENT_KEYS = ['pink', 'blue', 'green', 'purple', 'amber'] as const

export type AccentKey = (typeof ACCENT_KEYS)[number]

export const ACCENT_LABELS: Readonly<Record<AccentKey, string>> = {
  pink: 'Pink',
  blue: 'Blue',
  green: 'Green',
  purple: 'Purple',
  amber: 'Amber',
}

/**
 * Static swatch classes. Written out rather than interpolated from the hexes in
 * `theme.css` because Tailwind scans source text: a class assembled at runtime
 * is never generated, and the swatch renders colourless with nothing to see in a
 * headless test.
 *
 * Each is a `light-dark()` PAIR carrying that accent's value in both
 * appearances, and the second half of each pair is the literal this shipped with.
 * Before that, the picker painted the dark hex in both, so a swatch in the light
 * appearance advertised a colour the app never used anywhere — furthest apart for
 * pink, whose light value is a different hue family entirely (`theme.css`).
 * A pair is still one static string, so Tailwind scans it exactly as before.
 *
 * These duplicate `theme.css` rather than reading `--accent`, and must: the
 * swatch has to show what each choice WOULD paint while a different one is
 * active, so it cannot resolve through the token that is currently live.
 */
export const ACCENT_SWATCH_CLASS: Readonly<Record<AccentKey, string>> = {
  pink: 'bg-[light-dark(#bb3e84,#f472b6)]',
  blue: 'bg-[light-dark(#2563eb,#60a5fa)]',
  green: 'bg-[light-dark(#15803d,#4ade80)]',
  purple: 'bg-[light-dark(#7c3aed,#c084fc)]',
  amber: 'bg-[light-dark(#a35f00,#fbbf24)]',
}

/** The accent the app has always shipped (`theme.css` `--accent: #f472b6`), and
 * the prototype's own default (`Settings.jsx:306`). Its values are the unscoped
 * `:root` declaration, so this key needs no stylesheet rule of its own. */
export const DEFAULT_ACCENT: AccentKey = 'pink'

export function isAccentKey(value: unknown): value is AccentKey {
  return (
    typeof value === 'string' && (ACCENT_KEYS as readonly string[]).includes(value)
  )
}

export function readAccentFromStorage(
  storage: ViewPreferenceStorage | null,
): AccentKey | null {
  return readViewPreference(storage, ACCENT_STORAGE_KEY, 'accent', value =>
    isAccentKey(value) ? value : null,
  )
}

export function writeAccentToStorage(
  storage: ViewPreferenceStorage | null,
  accent: AccentKey,
): void {
  writeViewPreference(storage, ACCENT_STORAGE_KEY, 'accent', accent)
}

export type AccentThemeContextValue = {
  accent: AccentKey
  setAccent: (accent: AccentKey) => void
}

/**
 * Published by `AccentThemeProvider` at the composition root, beside
 * `CodeThemeContext` and for the same reason: the value is set in one subtree
 * (Settings) and painted by another (the wrapper above the whole app).
 */
export const AccentThemeContext = createContext<AccentThemeContextValue>({
  accent: DEFAULT_ACCENT,
  setAccent: () => {},
})
