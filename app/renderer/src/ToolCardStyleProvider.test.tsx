import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ToolCardStyleProvider } from './ToolCardStyleProvider.js'
import { ToolCardStylePreview } from './ToolCardStylePreview.js'
import { TOOL_CARD_STYLE_STORAGE_KEY } from './toolCardStyle.js'

function storage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  }
}

/**
 * The whole point of this file: storage → the provider's state initializer →
 * context → the real shells' markup. `toolCardStyle.test.ts` covers the storage
 * helpers alone and `TranscriptView.test.tsx` injects the context value
 * directly, so without this a provider that read the wrong key, ignored the
 * stored value, or never published it would pass every other test.
 */
function render(store: Parameters<typeof ToolCardStyleProvider>[0]['storage']) {
  return renderToStaticMarkup(
    <ToolCardStyleProvider storage={store}>
      <ToolCardStylePreview />
    </ToolCardStyleProvider>,
  )
}

test('a stored style reaches the real transcript shells', () => {
  const html = render(
    storage({
      [TOOL_CARD_STYLE_STORAGE_KEY]: JSON.stringify({
        version: 1,
        style: 'lines',
      }),
    }),
  )

  expect(html).not.toContain('rounded-md border border-shell-seam')
  expect(html).toContain('data-card-style="lines"')
})

test('an empty or unavailable store falls back to the shipped default', () => {
  for (const store of [storage(), null]) {
    const html = render(store)
    expect(html).toContain('rounded-md border border-shell-seam')
    expect(html).toContain('data-card-style="cards"')
  }
})

test('an unknown or corrupt stored style degrades to the default', () => {
  const unknown = render(
    storage({
      [TOOL_CARD_STYLE_STORAGE_KEY]: JSON.stringify({
        version: 1,
        style: 'bare',
      }),
    }),
  )
  expect(unknown).toContain('data-card-style="cards"')

  const corrupt = render(storage({ [TOOL_CARD_STYLE_STORAGE_KEY]: '{oops' }))
  expect(corrupt).toContain('data-card-style="cards"')
})

test('the preview renders the transcript itself, including a collapsed peek', () => {
  // The peek is the row that differs most between the two styles and the one a
  // shell-only conversion got wrong, so the preview has to show it or it
  // advertises a drawing the transcript does not produce.
  const cards = render(storage())
  expect(cards).toContain('Ran 12 tests across 3 files.')
  expect(cards).toContain('border-t border-shell-seam bg-black/20')

  const lines = render(
    storage({
      [TOOL_CARD_STYLE_STORAGE_KEY]: JSON.stringify({
        version: 1,
        style: 'lines',
      }),
    }),
  )
  expect(lines).toContain('Ran 12 tests across 3 files.')
  expect(lines).not.toContain('border-t border-shell-seam bg-black/20')
  expect(lines).toContain('ml-6 border-l border-shell-seam bg-black/20')
})
