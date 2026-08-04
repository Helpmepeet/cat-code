import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SDKMessage } from '@cat-code/engine/session-events'
import {
  ToolInspectorOverlay,
  TranscriptRowsView,
} from './TranscriptView.js'
import {
  findNestedToolUseRow,
  logLineClass,
  resolveToolCardExpanded,
} from './transcriptViewModel.js'
import {
  createTranscriptState,
  projectServerFrame,
  selectNestedTranscriptRows,
} from './transcriptProjector.js'
import type {
  AgentCompletionProjection,
  NestedTranscriptRow,
  NestedToolUseRow,
  ToolCardStatus,
  ToolDiffProjection,
  ToolFamily,
  ToolResultProjection,
} from './transcriptProjector.js'
import {
  ReasoningLayoutContext,
  type ReasoningLayoutMode,
} from './reasoningLayout.js'
import type { AccountsSnapshot, AccountStatus } from '../../shared/protocol.js'

// P4-24 empty-state Welcome fixtures — a real `AccountsSnapshot` shape (mirrors
// WelcomeScreen.test.ts) so the empty transcript is
// proven to flow a REAL pool row into the Codex table, not a mock.
function account(over: Partial<AccountStatus> & { id: string }): AccountStatus {
  return {
    alias: over.id,
    status: 'healthy',
    statusReason: null,
    availability: 'available',
    availabilityLabel: 'Ready',
    isDefault: false,
    hasVaultProfile: true,
    source: 'vault',
    usagePrimary: 0,
    usageWeekly: 0,
    usageLimitReached: false,
    usageResetAt: null,
    lastRefreshIso: null,
    lastError: null,
    planType: 'plus',
    switchable: false,
    ...over,
  }
}

function pool(accounts: AccountStatus[]): AccountsSnapshot {
  return {
    accounts,
    activeAccountId: accounts.find(a => a.isDefault)?.id ?? null,
    readyCount: accounts.filter(a => a.status === 'healthy' && !a.usageLimitReached)
      .length,
    poolCount: accounts.length,
    initialized: true,
    anthropicAccounts: [],
    anthropicActiveAccountId: null,
    anthropicReadyCount: 0,
    anthropicPoolCount: 0,
    anthropicInitialized: true,
    anthropicRouteAvailable: false,
  }
}

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

/** Render rows under an explicit reasoning-display mode. No provider (the
 * `render` helper above) means the context default — the shipped default mode. */
function renderRows(
  rows: NestedTranscriptRow[],
  mode: ReasoningLayoutMode,
): string {
  return renderToStaticMarkup(
    <ReasoningLayoutContext.Provider value={{ mode, setMode: () => {} }}>
      <TranscriptRowsView rows={rows} />
    </ReasoningLayoutContext.Provider>,
  )
}

function thinkingRow(id: string, content: string): NestedTranscriptRow {
  return { ...blockSource, id, kind: 'thinking', content }
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/**
 * The rendered text with its tags removed, entities left escaped.
 *
 * For asserting that some source is ON SCREEN in a syntax-colored body. The
 * highlighter splits a line into token spans, so `const greeting` is no longer
 * one contiguous run in the markup even though it is one contiguous run to the
 * reader. Asserting through this says "the file's text is visible" instead of
 * pinning which tokenizer ran.
 */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, '')
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

test('P4-18c: a fenced code block renders framed + copyable with syntax highlight tokens', () => {
  const html = render({
    ...blockSource,
    id: 's:m:0:code',
    kind: 'assistant-text',
    role: 'assistant',
    content: 'Here:\n\n```ts\nconst x = 1\n```\n',
  })

  // rehype-highlight tokenizes the block — the code is split across hljs spans
  // (so it is no longer one contiguous string), but every token still renders.
  expect(html).toContain('hljs-keyword') // `const` colored as a keyword token
  expect(html).toContain('const') // code content still present, tokenized
  expect(html).toContain('copy') // per-block copy control
  expect(html).toContain('ts') // floating language label
})

test('P4-18c: a streaming assistant row renders a caret', () => {
  const html = render({
    ...blockSource,
    id: 's:m:0:stream',
    kind: 'assistant-text',
    role: 'assistant',
    content: 'partial answer',
    isStreaming: true,
  })

  expect(html).toContain('partial answer')
  expect(html).toContain('animate-pulse') // the blinking streaming caret
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
    agentCompletion: null,
    input: fields.input ?? {},
    status: fields.status ?? 'pending',
    result: fields.result ?? null,
    children: fields.children ?? [],
  }
}

test('P4-18b: a Read tool card renders the filename, not its full path', () => {
  const html = render(
    toolRow({
      toolName: 'Read',
      toolFamily: 'read',
      input: { file_path: '/etc/hosts' },
      status: 'pending',
    }),
  )

  expect(html).toContain('Read') // family word
  expect(html).toContain('hosts') // filename from input.file_path
  expect(html).not.toContain('/etc/hosts')
  expect(html).toContain('running') // pending → running state word
})

test('renders the rich WelcomeScreen (hero + real Codex table + cwd) when no rows are projected yet', () => {
  // Chat.jsx:1272 renders the SAME WelcomeScreen when the session is empty. The
  // in-session variant shows the cat|wordmark hero, the read-only cwd, and the
  // REAL P4-5 Codex pool table — proven by a fixture account alias reaching the
  // DOM (real data flows, not a shape-only assert). The old bare "How can I
  // help?" paw is gone.
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      rows={[]}
      accounts={pool([
        account({ id: 'main', alias: 'nightowl', isDefault: true, usagePrimary: 20 }),
      ])}
      orchestratorActive
      cwd="/w/cat-code"
    />,
  )

  // Hero + wordmark instead of the bare paw.
  expect(html).toContain('Welcome back')
  expect(html).toContain('cat ')
  expect(html).toContain('code')
  expect(html).not.toContain('How can I help?')
  // The REAL Codex pool table with a fixture account alias (real data flows).
  expect(html).toContain('Codex')
  expect(html).toContain('nightowl')
  expect(html).toContain('20%')
  // HC1 session variant: read-only cwd context, no interactive project picker.
  expect(html).toContain('/w/cat-code')
  expect(html).not.toContain('<button')
  expect(html).not.toContain('Open a project')
  // Orchestrator reflect is read-only and mirrors the passed active flag.
  expect(html).toContain('aria-readonly="true"')
  expect(html).toContain('>On<')
})

test('P4-8b — threads onToggleOrchestrator to the empty-state WelcomeScreen (interactive switch)', () => {
  // Proves the full renderer path App→…→TranscriptRowsView→WelcomeScreen: when the
  // toggle callback is threaded, the in-session Orchestrator becomes a real button.
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      rows={[]}
      orchestratorActive={false}
      cwd="/w/cat-code"
      onToggleOrchestrator={() => {}}
    />,
  )
  expect(html).toContain('role="switch"')
  expect(html).toContain('<button')
  expect(html).not.toContain('aria-readonly="true"')
})

test('the empty state degrades honestly with no pool snapshot and no cwd (no fabrication)', () => {
  const html = renderToStaticMarkup(<TranscriptRowsView rows={[]} />)

  // Defaults (no accounts/cwd threaded): the hero still renders, the Codex table
  // says it has no data, and the cwd shows an honest placeholder — never a mock.
  expect(html).toContain('Welcome back')
  expect(html).toContain('No Codex account data')
  expect(html).toContain('This workspace')
})

// IS-C (M5) — restore affordance. Cached transcript rows retain their content
// without startup decoration; a no-cache restore shows the skeleton instead of
// an empty WelcomeScreen (report F4's "reads as a hang").
const cachedRow: NestedTranscriptRow = {
  ...blockSource,
  id: 's:m:0:f',
  kind: 'assistant-text',
  role: 'assistant',
  content: 'cached line',
}

test('IS-C: preview rows render without a restore divider', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView rows={[cachedRow]} restorePhase="preview" />,
  )
  expect(html).toContain('cached line')
  expect(html).not.toContain('h-px flex-1 bg-accent/20')
  // No visible restore chrome or labels.
  expect(html).not.toContain('Restored session')
  expect(html).not.toContain('Resuming session')
  expect(html).not.toContain('Opening session')
})

