/**
 * The parts of the appearance preference that are pure: the stored choice, the
 * resolution of `system` against the OS, the stamp, and the stylesheet that
 * gives the stamped attribute something to mean.
 *
 * The stamp path takes an injected root (`colorScheme.ts` `AppearanceRoot`), so
 * this stays an SSR-only suite like the rest of the renderer's preference tests.
 * The runtime half lives in `ColorSchemeProvider.dom.test.ts`, because an SSR
 * suite cannot tell a working provider from one that never stamps anything.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import {
  APPEARANCE_ATTRIBUTE,
  applyAppearance,
  COLOR_SCHEME_KEYS,
  COLOR_SCHEME_STORAGE_KEY,
  DEFAULT_COLOR_SCHEME,
  isColorSchemeKey,
  readColorSchemeFromStorage,
  resolveAppearance,
  writeColorSchemeToStorage,
} from './colorScheme.js'

function storage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  }
}

function fakeRoot() {
  const attributes = new Map<string, string>()
  return {
    attributes,
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
  }
}

function themeCss(): string {
  return readFileSync(new URL('./theme.css', import.meta.url), 'utf8')
}

test('the shipped default follows the system', () => {
  expect(DEFAULT_COLOR_SCHEME).toBe('system')
  expect(COLOR_SCHEME_KEYS).toEqual(['system', 'light', 'dark'])
})

test('a written choice round-trips through the real read', () => {
  const store = storage()
  for (const key of COLOR_SCHEME_KEYS) {
    writeColorSchemeToStorage(store, key)
    expect(readColorSchemeFromStorage(store)).toBe(key)
  }
})

test('an empty, unavailable or corrupt store reads as no preference', () => {
  expect(readColorSchemeFromStorage(storage())).toBeNull()
  expect(readColorSchemeFromStorage(null)).toBeNull()
  expect(readColorSchemeFromStorage(storage({ [COLOR_SCHEME_STORAGE_KEY]: '{oops' }))).toBeNull()
  // A future version, and a value from neither version.
  expect(
    readColorSchemeFromStorage(
      storage({ [COLOR_SCHEME_STORAGE_KEY]: JSON.stringify({ version: 2, scheme: 'light' }) }),
    ),
  ).toBeNull()
  expect(
    readColorSchemeFromStorage(
      storage({ [COLOR_SCHEME_STORAGE_KEY]: JSON.stringify({ version: 1, scheme: 'sepia' }) }),
    ),
  ).toBeNull()
})

test('a failing store never throws into the caller', () => {
  const hostile = {
    getItem: () => {
      throw new Error('denied')
    },
    setItem: () => {
      throw new Error('denied')
    },
  }
  expect(readColorSchemeFromStorage(hostile)).toBeNull()
  expect(() => writeColorSchemeToStorage(hostile, 'light')).not.toThrow()
})

test('isColorSchemeKey rejects everything outside the closed set', () => {
  expect(isColorSchemeKey('system')).toBe(true)
  expect(isColorSchemeKey('Light')).toBe(false)
  expect(isColorSchemeKey('')).toBe(false)
  expect(isColorSchemeKey(null)).toBe(false)
  expect(isColorSchemeKey({ scheme: 'light' })).toBe(false)
})

/**
 * The whole point of `system` being a THIRD value rather than an absent one: a
 * forced choice must not move when the OS does, and `system` must.
 */
test('only the system choice follows the operating system', () => {
  expect(resolveAppearance('system', true)).toBe('dark')
  expect(resolveAppearance('system', false)).toBe('light')
  expect(resolveAppearance('light', true)).toBe('light')
  expect(resolveAppearance('light', false)).toBe('light')
  expect(resolveAppearance('dark', true)).toBe('dark')
  expect(resolveAppearance('dark', false)).toBe('dark')
})

/**
 * Both values are stamped, unlike `data-glass`. Only `light` has rules, but a
 * document carrying no attribute at all would be indistinguishable from one
 * whose provider has not run, and that ambiguity is what this asserts away.
 */
test('the stamp always states which appearance is live', () => {
  const root = fakeRoot()
  applyAppearance(root, 'light')
  expect(root.attributes.get(APPEARANCE_ATTRIBUTE)).toBe('light')
  applyAppearance(root, 'dark')
  expect(root.attributes.get(APPEARANCE_ATTRIBUTE)).toBe('dark')
  expect(() => applyAppearance(null, 'light')).not.toThrow()
})

/**
 * The attribute is only half the mechanism. Without matching rules the picker
 * silently does nothing, and no render assertion can see that.
 */
