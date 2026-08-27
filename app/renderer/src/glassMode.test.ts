/**
 * The two halves of glass mode, tested apart: the stored preference, and the
 * stylesheet that gives the stamped attribute something to mean.
 *
 * The stamp path takes an injected root rather than a document
 * (`glassMode.ts` `GlassRoot`), so this stays an SSR-only suite like the rest of
 * the renderer's preference tests.
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
  // A future version, and a shape from neither version.
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
 * Off REMOVES the attribute rather than writing `off`. Asserted directly because
 * the stylesheet below has exactly one rule, and a document left carrying
 * `data-glass="off"` would be a state no CSS in the app describes.
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
 * The attribute is only half the mechanism: without matching rules the toggle
 * silently does nothing, and no render assertion can see that.
 */
test('the stylesheet redeclares every window ground under the stamp', () => {
  const css = readFileSync(new URL('./theme.css', import.meta.url), 'utf8')
  const block = css.match(/html\[data-glass='on'\]\s*\{([^}]*)\}/)
  expect(block).not.toBeNull()
  for (const token of ['--app-bg', '--shell-chrome', '--surface-panel', '--surface-raised']) {
    expect(block?.[1]).toContain(`${token}: rgba(`)
  }
  // Off is the absence of the attribute, so no rule may describe it.
  expect(css).not.toContain("data-glass='off'")
})

/**
 * The indirection this whole mechanism rests on. `@theme inline` compiles the
 * VALUE into each utility it generates, so a literal here would leave `bg-app-bg`
 * carrying a hex that the rule above cannot reach: the toggle would flip, the
 * page ground would change, and every component would stay solid.
 */
test('the theme routes each window ground through an overridable var', () => {
  const css = readFileSync(new URL('./theme.css', import.meta.url), 'utf8')
  for (const [themed, raw] of [
    ['--color-app-bg', '--app-bg'],
    ['--color-shell-chrome', '--shell-chrome'],
    ['--color-surface-panel', '--surface-panel'],
    ['--color-surface-raised', '--surface-raised'],
  ]) {
    expect(css).toContain(`${themed}: var(${raw});`)
  }
})

/**
 * `html`, `body` and the app frame all paint the page ground. Opaque that is
 * invisible; translucent, three coats of 0.62 composite to about 0.95 and the
 * glass is a wall again.
 */
test('the repeated page grounds are cleared so their alpha cannot compound', () => {
  const css = readFileSync(new URL('./theme.css', import.meta.url), 'utf8')
  expect(css).toMatch(
    /html\[data-glass='on'\] body,\s*html\[data-glass='on'\] \[data-window-ground\]\s*\{\s*background: transparent;/,
  )
  const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  expect(app).toContain('data-window-ground')
})
