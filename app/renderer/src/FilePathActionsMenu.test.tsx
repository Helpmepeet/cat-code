import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { FilePathActionsMenu } from './FilePathActionsMenu.js'

const noop = () => {}

test('renders file path menu with scrim, aria label and flyout hosts', () => {
  const html = renderToStaticMarkup(
    <FilePathActionsMenu
      anchor={{ type: 'pointer', x: 100, y: 150 }}
      rawPath="src/components/Header.tsx:42"
      cwd="/Users/test/cat-code"
      sessionId="session-1"
      onClose={noop}
    />,
  )

  expect(html).toContain('role="menu"')
  expect(html).toContain('aria-label="File actions for Header.tsx"')
  expect(html).toContain('Copy')
  expect(html).toContain('Open in')
  expect(html).toContain('aria-haspopup="menu"')
  expect(html).toContain('aria-expanded="false"')
  expect(html).toContain('<svg')
})

test('renders with rect anchor positioning', () => {
  const html = renderToStaticMarkup(
    <FilePathActionsMenu
      anchor={{
        type: 'rect',
        rect: { top: 50, bottom: 70, left: 120, right: 200 },
      }}
      rawPath="src/foo.ts"
      cwd="/repo"
      sessionId="session-1"
      onClose={noop}
    />,
  )

  expect(html).toContain('role="menu"')
  expect(html).toContain('style="top:76px;left:120px"')
})
