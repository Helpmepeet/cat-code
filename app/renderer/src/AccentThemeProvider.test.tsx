import { expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { AccentThemeProvider } from './AccentThemeProvider.js'
import {
  ACCENT_KEYS,
  ACCENT_STORAGE_KEY,
  DEFAULT_ACCENT,
  readAccentFromStorage,
  writeAccentToStorage,
} from './accentTheme.js'
import { memoryStorage as storage } from './viewPreferenceStorageFixture.js'

function render(store: Parameters<typeof AccentThemeProvider>[0]['storage']) {
  return renderToStaticMarkup(
    <AccentThemeProvider storage={store}>
      <button className="bg-accent">go</button>
    </AccentThemeProvider>,
  )
}

test('a stored accent reaches the attribute the stylesheet selects on', () => {
  const html = render(
    storage({
      [ACCENT_STORAGE_KEY]: JSON.stringify({ version: 1, accent: 'blue' }),
    }),
  )
  expect(html).toContain('data-accent="blue"')
  // Out of layout, or the wrapper becomes a block box between #root and App's
  // viewport-sized frame (`CodeThemeProvider.tsx:10-13`).
  expect(html).toContain('class="contents"')
  // Nothing below is rewritten: the colour arrives through `--accent`.
  expect(html).toContain('<button class="bg-accent">go</button>')
})

test('an empty or unavailable store falls back to the shipped accent', () => {
  expect(render(storage())).toContain(`data-accent="${DEFAULT_ACCENT}"`)
  expect(render(null)).toContain(`data-accent="${DEFAULT_ACCENT}"`)
})

test('an unknown or corrupt stored accent degrades to the default', () => {
  expect(
    render(
      storage({
        [ACCENT_STORAGE_KEY]: JSON.stringify({ version: 1, accent: 'teal' }),
      }),
    ),
  ).toContain(`data-accent="${DEFAULT_ACCENT}"`)
  expect(render(storage({ [ACCENT_STORAGE_KEY]: '{oops' }))).toContain(
    `data-accent="${DEFAULT_ACCENT}"`,
  )
})

test('a written accent round-trips through the real read', () => {
  const store = storage()
  writeAccentToStorage(store, 'purple')
  expect(readAccentFromStorage(store)).toBe('purple')
  expect(render(store)).toContain('data-accent="purple"')
})

/**
 * The attribute is only half the mechanism: without a matching rule the accent
 * silently does not change, and no render assertion can see that. `pink` is the
 * unscoped `:root` declaration, so it is the one key with no rule of its own.
 */
test('every non-default accent has a stylesheet rule redefining both tokens', () => {
  const css = readFileSync(new URL('./theme.css', import.meta.url), 'utf8')
  for (const key of ACCENT_KEYS) {
    if (key === DEFAULT_ACCENT) continue
    const rule = new RegExp(
      `\\[data-accent='${key}'\\]\\s*\\{[^}]*--accent:[^}]*--accent-soft:[^}]*\\}`,
    )
    expect(rule.test(css)).toBe(true)
  }
  expect(css).not.toContain(`[data-accent='${DEFAULT_ACCENT}']`)
})