test('IS-C: an engaged preview does not add a pulsing restore divider', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView rows={[cachedRow]} restorePhase="resuming" />,
  )
  expect(html).toContain('cached line')
  expect(html).not.toContain('h-px flex-1 bg-accent/20')
  expect(html).not.toContain('animate-pulse')
  expect(html).not.toContain('Restored session')
  expect(html).not.toContain('Resuming session')
  expect(html).not.toContain('Opening session')
})

test('PL-A: a no-cache connecting pane shows a non-text skeleton, never an empty Welcome', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView rows={[]} restorePhase="connecting" cwd="/w/cat-code" />,
  )
  expect(html).toContain('aria-busy="true"')
  expect(html).toContain('animate-pulse')
  // The whole point of F4: no live/empty WelcomeScreen while a restore is pending.
  expect(html).not.toContain('Welcome back')
  expect(html).not.toContain('Opening session')
  expect(html).not.toContain('Resuming session')
  expect(html).not.toContain('Restored session')
})

test('IS-C: a preview that distilled to zero rows shows the skeleton, not Welcome', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView rows={[]} restorePhase="preview" />,
  )
  expect(html).toContain('aria-busy="true"')
  expect(html).not.toContain('Welcome back')
  expect(html).not.toContain('Restored session')
  expect(html).not.toContain('Resuming session')
  expect(html).not.toContain('Opening session')
})

test('IS-C: an ordinary empty pane (no restore) still shows the WelcomeScreen', () => {
  const html = renderToStaticMarkup(<TranscriptRowsView rows={[]} />)
  expect(html).toContain('Welcome back')
  expect(html).not.toContain('Opening session')
  expect(html).not.toContain('Restored session')
})

test('IS-C: an ordinary live pane renders no restore divider', () => {
  const html = renderToStaticMarkup(<TranscriptRowsView rows={[cachedRow]} />)
  expect(html).not.toContain('Restored session')
  expect(html).not.toContain('Resuming session')
  expect(html).toContain('cached line')
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

// Quote-free slice of ResumeAgent's real ack: SSR escapes the `"@Ramanujan"`
// the engine's wording puts around the name, so assert on the rest of it.
const RESUME_ACK = 'in the background. Previous context: ~105k / 372k tokens (28%).'

test('ack card: a resumed agent shows its outcome COLLAPSED, never as raw JSON', () => {
  const html = render(
    toolRow({
      toolName: 'ResumeAgent',
      toolFamily: 'agent-control',
      input: { agentId: '@Ramanujan', prompt: 'measure the card height' },
      status: 'success',
      result: {
        isError: false,
        content: JSON.stringify({
          success: true,
          message: `Resumed "@Ramanujan" ${RESUME_ACK}`,
        }),
        diff: null,
      },
    }),
  )

  // The whole point: no expansion needed, and none of the JSON scaffolding.
  expect(html).toContain(RESUME_ACK)
  expect(html).not.toContain('"success"')
  expect(html).toContain('resume @Ramanujan') // target from the real agentId
  expect(html).toContain('◇') // hollow mark against the spawn card's ◆
  expect(html).toContain('text-[#a78bfa]')
})

test('ack card: a FAILED ack tints the peek while the header still reports the call', () => {
  const html = render(
    toolRow({
      toolName: 'ResumeAgent',
      toolFamily: 'agent-control',
      input: { agentId: '@Ramanujon', prompt: 'go' },
      // The tool call succeeded; the operation it performed did not.
      status: 'success',
      result: {
        isError: false,
        content: JSON.stringify({
          success: false,
          message: 'No subagent found for "@Ramanujon".',
        }),
        diff: null,
      },
    }),
  )

  expect(html).toContain('No subagent found')
  expect(html).toContain('text-tone-danger') // ack tone, from `success:false`
  expect(html).toContain('done') // call status, unchanged and still true
  expect(html).not.toContain('failed')
})

test('ack card: the expanded body labels the result and the prompt that was sent', () => {
  const html = render(
    toolRow({
      toolName: 'ResumeAgent',
      toolFamily: 'agent-control',
      input: { agentId: '@Ramanujan', prompt: 'measure the card height' },
      // An errored row is the default-expanded case, so SSR can see the body.
      status: 'error',
      result: {
        isError: true,
        content: JSON.stringify({ success: false, message: 'Failed to resume.' }),
        diff: null,
      },
    }),
  )

  expect(html).toContain('Result')
  expect(html).toContain('Failed to resume.')
  expect(html).toContain('Sent')
  expect(html).toContain('measure the card height')
})

test('ack card: a non-ack result keeps its existing rendering untouched', () => {
  const html = render(
    toolRow({
      toolName: 'SomeFutureTool',
      toolFamily: 'other',
      status: 'error',
      result: { isError: true, content: 'plain stdout, not JSON', diff: null },
    }),
  )

  expect(html).toContain('plain stdout, not JSON')
  expect(html).toContain('Tool') // still the neutral family
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
  // P4-18c word-level intra-line highlight: the replaced token (2 → 3) is washed
  // per side; the shared prefix dims. The line is no longer one contiguous string.
  expect(html).toContain('bg-tone-danger/28') // removed word wash
  expect(html).toContain('bg-tone-success/26') // added word wash
  expect(html).toContain('const b = ') // shared, dimmed prefix
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
    { family: 'agent-control', word: 'Agent' },
    { family: 'other', word: 'Tool' },
  ]
  for (const { family, word } of families) {
    const html = render(
      toolRow({ toolName: `T_${family}`, toolFamily: family, status: 'pending' }),
    )
    expect(html).toContain(word)
  }
})

test('P4-18b: a GenerateImage card renders its real result text and never mocks a tile', () => {
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
  // P4-45: the missing inline-image tile is still deferred, but the deferral is
  // recorded in the ledger, not printed under every image the user generates.
  expect(html).not.toContain('inline image tile pending')
  // ("seam" alone is not assertable here: `border-shell-seam` is a Tailwind
  // token. `userVisibleText.test.ts` strips class names and enforces the word.)
  expect(html).not.toContain('image-payload')
})

// P4-8c: a top-level Agent tool-use row (the DelegateGroup member / lone card).
// messageId is shared ('m' via blockSource) so two of these coalesce; distinct
// ids/toolUseIds keep them separate rows.
function agentRow(
  suffix: string,
  input: Record<string, unknown>,
  status: ToolCardStatus,
  children: NestedTranscriptRow[] = [],
  agentCompletion: AgentCompletionProjection | null = null,
): NestedTranscriptRow {
  return {
    ...blockSource,
    id: `s:m:0:agent-${suffix}`,
    kind: 'tool-use',
    toolUseId: `toolu_agent_${suffix}`,
    toolName: 'Agent',
    toolFamily: 'agent',
    agentCompletion,
    input,
    status,
    result: null,
    children,
  }
}

test('P4-8c: an Agent card derives type/state/task from the row input + status (data-path honest)', () => {
  const html = render(
    agentRow('solo', { subagent_type: 'Explore', description: 'map the seam' }, 'pending'),
  )

  expect(html).toContain('Agent') // family word (◆ Agent header)
  expect(html).toContain('Explore') // worker type from input.subagent_type
  expect(html).toContain('map the seam') // description line (header target)
  expect(html).toContain('Running') // derived AgentStateLabel (pending → running)
})

test('P4-8c: a completed Agent card shows the Completed agent state', () => {
  const html = render(
    agentRow('done', { subagent_type: 'Explore', description: 'done task' }, 'success'),
  )

  expect(html).toContain('Completed') // deriveAgentToolState: success → completed
})

/* ── the finished background agent (leak fix, 2026-08-01) ─────────────────── */

const ADA_COMPLETION: AgentCompletionProjection = {
  status: 'completed',
  summary: 'Agent @Ada completed',
  result: 'Sidebar lives in app/renderer/src/Sidebar.tsx',
  usage: { totalTokens: 12400, toolUses: 3, durationMs: 48000 },
}

test('a finished background agent shows its result and stats on its own card, opened', () => {
  const html = render(
    agentRow(
      'bg',
      { subagent_type: 'Explore', description: 'find the sidebar owner' },
      'success',
      [],
      ADA_COMPLETION,
    ),
  )

  expect(html).toContain('Result')
  expect(html).toContain('Sidebar lives in app/renderer/src/Sidebar.tsx')
  // Stats read compactly, the way the prototype's card footer does.
  expect(html).toContain('~12.4k tokens')
  expect(html).toContain('3 tools')
  expect(html).toContain('48s')
  // The card is the ONLY place this appears: no second banner row, and the
  // summary is not repeated inside a card that already names the agent.
  expect(html).not.toContain('Agent @Ada completed')
})

test('a foreground agent card keeps the C4 collapsed default and grows no result section', () => {
  const html = render(
    agentRow('fg', { subagent_type: 'Explore', description: 'inline work' }, 'success'),
  )
  expect(html).not.toContain('Result')
  expect(html).toContain('aria-expanded="false"')
})

test('an unmergeable completion renders one line, never the model-facing banner', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      rows={[
        {
          ...blockSource,
          id: 's:m:0:task-notification',
          kind: 'task-notification',
          status: 'completed',
          summary: 'Agent @Ada completed',
          toolUseId: null,
          isReplay: false,
          children: [],
        },
      ]}
    />,
  )
  expect(html).toContain('Agent @Ada completed')
  // The words the operator should never see again.
  for (const leaked of ['Task notification', 'Task ID', 'Output file', 'Tool use ID', 'Agent task']) {
    expect(html).not.toContain(leaked)
  }
  // No status chip beside a summary that already ends in its outcome.
  expect(html).not.toContain('>completed<')
})

