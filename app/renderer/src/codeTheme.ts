/**
 * Fenced-code syntax theme — a RENDERER-LOCAL view preference.
 *
 * APP-LOCAL BY OPERATOR RULING (2026-07-29, PARITY-LEDGER "Theme ▸ Code theme
 * select"). It is deliberately NOT bound to the engine's `theme` key: that one
 * is the TERMINAL palette (`src/utils/config.ts:197`, `src/utils/theme.ts:92-104`)
 * and its `getSyntaxTheme` machinery emits ANSI escapes
 * (`src/native-ts/color-diff/index.ts:970-977`), not CSS, so there is nothing to
 * reuse and no seam to add. Persisted exactly like the reasoning-layout
 * preference (`reasoningLayout.ts:41-112`): versioned JSON in the renderer's own
 * storage, best-effort.
 *
 * THE COLORS ARE NOT HERE. Themes swap by CSS alone: `CodeThemeProvider` puts
 * `data-code-theme` on a wrapper and `theme.css` carries one `[data-code-theme]`
 * block per non-default theme. That is forced — `rehype-highlight`
 * (`TranscriptView.tsx:534-538`) emits stable `hljs-*` classes and never inline
 * styles, and an interpolated Tailwind class (`text-[${hex}]`) silently no-ops in
 * this renderer. A palette map here would have no consumer and would drift from
 * the stylesheet that actually paints; `codeTheme.test.ts` reads `theme.css`
 * instead and proves every theme covers every themed scope.
 *
 * PROTOTYPE KEY TRANSLATION (`Messages.jsx:1760-1766` → `theme.css`). The
 * prototype colors PRISM token types inline; we color HIGHLIGHT.JS scopes by
 * stylesheet, and the two vocabularies are not one-to-one:
 *   fg         → `.hljs`
 *   comment    → `.hljs-comment`, `.hljs-quote`
 *   keyword    → `.hljs-keyword`, `-selector-tag`, `-tag`, `-name`, `-meta`,
 *                `-meta-keyword`
 *   operator   → `.hljs-operator` (its own rule: One Dark is the one palette
 *                where operator ≠ keyword)
 *   string     → `.hljs-string`, `-regexp`, `.hljs-meta .hljs-string`,
 *                `.hljs-char.escape_`
 *   number     → `.hljs-number`, `-literal`, `-symbol`, `-bullet`
 *   boolean    → folded into number; identical in all five palettes, and hljs
 *                puts True/False/None in `.hljs-literal` anyway
 *   function   → `.hljs-title`, `.hljs-title.function_`, `-section`, `-doctag`
 *   builtin    → `.hljs-built_in` (its own rule: Monokai is the one palette
 *                where builtin ≠ class-name)
 *   class-name → `.hljs-type`, `.hljs-title.class_`, `.hljs-class .hljs-title`,
 *                `.hljs-selector-class`
 *   property   → `.hljs-attr`, `-attribute`, `-property`, `-variable`,
 *                `-template-variable`, `-selector-attr`, `-selector-id`
 * NO HLJS EQUIVALENT: `punctuation` — highlight.js leaves punctuation as bare
 * text inside `.hljs`, so it can only take the `fg` color. Only Nord separates
 * the two (#eceff4 vs #d8dee9), so Nord punctuation reads as its foreground.
 * `bg` is deliberately unused (see `theme.css`). Scopes the existing block does
 * NOT use were not invented; `.hljs-addition`/`.hljs-deletion` stay fixed across
 * themes because they are diff status, not syntax, and no palette defines them.
 */

import { createContext } from 'react'

export const CODE_THEME_STORAGE_KEY = 'catcode.codeTheme.v1'

/** The prototype's five themes, in its own order and under its own keys
 * (`Messages.jsx:1760-1766`), so no translation table is needed. */
export const CODE_THEME_KEYS = [
  'dracula',
  'oneDark',
  'nord',
  'github',
  'monokai',
] as const

export type CodeThemeKey = (typeof CODE_THEME_KEYS)[number]

