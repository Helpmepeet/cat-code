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
import { readdirSync, readFileSync } from 'fs'
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
/**
 * DERIVED FROM `:root`, NOT A HAND-WRITTEN LIST, and the difference is the whole
 * value of the test. The first version named fourteen tokens; the appearance
 * layer declares more than twice that, so dropping `--scrollbar-thumb`,
 * `--tone-danger` or all six `--elev-*` from the light block left the suite green
 * while the light shell inherited dark values (a token forgotten here does not
 * fail, it silently keeps the `:root` value, which for `--elev-menu` means
 * `rgba(0,0,0,0.6)` shadows on a white page).
 *
 * The appearance layer is everything from `--app-bg` onward in `:root`, which is
 * where the block's own comment says it begins. `--transcript-width` is the one
 * member that legitimately does not move: it is a length, not a colour.
 */
test('every appearance-layer token declared in :root is redeclared for light', () => {
  const css = themeCss()
  const root = /:root \{(.*?)\n\}/s.exec(css)?.[1] ?? ''
  const light = /html\[data-appearance='light'\] \{(.*?)\n\}/s.exec(css)?.[1] ?? ''
  expect(root).not.toBe('')
  expect(light).not.toBe('')

  const declared = (block: string) =>
    [...block.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map(match => match[1])
  const rootTokens = declared(root)
  const start = rootTokens.indexOf('--app-bg')
  expect(start).toBeGreaterThanOrEqual(0)

  const NOT_APPEARANCE_DEPENDENT = new Set(['--transcript-width'])
  const lightTokens = new Set(declared(light))
  const missing = rootTokens
    .slice(start)
    .filter(token => !NOT_APPEARANCE_DEPENDENT.has(token) && !lightTokens.has(token))
  expect(missing).toEqual([])
  // A floor, so the derivation cannot pass by finding nothing.
  expect(rootTokens.length - start).toBeGreaterThan(20)
})

/**
 * The renderer names Tailwind's own shades directly in 155 places across 12
 * files (`text-teal-300`, `bg-zinc-500`, `border-purple-400/30`), and those are
 * invisible to a sweep for this file's tokens or for `text-[#hex]` — which is
 * exactly how they were missed the first time. On a near-white ground the
 * 200/300/400 shades measure between 1.34:1 and 2.82:1.
 *
 * They repaint for the same reason `--color-white` does, so this asserts the
 * shades the renderer actually uses are all redeclared. Derived from source, so
 * a new `text-rose-300` in some future component fails here rather than shipping
 * invisible.
 */
test('every Tailwind palette shade the renderer names is redeclared for light', () => {
  const dir = new URL('.', import.meta.url)
  const used = new Set<string>()
  for (const file of readdirSync(dir)) {
    if (!/\.(tsx?|ts)$/.test(file) || file.includes('.test.')) continue
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    for (const [, shade] of source.matchAll(
      /\b(?:text|bg|border|fill|stroke|ring|from|to|via|decoration)-((?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3})\b/g,
    )) {
      used.add(shade)
    }
  }
  expect(used.size).toBeGreaterThan(20)

  const light = /html\[data-appearance='light'\] \{(.*?)\n\}/s.exec(themeCss())?.[1] ?? ''
  // Already dark enough to read on a light ground; moving them would flatten the
  // dimmest end of the ramp, and the stylesheet says so.
  const KEPT = new Set(['zinc-600', 'zinc-700'])
  const missing = [...used]
    .filter(shade => !KEPT.has(shade) && !light.includes(`--color-${shade}:`))
    .sort()
  expect(missing).toEqual([])
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

/**
 * The one defect `light-dark()` invites and that nothing else here can see: a
 * SWAPPED pair. The CSS order is `light-dark(light, dark)`, both halves are
 * plausible hexes, and every other assertion in this file is satisfied by a pair
 * whichever way round it is. A swap puts pale syntax ink on a white page, in one
 * theme only, with the whole suite green.
 *
 * The check is legibility, not ordering. Ordering looked like the obvious
 * invariant and is WRONG: a comment is deliberately the least contrasty scope in
 * a syntax theme, so One Light's comment grey really is lighter than One Dark's,
 * and two pairs here are legitimately "light half lighter". What does hold for
 * all 55 is that each half must be readable against its OWN ground.
 *
 * At a 3:1 floor this discriminates 47 of the 55 possible swaps (measured). The
 * 8 it cannot are pairs whose halves are both mid-tone greys, where the swap is
 * genuinely hard to see by any rule; they are named as the residue rather than
 * papered over. The floor itself is worth asserting on its own account: it is
 * the WCAG non-text minimum, and the tightest real value is 3.29.
 */
test('every syntax colour is legible on the ground it is used against', () => {
  const luminance = (hex: string): number => {
    const channel = (raw: number) => {
      const c = raw / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  }
  const contrast = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }
  // The two page grounds these are read against (`--app-bg`, both appearances).
  const LIGHT_GROUND = '#fcfcfd'
  const DARK_GROUND = '#09090b'
  const FLOOR = 3

  const css = themeCss()
  const codeThemes = css.slice(css.indexOf('.hljs {'))
  const pairs = [
    ...codeThemes.matchAll(
      /color: light-dark\((#[0-9a-fA-F]{6}),\s*(#[0-9a-fA-F]{6})\)/g,
    ),
  ]
  expect(pairs.length).toBe(55)

  const illegible = pairs
    .filter(
      ([, light, dark]) =>
        contrast(light, LIGHT_GROUND) < FLOOR || contrast(dark, DARK_GROUND) < FLOOR,
    )
    .map(([whole]) => whole)
  expect(illegible).toEqual([])
})

/**
 * The accents, which nothing guarded until the light pink shipped wrong.
 *
 * CONTRAST ALONE WOULD NOT HAVE CAUGHT IT. The bad value measured 4.95:1 on the
 * ground and 5.07:1 under white ink, i.e. it passed every floor this file
 * otherwise asserts, and still read as the wrong colour. What it did was cross
 * hues: in OKLCH the light pink landed at 2.7 degrees, over the far side of red,
 * closing the gap to `--tone-danger` from 32.5 degrees in dark to 24.6 in light.
 * The colour most of the app is painted with had drifted toward the colour that
 * means destructive.
 *
 * So this asserts both: every accent clears the bar in both of its roles, AND no
 * accent sits close enough to the danger tone to be read as it. The 30 degree
 * floor is below dark's own 32.5, so it constrains the light values without
 * pinning either palette to today's hexes.
 *
 * OKLCH rather than sRGB hue because that is the space the drift was measured in
 * and the space Tailwind mixes in; sRGB hue angles are not perceptually spaced
 * and would put a different, wrong number on the same colours.
 */
test('every accent clears its contrast bar and none collides with the danger tone', () => {
  const srgbToLinear = (channel: number) => {
    const c = channel / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const parse = (hex: string) =>
    [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
  const luminance = (hex: string) => {
    const [r, g, b] = parse(hex).map(srgbToLinear)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }
  const oklchHue = (hex: string) => {
    const [r, g, b] = parse(hex).map(srgbToLinear)
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
    const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
    return ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360
  }
  const apart = (a: string, b: string) => {
    const d = Math.abs(oklchHue(a) - oklchHue(b)) % 360
    return Math.min(d, 360 - d)
  }

  const css = themeCss()
  const light = /html\[data-appearance='light'\] \{(.*?)\n\}/s.exec(css)?.[1] ?? ''
  const readLight = (token: string, block = light) =>
    new RegExp(`--${token}:\\s*(#[0-9a-fA-F]{6})`).exec(block)?.[1] ?? null

  const LIGHT_GROUND = '#fcfcfd'
  const WHITE_INK = '#ffffff'
  /*
   * 30 degrees, which sits just under dark's own pink-to-danger 32.5, so the
   * floor constrains the light values without pinning either palette to today's
   * hexes.
   *
   * AMBER IS EXEMPT AT ITS MEASURED VALUE, recorded rather than waived. It has
   * pink's structural problem and the opposite resolution: amber is also a
   * tint-named colour, so darkening it at constant hue gives an olive (#9a6900),
   * and the palette instead rotates it toward orange-brown. That is the better
   * of two bad options for the colour's identity, and it costs separation from
   * danger, which fell from 62.2 degrees in dark to 21.7 in light. Nobody has
   * complained about amber and it is not the default accent, so it was left
   * alone; it is the next candidate if the light palette is revisited. Pinning
   * the number here means it cannot quietly get worse.
   */
  const DANGER_FLOOR: Record<string, number> = {
    pink: 30,
    blue: 30,
    green: 30,
    purple: 30,
    amber: 21,
  }
  const danger = readLight('tone-danger')
  expect(danger).not.toBeNull()

  // The default accent lives in the light block; the other four have their own.
  const accents: Array<[string, string, string]> = [['pink', ...([readLight('accent'), readLight('accent-soft')] as [string, string])]]
  for (const key of ['blue', 'green', 'purple', 'amber']) {
    const rule = new RegExp(
      `html\\[data-appearance='light'\\] \\[data-accent='${key}'\\] \\{(.*?)\\n\\}`,
      's',
    ).exec(css)?.[1]
    expect(rule).toBeDefined()
    accents.push([key, readLight('accent', rule ?? '')!, readLight('accent-soft', rule ?? '')!])
  }
  expect(accents).toHaveLength(5)

  const failures: string[] = []
  for (const [name, base, soft] of accents) {
    expect(base).toMatch(/^#[0-9a-f]{6}$/)
    expect(soft).toMatch(/^#[0-9a-f]{6}$/)
    // Both roles: emphasis text on the page ground, and white ink on the fill.
    if (contrast(base, LIGHT_GROUND) < 4.5) failures.push(`${name} base on ground`)
    if (contrast(WHITE_INK, base) < 4.5) failures.push(`${name} base under white ink`)
    if (contrast(soft, LIGHT_GROUND) < 4.5) failures.push(`${name} soft on ground`)
    if (contrast(WHITE_INK, soft) < 4.5) failures.push(`${name} soft under white ink`)
    // The hue collision, which contrast is blind to.
    if (apart(base, danger!) < DANGER_FLOOR[name]) {
      failures.push(
        `${name} base is ${apart(base, danger!).toFixed(1)}deg from danger, floor ${DANGER_FLOOR[name]}`,
      )
    }
  }
  expect(failures).toEqual([])

  // And the accent-rgb channels must be the base, or the ~10 glow and ring
  // sites that read `rgb(var(--accent-rgb) / a)` silently paint a stale colour.
  for (const [name, base] of accents) {
    const block =
      name === 'pink'
        ? light
        : new RegExp(
            `html\\[data-appearance='light'\\] \\[data-accent='${name}'\\] \\{(.*?)\\n\\}`,
            's',
          ).exec(css)?.[1] ?? ''
    const rgb = /--accent-rgb:\s*([0-9]+) ([0-9]+) ([0-9]+)/.exec(block)
    expect(rgb).not.toBeNull()
    const channels = [rgb![1], rgb![2], rgb![3]].map(Number)
    expect({ name, channels }).toEqual({ name, channels: parse(base) })
  }
})
