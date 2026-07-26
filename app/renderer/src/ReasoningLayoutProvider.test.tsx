import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReasoningLayoutProvider } from './ReasoningLayoutProvider.js'
import { REASONING_LAYOUT_STORAGE_KEY } from './reasoningLayout.js'
import { TranscriptRowsView } from './TranscriptView.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'

function storage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  }
}

const REASONING_ROW: NestedTranscriptRow = {
  sessionId: 's',
  messageId: 'm',
  frameId: 'f',
  blockIndex: 0,
  parentToolUseId: null,
  children: [],
  id: 's:m:0:thinking',
  kind: 'thinking',
  content: 'Locating the transport teardown path',
}

function render(store: Parameters<typeof ReasoningLayoutProvider>[0]['storage']) {
  return renderToStaticMarkup(
    <ReasoningLayoutProvider storage={store}>
      <TranscriptRowsView rows={[REASONING_ROW]} />
    </ReasoningLayoutProvider>,
  )
}

test('a stored layout reaches the transcript — the real read path, not just the helper', () => {
  const html = render(
    storage({
      [REASONING_LAYOUT_STORAGE_KEY]: JSON.stringify({ version: 1, mode: 'blocks' }),
    }),
  )

  // The persisted choice wins: the original reasoning card, not the trail line.
  expect(html).toContain('Thinking')
  expect(html).not.toContain('Reasoning')
})

test('an empty or unavailable store falls back to the shipped default', () => {
  expect(render(storage())).toContain('Reasoning')
  // No storage at all (SSR / a locked-down renderer) must still render.
  expect(render(null)).toContain('Reasoning')
})

test('a corrupt stored value degrades to the default instead of throwing', () => {
  const html = render(storage({ [REASONING_LAYOUT_STORAGE_KEY]: '{oops' }))
  expect(html).toContain('Reasoning')
})
