/**
 * The two halves of glass mode, tested apart: the stored preference, and the
 * stylesheet that gives the stamped attribute something to mean.
 *
 * The stamp path takes an injected root rather than a document
 * (`glassMode.ts` `GlassRoot`), so this stays an SSR-only suite. Whether the
 * PROVIDER actually reaches that path is a separate question, and a
 * `renderToStaticMarkup` suite structurally cannot answer it: effects do not
 * run. `GlassModeProvider.dom.test.ts` owns that half.
 */
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import {
  applyGlassMode,
  DEFAULT_GLASS_ENABLED,
  GLASS_ATTRIBUTE,
  GLASS_ATTRIBUTE_ON,
  GLASS_STORAGE_KEY,
  readGlassFromStorage,
  writeGlassToStorage,
} from './glassMode.js'

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
    removeAttribute: (name: string) => void attributes.delete(name),
  }
}

function themeCss(): string {
  return readFileSync(new URL('./theme.css', import.meta.url), 'utf8')
}

/**
 * Reads a glass `background: light-dark(light, dark)` and reports whether EACH
 * half is actually translucent.
 *
 * Alpha is the whole mechanism: the material is behind the page either way, and
 * these declarations only decide how much of it survives. So a hex, an
 * `rgb(...)`, or an `rgba(..., 1)` on either side is glass that silently does
 * nothing in that appearance. A missing half reports `false` for that half
 * rather than throwing, so the assertion names which one broke.
 *
 * `var(...)` counts as opaque, which is exact rather than a shortcut: the only
 * var this declaration may name is the page ground itself, and the assertion
 * below pins it to that.
 */
function translucentPair(body: string): { light: boolean; dark: boolean } {
  const pair =
    /background:\s*light-dark\(\s*(.+?)\s*,\s*(rgba?\([^)]*\)|#[0-9a-fA-F]+|var\(--[\w-]+\))\s*\)\s*;/.exec(
      body,
    )
  const translucent = (value: string | undefined) => {
    const alpha = /rgba\([^)]*,\s*([0-9.]+)\s*\)/.exec(value ?? '')
    return alpha !== null && Number(alpha[1]) < 1
  }
  return { light: translucent(pair?.[1]), dark: translucent(pair?.[2]) }
}

test('the shipped default is solid', () => {
  expect(DEFAULT_GLASS_ENABLED).toBe(false)
})

test('a written preference round-trips through the real read', () => {
  const store = storage()
  writeGlassToStorage(store, true)
  expect(readGlassFromStorage(store)).toBe(true)
  writeGlassToStorage(store, false)
  expect(readGlassFromStorage(store)).toBe(false)
})

