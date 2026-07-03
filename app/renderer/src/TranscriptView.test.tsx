import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TranscriptView } from './TranscriptView.js'

test('renders an assistant text row as markdown, not raw source', () => {
  const html = renderToStaticMarkup(
    <TranscriptView
      rows={[
        {
          kind: 'assistant-text',
          role: 'assistant',
          content: 'Reading **package.json** now.',
        },
      ]}
    />,
  )

  expect(html).toContain('<strong>package.json</strong>')
  expect(html).not.toContain('**package.json**')
})

test('renders a tool_use row as a card with tool name and structured input', () => {
  const html = renderToStaticMarkup(
    <TranscriptView
      rows={[
        {
          kind: 'tool-use',
          toolUseId: 'toolu_p13_1',
          toolName: 'Read',
          input: { file_path: '/etc/hosts' },
        },
      ]}
    />,
  )

  expect(html).toContain('Read')
  expect(html).toContain('file_path')
  expect(html).toContain('/etc/hosts')
})

test('renders an empty-state hint when no rows are projected yet', () => {
  const html = renderToStaticMarkup(<TranscriptView rows={[]} />)

  expect(html).toContain('No transcript rows yet.')
})
