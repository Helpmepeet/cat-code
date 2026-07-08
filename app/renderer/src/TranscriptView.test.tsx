import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TranscriptRowsView } from './TranscriptView.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'

// P4-18a helpers: the two producer-id shapes rows carry. `content`-block rows
// (user/thinking/…) carry messageId/blockIndex/parentToolUseId; frame rows
// (session-init/result/boundaries/notices) carry only frameId.
const blockSource = {
  sessionId: 's' as const,
  messageId: 'm',
  frameId: 'f',
  blockIndex: 0,
  parentToolUseId: null,
  children: [] as NestedTranscriptRow[],
}
const frameSource = {
  sessionId: 's' as const,
  frameId: 'f',
  children: [] as NestedTranscriptRow[],
}

function render(row: NestedTranscriptRow): string {
  return renderToStaticMarkup(<TranscriptRowsView rows={[row]} />)
}

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

// ── P4-18a: user turns + core/boundary rows (the functional fix) ────────────

test('P4-18a REGRESSION: a projected user-text turn is rendered, not dropped', () => {
  // Pre-18a, TranscriptView returned null for every non-tool-use kind, so the
  // running app showed no user messages. This proves the drop is fixed.
  const html = render({
    ...blockSource,
    id: 's:m:0:user-text',
    kind: 'user-text',
    role: 'user',
    content: 'restart the sidecar please',
    isReplay: false,
  })

  expect(html).toContain('restart the sidecar please')
})

test('P4-18a: a command echo renders the slash command in the user column', () => {
  const html = render({
    ...blockSource,
    id: 's:m:0:command-echo',
    kind: 'command-echo',
    commandName: 'resume',
    args: 'abc123',
    content: '/resume abc123',
    skillFormat: false,
    isReplay: false,
  })

  expect(html).toContain('/resume')
  expect(html).toContain('abc123')
})

test('P4-18a: a skill-format command echo renders Skill(name)', () => {
  const html = render({
    ...blockSource,
    id: 's:m:0:command-echo',
    kind: 'command-echo',
    commandName: 'pickup',
    args: null,
    content: 'Skill(pickup)',
    skillFormat: true,
    isReplay: false,
  })

  expect(html).toContain('Skill(pickup)')
})

test('P4-18a: a pasted user image renders an img with the data URI', () => {
  const html = render({
    ...blockSource,
    id: 's:m:0:user-image',
    kind: 'user-image',
    source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' },
    isReplay: false,
  })

  expect(html).toContain('<img')
  expect(html).toContain('data:image/png;base64,AAAA')
})

test('P4-18a: a thinking row renders its reasoning body and eyebrow', () => {
  const html = render({
    ...blockSource,
    id: 's:m:0:thinking',
    kind: 'thinking',
    content: 'weighing the socket options',
    reasoningKind: 'summary',
  })

  expect(html).toContain('Thinking')
  expect(html).toContain('weighing the socket options')
  expect(html).toContain('summary')
})

test('P4-18a: a redacted-thinking row renders a redacted placeholder', () => {
  const html = render({
    ...blockSource,
    id: 's:m:0:redacted-thinking',
    kind: 'redacted-thinking',
    data: 'ENCRYPTED',
  })

  expect(html).toContain('redacted by the model provider')
  // The encrypted payload must never be printed.
  expect(html).not.toContain('ENCRYPTED')
})

test('P4-18a: a session-init row renders the started banner with cwd/model/mode', () => {
  const html = render({
    ...frameSource,
    id: 's:f:session-init',
    kind: 'session-init',
    cwd: '/Users/pt/cat-code',
    model: 'claude-opus-4-8',
    tools: ['Bash', 'Read', 'Edit'],
    permissionMode: 'default',
  })

  expect(html).toContain('Session started')
  expect(html).toContain('/Users/pt/cat-code')
  expect(html).toContain('claude-opus-4-8')
  expect(html).toContain('default')
})

test('P4-18a: a completed result row renders a Completed seam with duration', () => {
  const html = render({
    ...frameSource,
    id: 's:f:result',
    kind: 'result',
    subtype: 'success',
    isError: false,
    errors: [],
    durationMs: 4200,
    totalCostUsd: 0.0123,
  })

  expect(html).toContain('Completed')
  expect(html).toContain('4.2s')
})

test('P4-18a: an errored result row renders an Errored seam', () => {
  const html = render({
    ...frameSource,
    id: 's:f:result',
    kind: 'result',
    subtype: 'error_during_execution',
    isError: true,
    errors: ['boom'],
  })

  expect(html).toContain('Errored')
})

test('P4-18a: a compact-boundary row renders the compaction seam', () => {
  const html = render({
    ...frameSource,
    id: 's:f:compact-boundary',
    kind: 'compact-boundary',
    trigger: 'auto',
    preTokens: 120000,
  })

  expect(html).toContain('Conversation compacted')
  expect(html).toContain('auto')
})

test('P4-18a: a system-notice row renders the notice box with its tag', () => {
  const html = render({
    ...frameSource,
    id: 's:f:system-notice',
    kind: 'system-notice',
    noticeType: 'api_retry',
    content: 'retrying after 429',
  })

  expect(html).toContain('retrying after 429')
  expect(html).toContain('api_retry')
})

test('P4-18a: snip-boundary and tombstone typed-degraded rows still render', () => {
  const snip = render({
    ...frameSource,
    id: 's:f:snip-boundary',
    kind: 'snip-boundary',
  })
  const tombstone = render({
    ...frameSource,
    id: 's:f:tombstone',
    kind: 'tombstone',
  })

  expect(snip).toContain('Stale tool output snipped')
  expect(tombstone).toContain('message removed')
})

test('P4-18a: a schema-drifted unknown kind degrades to a tolerant fallback, not a throw', () => {
  // Simulates a wire kind past the pinned union (display = degrade gracefully).
  const drifted = {
    ...frameSource,
    id: 's:f:future',
    kind: 'future-row-kind',
  } as unknown as NestedTranscriptRow

  const html = render(drifted)

  expect(html).toContain('Unrecognized transcript row')
  expect(html).toContain('future-row-kind')
})
