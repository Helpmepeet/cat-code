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
import {
  memoryStorage as storage,
  throwingStorage,
} from './viewPreferenceStorageFixture.js'

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
    const hostile = throwingStorage()
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

/**
 * Both appearances are read, because both ship. Every code-theme declaration is
 * a `light-dark(light, dark)` pair (the block takes its ground from `bg-app-bg`,
 * so a light page would otherwise turn all five palettes into pale ink on
 * near-white), and the checks below have to hold for each half independently:
 * a light palette that silently equals another light palette is the same defect
 * as two dark ones colliding.
 */
const APPEARANCES = ['light', 'dark'] as const

type Appearance = (typeof APPEARANCES)[number]

/** `selector { … color: light-dark(#light, #dark) … }` for one scope under one
 * theme. A bare `color: #hex` still answers, for both, so this reader does not
 * quietly report "unset" if a pair is ever collapsed back to one value. */
function colorFor(
  theme: CodeThemeKey,
  scope: string,
  appearance: Appearance = 'dark',
): string | null {
  const prefix = theme === DEFAULT_CODE_THEME ? '' : `[data-code-theme="${theme}"] `
  for (const block of CSS.split('}')) {
    const [selectorText, body] = block.split('{')
    if (body === undefined) continue
    const selectors = selectorText.split(',').map(part => part.trim())
    // Exact match only: `.hljs-title.class_` must not answer for `.hljs-title`.
    if (!selectors.includes(`${prefix}${scope}`)) continue
    const pair =
      /color:\s*light-dark\(\s*(#[0-9a-f]{3,8})\s*,\s*(#[0-9a-f]{3,8})\s*\)/i.exec(body)
    if (pair) return pair[appearance === 'light' ? 1 : 2].toLowerCase()
    const single = /color:\s*(#[0-9a-f]{3,8})/i.exec(body)
    if (single) return single[1].toLowerCase()
  }
  return null
}

function paletteOf(
  theme: CodeThemeKey,
  appearance: Appearance = 'dark',
): Record<string, string> {
  const palette: Record<string, string> = {}
  for (const scope of THEMED_SCOPES) {
    const color = colorFor(theme, scope, appearance)
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
        '.animate-compact-absorb',
        '.animate-compact-ingest',
        '.animate-compact-star',
        '.animate-compact-sweep-left',
        '.animate-compact-sweep-right',
        '.animate-face-pulse',
        '.animate-ping',
        '.animate-pulse',
        '.animate-sa-pop',
        '.animate-spin',
        '.animate-toast-in',
        '.animate-token-warn-in',
        // Arriving prose fades in; a reader who asked for less motion gets the
        // honest instant arrival instead (`proseArrival.ts`).
        '.prose-arrive-smooth',
        '.prose-arrive-flowing',
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

  test('every theme colors every themed scope in both appearances', () => {
    for (const appearance of APPEARANCES) {
      for (const theme of CODE_THEME_KEYS) {
        const missing = THEMED_SCOPES.filter(scope => !colorFor(theme, scope, appearance))
        expect({ appearance, theme, missing }).toEqual({ appearance, theme, missing: [] })
      }
    }
  })

  test('the five themes stay five distinct palettes in both appearances', () => {
    for (const appearance of APPEARANCES) {
      const seen = new Map<string, CodeThemeKey>()
      for (const theme of CODE_THEME_KEYS) {
        const signature = JSON.stringify(paletteOf(theme, appearance))
        const clash = seen.get(signature)
        expect({ appearance, theme, clash: clash ?? null }).toEqual({
          appearance,
          theme,
          clash: null,
        })
        seen.set(signature, theme)
      }
      expect(seen.size).toBe(CODE_THEME_KEYS.length)
    }
  })

  /**
   * A light palette that is byte-identical to its dark one is a theme that was
   * given a `light-dark()` pair with the same value twice, which reads as
   * "converted" in a diff and is invisible in every other assertion here.
   */
  test('no theme paints the same palette in both appearances', () => {
    for (const theme of CODE_THEME_KEYS) {
      expect({ theme, same: JSON.stringify(paletteOf(theme, 'light')) === JSON.stringify(paletteOf(theme, 'dark')) })
        .toEqual({ theme, same: false })
    }
  })

  test('One Dark and Monokai keep the two splits the Prism mapping needed', () => {
    // The reason `.hljs-operator` and `.hljs-built_in` are separate rules at
    // all: fold either back into its neighbour and these two palettes go wrong.
    for (const appearance of APPEARANCES) {
      expect(colorFor('oneDark', '.hljs-operator', appearance)).not.toBe(
        colorFor('oneDark', '.hljs-keyword', appearance),
      )
      expect(colorFor('monokai', '.hljs-built_in', appearance)).not.toBe(
        colorFor('monokai', '.hljs-selector-class', appearance),
      )
    }
  })

  test('every theme has a label to pick it by', () => {
    for (const theme of CODE_THEME_KEYS) {
      expect(CODE_THEME_LABELS[theme].length).toBeGreaterThan(0)
    }
  })
})
