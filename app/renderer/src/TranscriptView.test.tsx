import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SDKMessage } from '@cat-code/engine/session-events'
import {
  ToolInspectorOverlay,
  TranscriptRowsView,
} from './TranscriptView.js'
import {
  findNestedToolUseRow,
  resolveToolCardExpanded,
} from './transcriptViewModel.js'
import {
  createTranscriptState,
  projectServerFrame,
  selectNestedTranscriptRows,
} from './transcriptProjector.js'
import type {
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

test('P4-18c: a >60-line assistant body collapses behind a Show-more control', () => {
  const long = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n')
  const html = render({
    ...blockSource,
    id: 's:m:0:long',
    kind: 'assistant-text',
    role: 'assistant',
    content: long,
  })

  expect(html).toContain('Show 20 more lines')
  expect(html).toContain('line 0')
  expect(html).not.toContain('line 79') // tail hidden while collapsed
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

// IS-C (M5) — restore affordance. A cached preview keeps a non-text divider, an
// engaged restore pulses, and a no-cache restore shows the skeleton instead of
// an empty WelcomeScreen (report F4's "reads as a hang").
const cachedRow: NestedTranscriptRow = {
  ...blockSource,
  id: 's:m:0:f',
  kind: 'assistant-text',
  role: 'assistant',
  content: 'cached line',
}

test('IS-C: preview rows render under a non-text restore divider', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView rows={[cachedRow]} restorePhase="preview" />,
  )
  expect(html).toContain('cached line')
  expect(html).toContain('bg-accent')
  // No visible restore labels.
  expect(html).not.toContain('Restored session')
  expect(html).not.toContain('Resuming session')
  expect(html).not.toContain('Opening session')
})

test('IS-C: an engaged preview shows a pulsing non-text divider', () => {
  const html = renderToStaticMarkup(
    <TranscriptRowsView rows={[cachedRow]} restorePhase="resuming" />,
  )
  expect(html).toContain('animate-pulse') // live pulse dot
  expect(html).toContain('cached line')
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

// P4-8c: a top-level Agent tool-use row (the DelegateGroup member / lone card).
// messageId is shared ('m' via blockSource) so two of these coalesce; distinct
// ids/toolUseIds keep them separate rows.
function agentRow(
  suffix: string,
  input: Record<string, unknown>,
  status: ToolCardStatus,
  children: NestedTranscriptRow[] = [],
): NestedTranscriptRow {
  return {
    ...blockSource,
    id: `s:m:0:agent-${suffix}`,
    kind: 'tool-use',
    toolUseId: `toolu_agent_${suffix}`,
    toolName: 'Agent',
    toolFamily: 'agent',
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

test('trail mode: a summary heading is plain text, never markdown prose', () => {
  const html = render(thinkingRow('s:m:0:thinking', 'weighing the **socket** options'))

  // A heading is a label, not prose — it is not run through the markdown path.
  expect(html).toContain('**socket**')
  expect(html).not.toContain('<strong>socket</strong>')
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

test('#6: a successful result row renders no turn-footer', () => {
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

test('P4-18a/#6: an errored result row still renders an Errored seam', () => {
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

test('#6: an aborted/max-turns result row still renders its seam', () => {
  const html = render({
    ...frameSource,
    id: 's:f:result',
    kind: 'result',
    subtype: 'error_max_turns',
    isError: true,
    errors: [],
  })

  expect(html).toContain('Stopped · max turns reached')
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
  expect(html).toContain('Open full output')
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