test('a summary-less completion draws nothing at all', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      rows={[
        {
          ...blockSource,
          id: 's:m:0:task-notification',
          kind: 'task-notification',
          status: 'completed',
          summary: null,
          toolUseId: null,
          isReplay: false,
          children: [],
        },
      ]}
    />,
  )
  expect(html).not.toContain('completed')
})

test('D2/C4: an owning Agent card nests its subagent COLLAPSED by default with a child-count affordance', () => {
  const html = render(
    agentRow('owner', { subagent_type: 'Explore', description: 'investigate the seam' }, 'pending', [
      toolRow({
        toolName: 'Grep',
        toolFamily: 'grep',
        input: { pattern: 'foo' },
        status: 'pending',
      }),
    ]),
  )

  expect(html).toContain('Agent') // parent family word (always-visible header)
  expect(html).toContain('1 nested') // child-count expand affordance in the header
  // C4: children are COLLAPSED by default — the nested subagent content is not
  // rendered until the card is expanded, so it must not leak top-level.
  expect(html).not.toContain('Search') // nested grep family word hidden
  expect(html).not.toContain('foo') // nested target hidden
})

test('D2/§3: two co-spawned Agent rows (same messageId) render as ONE DelegateGroup with both members', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      rows={[
        agentRow('a', { subagent_type: 'Explore', description: 'audit A' }, 'pending'),
        agentRow('b', { subagent_type: 'Explore', description: 'audit B' }, 'pending'),
      ]}
    />,
  )

  expect(html).toContain('Delegate') // group eyebrow
  expect(html).toContain('Running 2 Explore agents') // engine-faithful group summary
  expect(html).toContain('audit A') // member A card
  expect(html).toContain('audit B') // member B card
})

test('P4-8c: the Agent card + DelegateGroup emit only static tone utilities (no interpolated/arbitrary classes)', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView
      rows={[
        agentRow('a', { subagent_type: 'Explore', description: 'x' }, 'pending'),
        agentRow('b', { subagent_type: 'Explore', description: 'y' }, 'pending'),
      ]}
    />,
  )

  // Static utilities from the 8a tone maps actually reach the DOM (a dynamic
  // `text-[${hex}]` would silently never generate — the P4-9 trap).
  expect(html).toContain('text-blue-400') // running state tone (AGENT_STATE_TONE_CLASS.info)
  expect(html).toContain('bg-blue-400')
  expect(html).toContain('text-sky-300') // Explore type tone (AGENT_TYPE_TONE_CLASS.sky)
  // No template-literal interpolation ever leaks into a className.
  expect(html).not.toContain('${')
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

