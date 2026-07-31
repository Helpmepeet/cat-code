/**
 * The app-local code-theme preference, and the stylesheet that actually paints
 * it.
 *
 * The CSS half is the load-bearing half. A theme swaps by CSS alone, so the way
 * this feature breaks is silent: a `[data-code-theme]` block that forgets one
 * `hljs-*` group leaves that group at the unscoped Dracula color, and the result
 * is a palette that is 90% right with a stray pink keyword in it. Nothing in the
 * SSR renderer can see that, so the stylesheet is parsed here instead.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CODE_THEME_KEYS,
  CODE_THEME_LABELS,
  CODE_THEME_STORAGE_KEY,
  DEFAULT_CODE_THEME,
  isCodeThemeKey,
  readCodeThemeFromStorage,
  selectCodeThemeNote,
  writeCodeThemeToStorage,
  type CodeThemeKey,
} from './codeTheme.js'

function storage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    raw: store,
  }
}

describe('persistence', () => {
  test('an empty store, and no store at all, leave the caller on the default', () => {
    expect(readCodeThemeFromStorage(storage())).toBeNull()
    expect(readCodeThemeFromStorage(null)).toBeNull()
  })

  test('every theme round-trips through the real write and read helpers', () => {
    for (const theme of CODE_THEME_KEYS) {
      const store = storage()
      writeCodeThemeToStorage(store, theme)
      expect(readCodeThemeFromStorage(store)).toBe(theme)
    }
  })

  test('a value that is not one of the five is rejected, not returned', () => {
    // The realistic shape: a key written by an older or newer build.
    expect(
      readCodeThemeFromStorage(
        storage({
          [CODE_THEME_STORAGE_KEY]: JSON.stringify({
            version: 1,
            theme: 'solarized',
          }),
        }),
      ),
    ).toBeNull()
    // A bare string (the prototype's un-versioned format) is not accepted either.
    expect(
      readCodeThemeFromStorage(
        storage({ [CODE_THEME_STORAGE_KEY]: '"dracula"' }),
      ),
    ).toBeNull()
    expect(isCodeThemeKey('solarized')).toBe(false)
    expect(isCodeThemeKey(null)).toBe(false)
  })

  test('a wrong version or corrupt JSON degrades instead of throwing', () => {
    expect(
      readCodeThemeFromStorage(
        storage({
          [CODE_THEME_STORAGE_KEY]: JSON.stringify({ version: 2, theme: 'nord' }),
        }),
      ),
    ).toBeNull()
    expect(
      readCodeThemeFromStorage(storage({ [CODE_THEME_STORAGE_KEY]: '{oops' })),
    ).toBeNull()
  })

  test('a storage that throws does not take the caller down with it', () => {
    const hostile = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    }
    expect(readCodeThemeFromStorage(hostile)).toBeNull()
    expect(() => writeCodeThemeToStorage(hostile, 'nord')).not.toThrow()
  })
})

describe('the disabled note', () => {
  test('it says what to do when highlighting is off, and nothing otherwise', () => {
    expect(selectCodeThemeNote(false)).toBeNull()
    const note = selectCodeThemeNote(true)
    expect(note).toContain('Interface')
    // Operator text rules: no em dash, no engineering vocabulary on screen.
    expect(note).not.toContain('—')
  })
})

/* ── the stylesheet ───────────────────────────────────────────────────────── */

/** Comments are stripped first: the stylesheet's own prose quotes CSS and even a
 * `${…}` interpolation, which a brace-splitting reader would take for rules. */
const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'theme.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * The hljs scopes the shipped Dracula block colors, one entry per rule. Any
 * theme that leaves one unset inherits Dracula's color for it.
 */
const THEMED_SCOPES = [
  '.hljs',
  '.hljs-comment',
  '.hljs-keyword',
  '.hljs-operator',
  '.hljs-string',
  '.hljs-number',
  '.hljs-title',
  '.hljs-built_in',
  '.hljs-selector-class',
  '.hljs-property',
  '.hljs-link',
] as const

/** `selector { … color: #hex … }` for one scope under one theme. */
function colorFor(theme: CodeThemeKey, scope: string): string | null {
  const prefix = theme === DEFAULT_CODE_THEME ? '' : `[data-code-theme="${theme}"] `
  for (const block of CSS.split('}')) {
    const [selectorText, body] = block.split('{')
    if (body === undefined) continue
    const selectors = selectorText.split(',').map(part => part.trim())
    // Exact match only: `.hljs-title.class_` must not answer for `.hljs-title`.
    if (!selectors.includes(`${prefix}${scope}`)) continue
    const color = /color:\s*(#[0-9a-f]{3,8})/i.exec(body)
    if (color) return color[1].toLowerCase()
  }
  return null
}

function paletteOf(theme: CodeThemeKey): Record<string, string> {
  const palette: Record<string, string> = {}
  for (const scope of THEMED_SCOPES) {
    const color = colorFor(theme, scope)
    if (color) palette[scope] = color
  }
  return palette
}

describe('theme.css', () => {
  test('reduced motion neutralizes every current renderer animation class', () => {
    const mediaRule =
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*([^{}]+)\s*\{\s*([^{}]+)\s*\}\s*\}/.exec(
        CSS,
      )
    expect(mediaRule).not.toBeNull()

    const selectors = mediaRule?.[1]
      .split(',')
      .map(selector => selector.trim())
      .sort()
    expect(selectors).toEqual(
      [
        '.animate-ping',
        '.animate-pulse',
        '.animate-sa-pop',
        '.animate-spin',
        '.animate-toast-in',
        '.animate-token-warn-in',
      ].sort(),
    )
    expect(mediaRule?.[2].trim()).toBe('animation: none !important;')
  })

  test('the default theme is the unscoped block, so it needs no rules of its own', () => {
    expect(CSS).not.toContain(`[data-code-theme="${DEFAULT_CODE_THEME}"]`)
    expect(Object.keys(paletteOf(DEFAULT_CODE_THEME)).sort()).toEqual(
      [...THEMED_SCOPES].sort(),
    )
  })

  test('every theme colors every themed scope, so no palette leaks the default', () => {
    for (const theme of CODE_THEME_KEYS) {
      const missing = THEMED_SCOPES.filter(scope => !colorFor(theme, scope))
      expect({ theme, missing }).toEqual({ theme, missing: [] })
    }
  })

  test('the five themes are five distinct palettes', () => {
    const seen = new Map<string, CodeThemeKey>()
    for (const theme of CODE_THEME_KEYS) {
      const signature = JSON.stringify(paletteOf(theme))
      const clash = seen.get(signature)
      expect({ theme, clash: clash ?? null }).toEqual({ theme, clash: null })
      seen.set(signature, theme)
    }
    expect(seen.size).toBe(CODE_THEME_KEYS.length)
  })

  test('One Dark and Monokai keep the two splits the Prism mapping needed', () => {
    // The reason `.hljs-operator` and `.hljs-built_in` are separate rules at
    // all: fold either back into its neighbour and these two palettes go wrong.
    expect(colorFor('oneDark', '.hljs-operator')).not.toBe(
      colorFor('oneDark', '.hljs-keyword'),
    )
    expect(colorFor('monokai', '.hljs-built_in')).not.toBe(
      colorFor('monokai', '.hljs-selector-class'),
    )
  })

  test('every theme has a label to pick it by', () => {
    for (const theme of CODE_THEME_KEYS) {
      expect(CODE_THEME_LABELS[theme].length).toBeGreaterThan(0)
    }
  })
})