test('an empty, unavailable or corrupt store reads as no preference', () => {
  expect(readGlassFromStorage(storage())).toBeNull()
  expect(readGlassFromStorage(null)).toBeNull()
  expect(readGlassFromStorage(storage({ [GLASS_STORAGE_KEY]: '{oops' }))).toBeNull()
  expect(
    readGlassFromStorage(
      storage({ [GLASS_STORAGE_KEY]: JSON.stringify({ version: 2, enabled: true }) }),
    ),
  ).toBeNull()
  expect(
    readGlassFromStorage(
      storage({ [GLASS_STORAGE_KEY]: JSON.stringify({ version: 1, enabled: 'on' }) }),
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
  expect(readGlassFromStorage(hostile)).toBeNull()
  expect(() => writeGlassToStorage(hostile, true)).not.toThrow()
})

/**
 * Off REMOVES the attribute rather than writing `off`, so a document with glass
 * disabled is indistinguishable from one whose renderer never knew about the
 * preference, and the stylesheet needs no rule for the off state.
 */
test('the stamp is present only while glass is on', () => {
  const root = fakeRoot()
  applyGlassMode(root, true)
  expect(root.attributes.get(GLASS_ATTRIBUTE)).toBe(GLASS_ATTRIBUTE_ON)
  applyGlassMode(root, false)
  expect(root.attributes.has(GLASS_ATTRIBUTE)).toBe(false)
  expect(() => applyGlassMode(null, true)).not.toThrow()
})

/**
 * The attribute is only half the mechanism: without a matching rule the toggle
 * silently does nothing, and no render assertion can see that.
 *
 * WHAT EACH HALF HAS TO BE, and why the light half moved 2026-08-28. Dark must be
 * translucent on the ROOT: an opaque value there is a toggle that does nothing
 * while still passing a shape check. Light must still read as the plain opaque
 * page ground — glass in light is deliberately inert, because macOS's light
 * material composites to about #c2c2c2 over a real desktop and a coat heavy
 * enough to keep the light text ramp legible leaves no material to see. That
 * ruling stands. What changed is WHERE the light ground is painted.
 *
 * IT MAY NOT BE PAINTED ON THE ROOT. An opaque `html` is what broke the
 * operator's window: measured 2026-08-28, a vibrant window whose page ground is
 * opaque at first paint keeps an opaque render surface for life, so switching to
 * dark afterwards leaves the 20% coat sitting on the stuck LIGHT base instead of
 * on the material. Reproduced at #BDBCC1 against a healthy #2E2E30, and the
 * operator's own window read #D3D3D3 over a base of #FCFCFE — which is
 * `--app-bg` in light, exactly. Painting the same ground on the full-area frame
 * instead (`[data-window-ground]`, `App.tsx`) renders identically and does not
 * arm the trap: measured #2D2D2F through the same switch.
 *
 * So the root is never opaque, and the two ground rules are mirrors: the root
 * carries the dark coat and nothing in light, the frame carries the light ground
 * and nothing in dark.
 */
test('the root is never opaque, and light paints its ground on the frame', () => {
  const css = themeCss()
  const block = css.match(/html\[data-glass='on'\]\s*\{([^}]*)\}/)
  expect(block).not.toBeNull()
  // Dark still translucent on the root; light paints nothing there.
  expect(translucentPair(block?.[1] ?? '')).toEqual({ light: false, dark: true })
  expect(block?.[1]).toContain('light-dark(transparent,')

  // The light ground moved to the frame, named through the token so it cannot
  // drift from the ground it must equal, and dark clears it so the coats do not
  // compound.
  const ground = css.match(
    /html\[data-glass='on'\] \[data-window-ground\]\s*\{([^}]*)\}/,
  )
  expect(ground).not.toBeNull()
  expect(ground?.[1]).toContain('light-dark(var(--app-bg), transparent)')

  // Off is the absence of the attribute, so no rule may describe it.
  expect(css).not.toContain("data-glass='off'")
})

/**
 * The regression guard for the defect this mechanism replaced.
 *
 * Redeclaring the four theme tokens under the stamp looks like the obvious way
 * to make the app translucent, and it is wrong: each token carries a second role
 * that alpha breaks. `--color-app-bg` WAS the INK on accent-filled buttons, and
 * glass dropped the permission prompt's Allow/Deny label to about 3.8:1 contrast
 * before this was narrowed to the page ground. That one is now genuinely fixed:
 * the light appearance had to split the role out as `--color-on-fill`. The other
 * two stand — `--color-shell-chrome` grounds nine floating menus, and
 * `--color-surface-panel` backs SVG separators and the sidebar fade masks — so
 * separate those first if the rail and the drawers should ever be glass too.
 */
test('glass never redeclares a theme token', () => {
  const css = themeCss()
  const scoped = css.matchAll(/html\[data-glass='on'\][^{]*\{([^}]*)\}/g)
  for (const [, body] of scoped) {
    expect(body).not.toMatch(/--(color-)?(app-bg|shell-chrome|surface-panel|surface-raised)\s*:/)
  }
})

/**
 * `html`, `body` and the app frame all paint the page ground. Opaque that is
 * invisible; in DARK, where the root carries the coat, the other two would hide
 * what the toggle just turned on, so both are cleared there.
 *
 * They are NOT cleared in light, and that asymmetry is the fix from 2026-08-28
 * rather than an oversight: the light ground has to be painted by something, and
 * it may not be the root (an opaque root at first paint strands the render
 * surface opaque for the window's life). So light paints here and dark clears
 * here — the exact mirror of the root rule above.
 */