export const CODE_THEME_LABELS: Readonly<Record<CodeThemeKey, string>> = {
  dracula: 'Dracula',
  oneDark: 'One Dark',
  nord: 'Nord',
  github: 'GitHub Dark',
  monokai: 'Monokai',
}

/** The palette the transcript already shipped with, and the prototype's own
 * default (`Messages.jsx:1767`). Its rules are the UNSCOPED block in
 * `theme.css`, so this key needs no stylesheet of its own. */
export const DEFAULT_CODE_THEME: CodeThemeKey = 'dracula'

type CodeThemeStorage = Pick<Storage, 'getItem' | 'setItem'>

type PersistedCodeTheme = {
  version: 1
  theme: CodeThemeKey
}

export function isCodeThemeKey(value: unknown): value is CodeThemeKey {
  return (
    typeof value === 'string' &&
    (CODE_THEME_KEYS as readonly string[]).includes(value)
  )
}

export function readCodeThemeFromStorage(
  storage: CodeThemeStorage | null,
): CodeThemeKey | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(CODE_THEME_STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<PersistedCodeTheme>
    if (value.version !== 1 || !isCodeThemeKey(value.theme)) return null
    return value.theme
  } catch {
    return null
  }
}

export function writeCodeThemeToStorage(
  storage: CodeThemeStorage | null,
  theme: CodeThemeKey,
): void {
  if (!storage) return
  try {
    const value: PersistedCodeTheme = { version: 1, theme }
    storage.setItem(CODE_THEME_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Renderer-owned view persistence is best-effort; a storage failure must not
    // affect the live session/control-plane state (reasoningLayout.ts:109).
  }
}

export type CodeThemeContextValue = {
  theme: CodeThemeKey
  setTheme: (theme: CodeThemeKey) => void
}

/**
 * Published by `CodeThemeProvider` at the composition root, for the same reason
 * `ReasoningLayoutContext` is (`reasoningLayout.ts:119-129`): the value is set in
 * one subtree (Settings) and read in another (the wrapper that paints the
 * transcript), and belongs to neither.
 */
export const CodeThemeContext = createContext<CodeThemeContextValue>({
  theme: DEFAULT_CODE_THEME,
  setTheme: () => {},
})

/**
 * The one sentence a disabled picker owes the reader, or null in the ordinary
 * case — restating a state the user already chose is noise (`settingsScope.ts`
 * `settingsRowNote`). Highlighting is an ENGINE setting on a different page, so
 * the note has to say where to go.
 */
export function selectCodeThemeNote(
  syntaxHighlightingOff: boolean,
): string | null {
  return syntaxHighlightingOff
    ? 'Syntax highlighting is off, so code blocks have no colors to theme. Turn it back on under Interface.'
    : null
}

/**
 * The Settings preview sample, ported verbatim from the prototype's
 * `PREVIEW_CODE` (`Settings.jsx:281`). It is chosen, not arbitrary: one sample
 * has to exercise every themed scope at once, and this one carries comments, a
 * docstring, keywords, builtins, a class name, function names, numbers, an
 * f-string, and a boolean literal, so a palette swap is visible in all of them.
 *
 * It lives in this `.ts` module rather than beside the component because a
 * production renderer `.tsx` module may export React components only
 * (`lint:fast-refresh`).
 */
export const PREVIEW_CODE = `import random


class Cat:
    """A cat. Obeys no one, especially not the scheduler."""

    def __init__(self, name, lives=9):
        self.name = name
        self.lives = lives
        self.mood = "aloof"  # default disposition

    def knock_off(self, item):
        if item in ("mug", "pen", "your_dignity"):
            print(f"{self.name} pushes the {item} off the desk.")
            return True
        return False  # deemed unworthy of gravity

    def nap(self, hours=16):
        self.mood = "recharging"
        return ["zzz" for _ in range(hours)]


cats = [Cat(n) for n in ("Mochi", "Pixel", "Sir Fluff")]
chosen = random.choice(cats)
chosen.knock_off("mug")`

/** The sample's language, as both the fence and the block's own label. */
export const PREVIEW_CODE_LANG = 'python'
