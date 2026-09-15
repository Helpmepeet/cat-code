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
import {
  memoryStorage as storage,
  throwingStorage,
} from './viewPreferenceStorageFixture.js'

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
 * var these declarations may name is a page ground token, and a ground token is
 * the alpha-1 shape the light half is asserted never to return to.
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
  const hostile = throwingStorage()
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
 * WHAT EACH HALF HAS TO BE: translucent, both of them. An opaque value on
 * either side is a toggle that does nothing in that appearance while still
 * passing every shape check, and that is not a hypothetical — the light half was
 * `var(--app-bg)` from `6a90d30f` until 2026-08-28, which is precisely why the
 * operator reported light glass as dead: at alpha 1 no backdrop can reach the
 * page, so a light window over black is pixel-identical to a light window over
 * anything. Measured on the real material, the light ground went #FCFCFD (the
 * material contributing nothing) to #E5E5E5 when this half became a coat. So the
 * assertion is on ALPHA, and the bare token is the shape it must never return to.
 *
 * IT MAY NOT BE PAINTED ON `html` OR `body` IN ANY STATE. Their backgrounds
 * become the document CANVAS (`body`'s propagates up whenever `html`'s is
 * transparent — the propagation is what silently re-armed the first fix), and
 * on this vibrant window the canvas is a one-way latch: a document whose first
 * composited frame has an opaque canvas keeps an opaque render surface until
 * it navigates. That is the whole bug — launch light, switch dark, and the 20%
 * coat sits on a stuck copy of the light ground (#CDCDCD measured) instead of
 * on the material (#393939 with the identical colours on `body::before`). The
 * same probe showed the latch needs no appearance flip, and that glass toggled
 * on mid-session in dark had never shown material either (#0C0C0E against a
 * healthy #313131). So the ground lives on `body::before`, which covers the
 * window without ever touching the canvas, and the glass rule retargets it.
 */
test('the canvas is never painted, and the ground rules mirror on body::before', () => {
  const css = themeCss()

  // Base: html and body stay transparent, the ground is the pseudo-element.
  expect(css).toMatch(/html\s*\{\s*background:\s*transparent;\s*\}/)
  expect(css).toMatch(/body\s*\{\s*background:\s*transparent;/)
  // Anchored to the indented base-layer rule; the unindented glass rule that
  // retargets the same pseudo-element sits earlier in the file.
  const ground = css.match(/\n  body::before\s*\{([^}]*)\}/)
  expect(ground).not.toBeNull()
  expect(ground?.[1]).toContain('position: fixed')
  expect(ground?.[1]).toContain('inset: 0')
  expect(ground?.[1]).toContain('background: var(--color-app-bg)')

  // Glass retargets ONLY the pseudo-element, and both halves are coats.
  const coat = css.match(/html\[data-glass='on'\] body::before\s*\{([^}]*)\}/)
  expect(coat).not.toBeNull()
  expect(translucentPair(coat?.[1] ?? '')).toEqual({ light: true, dark: true })
  // The inert shape, named so a revert to it fails here rather than on screen.
  expect(coat?.[1]).not.toContain('light-dark(var(--app-bg),')

  // The old shape of the defect: no glass rule may put a background back on
  // `html` or `body` themselves. Every glass selector must aim past the canvas
  // at the pseudo-element or a marked element.
  for (const match of css.matchAll(/html\[data-glass='on'\][^{,]*\{/g)) {
    expect(match[0]).toMatch(/::before|\[data-window-/)
  }

  // The frame clears in both appearances now, so the coats do not compound.
  const frame = css.match(/html\[data-glass='on'\] \[data-window-ground\]\s*\{([^}]*)\}/)
  expect(frame).not.toBeNull()
  expect(frame?.[1]).toMatch(/background:\s*transparent;/)

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
 * The app frame repeats the page ground `body::before` paints. Opaque that is
 * invisible; over a coat it is a SECOND coat, and it would hide exactly what the
 * toggle just turned on.
 *
 * It used to clear in dark only, and carry the plain ground in light, because
 * light glass was inert. Both halves are coats now, so the asymmetry is gone and
 * the rule is one unconditional `transparent` — an appearance-split here would be
 * a frame painting over the material in whichever half kept the token. `body` no
 * longer appears in this rule at all: the base layer keeps it transparent in
 * every state (its background would become the canvas; see the test above), so
 * there is nothing on it for glass to clear.
 */
test('the repeated page ground is cleared in both appearances', () => {
  const css = themeCss()
  const rule = css.match(
    /html\[data-glass='on'\] \[data-window-ground\]\s*\{([^}]*)\}/,
  )
  expect(rule).not.toBeNull()
  expect(rule?.[1]).toMatch(/background:\s*transparent;/)
  expect(rule?.[1]).not.toContain('light-dark')
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
 * escapes the coat's trade, and it does not work from the page AT ALL. It was
 * tried on the ROOT and the operator's window came back pixel-identical to the
 * coat alone; the note left behind blamed the element and pointed at a full-area
 * child as the thread to pull. Refuted 2026-08-28 by putting the filter on
 * `body::before`, which IS that full-area child: `brightness(0.3)` moved not one
 * level on any of twelve vibrancy materials. The web layer's backdrop is
 * transparent black and a filter over transparent black stays transparent,
 * wherever it hangs. The sidebar overlay is not a counter-example either — it
 * samples the page behind it, never the native material.
 */
test('no page-ground rule carries a backdrop filter, because it is inert there', () => {
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
