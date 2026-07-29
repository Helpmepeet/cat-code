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
 */
export const ACCENT_SWATCH_CLASS: Readonly<Record<AccentKey, string>> = {
  pink: 'bg-[#f472b6]',
  blue: 'bg-[#60a5fa]',
  green: 'bg-[#4ade80]',
  purple: 'bg-[#c084fc]',
  amber: 'bg-[#fbbf24]',
}

/** The accent the app has always shipped (`theme.css` `--accent: #f472b6`), and
 * the prototype's own default (`Settings.jsx:306`). Its values are the unscoped
 * `:root` declaration, so this key needs no stylesheet rule of its own. */
export const DEFAULT_ACCENT: AccentKey = 'pink'

type AccentStorage = Pick<Storage, 'getItem' | 'setItem'>

type PersistedAccent = {
  version: 1
  accent: AccentKey
}

export function isAccentKey(value: unknown): value is AccentKey {
  return (
    typeof value === 'string' && (ACCENT_KEYS as readonly string[]).includes(value)
  )
}

export function readAccentFromStorage(
  storage: AccentStorage | null,
): AccentKey | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(ACCENT_STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<PersistedAccent>
    if (value.version !== 1 || !isAccentKey(value.accent)) return null
    return value.accent
  } catch {
    return null
  }
}

export function writeAccentToStorage(
  storage: AccentStorage | null,
  accent: AccentKey,
): void {
  if (!storage) return
  try {
    const value: PersistedAccent = { version: 1, accent }
    storage.setItem(ACCENT_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Renderer-owned view persistence is best-effort; a storage failure must not
    // affect the live session/control-plane state (codeTheme.ts:118).
  }
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
