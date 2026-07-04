import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TranscriptRowsView } from './TranscriptView.js'

test('renders an assistant text row as markdown, not raw source', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      rows={[
        {
          id: 's:m:0:f',
          sessionId: 's',
          messageId: 'm',
          frameId: 'f',
          blockIndex: 0,
          parentToolUseId: null,
          kind: 'assistant-text',
          role: 'assistant',
          content: 'Reading **package.json** now.',
          children: [],
        },
      ]}
    />,
  )

  expect(html).toContain('<strong>package.json</strong>')
  expect(html).not.toContain('**package.json**')
})

test('renders a tool_use row as a card with tool name and structured input', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      rows={[
        {
          id: 's:m:1:toolu_p13_1',
          sessionId: 's',
          messageId: 'm',
          frameId: 'f',
          blockIndex: 1,
          parentToolUseId: null,
          kind: 'tool-use',
          toolUseId: 'toolu_p13_1',
          toolName: 'Read',
          toolFamily: 'read',
          input: { file_path: '/etc/hosts' },
          status: 'pending',
          result: null,
          children: [],
        },
      ]}
    />,
  )

  expect(html).toContain('Read')
  expect(html).toContain('file_path')
  expect(html).toContain('/etc/hosts')
})

test('renders an empty-state hint when no rows are projected yet', () => {
  const html = renderToStaticMarkup(<TranscriptRowsView rows={[]} />)

  expect(html).toContain('No transcript rows yet.')
})

test('renders a resolved tool card with success status and result content', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      rows={[
        {
          id: 's:m:1:toolu_res_1',
          sessionId: 's',
          messageId: 'm',
          frameId: 'f',
          blockIndex: 1,
          parentToolUseId: null,
          kind: 'tool-use',
          toolUseId: 'toolu_res_1',
          toolName: 'Bash',
          toolFamily: 'bash',
          input: { command: 'echo hi' },
          status: 'success',
          result: { isError: false, content: 'hi\n', diff: null },
          children: [],
        },
      ]}
    />,
  )

  expect(html).toContain('success')
  expect(html).toContain('hi')
})

test('D2/C4: renders a subagent tool card NESTED inside its owning agent card, not as a sibling', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      rows={[
        {
          id: 's:m:0:toolu_agent_1',
          sessionId: 's',
          messageId: 'm',
          frameId: 'f',
          blockIndex: 0,
          parentToolUseId: null,
          kind: 'tool-use',
          toolUseId: 'toolu_agent_1',
          toolName: 'Agent',
          toolFamily: 'agent',
          input: { prompt: 'investigate' },
          status: 'pending',
          result: null,
          children: [
            {
              id: 's:m:1:toolu_sub_1',
              sessionId: 's',
              messageId: 'm2',
              frameId: 'f2',
              blockIndex: 0,
              parentToolUseId: 'toolu_agent_1',
              kind: 'tool-use',
              toolUseId: 'toolu_sub_1',
              toolName: 'Grep',
              toolFamily: 'grep',
              input: { pattern: 'foo' },
              status: 'pending',
              result: null,
              children: [],
            },
          ],
        },
      ]}
    />,
  )

  expect(html).toContain('Agent')
  expect(html).toContain('Grep')
})
