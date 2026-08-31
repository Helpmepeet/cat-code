import { readFileSync } from 'node:fs'
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

test('CC-84 drop tripwire: files are inspected before the text-only early return', () => {
  // LAYER HONESTY: SSR, so no drop can be dispatched here and `handleDrop` is a
  // closure that cannot be called directly. The selection rule itself is covered
  // in imageAttachment.test.ts. What only the source can decide is the ORDERING
  // that was the bug: `getData('text')` came first and its `if (!text) return`
  // ate a Finder drag, whose payload is on `dataTransfer.files`.
  const source = readFileSync(new URL('./ComposerInput.tsx', import.meta.url), 'utf8')
  const start = source.indexOf('const handleDrop =')
  const end = source.indexOf('const preview =', start)
  const body = source.slice(start, end)

  expect(body).toContain('selectAttachableImageFile(')
  expect(body).toContain('onAttachImageFile?.(image)')
  expect(body.indexOf('event.dataTransfer.files')).toBeLessThan(
    body.indexOf("event.dataTransfer.getData('text')"),
  )
  // An image drop stops there: no text is inserted underneath it.
  expect(body.indexOf('onAttachImageFile?.(image)')).toBeLessThan(
    body.indexOf("event.dataTransfer.getData('text')"),
  )
  // The text drop still works.
  expect(body).toContain('value.slice(0, bounded) + text + value.slice(bounded)')
  // A read-only or session-less composer takes neither.
  expect(body.indexOf('if (!editable) return')).toBeLessThan(
    body.indexOf('event.dataTransfer.files'),
  )
})
