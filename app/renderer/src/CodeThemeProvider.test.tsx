import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { CodeThemeProvider } from './CodeThemeProvider.js'
import { CODE_THEME_STORAGE_KEY } from './codeTheme.js'
import { memoryStorage as storage } from './viewPreferenceStorageFixture.js'

function render(store: Parameters<typeof CodeThemeProvider>[0]['storage']) {
  return renderToStaticMarkup(
    <CodeThemeProvider storage={store}>
      <pre>
        <code className="hljs">x = 1</code>
      </pre>
    </CodeThemeProvider>,
  )
}

test('a stored theme reaches the attribute the stylesheet selects on', () => {
  const html = render(
    storage({
      [CODE_THEME_STORAGE_KEY]: JSON.stringify({ version: 1, theme: 'nord' }),
    }),
  )

  expect(html).toContain('data-code-theme="nord"')
  // The wrapper must stay out of layout, or it becomes a block box between
  // #root and App's viewport-sized frame.
  expect(html).toContain('class="contents"')
  // The code it wraps is untouched: the palette is applied by CSS, not by
  // rewriting spans.
  expect(html).toContain('<code class="hljs">x = 1</code>')
})

test('an empty or unavailable store falls back to the shipped default', () => {
  expect(render(storage())).toContain('data-code-theme="dracula"')
  expect(render(null)).toContain('data-code-theme="dracula"')
})

test('an unknown or corrupt stored theme degrades to the default', () => {
  expect(
    render(
      storage({
        [CODE_THEME_STORAGE_KEY]: JSON.stringify({
          version: 1,
          theme: 'solarized',
        }),
      }),
    ),
  ).toContain('data-code-theme="dracula"')
  expect(render(storage({ [CODE_THEME_STORAGE_KEY]: '{oops' }))).toContain(
    'data-code-theme="dracula"',
  )
})
