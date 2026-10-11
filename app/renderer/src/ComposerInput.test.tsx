import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ComposerInput } from './ComposerInput.js'

function render(typeahead?: { listboxId: string; activeOptionId: string } | null): string {
  return renderToStaticMarkup(
    <ComposerInput
      ariaLabel="Prompt"
      disabled={false}
      onCompositionEnd={() => {}}
      onCompositionStart={() => {}}
      onFocus={() => {}}
      onPointerDown={() => {}}
      onRemovePaste={() => {}}
      onValueChange={() => {}}
      pastes={[]}
      placeholder="Message Cat Code"
      readOnly={false}
      typeahead={typeahead}
      value="/help"
    />,
  )
}

test('the focused composer owns the open typeahead listbox and its active option', () => {
  const html = render({
    listboxId: 'composer-slash-command-matches',
    activeOptionId: 'composer-slash-command-option-0',
  })
  expect(html).toContain('role="textbox"')
  expect(html).toContain('aria-expanded="true"')
  expect(html).toContain('aria-controls="composer-slash-command-matches"')
  expect(html).toContain(
    'aria-activedescendant="composer-slash-command-option-0"',
  )
})

test('the composer reports a closed typeahead when no picker is open', () => {
  const html = render(null)
  expect(html).toContain('aria-expanded="false"')
  expect(html).not.toContain('aria-controls=')
  expect(html).not.toContain('aria-activedescendant=')
})
