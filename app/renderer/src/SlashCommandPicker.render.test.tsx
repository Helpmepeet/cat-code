import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SlashCommandPicker } from './SlashCommandPicker.js'
import type { SlashCatalogEntry } from '../../shared/protocol.js'

const CATALOG: SlashCatalogEntry[] = [
  { name: 'help', description: 'Show help and available commands' },
  { name: 'model', description: 'Switch the model', argumentHint: '<name>' },
]

function render(commands: SlashCatalogEntry[]): string {
  return renderToStaticMarkup(
    <SlashCommandPicker
      open
      query=""
      commands={commands}
      activeIndex={0}
      onPick={() => {}}
    />,
  )
}

test('renders the description column and arg hint (prototype parity, not name-only)', () => {
  const html = render(CATALOG)
  // Names.
  expect(html).toContain('/help')
  expect(html).toContain('/model')
  // Descriptions — the drift the operator saw (the picker was name-only before).
  expect(html).toContain('Show help and available commands')
  expect(html).toContain('Switch the model')
  // Arg hint after the command name.
  expect(html).toContain('&lt;name&gt;')
})

test('a names-only fallback entry renders just the name (no empty separator row)', () => {
  // A session without the rich snapshot: the composer maps names to entries with
  // an empty description; the row must render the name alone, no `·` separator.
  const html = render([{ name: 'clear', description: '' }])
  expect(html).toContain('/clear')
  expect(html).not.toContain('·')
})
