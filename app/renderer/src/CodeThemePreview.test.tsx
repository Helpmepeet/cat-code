/**
 * The Settings code canvas (`CodeThemePreview`).
 *
 * SSR-only (`renderToStaticMarkup`), so what these can prove is what the markup
 * says: that the sample went through the transcript's own `CodeBlock` instead of
 * a lookalike, that `rehype-highlight` really tokenized it (a preview of flat
 * text would recolor on nothing), and that it renders under the attribute the
 * palette stylesheet selects on. What they cannot prove is the paint itself:
 * `theme.css` is never loaded here, so "Nord looks like Nord" stays an operator
 * check.
 */

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { CodeThemePreview } from './CodeThemePreview.js'
import { CodeThemeProvider } from './CodeThemeProvider.js'
import { CODE_THEME_STORAGE_KEY } from './codeTheme.js'

const html = renderToStaticMarkup(<CodeThemePreview />)

test('the sample renders through the transcript code block, not a copy of it', () => {
  // The docstring and the trailing comment survive as readable text, so the
  // canvas is showing the sample rather than an empty frame.
  expect(html).toContain('Obeys no one, especially not the scheduler')
  expect(html).toContain('deemed unworthy of gravity')

  // CodeBlock's own chrome: the copy control and compact top padding that
  // clears it. A parallel component would have to reproduce both.
  expect(html).toContain('aria-label="Copy code"')
  expect(html).toContain('pt-8')
  expect(html).not.toContain('&lt;/&gt;')

  // react-markdown wraps a fence in <pre><code>; the bridge has to unwrap the
  // <pre> or the framed block nests one inside another.
  expect(html.match(/<pre/g)).toHaveLength(1)
})

test('the sample is really tokenized, so a palette has something to color', () => {
  // The base class every palette rule hangs off.
  expect(html).toContain('class="hljs"')
  // Scopes the sample was chosen to exercise, one per themed rule group in
  // theme.css. `detect:false` means these only appear because the fence
  // declared python.
  expect(html).toContain('hljs-keyword') // class / def / return
  expect(html).toContain('hljs-string') // the docstring and "aloof"
  expect(html).toContain('hljs-comment') // # default disposition
  expect(html).toContain('hljs-number') // lives=9, hours=16
  expect(html).toContain('hljs-title') // Cat, knock_off, nap
  expect(html).toContain('hljs-built_in') // print, range
})

test('the preview shares the transcript highlighting configuration', () => {
  const source = readFileSync(new URL('./CodeThemePreview.tsx', import.meta.url), 'utf8')

  expect(source).toContain("import { REHYPE_PLUGINS } from './markdownPlugins.js'")
  expect(source).toContain('rehypePlugins={REHYPE_PLUGINS}')
  expect(source).not.toContain('PREVIEW_REHYPE_PLUGINS')
})

test('the canvas renders under the attribute the active palette selects on', () => {
  const themed = renderToStaticMarkup(
    <CodeThemeProvider
      storage={{
        getItem: () => JSON.stringify({ version: 1, theme: 'nord' }),
        setItem: () => {},
      }}
    >
      <CodeThemePreview />
    </CodeThemeProvider>,
  )

  const attribute = themed.indexOf('data-code-theme="nord"')
  const tokens = themed.indexOf('hljs-keyword')
  expect(attribute).toBeGreaterThanOrEqual(0)
  expect(tokens).toBeGreaterThan(attribute)
  // Nothing rewrites the spans per theme: the palette is CSS, so the same token
  // markup has to come out under every theme.
  expect(themed).toContain('class="hljs"')
})

test('the preview reads the picker, so a theme change recolors it with no reload', () => {
  const store = new Map<string, string>([
    [CODE_THEME_STORAGE_KEY, JSON.stringify({ version: 1, theme: 'monokai' })],
  ])
  const themed = renderToStaticMarkup(
    <CodeThemeProvider
      storage={{
        getItem: key => store.get(key) ?? null,
        setItem: (key, value) => void store.set(key, value),
      }}
    >
      <CodeThemePreview />
    </CodeThemeProvider>,
  )

  expect(themed).toContain('data-code-theme="monokai"')
})