test('the repeated page grounds are cleared in dark, and carry the ground in light', () => {
  const css = themeCss()
  const rule = css.match(
    /html\[data-glass='on'\] body,\s*html\[data-glass='on'\] \[data-window-ground\]\s*\{([^}]*)\}/,
  )
  expect(rule).not.toBeNull()
  // Dark half clears; light half paints the token.
  expect(translucentPair(rule?.[1] ?? '')).toEqual({ light: false, dark: false })
  expect(rule?.[1]).toContain('light-dark(var(--app-bg), transparent)')
})

/**
 * The inset repeats, which the full-area sweep below deliberately does not see.
 *
 * A fenced code block paints `bg-app-bg` because this shell's grammar is that
 * code sits IN the page rather than on a coloured slab; the colour IS the page,
 * so opaque it is invisible. Against a translucent page it stops being invisible
 * and becomes exactly the slab the grammar avoids. The sweep cannot catch these
 * because it only looks at elements that FILL their container, and these are
 * small boxes, so they are named.
 */
test('the inset boxes that repeat the page ground are cleared too', () => {
  // Line comments are stripped as well as block ones. Without that this test
  // passes on the PROSE: the paragraph explaining the marker contains the
  // marker's name, so removing the real attribute left the suite green
  // (verified by mutation, 2026-08-27).
  const strip = (name: string) =>
    readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')

  for (const file of ['TranscriptView.tsx', 'GoalsPage.tsx']) {
    const source = strip(file)
    // The attribute has to sit in the SAME opening tag as the ground class, not
    // merely somewhere in the file.
    const tags = source.match(/<[a-zA-Z][^<>]*border-shell-seam bg-app-bg[^<>]*>/g) ?? []
    expect({ file, tags: tags.length }).toEqual({ file, tags: 1 })
    expect({ file, marked: (tags[0] ?? '').includes('data-window-ground') }).toEqual({
      file,
      marked: true,
    })
  }
})

/**
 * The sweep that would have caught the session panel.
 *
 * Marking the app frame was not enough: `WorkspacePanels`' panel `<section>`
 * also fills the content area with `bg-app-bg`, so the shell was frosted until
 * the first session opened and then went solid (operator, 2026-08-27). Any
 * element that paints the page ground AND fills its container is a repeat of
 * what `html` already paints, and glass has to clear it.
 *
 * Deliberate exceptions are listed with their reason, not silently skipped: a
 * fault screen and a launch scrim SHOULD stay solid.
 */
test('every full-area page ground is marked for glass to clear', () => {
  const dir = new URL('.', import.meta.url)
  const EXEMPT = new Map([
    ['RendererErrorBoundary.tsx', 'a fault screen stays solid on purpose'],
    ['StartupSurfaces.tsx', 'the launch scrim covers the pane on purpose'],
  ])
  // Fills its container, as opposed to an input or a chip that merely flexes.
  const FILLS = [/\bh-screen\b/, /\bmin-h-screen\b/, /\binset-0\b/, /min-h-0[\s\S]{0,40}flex-1/]
  const offenders: string[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.tsx') || file.includes('.test.')) continue
    if (EXEMPT.has(file)) continue
    const lines = readFileSync(new URL(file, dir), 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (!line.includes('bg-app-bg')) return
      const chunk = lines.slice(Math.max(0, i - 8), i + 9).join('\n')
      if (!FILLS.some(re => re.test(chunk))) return
      if (!chunk.includes('data-window-ground')) offenders.push(`${file}:${i + 1}`)
    })
  }
  expect(offenders).toEqual([])
})

/**
 * Flow chrome is thinned, not cleared, and the marker is per ELEMENT.
 *
 * The tempting version of this is to thin `--color-shell-chrome`. That token
 * also grounds nine floating menus, so doing it makes an open context menu
 * readable straight through to the transcript underneath. The last assertion is
 * the one that matters: a floating consumer of that token must never carry the
 * chrome marker.
 */
