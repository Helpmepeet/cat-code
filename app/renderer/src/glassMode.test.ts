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
import { readFileSync } from 'fs'
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
 */
test('the stylesheet paints exactly one translucent ground under the stamp', () => {
  const css = themeCss()
  const block = css.match(/html\[data-glass='on'\]\s*\{([^}]*)\}/)
  expect(block).not.toBeNull()
  expect(block?.[1]).toMatch(/background:\s*rgba\(/)
  // Off is the absence of the attribute, so no rule may describe it.
  expect(css).not.toContain("data-glass='off'")
})

/**
 * The regression guard for the defect this mechanism replaced.
 *
 * Redeclaring the four theme tokens under the stamp looks like the obvious way
 * to make the app translucent, and it is wrong: each token carries a second role
 * that alpha breaks. `--color-app-bg` is the INK on accent-filled buttons
 * (`.text-app-bg`), `--color-shell-chrome` grounds nine floating menus, and
 * `--color-surface-panel` backs SVG separators and the sidebar fade masks. Glass
 * dropped the permission prompt's Allow/Deny label to about 3.8:1 contrast
 * before this was narrowed to the page ground. Separate those roles first if the
 * rail and the drawers should ever be glass too.
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
 * invisible; with `html` translucent, the other two would hide what the toggle
 * just turned on.
 */
test('the repeated page grounds are cleared so they cannot hide the ground', () => {
  expect(themeCss()).toMatch(
    /html\[data-glass='on'\] body,\s*html\[data-glass='on'\] \[data-window-ground\]\s*\{\s*background: transparent;/,
  )
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
