import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SlashCommandPicker } from './SlashCommandPicker.js'
import type { SlashCatalogEntry } from '../../shared/protocol.js'

const CATALOG: SlashCatalogEntry[] = [
  { name: 'help', description: 'Show help and available commands' },
  { name: 'model', description: 'Switch the model', argumentHint: '<name>' },
]

function render(commands: SlashCatalogEntry[], activeIndex = 0): string {
  return renderToStaticMarkup(
    <SlashCommandPicker
      open
      query=""
      commands={commands}
      activeIndex={activeIndex}
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

function rowMarkup(html: string, name: string): string {
  const rows = html.split('<li').slice(1).map(fragment => '<li' + fragment)
  const row = rows.find(fragment => fragment.includes(`/${name}<`))
  if (!row) throw new Error(`no row found for /${name}`)
  return row
}

test('the active-row marker moves with activeIndex, not fixed to the first row (SLASH-3)', () => {
  const atZero = render(CATALOG, 0)
  expect(rowMarkup(atZero, 'help')).toContain('data-slash-active="true"')
  expect(rowMarkup(atZero, 'help')).toContain('aria-selected="true"')
  expect(rowMarkup(atZero, 'model')).toContain('data-slash-active="false"')
  expect(rowMarkup(atZero, 'model')).toContain('aria-selected="false"')

  const atOne = render(CATALOG, 1)
  expect(rowMarkup(atOne, 'help')).toContain('data-slash-active="false"')
  expect(rowMarkup(atOne, 'help')).toContain('aria-selected="false"')
  expect(rowMarkup(atOne, 'model')).toContain('data-slash-active="true"')
  expect(rowMarkup(atOne, 'model')).toContain('aria-selected="true"')

  // The active row also carries the accent text tone; the inactive row does not.
  expect(rowMarkup(atOne, 'model')).toContain('text-accent')
  expect(rowMarkup(atOne, 'help')).not.toContain('text-accent')
})

test('a names-only fallback entry renders just the name (no empty separator row)', () => {
  // A session without the rich snapshot: the composer maps names to entries with
  // an empty description; the row must render the name alone, no `·` separator.
  const html = render([{ name: 'clear', description: '' }])
  expect(html).toContain('/clear')
  expect(html).not.toContain('·')
})