test('the sidebar and tab bar are thinned, and no floating menu is', () => {
  const css = themeCss()
  const rule = css.match(/html\[data-glass='on'\] \[data-window-chrome\]\s*\{([^}]*)\}/)
  expect(rule).not.toBeNull()
  expect(translucentPair(rule?.[1] ?? '')).toEqual({ light: true, dark: true })

  // Comments become blank lines rather than vanishing, so reported line numbers
  // still match the file a reader will open.
  const blankOut = (m: string) => m.replace(/[^\n]/g, '')
  const strip = (name: string) =>
    readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, blankOut)
      .replace(/\/\*[\s\S]*?\*\//g, blankOut)
  expect(strip('TabBar.tsx')).toContain('data-window-chrome')

  // The sidebar is an OVERLAY, and the distinction is the whole finding: it
  // expands over the tab bar and the transcript, so thinning it without blurring
  // let the titles underneath read through the ones on top (operator,
  // 2026-08-27). The blur is what occludes; alpha alone is not enough.
  expect(strip('Sidebar.tsx')).toContain('data-window-overlay')
  expect(strip('Sidebar.tsx')).not.toContain('data-window-chrome')
  const overlay = css.match(/html\[data-glass='on'\] \[data-window-overlay\]\s*\{([^}]*)\}/)
  expect(overlay).not.toBeNull()
  expect(overlay?.[1]).toMatch(/backdrop-filter:\s*blur\(/)
  // The tint under the blur, both halves, for the same reason the other two
  // rules check both: an opaque value on either side is an overlay that stops
  // being glass in that appearance while still passing every shape check.
  expect(translucentPair(overlay?.[1] ?? '')).toEqual({ light: true, dark: true })

  // A `fixed`/`absolute` element on the chrome token is a floating menu, and
  // must stay opaque over the transcript.
  const dir = new URL('.', import.meta.url)
  const leaking: string[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.tsx') || file.includes('.test.')) continue
    const lines = strip(file).split('\n')
    lines.forEach((line, i) => {
      if (!line.includes('bg-shell-chrome')) return
      if (!/\b(fixed|absolute)\b/.test(line)) return
      const chunk = lines.slice(Math.max(0, i - 6), i + 7).join('\n')
      if (/data-window-(chrome|overlay)/.test(chunk)) leaking.push(`${file}:${i + 1}`)
    })
  }
  expect(leaking).toEqual([])
})

/**
 * Asserted against the SOURCE with JSX comments stripped. The first version of
 * this test was `expect(app).toContain('data-window-ground')`, which the comment
 * ABOVE the element satisfied on its own: deleting the attribute from the frame
 * left the suite fully green (demonstrated by mutation, 2026-08-27).
 */
test('the app frame is marked, on the element and not only in its comment', () => {
  const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8').replace(
    /\{\/\*[\s\S]*?\*\/\}/g,
    '',
  )
  expect(app).toContain('data-window-ground')
})

/**
 * The filter that was tried for light glass and removed, guarded so it is not
 * re-added here without the finding that killed it.
 *
 * Toning the backdrop toward the appearance's own ground is the one lever that
 * escapes the coat's trade, and it does not work from this element: Chromium
 * declines `backdrop-filter` on the ROOT, and the operator's window was
 * pixel-identical to the coat alone with it shipped. The sidebar overlay below
 * proves the filter can sample the native material, so this is about `html`
 * being the wrong element, not about the technique (`theme.css`).
 */
test('the root rule carries no backdrop filter, because it is inert there', () => {
  const css = themeCss()
  for (const selector of [
    /html\[data-glass='on'\]\s*\{([^}]*)\}/,
    /html\[data-appearance='light'\]\[data-glass='on'\]\s*\{([^}]*)\}/,
  ]) {
    const block = css.match(selector)
    if (block) expect(block[1]).not.toContain('backdrop-filter')
  }
  // The overlay's own blur is a different element and must survive untouched.
  const overlay = css.match(
    /html\[data-glass='on'\] \[data-window-overlay\]\s*\{([^}]*)\}/,
  )
  expect(overlay?.[1]).toContain('backdrop-filter: blur(')
})
