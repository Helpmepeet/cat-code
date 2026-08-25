import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProseArrivalProvider } from './ProseArrivalProvider.js'
import { TranscriptRowsView } from './TranscriptView.js'
import {
  PROSE_ARRIVAL_STORAGE_KEY,
  readProseArrivalFromStorage,
  writeProseArrivalToStorage,
} from './proseArrival.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'

function storage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  }
}

const streamingRow: NestedTranscriptRow = {
  sessionId: 's',
  messageId: 'm',
  frameId: 'f',
  blockIndex: 0,
  parentToolUseId: null,
  children: [],
  id: 's:m:0',
  kind: 'assistant-text',
  role: 'assistant',
  content: 'alpha beta gamma',
  isStreaming: true,
}

/**
 * Storage → the provider's state initializer → context → the REAL transcript
 * markup. `proseArrival.test.ts` covers the storage helpers alone and
 * `proseArrivalMark.test.ts` covers the transform alone; without this a provider
 * that read the wrong key or never published would pass both.
 */
function render(store: Parameters<typeof ProseArrivalProvider>[0]['storage']) {
  return renderToStaticMarkup(
    <ProseArrivalProvider storage={store}>
      <TranscriptRowsView rows={[streamingRow]} />
    </ProseArrivalProvider>,
  )
}

test('the shipped default fades arriving text', () => {
  // `smooth`, not today's behavior: the operator picked it off the playable
  // reference, and `instant` is what preserves the old rendering.
  const html = render(storage())
  expect(html).toContain('prose-arrive-smooth')
  expect(html).not.toContain('prose-arrive-flowing')
})

test('a stored option reaches the rendered prose', () => {
  const html = render(
    storage({
      [PROSE_ARRIVAL_STORAGE_KEY]: JSON.stringify({
        version: 1,
        arrival: 'flowing',
      }),
    }),
  )
  expect(html).toContain('prose-arrive-flowing')
  // Flowing is the only option that staggers, so the delay must be on the wire.
  expect(html).toContain('animation-delay:25ms')
})

test('instant marks nothing at all, which is the pre-change rendering', () => {
  const html = render(
    storage({
      [PROSE_ARRIVAL_STORAGE_KEY]: JSON.stringify({
        version: 1,
        arrival: 'instant',
      }),
    }),
  )
  expect(html).not.toContain('prose-arrive')
  expect(html).toContain('alpha')
})

test('a corrupt or unknown stored option degrades to the default', () => {
  for (const raw of ['{oops', '{"version":1,"arrival":"drift"}', '{"version":2}']) {
    const html = render(storage({ [PROSE_ARRIVAL_STORAGE_KEY]: raw }))
    expect(html).toContain('prose-arrive-smooth')
  }
})

test('marking never changes the text a reader sees', () => {
  for (const arrival of ['instant', 'smooth', 'flowing']) {
    const html = render(
      storage({
        [PROSE_ARRIVAL_STORAGE_KEY]: JSON.stringify({ version: 1, arrival }),
      }),
    )
    const text = html.replace(/<[^>]*>/g, '')
    expect(text).toContain('alpha beta gamma')
  }
})

test('the write path round-trips, so a choice survives a reload', () => {
  // Nothing else drives `writeProseArrivalToStorage`: the render tests only
  // ever READ a seeded store. A provider that published the choice but never
  // persisted it would pass every test above and lose the setting on restart.
  const store = storage()
  writeProseArrivalToStorage(store, 'flowing')
  expect(readProseArrivalFromStorage(store)).toBe('flowing')
  expect(render(store)).toContain('prose-arrive-flowing')

  writeProseArrivalToStorage(store, 'instant')
  expect(render(store)).not.toContain('prose-arrive')
})