test('the stylesheet repaints every window ground under the stamp', () => {
  const block = themeCss().match(/html\[data-appearance='light'\]\s*\{([^}]*)\}/)
  expect(block).not.toBeNull()
  const body = block?.[1] ?? ''
  for (const token of [
    '--app-bg',
    '--shell-chrome',
    '--surface-raised',
    '--surface-panel',
    '--shell-seam',
    '--shell-hover',
    '--shell-active',
    '--text-primary',
    '--text-muted',
    '--text-subtle',
    '--text-faint',
    '--text-ghost',
    '--on-fill',
    '--scrim',
  ]) {
    expect(body).toContain(`${token}:`)
  }
})

/**
 * `color-scheme` is load-bearing twice: Chromium's own form controls, focus
 * rings and default scrollbars, AND every `light-dark()` pair in this
 * stylesheet and in the transcript's status-ink classes. Dropping it would
 * leave a light shell painting dark syntax highlighting and dark glass.
 */
test('the light appearance moves color-scheme, not only the grounds', () => {
  const css = themeCss()
  expect(css).toMatch(/html\[data-appearance='light'\]\s*\{[^}]*color-scheme:\s*light/)
  expect(css).toMatch(/:root\s*\{[^}]*color-scheme:\s*dark/)
})

/**
 * The indirection this whole mechanism rests on, and the trap it was written
 * against. `@theme inline` compiles a token's VALUE into every utility it
 * generates, so a literal here would leave `bg-app-bg` carrying a hex that no
 * `html[data-appearance='light']` rule can reach: the picker would flip, the
 * page ground would change, and every component would stay dark.
 */
test('the theme routes each appearance-dependent token through an overridable var', () => {
  const css = themeCss()
  for (const [themed, raw] of [
    ['--color-app-bg', '--app-bg'],
    ['--color-shell-chrome', '--shell-chrome'],
    ['--color-shell-seam', '--shell-seam'],
    ['--color-shell-hover', '--shell-hover'],
    ['--color-shell-active', '--shell-active'],
    ['--color-surface-raised', '--surface-raised'],
    ['--color-surface-panel', '--surface-panel'],
    ['--color-text-primary', '--text-primary'],
    ['--color-text-muted', '--text-muted'],
    ['--color-text-subtle', '--text-subtle'],
    ['--color-text-faint', '--text-faint'],
    ['--color-text-ghost', '--text-ghost'],
    ['--color-on-fill', '--on-fill'],
    ['--color-scrim', '--scrim'],
    ['--color-source-user', '--source-user'],
  ]) {
    expect(css).toContain(`${themed}: var(${raw});`)
  }
})

/**
 * The 195 hardcoded `white/<alpha>` and `black/<alpha>` utilities are reachable
 * ONLY through these two names, because Tailwind compiles them to
 * `color-mix(in oklab, var(--color-white) N%, transparent)`. If the light block
 * stops declaring them, 38 files quietly keep lightening a white page and
 * nothing else in the suite notices.
 */
test('the light appearance turns the two hardcoded washes around', () => {
  const block = themeCss().match(/html\[data-appearance='light'\]\s*\{([^}]*)\}/)
  expect(block?.[1]).toContain('--color-white:')
  expect(block?.[1]).toContain('--color-black:')
})

/**
 * `--accent` is declared on a wrapper INSIDE `html` by `AccentThemeProvider`, and
 * a descendant's own declaration beats an inherited one. So the four non-default
 * accents need their own light rules; without them, picking blue on a light shell
 * keeps a 400-level hue that measures about 2.5:1 as text on white.
 */
test('every accent has a light value, not just the default', () => {
  const css = themeCss()
  for (const accent of ['blue', 'green', 'purple', 'amber']) {
    expect(css).toContain(`html[data-appearance='light'] [data-accent='${accent}']`)
  }
  // pink has no `[data-accent]` rule of its own and inherits from the block.
  expect(css).toMatch(/html\[data-appearance='light'\]\s*\{[^}]*--accent:/)
})

/**
 * Every syntax palette is dark-designed and paints onto `bg-app-bg`, so a light
 * page would turn all five into pale ink on near-white. Each declaration carries
 * its light twin inline; a bare `color: #hex` left in that block is a theme that
 * silently stayed dark.
 */
test('no code-theme colour is left without a light twin', () => {
  const css = themeCss()
  const codeThemes = css.slice(css.indexOf('.hljs {'))
  const bare = codeThemes.match(/^\s*color: #[0-9a-fA-F]{6};/gm)
  expect(bare).toBeNull()
  expect(codeThemes.match(/color: light-dark\(/g)?.length).toBe(55)
})