test('an injected turn renders system-side — never in the operator user column', () => {
  // The bug this closes: `coordinator`/`channel`/`teammate`/`deferred-continuation`
  // all carry role:'user' and rendered inside the right-aligned accent bubble,
  // i.e. as if the operator had typed them.
  const cases: Array<[string, string | null, string, string]> = [
    ['coordinator', null, 'Coordinator', 'coordinator'],
    ['channel', 'slack · dana', 'slack · dana', 'channel'],
    ['teammate', 'scout', '@scout', 'teammate'],
    ['deferred-continuation', null, 'Continuation', 'continuation'],
    // A kind from a newer engine: still attributed away from the operator.
    ['future-kind-2027', null, 'Injected message', 'injected'],
  ]
  for (const [injectedKind, label, expectedHeading, expectedTag] of cases) {
    const html = render({
      ...blockSource,
      id: `s:m:0:injected-${injectedKind}`,
      kind: 'injected-turn',
      injectedKind,
      label,
      content: 'a message the operator did not write',
      isReplay: false,
    })
    expect(html).toContain('a message the operator did not write')
    expect(html).toContain(expectedHeading)
    expect(html).toContain(expectedTag)
    // The user-bubble grammar (UserBubble/CommandEchoBubble/UserImageRowView)
    // is right-aligned + accent-tinted; an injected row must use neither.
    expect(html).not.toContain('justify-end')
    expect(html).not.toContain('bg-accent/10')
  }
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

test('P4-18a/#7: the blocks mode renders a thinking row as an expanded markdown block', () => {
  const html = renderRows(
    [
      {
        ...blockSource,
        id: 's:m:0:thinking',
        kind: 'thinking',
        content: 'weighing the **socket** options',
        reasoningKind: 'summary',
      },
    ],
    'blocks',
  )

  expect(html).toContain('Thinking')
  // #7: the reasoning body renders through the markdown path — **bold** becomes
  // <strong>, not literal asterisks.
  expect(html).toContain('<strong>socket</strong>')
  expect(html).not.toContain('**socket**')
  // #7: the "summary" reasoningKind sub-label was removed.
  expect(html).not.toContain('summary')
})

test('P4-18a: the blocks mode renders a redacted-thinking placeholder', () => {
  const html = renderRows(
    [
      {
        ...blockSource,
        id: 's:m:0:redacted-thinking',
        kind: 'redacted-thinking',
        data: 'ENCRYPTED',
      },
    ],
    'blocks',
  )

  expect(html).toContain('redacted by the model provider')
  // The encrypted payload must never be printed.
  expect(html).not.toContain('ENCRYPTED')
})

test('trail mode: a lone reasoning summary is ONE labelled line, not a card', () => {
  const html = render(
    thinkingRow('s:m:0:thinking', 'Locating the transport teardown path'),
  )

  expect(html).toContain('Reasoning')
  expect(html).toContain('Locating the transport teardown path')
  // No run head: a single summary has no step count and nothing to collapse.
  expect(html).not.toContain('steps')
  expect(html).not.toContain('aria-expanded')
  // Not the blocks treatment: no accent-tinted card frame around four words.
  expect(html).not.toContain('border-accent/15')
})

test('trail mode: a summary heading renders its Markdown emphasis', () => {
  const html = render(thinkingRow('s:m:0:thinking', 'weighing the **socket** options'))

  // Summary headings are compact, but must not expose model-authored Markdown
  // delimiters to the user.
  expect(html).toContain('<strong>socket</strong>')
  expect(html).not.toContain('**socket**')
})

test('trail mode: every heading in a reasoning run renders inline Markdown', () => {
  const html = renderRows(
    [
      thinkingRow('s:m:0:thinking', '**Checking** the transport'),
      thinkingRow('s:m:1:thinking', '_Ordering_ the close frame'),
    ],
    'trail',
  )

  expect(html).toContain('<strong>Checking</strong>')
  expect(html).toContain('<em>Ordering</em>')
  expect(html).not.toContain('**Checking**')
  expect(html).not.toContain('_Ordering_')
})

test('trail mode: adjacent reasoning rows coalesce into ONE run with a step count', () => {
  const html = renderRows(
    [
      thinkingRow('s:m:0:thinking', 'Checking close-frame ordering'),
      thinkingRow('s:m:1:thinking', 'Considering the early-abort path'),
      thinkingRow('s:m:2:thinking', 'Planning a focused test run'),
    ],
    'trail',
  )

  expect(html).toContain('3 steps')
  // One head for the run, not one per summary.
  expect(occurrences(html, 'Reasoning')).toBe(1)
  expect(html).toContain('Checking close-frame ordering')
  expect(html).toContain('Considering the early-abort path')
  expect(html).toContain('Planning a focused test run')
})

test('trail mode: a run mixes readable summaries with an encrypted-only step, payload never printed', () => {
  const html = renderRows(
    [
      thinkingRow('s:m:0:thinking', 'Acknowledging correction on summary display'),
      {
        ...blockSource,
        id: 's:m:1:redacted-thinking',
        kind: 'redacted-thinking',
        data: 'ENCRYPTED',
      },
    ],
    'trail',
  )

  expect(html).toContain('2 steps')
  expect(html).toContain('Acknowledging correction on summary display')
  expect(html).toContain('reasoning not shared by the provider')
  expect(html).not.toContain('ENCRYPTED')
})

test('trail mode: a lone encrypted-only block is one row with no label and no payload', () => {
  const html = render({
    ...blockSource,
    id: 's:m:0:redacted-thinking',
    kind: 'redacted-thinking',
    data: 'ENCRYPTED',
  })

  expect(html).toContain('reasoning not shared by the provider')
  expect(html).not.toContain('ENCRYPTED')
  expect(html).not.toContain('steps')
})

test('trail mode: a long-form reasoning body keeps its prose, on the trail', () => {
  const long = `The transcript keys thinking rows by message id and block index, which is a sentence long enough that it is plainly reasoning text rather than a heading label.

Which means two consecutive **summary** blocks already produce two distinct rows.`
  const html = render(thinkingRow('s:m:0:thinking', long))

  // A prose step: the trail head with no step count, and the markdown body.
  expect(html).toContain('Reasoning')
  expect(html).toContain('<strong>summary</strong>')
  expect(html).not.toContain('steps')
})

test('trail mode: the adapter\'s "\\n\\n"-merged headings become one step each', () => {
  // The common Codex turn: several summary parts merged into ONE thinking block
  // (codex-fetch-adapter.ts:2018-2031), which must still read as a trail.
  const html = render(
    thinkingRow(
      's:m:0:thinking',
      'Locating the teardown path\n\nChecking close-frame ordering\n\nPlanning a test run',
    ),
  )

  expect(html).toContain('3 steps')
  expect(html).toContain('Locating the teardown path')
  expect(html).toContain('Checking close-frame ordering')
  expect(html).toContain('Planning a test run')
})

test('an empty-bodied thinking row is withheld in BOTH modes, never an empty card or label', () => {
  // Encrypted-only reasoning reaches the app as `thinking` with an empty body
  // carrying the signature (codex-fetch-adapter.ts:2229).
  const trail = render(thinkingRow('s:m:0:thinking', ''))
  expect(trail).toContain('reasoning not shared by the provider')
  expect(trail).not.toContain('steps')

  const blocks = renderRows([thinkingRow('s:m:0:thinking', '')], 'blocks')
  expect(blocks).toContain('redacted by the model provider')
})

test('trail mode: an all-withheld run draws bare lines — no head asserting steps', () => {
  const html = renderRows(
    [
      { ...blockSource, id: 's:m:0:r', kind: 'redacted-thinking', data: 'ENCRYPTED' },
      { ...blockSource, id: 's:m:1:r', kind: 'redacted-thinking', data: 'ENCRYPTED' },
    ],
    'trail',
  )

  expect(occurrences(html, 'reasoning not shared by the provider')).toBe(2)
  expect(html).not.toContain('steps')
  expect(html).not.toContain('aria-expanded')
  expect(html).not.toContain('ENCRYPTED')
})

test('trail mode: a long run folds its older steps behind a control', () => {
  const html = renderRows(
    Array.from({ length: 7 }, (_, index) =>
      thinkingRow(`s:m:${index}:thinking`, `Step number ${index}`),
    ),
    'trail',
  )

  expect(html).toContain('7 steps')
  expect(html).toContain('3 earlier steps')
  // The oldest three are folded away; the last four remain.
  expect(html).not.toContain('Step number 0')
  expect(html).toContain('Step number 3')
  expect(html).toContain('Step number 6')
})

test('trail mode: a long member inside a run keeps its prose under its own step', () => {
  const long = `A body long enough to be real reasoning rather than a heading label, carrying **emphasis** across more than one hundred and forty characters of text.`
  const html = renderRows(
    [thinkingRow('s:m:0:thinking', long), thinkingRow('s:m:1:thinking', 'Settling on a boxless trail')],
    'trail',
  )

  expect(html).toContain('2 steps')
  expect(html).toContain('<strong>emphasis</strong>')
  expect(html).toContain('Settling on a boxless trail')
})

test('blocks mode: adjacent reasoning rows stay separate blocks, never grouped', () => {
  const html = renderRows(
    [
      thinkingRow('s:m:0:thinking', 'Checking close-frame ordering'),
      thinkingRow('s:m:1:thinking', 'Considering the early-abort path'),
    ],
    'blocks',
  )

  expect(occurrences(html, 'Thinking')).toBe(2)
  expect(html).not.toContain('steps')
})

// P4-23 (operator, 2026-07-09): the ✦ "Session started" banner row was removed.
// The init frame still runs (it captures the P3-7 slash catalog — see
// transcriptProjector.test.ts) but emits no transcript row, so there is no
// SessionInitBanner render case to test here anymore.

test('P4-60/#6: a successful result row renders no turn-footer', () => {
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

  // #6 (operator, 2026-07-19): the success `Completed · Ns · $…` footer was
  // removed entirely — a completed turn surfaces no seam.
  expect(html).not.toContain('Completed')
  expect(html).not.toContain('4.2s')
  expect(html).not.toContain('$0.0123')
})

test.each([
  ['error_during_execution', 'Errored during execution'],
  ['error_max_turns', 'Stopped · max turns reached'],
  ['error_max_budget_usd', 'Stopped · budget limit reached'],
  [
    'error_max_structured_output_retries',
    'Stopped · max output retries',
  ],
] as const)('P4-60: %s renders its truthful result label', (subtype, label) => {
  const html = render({
    ...frameSource,
    id: `s:f:result:${subtype}`,
    kind: 'result',
    subtype,
    isError: true,
    errors: ['Detailed failure text stays outside the label-only seam'],
    durationMs: 4200,
    totalCostUsd: 0.0123,
  })

  expect(html).toContain(label)
  expect(html).toContain('4.2s')
  expect(html).toContain('$0.0123')
  expect(html).not.toContain('Detailed failure text')
})

test('P4-60: an unknown error subtype renders a generic failure label', () => {
  const html = render({
    ...frameSource,
    id: 's:f:result:future-error',
    kind: 'result',
    subtype: 'error_future_subtype',
    isError: true,
    errors: [],
  })

  expect(html).toContain('Turn failed')
  expect(html).not.toContain('Completed')
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

test('P4-18a: a system-notice row renders the notice box, never its raw type', () => {
  const html = render({
    ...frameSource,
    id: 's:f:system-notice',
    kind: 'system-notice',
    noticeType: 'api_retry',
    content: 'retrying after 429',
  })

  expect(html).toContain('retrying after 429')
  expect(html).toContain('↻') // the glyph is what distinguishes the three types
  // P4-45: the discriminant used to print in the corner of the most-read
  // surface in the app. It is a debug tag (CLAUDE.md §7).
  expect(html).not.toContain('api_retry')
})

test('P4-45: no notice type prints its discriminant', () => {
  for (const noticeType of [
    'api_retry',
    'local_command_output',
    'account_diagnostic',
  ] as const) {
    const html = render({
      ...frameSource,
      id: `s:f:${noticeType}`,
      kind: 'system-notice',
      noticeType,
      content: 'something happened',
    })

    expect(html).toContain('something happened')
    expect(html).not.toContain(noticeType)
  }
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

// P4-REVIEW B3: `resolveToolCardExpanded` is the pure decision logic behind
// ToolCardShell's collapse state. Before this fix, `expanded` was seeded once
// from `defaultExpanded` via `useState(defaultExpanded ?? false)`, so a stable
// row that lived through a live pending→error (or imagegen success) transition
// never re-read the new `defaultExpanded` — the card stayed collapsed. SSR
// can't exercise that live re-render (no effects, no re-render), so this
// helper is unit-tested directly; the live transition itself is covered only
// by the P4-18 GUI acceptance pass.
test('P4-REVIEW B3: resolveToolCardExpanded defaults to defaultExpanded until the user overrides it', () => {
  // The fix: no user toggle yet (null) → defaultExpanded wins every time,
  // including a fresh pending→error flip on an already-mounted card.
  expect(resolveToolCardExpanded(null, true)).toBe(true)
  expect(resolveToolCardExpanded(null, false)).toBe(false)
})

test('P4-REVIEW B3: resolveToolCardExpanded lets a user override win over either default', () => {
  expect(resolveToolCardExpanded(true, false)).toBe(true)
  expect(resolveToolCardExpanded(false, true)).toBe(false)
})

// ── Output-line tint: the prototype's `logLineColor`, and the two drifts off it
// that made tool output read as colorless. The hues are the prototype's 300-level
// pastels (`Messages.jsx:212-218`), NOT the `--tone-*` 400s this returned before:
// the prototype reserves those for signs/dots (`Messages.jsx:182` body vs `:186`
// sign), so painting body text with them read muddy against `#09090b`.

test('output lines take the prototype logLineColor pastel for their own semantics', () => {
  expect(logLineClass('ERROR: boom')).toBe('text-[#fca5a5]')
  expect(logLineClass('npm ERR! install failed')).toBe('text-[#fca5a5]')
  expect(logLineClass('WARNING: cache exceeded')).toBe('text-[#fcd34d]')
  expect(logLineClass('PASS src/thing.test.ts')).toBe('text-[#86efac]')
  expect(logLineClass('✓ 100 pass')).toBe('text-[#86efac]')
  // Stack/trace continuation lines recede rather than reading as ordinary output.
  expect(logLineClass('    at Object.<anonymous>')).toBe('text-text-faint')
  expect(logLineClass('  > bun run build')).toBe('text-text-faint')
  // Anything unclassified stays the resting body grey.
  expect(logLineClass('src/index.ts')).toBe('text-text-muted')
})

test('output-line tint keeps the prototype branch ORDER, so a failed pass reads failed', () => {
  // Both the error and the pass branch match this line; the prototype tests
  // error FIRST, and a line saying a test suite failed must not read green.
  expect(logLineClass('1 failed, 3 passed')).toBe('text-[#fca5a5]')
})

test('output-line tint anchors the bare FAIL/PASS words, so prose is not a status line', () => {
  // `^\s*FAIL`/`^\s*PASS` — the prototype anchors these, and the earlier port
  // used `\bFAIL\b`/`\bPASS\b`, so a sentence mentioning either was painted as
  // an outcome. Nothing else in those branches rescues the uppercase word:
  // `failed`/`passed` are separate lowercase alternatives.
  expect(logLineClass('the PASS threshold is configurable')).toBe('text-text-muted')
  expect(logLineClass('Tests: 1 FAIL out of 40')).toBe('text-text-muted')
  // Anchored still means leading whitespace is fine — that is how real output
  // indents its status lines.
  expect(logLineClass('  FAIL src/thing.test.ts')).toBe('text-[#fca5a5]')
})

test('output-line tint carries `not wrapped`, the one warn term the first port dropped', () => {
  // Only this one: the parent branch was `/\bWARN(ING)?\b|…/i`, so a lowercase
  // `warn` ALREADY matched. Without `not wrapped`, React's act() warning read as
  // ordinary output, which is the case that motivated re-checking the port.
  expect(logLineClass('An update was not wrapped in act(...)')).toBe('text-[#fcd34d]')
  expect(logLineClass('warn: peer dependency')).toBe('text-[#fcd34d]')
  // `WARNING` carries a `^\s*` anchor in the prototype, but that alternative is
  // unreachable: the branch's `\bwarn(ing)?\b` is unanchored and the whole regex
  // is case-insensitive, so a mid-line `WARNING` still matches. Ported verbatim
  // rather than "cleaned up", and pinned here so the quirk is not read as a bug.
  expect(logLineClass('emitted a WARNING during the run')).toBe('text-[#fcd34d]')
})

test('a bash body tints each line by its own semantics, not one flat wash', () => {
  // `status: 'error'` only EXPANDS the card; `isError: false` is what keeps the
  // per-line tinting path (a known failure paints one danger tone instead).
  const html = render(
    toolRow({
      toolName: 'Bash',
      toolFamily: 'bash',
      input: { command: 'bun test' },
      status: 'error',
      result: {
        isError: false,
        content: 'bun test v1.3\nWARNING: slow suite\nERROR: probe refused\n✓ 1 pass',
        diff: null,
      },
    }),
  )

  expect(html).toContain('text-[#fcd34d]') // the warn line
  expect(html).toContain('text-[#fca5a5]') // the error line
  expect(html).toContain('text-[#86efac]') // the passing line
  expect(html).toContain('text-text-muted') // the unclassified first line
})

test('a bash body numbers its output lines', () => {
  // The prototype runs bash output through `OutputLines`, which always draws a
  // line-number gutter (`Messages.jsx:525,550-554`); this body had none.
  const html = render(
    toolRow({
      toolName: 'Bash',
      toolFamily: 'bash',
      input: { command: 'ls' },
      status: 'error',
      result: { isError: false, content: 'alpha\nbeta\ngamma', diff: null },
    }),
  )

  expect(html).toContain('>1<')
  expect(html).toContain('>2<')
  expect(html).toContain('>3<')
})

test('a truncated bash tail resumes at its TRUE line number, never restarting at 1', () => {
  // Same rule P4-36 established for a truncated read: 900 lines, head 30,
  // tail 6 → the tail is output lines 895..900, not 1..6.
  const content = Array.from({ length: 900 }, (_, i) => `out ${i + 1}`).join('\n')
  const html = render(
    toolRow({
      toolName: 'Bash',
      toolFamily: 'bash',
      input: { command: 'bun test' },
      status: 'error',
      result: { isError: false, content, diff: null },
    }),
  )

  expect(html).toContain('864 lines hidden') // the window really did cut
  expect(html).toContain('>30<') // last head line
  expect(html).toContain('>895<') // first tail line, its real number
  expect(html).toContain('>900<') // last tail line
})

test('an errored bash body stays one danger tone rather than tinting its trace', () => {
  const html = render(
    toolRow({
      toolName: 'Bash',
      toolFamily: 'bash',
      input: { command: 'bun test' },
      status: 'error',
      result: { isError: true, content: 'ERROR: refused\n    at probe.ts:4', diff: null },
    }),
  )

  expect(html).toContain('text-tone-danger')
  expect(html).not.toContain('text-[#fca5a5]') // no per-line heuristic on a known failure
})

test('a NON-bash body keeps the prototype flat base, NOT the bash line heuristic', () => {
  // Parity guard, and the reason this file does not simply reuse `logLineClass`
  // everywhere: the prototype gives Grep/Web/Mcp/Skill bodies flat `FE_T.t2`
  // (`#a1a1aa` = `text-text-muted`) plus `hl()` syntax coloring
  // (`Messages.jsx:695,715,734,788`), and routes only bash output through
  // `OutputLines`/`logLineColor`. Tinting these by log semantics would be drift.
  const html = render(
    toolRow({
      toolName: 'mcp__probe__scan',
      toolFamily: 'mcp',
      input: { query: 'scan' },
      status: 'error',
      result: {
        isError: false,
        content: 'scanning\nWARNING: slow probe\n✓ 1 recovered',
        diff: null,
      },
    }),
  )

  expect(html).toContain('text-text-muted')
  expect(html).not.toContain('text-[#fcd34d]')
  expect(html).not.toContain('text-[#86efac]')
})

test('a written file is syntax-colored AND still reads as additions', () => {
  // The prototype's `hl()` colors only the tokens it recognizes and lets every
  // untouched character inherit the surrounding `FE_T.add` (`Messages.jsx:626`).
  // Reproduced by NOT putting `hljs` on the source element: `.hljs` sets an
  // explicit base color that would repaint the file in the code theme's
  // foreground, while the per-token `.hljs-*` rules are independent selectors
  // and still apply. Both halves are asserted, because either alone would pass
  // while the body looked wrong.
  const html = render(
    writeRow(
      { file_path: '/w/hello.ts', content: 'const greeting = "hi"' },
      { content: WRITE_ACK, isError: false },
    ),
  )

  expect(html).toContain('hljs-keyword') // `const` tokenized
  expect(html).toContain('hljs-string') // the quoted literal tokenized
  expect(html).toContain('text-[#86efac]') // …over the add-green base
  // `hljs` must appear ONLY as the `hljs-<token>` prefix, never as a class of
  // its own — that bare class is what carries the base color. Matched as a
  // whole class token: a plain `toContain('hljs')` cannot tell the two apart,
  // and `toContain('"hljs"')` silently never matches, since the class would sit
  // mid-list rather than alone in the attribute.
  expect(html).not.toMatch(/class="[^"]*\bhljs\b(?!-)/)
})

test('a written file whose extension names no language stays plain green', () => {
  // `detect: false` is the house rule: color only what we can name. An unknown
  // extension must not be guessed at, and must not lose the additions green.
  const html = render(
    writeRow(
      { file_path: '/w/notes.xyz', content: 'const greeting = "hi"' },
      { content: WRITE_ACK, isError: false },
    ),
  )

  expect(visibleText(html)).toContain('const greeting = &quot;hi&quot;')
  expect(html).toContain('text-[#86efac]')
  expect(html).not.toContain('hljs')
})

test('a written file uses the prototype add-green on both the + and the line', () => {
  // `FE_T.add` `#86efac` on the row AND the marker (`Messages.jsx:625-627`).
  // NOT `tone-success` `#4ade80`, which is the prototype's DIFF sign green
  // (`:186`); painting the body with it made a write read as a green slab.
  const html = render(
    writeRow(
      { file_path: '/w/hello.ts', content: 'const greeting = "hi"' },
      { content: WRITE_ACK, isError: false },
    ),
  )

  expect(html).toContain('text-[#86efac]')
  expect(html).not.toContain('text-tone-success')
})

// ── P4-18c dep-gated deferrals resolved: GFM tables + syntax highlight + word-diff

function proseRow(content: string, id: string): NestedTranscriptRow {
  return {
    ...blockSource,
    id: `s:m:0:${id}`,
    kind: 'assistant-text',
    role: 'assistant',
    content,
  }
}

test('P4-18c: a GFM pipe table renders a real <table> with header + body cells', () => {
  const html = render(
    proseRow('| Name | Role |\n|------|------|\n| cat | agent |\n', 'table'),
  )

  expect(html).toContain('<table') // real table element (remark-gfm), not raw text
  expect(html).toContain('<th') // header cells
  expect(html).toContain('<td') // body cells
  expect(html).toContain('Name')
  expect(html).toContain('agent')
  // Prototype ProseTable grammar reaches the DOM (exact header wash + rules).
  expect(html).toContain('bg-white/[0.03]')
  expect(html).toContain('border-white/[0.12]')
})

test('P4-18c: a malformed pipe table degrades tolerantly, never throws', () => {
  // Ragged columns (header 3 / delimiter 1) — GFM declines it as a table and it
  // falls back to text; the point is the prose subtree must not crash.
  const render0 = () =>
    render(proseRow('| A | B | C |\n|---|\n| 1 |\n', 'badtable'))
  expect(render0).not.toThrow()
  expect(render0()).toContain('A') // content still surfaces
})

test('P4-18c: an explicitly-languaged fenced block gets highlight.js token classes', () => {
  const html = render(
    proseRow('```python\ndef greet(name):\n    return name\n```\n', 'py'),
  )

  expect(html).toContain('hljs') // highlight.js base class on the <code>
  expect(html).toContain('hljs-keyword') // `def`/`return` keyword tokens
  expect(html).toContain('python') // floating language label
  expect(html).toContain('greet') // code content still present
})

test('P4-18c: an unknown code language degrades to plain framed code, never throws', () => {
  const render0 = () =>
    render(proseRow('```notalang\nsome plain content\n```\n', 'unklang'))
  expect(render0).not.toThrow()
  const html = render0()
  // ignoreMissing → no highlight, so the body stays a contiguous, legible string.
  expect(html).toContain('some plain content')
  expect(html).toContain('copy') // still framed + copyable
  expect(html).toContain('notalang') // language label passthrough
})

function diffToolRow(lines: string[], filePath: string, id: string): NestedTranscriptRow {
  return toolRow({
    toolName: `Edit_${id}`,
    toolFamily: 'edit',
    input: { file_path: filePath },
    status: 'error', // expand so the diff body renders
    result: { isError: true, content: '', diff: { filePath, hunks: [
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines },
    ] } },
  })
}

test('P4-18c: a replaced diff line shows word-level intra-line highlighting', () => {
  const html = render(
    diffToolRow(['-const timeout = 30', '+const timeout = 60'], '/repo/x.ts', 'word'),
  )

  // The differing token (30 → 60) is washed per side; the shared prefix dims.
  expect(html).toContain('bg-tone-danger/28') // removed word wash (exact prototype 0.28)
  expect(html).toContain('bg-tone-success/26') // added word wash (exact prototype 0.26)
  expect(html).toContain('text-[#fca5a5]/55') // unchanged del word dims (exact)
  expect(html).toContain('const timeout = ') // shared prefix present
})

test('P4-18c: a near-total line rewrite skips word-highlight (line-level), no throw', () => {
  // >90% of the line changed → the prototype guard falls back to line-level.
  const render0 = () =>
    render(diffToolRow(['-aaaaaaaa', '+zzzzzzzzzz'], '/repo/y.ts', 'rewrite'))
  expect(render0).not.toThrow()
  const html = render0()
  expect(html).toContain('zzzzzzzzzz') // whole line intact (not word-split)
  expect(html).not.toContain('bg-tone-success/26') // no word wash — guard tripped
})

// ─── P4-1 ToolInspector wiring: open-from-card affordance + overlay ──────────
// Live-path fixture: project a real tool_use + correlated tool_result through the
// reducer, then read the nested row the transcript actually renders — not a
// hand-built shape (§8 rule 1: prove real data flows).
function inspectorReady(sessionId: string) {
  return {
    kind: 'ready' as const,
    protocolVersion: 1 as const,
    sessionId,
    engineSessionId: `engine-${sessionId}`,
    payload: {
      type: 'app.ready' as const,
      protocolVersion: 1 as const,
      inputEnabled: true,
      activeTurn: false,
      abort: { status: 'idle' as const },
      goalSnapshot: null,
      pendingPermissionRequests: [],
    },
  }
}

function inspectorMessage(sessionId: string, message: SDKMessage) {
  return {
    kind: 'event' as const,
    protocolVersion: 1 as const,
    sessionId,
    event: { type: 'message' as const, message },
  }
}

function projectedBashRow(): NestedToolUseRow {
  let state = createTranscriptState()
  state = projectServerFrame(state, inspectorReady('insp-1'))
  state = projectServerFrame(
    state,
    inspectorMessage('insp-1', {
      type: 'assistant',
      message: {
        id: 'msg_insp_1',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_insp_1',
            name: 'Bash',
            input: { command: 'echo hi' },
          },
        ],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-0000000d0001',
    }),
  )
  state = projectServerFrame(
    state,
    inspectorMessage('insp-1', {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_insp_1',
            content: [{ type: 'text', text: 'hi from the shell' }],
            is_error: true,
          },
        ],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-0000000d0002',
    }),
  )
  const row = selectNestedTranscriptRows(state, 'insp-1')[0]
  if (row?.kind !== 'tool-use') throw new Error('expected a projected tool-use row')
  return row
}

test('P4-1: a real projected tool card renders the open-from-card inspector affordance', () => {
  // Default-expanded (error status), so the body — and the launch affordance
  // wired to the inspector via context — appears in the real render path.
  const html = renderToStaticMarkup(<TranscriptRowsView rows={[projectedBashRow()]} />)
  expect(html).toContain('Inspector')
  // P4-45: this footer is ALWAYS offered, so it must not wear the label of the
  // reveal band, which appears only when output was cut. This output is short:
  // there is no band here, and therefore no "Open full output" anywhere.
  expect(html).not.toContain('Open full output')
})

test('P4-1: the inspector overlay renders the REAL projected row (drawer + backdrop)', () => {
  const html = renderToStaticMarkup(
    <ToolInspectorOverlay row={projectedBashRow()} onClose={() => {}} />,
  )
  expect(html).toContain('Tool inspector')
  expect(html).toContain('echo hi') // real input summary, from the projected row
  expect(html).toContain('hi from the shell') // real correlated result output
  expect(html).toContain('bg-black/60') // the dimmed dismiss backdrop
})

test('P4-1: the inspector overlay renders nothing when closed (null row)', () => {
  expect(
    renderToStaticMarkup(<ToolInspectorOverlay row={null} onClose={() => {}} />),
  ).toBe('')
})

test('P4-36: a revealed hidden row renders DIMMED, and only when revealed', () => {
  // Built from the REAL projection of a synthetic frame (the engine's hidden
  // tier), not a hand-made row: the dim depends on the read-time `isHidden`
  // mark, so a hand-made row would prove nothing about the wiring.
  let state = createTranscriptState()
  state = projectServerFrame(state, {
    kind: 'ready',
    protocolVersion: 1,
    sessionId: 's',
    engineSessionId: 'engine-s',
    payload: {
      type: 'app.ready',
      protocolVersion: 1,
      inputEnabled: true,
      activeTurn: false,
      abort: { status: 'idle' },
      goalSnapshot: null,
      pendingPermissionRequests: [],
    },
  })
  const hiddenFrame: SDKMessage = {
    type: 'user',
    message: { role: 'user', content: 'engine bookkeeping turn' },
    parent_tool_use_id: null,
    session_id: 's',
    uuid: '00000000-0000-4000-8000-0000000036b2',
    isSynthetic: true,
  }
  state = projectServerFrame(state, {
    kind: 'event',
    protocolVersion: 1,
    sessionId: 's',
    event: { type: 'message', message: hiddenFrame },
  })

  // Default view: the row is absent entirely (the transcript the app has always
  // shown), so there is nothing to dim.
  const plain = renderToStaticMarkup(
    <TranscriptRowsView rows={selectNestedTranscriptRows(state, 's')} />,
  )
  expect(plain).not.toContain('engine bookkeeping turn')
  expect(plain).not.toContain('opacity-55')

  // Revealed view: the row renders, wrapped in the prototype's 0.55 dim
  // (Chat.jsx:1285), so it never passes as ordinary conversation.
  const revealed = renderToStaticMarkup(
    <TranscriptRowsView rows={selectNestedTranscriptRows(state, 's', true)} />,
  )
  expect(revealed).toContain('engine bookkeeping turn')
  expect(revealed).toContain('opacity-55')
})

test('P4-1/F1: findNestedToolUseRow re-derives the row by id, or null when gone', () => {
  const row = projectedBashRow()
  // Found at the top level.
  expect(findNestedToolUseRow([row], row.id)).toBe(row)
  // A vanished id resolves to null → the drawer closes instead of pinning a snapshot.
  expect(findNestedToolUseRow([row], 'no-such-id')).toBeNull()
  // Re-derivation reads from the PASSED rows: a freshly-projected row object with
  // the same id supersedes an earlier open-time snapshot (the F1 staleness fix).
  const updated: NestedToolUseRow = { ...row }
  expect(findNestedToolUseRow([updated], row.id)).toBe(updated)
  expect(findNestedToolUseRow([updated], row.id)).not.toBe(row)
})

/* --------------------------------------------------------------------------- *
 * User bubble: no copy affordance (operator call, 2026-08-02) — deviates from
 * the prototype's UserBubble hover chip (Messages.jsx:2094); the assistant
 * twin below keeps it.
 * --------------------------------------------------------------------------- */

function userRow(content: string): NestedTranscriptRow {
  return {
    ...blockSource,
    id: 's:m:0:user-text',
    kind: 'user-text',
    role: 'user',
    content,
    isReplay: false,
  }
}

test('a user turn carries no copy control', () => {
  const html = render(userRow('restart the sidecar please'))
  expect(html).not.toContain('aria-label="Copy message"')
  expect(html).not.toContain('Copy message')
})

/* --------------------------------------------------------------------------- *
 * P4-38 — the hover-reveal copy chip on the assistant body (Messages.jsx:2064-2091).
 *
 * SSR-ONLY LIMIT: `renderToStaticMarkup` produces no document, so the hover
 * reveal and the clipboard round-trip are structurally untestable here. What
 * these tests pin is everything that IS decidable from the markup — the gates,
 * the host contract the absolute chip depends on, the assistant wording — plus
 * a source pin on the payload, which never reaches the DOM at all.
 * --------------------------------------------------------------------------- */

function assistantRow(
  content: string,
  streaming?: true,
): NestedTranscriptRow {
  return {
    ...blockSource,
    id: 's:m:0:assistant-text',
    kind: 'assistant-text',
    role: 'assistant',
    content,
    ...(streaming ? { isStreaming: streaming } : {}),
  }
}

test('P4-38 — a settled assistant reply carries a copy control, worded for a response', () => {
  const html = render(assistantRow('Here is the answer.'))
  expect(html).toContain('aria-label="Copy response"')
  expect(html).toContain('title="Copy response"')
})

test('P4-38 — the assistant body is the positioned hover group the chip needs', () => {
  // The chip is `absolute` + `opacity-0`; without `group relative` on the host it
  // anchors to a distant ancestor and never reveals. No reserved right gutter:
  // the revealed glyph overlays the last line, matching the prototype.
  const html = render(assistantRow('Here is the answer.'))
  expect(html).toContain('group relative')
  expect(html).not.toContain('pr-8')
  expect(html).toContain('opacity-0')
  expect(html).toContain('group-hover:opacity-100')
  // Real-added keyboard reach; the prototype reveals on hover only.
  expect(html).toContain('group-focus-within:opacity-100')
})

test('P4-38 — no copy chip while the reply is still streaming', () => {
  const html = render(assistantRow('partial ans', true))
  expect(html).toContain('animate-pulse') // still streaming: the caret is up
  expect(html).not.toContain('Copy response')
})

test('P4-38 — an empty assistant turn gets no copy chip', () => {
  expect(render(assistantRow('   \n  '))).not.toContain('Copy response')
})

/* --------------------------------------------------------------------------- *
 * P4-36 — inline truncation reveal band (prototype Messages.jsx:438-457,546-556).
 *
 * The defect: `NumberedBody` (file read) and `AdditionsBody` (file write) sliced
 * the content and rendered NOTHING about the slice, so a 900-line read showed 400
 * lines that simply stopped and the last visible line read as the end of the file.
 *
 * SSR-ONLY LIMIT: `renderToStaticMarkup` cannot click "Show N more", so what these
 * tests pin is the first paint of each state. The reveal itself is proven against
 * the pure window in `inlineOutputWindow.test.ts`.
 *
 * Cards collapse by default, so these rows are `status: 'error'` — the one status
 * that expands a read/write card (`ToolCard` `defaultExpanded`).
 * --------------------------------------------------------------------------- */

function longToolRow(family: ToolFamily, lineCount: number): NestedTranscriptRow {
  return toolRow({
    toolName: family === 'read' ? 'Read' : 'Write',
    toolFamily: family,
    input: { file_path: '/w/big.ts' },
    status: 'error',
    result: {
      content: Array.from({ length: lineCount }, (_, i) => `src line ${i + 1}`).join('\n'),
      isError: true,
      diff: null,
    },
  })
}

test('P4-36 — a long file READ no longer stops silently: it states the gap', () => {
  const html = render(longToolRow('read', 900))

  // 900 lines, head 30, tail 6 → 864 in the gap.
  expect(html).toContain('864 lines hidden')
  expect(html).toContain('Show 100 more')
})

test('P4-36 — a long file WRITE states the gap too (the second silent body)', () => {
  const html = render(longToolRow('write', 900))

  expect(html).toContain('864 lines hidden')
  expect(html).toContain('Show 100 more')
})

test('P4-36 — the tail of a truncated read stays visible, with its real line numbers', () => {
  const html = render(longToolRow('read', 900))

  expect(html).toContain('src line 1') // head
  expect(html).toContain('src line 900') // tail: the file's true last line
  expect(html).not.toContain('src line 500') // the gap really is hidden
  // The tail is numbered 895..900, not 1..6.
  expect(html).toContain('>895<')
  expect(html).toContain('>900<')
})

test('P4-36 — the band offers the route to the complete text', () => {
  const html = render(longToolRow('read', 900))
  expect(html).toContain('Open full output')
  // P4-45: this card renders BOTH routes to the drawer (the always-present
  // footer and this band), so a bare `toContain` passed even when the footer
  // was the only thing carrying the label. Exactly one button says it now, and
  // the other says "Inspector".
  expect(html.split('Open full output').length - 1).toBe(1)
  expect(html).toContain('Inspector')
})

test('P4-36 — output under the window renders whole, with no band', () => {
  const html = render(longToolRow('read', 30))

  expect(html).toContain('src line 30')
  expect(html).not.toContain('lines hidden')
  expect(html).not.toContain('Show ')
})

test('P4-36 — one line over the window bands, and offers exactly that line', () => {
  const html = render(longToolRow('read', 37))

  expect(html).toContain('1 line hidden') // singular, not "1 lines"
  expect(html).toContain('Show 1 more') // never offers more than exists
  expect(html).toContain('src line 37') // the tail is still the real last line
})

test('P4-36 — a body shorter than the tail renders whole', () => {
  const html = render(longToolRow('write', 3))

  expect(html).toContain('src line 1')
  expect(html).toContain('src line 3')
  expect(html).not.toContain('lines hidden')
})

test('P4-36 — an empty result keeps its own message and never bands', () => {
  const html = render(
    toolRow({
      toolName: 'Read',
      toolFamily: 'read',
      input: { file_path: '/w/empty.ts' },
      status: 'error',
      result: { content: '', isError: true, diff: null },
    }),
  )

  expect(html).toContain('Failed with no output.')
  expect(html).not.toContain('lines hidden')
})

test('P4-36 — bash keeps its band too, so the four bodies share one grammar', () => {
  const html = render(longToolRow('bash', 900))

  expect(html).toContain('864 lines hidden')
  // The old one-line note is gone from every body.
  expect(html).not.toContain('Open the full-output inspector to view all')
})

/* --------------------------------------------------------------------------- *
 * The file-READ body over the payload the engine actually sends.
 *
 * The fixtures above are plain strings, which is why two defects survived them:
 * a real read arrives in `cat -n` form (`FileReadTool.ts:721` →
 * `addLineNumbers`, `src/utils/file.ts:290-318`), so the card drew its own
 * 1..N gutter on top of the engine's numbers and fed the prefixed lines to
 * nothing that could color them. These rows use the real shape.
 * --------------------------------------------------------------------------- */

function readRow(content: string, filePath: string): NestedTranscriptRow {
  return toolRow({
    toolName: 'Read',
    toolFamily: 'read',
    input: { file_path: filePath },
    // `error` is the one status that expands a read card by default.
    status: 'error',
    result: { content, isError: true, diff: null },
  })
}

test('a real read paints ONE gutter, not the engine numbers plus its own', () => {
  const html = render(
    readRow('1\timport os\n2\t\n3\tdef f():\n4\t    return 1', '/w/a.py'),
  )

  // The prefix is gone from the source column (the keyword is tokenized, so
  // the rest of the line is what survives as plain text beside it)…
  expect(html).not.toContain('1\timport os')
  expect(html).toContain('>import</span> os')
  // …and each number appears once, in the gutter.
  expect(occurrences(html, '>1</div>')).toBe(1)
  expect(occurrences(html, '>4</div>')).toBe(1)
})

test('an offset read is numbered with the file lines it really is', () => {
  const html = render(readRow('812\tconst x = 1\n813\tconst y = 2', '/w/a.ts'))

  expect(html).toContain('>812</div>')
  expect(html).toContain('>813</div>')
  expect(html).not.toContain('>1</div>') // the old gutter restarted at 1 here
})

test('read source is syntax-colored by the theme the transcript already uses', () => {
  const html = render(readRow('1\tdef f():\n2\t    return 1', '/w/a.py'))

  // `hljs-*` classes, not a private palette: `theme.css` colors these under the
  // operator's chosen code theme (`codeTheme.ts`).
  expect(html).toContain('class="hljs-keyword"')
  expect(html).toContain('hljs')
})

test('a file we cannot name a language for stays uncolored rather than guessed', () => {
  const html = render(readRow('1\tsome notes\n2\tmore notes', '/w/notes.wat'))

  expect(html).not.toContain('hljs')
  expect(html).toContain('some notes')
  expect(html).toContain('>1</div>') // still numbered from the payload
})

test('a read result that is not a numbered file keeps the plain rendering', () => {
  const html = render(readRow('EISDIR: illegal operation', '/w/a.ts'))

  expect(html).not.toContain('hljs')
  expect(html).toContain('EISDIR: illegal operation')
  expect(html).toContain('>1</div>') // counted, since the payload carried none
})

test('a truncated real read numbers its tail with the file lines, not 1..6', () => {
  const content = Array.from(
    { length: 900 },
    (_, index) => `${index + 1}\tconst v${index + 1} = ${index + 1}`,
  ).join('\n')
  const html = render(readRow(content, '/w/big.ts'))

  expect(html).toContain('864 lines hidden')
  expect(html).toContain('>895</div>')
  expect(html).toContain('>900</div>')
  expect(html).not.toContain('>500</div>') // the gap really is hidden
})

/* --------------------------------------------------------------------------- *
 * The file-WRITE body over the payload the engine actually sends.
 *
 * `FileWriteTool` returns one of exactly two sentences and never the file
 * (`src/tools/FileWriteTool/FileWriteTool.ts:418-433`), so an additions view fed
 * `result.content` painted an English sentence, or a failure, as green `+` added
 * lines. The file is the tool's INPUT (`content`, `FileWriteTool.ts:63`).
 *
 * SSR-ONLY LIMIT: a card opens by default only on `status: 'error'`, and these
 * rows need an OPEN card whose result is not an error. The two are independent
 * inputs to different decisions — `status` drives `defaultExpanded`, the body
 * path reads `result.isError` — so the successful-write rows below set them
 * apart purely to get the body into the markup. The genuinely-failed row keeps
 * both.
 * --------------------------------------------------------------------------- */

const WRITE_ACK = 'File created successfully at: /w/hello.ts'

function writeRow(
  input: Record<string, unknown>,
  result: { content: string; isError: boolean },
): NestedTranscriptRow {
  return toolRow({
    toolName: 'Write',
    toolFamily: 'write',
    input,
    status: 'error',
    result: { ...result, diff: null },
  })
}

test('a write shows the file it wrote, not the engine sentence about it', () => {
  const html = render(
    writeRow(
      { file_path: '/w/hello.ts', content: 'const greeting = "hi"\nexport default greeting' },
      { content: WRITE_ACK, isError: false },
    ),
  )

  expect(visibleText(html)).toContain('const greeting = &quot;hi&quot;')
  expect(visibleText(html)).toContain('export default greeting')
  // Painted as additions, which is now true of what it is painting.
  expect(html).toContain('text-[#86efac]')
  // The ack never reaches the body; the card's own status already reports it.
  expect(html).not.toContain('File created successfully at')
})

test('a failed write reports the failure instead of claiming additions', () => {
  const html = render(
    writeRow(
      { file_path: '/w/hello.ts', content: 'const greeting = "hi"' },
      { content: 'EACCES: permission denied', isError: true },
    ),
  )

  expect(html).toContain('EACCES: permission denied')
  expect(html).toContain('text-tone-danger')
  // Nothing was written, so nothing is painted as an addition.
  expect(html).not.toContain('const greeting')
  expect(html).not.toContain('text-[#86efac]')
})

test('a write whose input carries no content falls back to the result text', () => {
  const html = render(
    writeRow({ file_path: '/w/hello.ts' }, { content: WRITE_ACK, isError: false }),
  )

  expect(html).toContain('File created successfully at')
  // …as plain text, never as a green added line.
  expect(html).not.toContain('text-[#86efac]')
})

test('a long written file still bands, and the band counts the FILE', () => {
  const written = Array.from({ length: 900 }, (_, i) => `line ${i + 1}`).join('\n')
  const html = render(
    writeRow(
      { file_path: '/w/big.ts', content: written },
      { content: WRITE_ACK, isError: false },
    ),
  )

  expect(html).toContain('864 lines hidden') // 900 - 30 head - 6 tail
  expect(visibleText(html)).toContain('line 1')
  expect(visibleText(html)).toContain('line 900')
  expect(visibleText(html)).not.toContain('line 500')
})
