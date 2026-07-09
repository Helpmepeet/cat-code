import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TranscriptRowsView } from './TranscriptView.js'
import type {
  NestedTranscriptRow,
  ToolCardStatus,
  ToolDiffProjection,
  ToolFamily,
  ToolResultProjection,
} from './transcriptProjector.js'

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

// P4-18b tool-card family helper: builds a tool-use nested row. Cards collapse
// by default (prototype FrameEShell), so header assertions (family WORD + target
// + state) are the per-family proof; bodies are asserted where they render
// (errored/imagegen cards expand; a bash card shows a collapsed tail-peek).
function toolRow(fields: {
  toolName: string
  toolFamily: ToolFamily
  input?: Record<string, unknown>
  status?: ToolCardStatus
  result?: ToolResultProjection | null
  children?: NestedTranscriptRow[]
}): NestedTranscriptRow {
  return {
    ...blockSource,
    id: `s:m:0:${fields.toolName}`,
    kind: 'tool-use',
    toolUseId: `toolu_${fields.toolName}`,
    toolName: fields.toolName,
    toolFamily: fields.toolFamily,
    input: fields.input ?? {},
    status: fields.status ?? 'pending',
    result: fields.result ?? null,
    children: fields.children ?? [],
  }
}

test('P4-18b: a tool card renders the family word, real target, and running state', () => {
  const html = render(
    toolRow({
      toolName: 'Read',
      toolFamily: 'read',
      input: { file_path: '/etc/hosts' },
      status: 'pending',
    }),
  )

  expect(html).toContain('Read') // family word
  expect(html).toContain('/etc/hosts') // real target from input.file_path
  expect(html).toContain('running') // pending → running state word
})

test('renders an empty-state hint when no rows are projected yet', () => {
  const html = renderToStaticMarkup(<TranscriptRowsView rows={[]} />)

  expect(html).toContain('No transcript rows yet.')
})

test('P4-18b: a resolved bash card shows the collapsed tail-peek output and done state', () => {
  const html = render(
    toolRow({
      toolName: 'Bash',
      toolFamily: 'bash',
      input: { command: 'echo hi' },
      status: 'success',
      result: { isError: false, content: 'hi\n', diff: null },
    }),
  )

  expect(html).toContain('done') // success → done state word
  expect(html).toContain('hi') // tail-peek surfaces output even collapsed
})

test('P4-18b: a bash card tints an error line and expands failed results', () => {
  const html = render(
    toolRow({
      toolName: 'Bash',
      toolFamily: 'bash',
      input: { command: 'run tests' },
      status: 'error',
      result: { isError: true, content: 'ERROR: boom\nline two', diff: null },
    }),
  )

  expect(html).toContain('failed')
  expect(html).toContain('ERROR: boom') // errored card is expanded by default
  expect(html).toContain('text-tone-danger')
})

test('P4-18b: an edit card renders a dual-gutter diff with +adds/−dels counts', () => {
  const diff: ToolDiffProjection = {
    filePath: '/repo/app.ts',
    hunks: [
      {
        oldStart: 10,
        oldLines: 2,
        newStart: 10,
        newLines: 2,
        lines: [' const a = 1', '-const b = 2', '+const b = 3'],
      },
    ],
  }
  const html = render(
    toolRow({
      toolName: 'Edit',
      toolFamily: 'edit',
      input: { file_path: '/repo/app.ts' },
      status: 'error', // expand so the diff body renders
      result: { isError: true, content: '', diff },
    }),
  )

  expect(html).toContain('/repo/app.ts')
  expect(html).toContain('+1') // one addition
  expect(html).toContain('−1') // one deletion
  expect(html).toContain('const b = 3')
})

test('P4-18b: an MCP card frames the target as server › tool', () => {
  const html = render(
    toolRow({
      toolName: 'mcp__gpt-agent__spawn',
      toolFamily: 'mcp',
      input: {},
      status: 'pending',
    }),
  )

  expect(html).toContain('MCP') // family word
  expect(html).toContain('gpt-agent › spawn') // server › tool framing
})

test('P4-18b: each tool family renders its own glyph + word header', () => {
  const families: Array<{ family: ToolFamily; word: string }> = [
    { family: 'read', word: 'Read' },
    { family: 'write', word: 'Write' },
    { family: 'grep', word: 'Search' },
    { family: 'web', word: 'Web' },
    { family: 'notebook', word: 'Notebook' },
    { family: 'lsp', word: 'LSP' },
    { family: 'skill', word: 'Skill' },
    { family: 'imagegen', word: 'Image' },
    { family: 'other', word: 'Tool' },
  ]
  for (const { family, word } of families) {
    const html = render(
      toolRow({ toolName: `T_${family}`, toolFamily: family, status: 'pending' }),
    )
    expect(html).toContain(word)
  }
})

test('P4-18b: a GenerateImage card flags the missing inline-image seam, never mocks a tile', () => {
  const html = render(
    toolRow({
      toolName: 'GenerateImage',
      toolFamily: 'imagegen',
      input: { prompt: 'a cat' },
      status: 'success',
      result: { isError: false, content: 'saved to /tmp/cat.png', diff: null },
    }),
  )

  expect(html).toContain('saved to /tmp/cat.png') // real result text
  expect(html).toContain('inline image tile pending') // flagged, not mocked
})

test('D2/C4: renders a subagent tool card NESTED inside its owning agent card, not as a sibling', () => {
  const html = render(
    toolRow({
      toolName: 'Agent',
      toolFamily: 'agent',
      input: { prompt: 'investigate' },
      status: 'pending',
      children: [
        toolRow({
          toolName: 'Grep',
          toolFamily: 'grep',
          input: { pattern: 'foo' },
          status: 'pending',
        }),
      ],
    }),
  )

  expect(html).toContain('Agent') // parent family word
  expect(html).toContain('Search') // nested grep family word
  expect(html).toContain('foo') // nested target
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

// P4-23 (operator, 2026-07-09): the ✦ "Session started" banner row was removed.
// The init frame still runs (it captures the P3-7 slash catalog — see
// transcriptProjector.test.ts) but emits no transcript row, so there is no
// SessionInitBanner render case to test here anymore.

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
